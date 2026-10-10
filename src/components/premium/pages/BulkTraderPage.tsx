import { useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import {
    BULK_MARKETS, ENGINE_TICKS, MIN_ENGINE_TICKS, OverUnderEngine, assertAllowedContract, buildEngineTicks, contractLabel, digitPercents,
    digitsFromPrices, inferDecimals, lastDigit, recommend, refreshLocked, SignalStability, validateRecommendation, watching,
    type CombinedVerdict, type OverUnderContract, type Recommendation,
} from '../over-under-engine';
import {
    DEFAULT_BULK, RunGuard, emptyTally, limitError, recordFailed, recordPlaced, recordSettled, sanitizeBulk, syncReport, syncText,
    type Fill, type Tally,
} from '../bulk-run';
import {
    DEFAULT_AUTO, armSession, disarmSession, newSession, recordAutoRun, sanitizeAuto, stepAuto, waitingNote,
    type AutoConfig, type AutoGrade, type AutoSession,
} from '../auto-trader';
import BulkTraderView, { type AutoForm, type BulkForm, type LogRow } from './BulkTraderView';

type MarketStore = { prices: number[]; times: number[]; digits: number[]; decimals: number };

const IDLE = 'Bot is not running.';
const LOCK_KEY = 'apex_bulk_locked_signal';
const readLock = (): Recommendation | null => {
    try {
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(LOCK_KEY) : null;
        const parsed = raw ? (JSON.parse(raw) as Recommendation) : null;
        return parsed && parsed.id && parsed.symbol && parsed.proposition ? { ...parsed, locked: true, expiresAt: Infinity } : null;
    } catch { return null; }
};
const writeLock = (value: Recommendation | null) => {
    try {
        if (typeof sessionStorage === 'undefined') return;
        if (value) sessionStorage.setItem(LOCK_KEY, JSON.stringify(value)); else sessionStorage.removeItem(LOCK_KEY);
    } catch { /* storage unavailable: the lock simply lasts for this visit */ }
};
const ENGINE_STEP_MS = 150;
const SETTLE_WAIT_MS = 90_000;
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const numOrNull = (value: unknown) => { const n = Number(value); return value !== undefined && value !== null && Number.isFinite(n) ? n : null; };
const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : (error as { message?: string })?.message || String(error));

const BulkTraderPage = () => {
    const { authData } = useApiBase();
    const currency = authData?.currency || 'USD';

    const [symbol, setSymbol] = useState('1HZ100V');
    const [overBarrier, setOverBarrier] = useState('2');
    const [underBarrier, setUnderBarrier] = useState('7');
    const [form, setForm] = useState<BulkForm>({ duration: String(DEFAULT_BULK.duration), stake: String(DEFAULT_BULK.stake), runs: String(DEFAULT_BULK.runs) });
    const [loaded, setLoaded] = useState<Recommendation | null>(null);
    const [locked, setLocked] = useState<Recommendation | null>(readLock);
    // Auto trader is always OFF on page load; arming is never persisted between visits.
    const [autoForm, setAutoForm] = useState<AutoForm>({ grade: DEFAULT_AUTO.grade, cooldownSec: String(DEFAULT_AUTO.cooldownSec), maxRuns: String(DEFAULT_AUTO.maxRuns), maxLoss: String(DEFAULT_AUTO.maxLoss) });
    const [autoSession, setAutoSession] = useState<AutoSession>(newSession());
    const [autoNote, setAutoNote] = useState('Off.');
    const [pendingAuto, setPendingAuto] = useState<{ rec: Recommendation; nonce: number } | null>(null);
    const [live, setLive] = useState(false);
    const [tickVersion, setTickVersion] = useState(0);
    const [, setClock] = useState(0);
    const [recVersion, setRecVersion] = useState('');
    const [marketsReady, setMarketsReady] = useState(0);
    const [error, setError] = useState('');
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState(IDLE);
    const [tally, setTally] = useState<Tally>(emptyTally());
    const [syncNote, setSyncNote] = useState('');
    const [log, setLog] = useState<LogRow[]>([]);

    const store = useRef<Record<string, MarketStore>>({});
    const verdicts = useRef<Record<string, CombinedVerdict>>({});
    const recRef = useRef<Recommendation | null>(null);
    const engine = useRef(new OverUnderEngine());
    const stability = useRef(new SignalStability());
    const autoRef = useRef<{ session: AutoSession; config: AutoConfig }>({ session: newSession(), config: DEFAULT_AUTO });
    const lockedRef = useRef<Recommendation | null>(null);
    const autoBusy = useRef(false);
    const applyRef = useRef<(target: Recommendation, scroll?: boolean) => void>(() => undefined);
    const symbolRef = useRef(symbol);
    const waiters = useRef<Record<string, Array<() => void>>>({});
    const mounted = useRef(true);
    const guard = useRef(new RunGuard());
    const stopRef = useRef(false);
    const tallyRef = useRef<Tally>(emptyTally());
    const rowSeq = useRef(0);
    const run = useRef<{ owned: Map<number, number>; settled: Set<number>; fills: Map<number, Fill>; stake: number } | null>(null);
    const traderRef = useRef<HTMLElement>(null);

    symbolRef.current = symbol;
    lockedRef.current = locked;
    const autoConfig = sanitizeAuto({ grade: autoForm.grade as AutoGrade, cooldownSec: Number(autoForm.cooldownSec), maxRuns: Number(autoForm.maxRuns), maxLoss: Number(autoForm.maxLoss) });
    autoRef.current.config = autoConfig;
    useEffect(() => () => { mounted.current = false; stopRef.current = true; }, []);

    // ------------------------------------------------------------------
    // Live data: 1000 ticks of history (prices AND times), then the live tick stream, for all 13 markets.
    // ------------------------------------------------------------------
    useEffect(() => {
        let alive = true;
        const disposers: Array<() => void> = [];
        const loadMarket = async (market: (typeof BULK_MARKETS)[number]) => {
            try {
                const result = await PremiumDerivApiService.request({ ticks_history: market.symbol, end: 'latest', count: ENGINE_TICKS, style: 'ticks' });
                if (!alive) return;
                const prices: number[] = (result.history?.prices ?? []).map(Number);
                const times: number[] = (result.history?.times ?? []).map((t: unknown) => Number(t) * 1000);
                const decimals = inferDecimals(prices, market.pip);
                store.current[market.symbol] = { prices, times, digits: digitsFromPrices(prices, decimals), decimals };
                const dispose = await PremiumDerivApiService.subscribeTicks(market.symbol, tick => {
                    const entry = store.current[market.symbol];
                    const quote = Number(tick?.quote);
                    if (!entry || !Number.isFinite(quote)) return;
                    const pip = Number(tick?.pip_size);
                    if (Number.isInteger(pip) && pip > entry.decimals) entry.decimals = pip;
                    entry.prices.push(quote);
                    entry.times.push(num(tick?.epoch, Date.now() / 1000) * 1000);
                    entry.digits.push(lastDigit(quote, entry.decimals));
                    if (entry.prices.length > ENGINE_TICKS) {
                        const extra = entry.prices.length - ENGINE_TICKS;
                        entry.prices.splice(0, extra); entry.times.splice(0, extra); entry.digits.splice(0, extra);
                    }
                    const pending = waiters.current[market.symbol];
                    if (pending?.length) { waiters.current[market.symbol] = []; pending.forEach(resolve => resolve()); }
                    if (market.symbol === symbolRef.current) setTickVersion(value => value + 1);
                });
                if (alive) disposers.push(dispose); else dispose();
            } catch (err) {
                if (alive) setError(errorText(err));
            }
        };
        const queue = [...BULK_MARKETS];
        const worker = async () => { for (let m = queue.shift(); m && alive; m = queue.shift()) await loadMarket(m); };
        void Promise.all([worker(), worker(), worker(), worker()]).then(() => { if (alive) setLive(true); });
        return () => {
            alive = false;
            disposers.forEach(dispose => { try { dispose(); } catch { /* already closed */ } });
        };
    }, []);

    // ------------------------------------------------------------------
    // Backend analysis: Insight Fusion, one market per step, round-robin (so the page never blocks for long).
    // ------------------------------------------------------------------
    useEffect(() => {
        let index = 0;
        const timer = window.setInterval(() => {
            for (let tries = 0; tries < BULK_MARKETS.length; tries += 1) {
                const market = BULK_MARKETS[index % BULK_MARKETS.length];
                index += 1;
                const entry = store.current[market.symbol];
                if (!entry || entry.prices.length < MIN_ENGINE_TICKS) continue;
                verdicts.current[market.symbol] = engine.current.analyse(market.symbol, buildEngineTicks(entry.prices, entry.times, entry.decimals));
                stability.current.observe(market.symbol, verdicts.current[market.symbol]);
                break;
            }
            const now = Date.now();
            const next = recommend(verdicts.current, now, recRef.current, stability.current);
            recRef.current = next;
            const version = next ? `${next.id}|${next.action}|${next.score}` : '';
            setRecVersion(previous => (previous === version ? previous : version));
            // Evaluate the same live recommendation shown to the user (the locked one while locked).
            const auto = autoRef.current;
            if (auto.session.armed) {
                const held = lockedRef.current;
                const target = held ? refreshLocked(held, verdicts.current, now) : next;
                const valid = target ? validateRecommendation(target, verdicts.current, now, Boolean(held)).ok : false;
                const result = stepAuto(auto.session, auto.config, { target, valid, busy: guard.current.busy || autoBusy.current, now });
                const shown = result.session.armed !== auto.session.armed || result.session.runs !== auto.session.runs
                    || result.session.pnl !== auto.session.pnl || result.session.stopReason !== auto.session.stopReason;
                auto.session = result.session;
                if (shown) setAutoSession(result.session);
                setAutoNote(previous => (previous === result.note ? previous : result.note));
                if (result.fire && target) {
                    applyRef.current(target, false);
                    setPendingAuto({ rec: target, nonce: now });
                }
            }
            const ready = Object.values(verdicts.current).filter(v => v.ready).length;
            setMarketsReady(previous => (previous === ready ? previous : ready));
        }, ENGINE_STEP_MS);
        const clock = window.setInterval(() => setClock(value => value + 1), 1000);
        return () => { window.clearInterval(timer); window.clearInterval(clock); };
    }, []);

    // ------------------------------------------------------------------
    // Recommendation -> Trading Deck. Loading never purchases anything.
    // ------------------------------------------------------------------
    const now = Date.now();
    const offered = recRef.current && recRef.current.expiresAt >= now ? recRef.current : null;
    void recVersion;
    const rec = locked ? refreshLocked(locked, verdicts.current, now) : offered;
    const watch = rec ? null : watching(verdicts.current);
    const applyToDeck = (target: Recommendation, scroll = true) => {
        setLoaded(target); setSymbol(target.symbol);
        if (target.contract === 'DIGITOVER') setOverBarrier(String(target.barrier)); else setUnderBarrier(String(target.barrier));
        setError('');
        if (scroll) window.setTimeout(() => traderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };
    applyRef.current = applyToDeck;
    const loadRecommendation = () => { if (rec) applyToDeck(rec); };
    const toggleLock = () => {
        if (locked) { setLocked(null); writeLock(null); return; }
        if (!offered) return;
        const held = { ...offered, locked: true, expiresAt: Infinity };
        setLocked(held); writeLock(held); applyToDeck(held);
    };

    const entry = store.current[symbol];
    const lastIndex = entry ? entry.prices.length - 1 : -1;
    const price = lastIndex >= 0 ? entry.prices[lastIndex] : null;
    const digit = lastIndex >= 0 ? entry.digits[lastIndex] : null;
    // Recomputed on EVERY tick of the selected market. (Keying on the buffer length would freeze it once the 1000-tick window is full.)
    const digitPct = useMemo(() => digitPercents(entry?.digits ?? [], ENGINE_TICKS), [entry, tickVersion]); // eslint-disable-line react-hooks/exhaustive-deps
    const recent = entry ? entry.digits.slice(-8) : [];

    const pickSide: 0 | 1 | null = loaded && loaded.symbol === symbol
        ? (loaded.side === 0 && Number(overBarrier) === loaded.barrier ? 0 : loaded.side === 1 && Number(underBarrier) === loaded.barrier ? 1 : null)
        : null;

    const loadedIsLocked = Boolean(locked && loaded && loaded.id === locked.id);
    const loadedCheck = loaded ? validateRecommendation(loaded, verdicts.current, now, loadedIsLocked) : null;
    const loadedNote = !loaded
        ? 'Load the recommendation, or choose your own market and barrier. Nothing is purchased until you press Over or Under.'
        : loadedCheck && !loadedCheck.ok
            ? `Loaded ${loaded.label} on ${loaded.market} is no longer valid: ${loadedCheck.reason}`
            : `Loaded ${loaded.label} on ${loaded.market} (${loaded.action}). Press ${loaded.label} to run it. Nothing is purchased until you do.`;

    const onForm = (key: keyof BulkForm) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));
    const nextTick = (target: string) => new Promise<void>(resolve => { (waiters.current[target] ||= []).push(resolve); });

    // ------------------------------------------------------------------
    // One Run: all N contracts are requested and bought in the same instant, on one tick.
    // ------------------------------------------------------------------
    const execute = async (side: 0 | 1) => {
        const token = guard.current.begin();          // repeated clicks / duplicate events cannot start a second run
        if (!token) return;
        const state = { owned: new Map<number, number>(), settled: new Set<number>(), fills: new Map<number, Fill>(), stake: 0 };
        let off: (() => void) | null = null;
        try {
            setError('');
            const contract: OverUnderContract = side === 0 ? 'DIGITOVER' : 'DIGITUNDER';
            const barrier = Number(side === 0 ? overBarrier : underBarrier);
            const params = sanitizeBulk({ stake: Number(form.stake), runs: Number(form.runs), duration: Number(form.duration) });
            try { assertAllowedContract(contract, barrier); } catch (err) { setError(errorText(err)); return; }
            const tooBig = limitError(params);
            if (tooBig) { setError(tooBig); return; }

            const isPick = Boolean(loaded && loaded.symbol === symbol && loaded.contract === contract && loaded.barrier === barrier);
            if (isPick) {
                const check = validateRecommendation(loaded, verdicts.current, Date.now(), Boolean(locked && loaded && loaded.id === locked.id));
                if (!check.ok) { setError(check.reason); return; }
            }

            const market = BULK_MARKETS.find(item => item.symbol === symbol) ?? BULK_MARKETS[0];
            const label = contractLabel(contract, barrier);

            stopRef.current = false;
            run.current = state;
            state.stake = params.stake;
            tallyRef.current = emptyTally(params.runs);
            setTally(tallyRef.current);
            setLog([]);
            setSyncNote('');
            setRunning(true);

            off = PremiumDerivApiService.onContractUpdate(update => {
                const id = Math.trunc(Number(update?.contract_id));
                if (!state.owned.has(id) || state.settled.has(id) || !PremiumDerivApiService.isContractClosed(update)) return;
                state.settled.add(id);                // duplicate events for the same contract are ignored
                const profit = update.profit !== undefined ? num(update.profit) : num(update.sold_for) - state.stake;
                const exitValue = update.exit_tick_display_value ?? update.exit_tick ?? update.sell_spot_display_value ?? update.sell_spot;
                const places = store.current[market.symbol]?.decimals ?? market.pip;
                const exitDigit = exitValue === undefined || exitValue === null ? null
                    : typeof exitValue === 'string' ? Number(exitValue.slice(-1)) : lastDigit(Number(exitValue), places);
                state.fills.set(id, {
                    contractId: id, entryTime: numOrNull(update.entry_tick_time), exitTime: numOrNull(update.exit_tick_time ?? update.sell_spot_time),
                    exitDigit: exitDigit !== null && Number.isFinite(exitDigit) ? exitDigit : null,
                });
                tallyRef.current = recordSettled(tallyRef.current, profit);
                if (!mounted.current) return;
                setTally(tallyRef.current);
                setSyncNote(syncText(syncReport([...state.fills.values()])));
                const rowId = state.owned.get(id);
                setLog(rows => rows.map(row => (row.id === rowId ? { ...row, profit, state: profit > 0 ? 'won' : 'lost', exitDigit: state.fills.get(id)?.exitDigit ?? null } : row)));
            });

            setStatus('Waiting for the next tick…');
            await Promise.race([nextTick(market.symbol), sleep(5000)]);
            if (stopRef.current) { setStatus('Stopped before any purchase was made.'); return; }

            // Independent final guard in the execution path, immediately before anything is sent.
            assertAllowedContract(contract, barrier);
            setStatus(`Placing ${params.runs} trades together…`);
            // Every copy is bought directly from the same parameters (no shared proposal ID), all sent in one synchronous pass.
            const buyParams = {
                amount: params.stake, basis: 'stake' as const, contract_type: contract, currency, underlying_symbol: market.symbol,
                duration: params.duration, duration_unit: 't' as const, barrier: String(barrier),
            };
            const buys = Array.from({ length: params.runs }, () => PremiumDerivApiService.buyNow(buyParams, params.stake).then(bought => {
                const contractId = Math.trunc(Number(bought.contract_id));
                const rowId = (rowSeq.current += 1);
                state.owned.set(contractId, rowId);   // registered the moment the purchase is confirmed, before any update can arrive
                tallyRef.current = recordPlaced(tallyRef.current);
                setLog(rows => [...rows, { id: rowId, time: new Date().toLocaleTimeString(), label, stake: params.stake, state: 'open' as const, profit: 0 }]);
                return bought;
            }));
            const outcomes = await Promise.allSettled(buys);
            const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
            failures.forEach(failure => {
                tallyRef.current = recordFailed(tallyRef.current);
                setLog(rows => [...rows, { id: (rowSeq.current += 1), time: new Date().toLocaleTimeString(), label, stake: params.stake, state: 'failed' as const, profit: 0, note: errorText(failure.reason) }]);
            });
            setTally(tallyRef.current);
            if (failures.length) setError(`${failures.length} of ${params.runs} purchases failed: ${errorText(failures[0].reason)}`);

            // Keep monitoring every purchased contract until it really settles (or is sold early).
            const deadline = Date.now() + SETTLE_WAIT_MS;
            while (state.settled.size < state.owned.size && Date.now() < deadline && mounted.current) {
                setStatus(`Placed ${state.owned.size}/${params.runs}${failures.length ? ` (${failures.length} failed)` : ''}. Waiting for ${state.owned.size - state.settled.size} to settle…`);
                await sleep(500);
            }
            const open = state.owned.size - state.settled.size;
            if (mounted.current) {
                setSyncNote(syncText(syncReport([...state.fills.values()])));
                setStatus(open > 0
                    ? `${open} contract(s) still open. They keep being monitored by your Deriv account; check the statement.`
                    : `Done. ${state.owned.size}/${params.runs} placed${failures.length ? `, ${failures.length} failed` : ''} · P/L ${money(tallyRef.current.pnl, currency)}.`);
            }
        } catch (err) {
            if (mounted.current) { setError(errorText(err)); setStatus('Run stopped because of an error.'); }
        } finally {
            off?.();
            guard.current.end(token);
            if (mounted.current) setRunning(false);
        }
    };

    // One Stop/Exit: no further purchases; ask Deriv to sell what it will sell; keep monitoring the rest.
    const stop = async () => {
        stopRef.current = true;
        if (autoRef.current.session.armed) {
            const off = disarmSession(autoRef.current.session, 'Stopped by you.');
            autoRef.current.session = off;
            setAutoSession(off);
            setAutoNote(off.stopReason);
        }
        const state = run.current;
        if (!state) return;
        const open = [...state.owned.keys()].filter(id => !state.settled.has(id));
        if (!open.length) { setStatus('Stopping. No contracts are open.'); return; }
        setStatus(`Stopping. Asking Deriv to sell ${open.length} open contract(s)…`);
        const results = await Promise.allSettled(open.map(id => PremiumDerivApiService.sell(id)));
        const sold = results.filter(result => result.status === 'fulfilled').length;
        const remain = open.length - sold;
        if (mounted.current) {
            setStatus(remain
                ? `Exit: ${sold} sold early. ${remain} cannot be sold early and stay open until they settle (still monitored).`
                : `Exit: ${sold} contract(s) sold early.`);
        }
    };

    // A qualifying signal follows the exact same execution path as a manual Run.
    useEffect(() => {
        if (!pendingAuto) return;
        const { rec: target } = pendingAuto;
        setPendingAuto(null);
        void (async () => {
            autoBusy.current = true;
            tallyRef.current = emptyTally();
            setAutoNote(`Running ${target.label} on ${target.market}…`);
            try { await execute(target.side); } finally { autoBusy.current = false; }
            const t = tallyRef.current;
            const finished = recordAutoRun(autoRef.current.session, { placed: t.placed, failed: t.failed, pnl: t.pnl });
            autoRef.current.session = finished;
            if (!mounted.current) return;
            setAutoSession(finished);
            setAutoNote(finished.armed ? waitingNote(autoRef.current.config) : finished.stopReason);
        })();
    }, [pendingAuto]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggleAuto = () => {
        const current = autoRef.current.session;
        const onScreen = lockedRef.current
            ? refreshLocked(lockedRef.current, verdicts.current, Date.now())
            : (recRef.current && recRef.current.expiresAt >= Date.now() ? recRef.current : null);
        const next = current.armed ? disarmSession(current, 'Off.') : armSession(onScreen, autoRef.current.config.grade);
        autoRef.current.session = next;
        setAutoSession(next);
        setAutoNote(next.armed ? waitingNote(autoRef.current.config) : 'Off.');
    };
    const onAutoForm = (key: keyof AutoForm, value: string) => setAutoForm(current => ({ ...current, [key]: value }));

    return <BulkTraderView
        live={live} marketsReady={marketsReady} rec={rec} watch={watch ? { market: watch.market, label: watch.label } : null} onLoadRec={loadRecommendation}
        locked={Boolean(locked)} canLock={Boolean(offered)} onToggleLock={toggleLock}
        auto={{ armed: autoSession.armed, form: autoForm, runs: autoSession.runs, pnl: autoSession.pnl, note: autoNote, maxRuns: autoConfig.maxRuns, maxLoss: autoConfig.maxLoss, account: authData?.is_virtual ? 'DEMO' : authData?.is_virtual === false ? 'REAL' : '' }}
        onAutoToggle={toggleAuto} onAutoForm={onAutoForm}
        symbol={symbol} onSymbol={setSymbol} price={price} digit={digit} digitPct={digitPct} recent={recent}
        form={form} onForm={onForm} overBarrier={overBarrier} underBarrier={underBarrier} onOverBarrier={setOverBarrier} onUnderBarrier={setUnderBarrier}
        pickSide={pickSide} loadedNote={loadedNote} currency={currency} running={running} status={status} error={error}
        tally={tally} syncNote={syncNote} log={log} onRun={side => void execute(side)} onStop={() => void stop()} traderRef={traderRef}
    />;
};

export default BulkTraderPage;
