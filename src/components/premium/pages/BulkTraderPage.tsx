import { useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import {
    BULK_MARKETS, ENGINE_TICKS, assertAllowedContract, contractLabel, digitPercents, refreshLocked, validateRecommendation, watching,
    type OverUnderContract, type Recommendation,
} from '../over-under-engine';
import {
    DEFAULT_BULK, RunGuard, emptyTally, exitDigitFrom, exposure, limitError, recordFailed, recordPlaced, recordSettled, sanitizeBulk, settlementText,
    type Fill, type Tally,
} from '../bulk-run';
import { bulkFeed } from '../bulk-feed';
import {
    DEFAULT_AUTO, armSession, disarmSession, entrySlip, lossLimitError, modeText, newSession, planTrade, recordAutoRun, releaseRun, sanitizeAuto, signalKey, slipText,
    stakeFor, stepAuto, tickMoved, tickSymbols,
    waitingNote,
    type AutoConfig, type AutoSession,
} from '../auto-trader';
import BulkTraderView, { type AutoForm, type BulkForm, type LogRow } from './BulkTraderView';

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
const SETTLE_WAIT_MS = 90_000;
/** Deriv sometimes closes a contract before its exit tick is attached. These are the follow-up lookups (ms from settlement). */
const EXIT_LOOKUP_DELAYS_MS = [400, 1200, 2500, 4500];
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
    const [autoForm, setAutoForm] = useState<AutoForm>({
        grade: DEFAULT_AUTO.grade, cooldownSec: String(DEFAULT_AUTO.cooldownSec), maxRuns: String(DEFAULT_AUTO.maxRuns), maxLoss: String(DEFAULT_AUTO.maxLoss),
        targetProfit: String(DEFAULT_AUTO.targetProfit), entryTicks: String(DEFAULT_AUTO.entryTicks), entryWaitSec: String(DEFAULT_AUTO.entryWaitSec),
        recovery: 'off', recoveryOver: String(DEFAULT_AUTO.recoveryOver), recoveryUnder: String(DEFAULT_AUTO.recoveryUnder),
        martingale: String(DEFAULT_AUTO.martingale), maxSteps: String(DEFAULT_AUTO.maxSteps), onCap: DEFAULT_AUTO.onCap,
    });
    const [autoSession, setAutoSession] = useState<AutoSession>(newSession());
    const [autoNote, setAutoNote] = useState('Off.');
    const [pendingAuto, setPendingAuto] = useState<{ rec: Recommendation; nonce: number; decidedAt: number } | null>(null);
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

    const autoRef = useRef<{ session: AutoSession; config: AutoConfig }>({ session: newSession(), config: DEFAULT_AUTO });
    const lockedRef = useRef<Recommendation | null>(null);
    const autoBusy = useRef(false);
    const releasedRef = useRef(false);
    const applyRef = useRef<(target: Recommendation, scroll?: boolean, barrier?: number) => void>(() => undefined);
    // The deck stake when the auto trader was armed. The stake in the deck is only ever a per-run override of this value.
    const baseStakeRef = useRef(String(DEFAULT_BULK.stake));
    const formRef = useRef(form);
    const symbolRef = useRef(symbol);
    const mounted = useRef(true);
    const guard = useRef(new RunGuard());
    const stopRef = useRef(false);
    const tallyRef = useRef<Tally>(emptyTally());
    const rowSeq = useRef(0);
    const run = useRef<{ owned: Map<number, number>; settled: Set<number>; fills: Map<number, Fill>; stake: number } | null>(null);
    const traderRef = useRef<HTMLElement>(null);

    symbolRef.current = symbol;
    lockedRef.current = locked;
    formRef.current = form;
    const autoConfig = sanitizeAuto({
        grade: autoForm.grade === 'ANY' ? 'ANY' : 'EXECUTE', cooldownSec: Number(autoForm.cooldownSec), maxRuns: Number(autoForm.maxRuns), maxLoss: Number(autoForm.maxLoss),
        targetProfit: Number(autoForm.targetProfit), entryTicks: Number(autoForm.entryTicks), entryWaitSec: Number(autoForm.entryWaitSec),
        recovery: autoForm.recovery === 'on', recoveryOver: Number(autoForm.recoveryOver), recoveryUnder: Number(autoForm.recoveryUnder),
        martingale: Number(autoForm.martingale), maxSteps: Number(autoForm.maxSteps), onCap: autoForm.onCap === 'RESET' ? 'RESET' : 'STOP',
    });
    autoRef.current.config = autoConfig;
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; stopRef.current = true; };
    }, []);

    // ------------------------------------------------------------------
    // Live data + signal engine live in `bulkFeed` (app level): they keep running whatever this page does or however you
    // navigate. The page only attaches to it for rendering and for the auto trader's decisions.
    // ------------------------------------------------------------------
    useEffect(() => {
        bulkFeed.start();
        const offTick = bulkFeed.onTick(tickSymbol => { if (tickSymbol === symbolRef.current) setTickVersion(value => value + 1); });
        const offStep = bulkFeed.onStep(({ now, ready }) => {
            const next = bulkFeed.rec;
            const version = next ? `${next.id}|${next.action}|${next.score}` : '';
            setRecVersion(previous => (previous === version ? previous : version));
            // Evaluate the same live recommendation shown to the user (the locked one while locked).
            const auto = autoRef.current;
            if (auto.session.armed) {
                const held = lockedRef.current;
                const target = held ? refreshLocked(held, bulkFeed.verdicts, now) : next;
                const valid = target ? validateRecommendation(target, bulkFeed.verdicts, now, Boolean(held)).ok : false;
                // Base stake and trades per run let the loss-limit guard price the run BEFORE it is fired.
                const sized = sanitizeBulk({ stake: Number(baseStakeRef.current), runs: Number(formRef.current.runs), duration: Number(formRef.current.duration) });
                const result = stepAuto(auto.session, auto.config, {
                    target, valid, busy: guard.current.busy || autoBusy.current, now,
                    digits: target ? bulkFeed.store[target.symbol]?.digits : undefined, baseStake: sized.stake, bulkRuns: sized.runs,
                });
                const shown = result.session.armed !== auto.session.armed || result.session.runs !== auto.session.runs
                    || result.session.pnl !== auto.session.pnl || result.session.stopReason !== auto.session.stopReason
                    || result.session.lossStreak !== auto.session.lossStreak || Boolean(result.session.pending) !== Boolean(auto.session.pending);
                auto.session = result.session;
                if (shown) setAutoSession(result.session);
                setAutoNote(previous => (previous === result.note ? previous : result.note));
                if (result.fire && target && result.plan) {
                    // Same hand-off as "Load to Trading Deck" (no scrolling), with the planned digit and stake: the signal's own digit at
                    // the base stake normally, the recovery digit with a martingale stake after a loss. Both are undone after the run.
                    applyRef.current(target, false, result.plan.barrier);
                    const stake = stakeFor(sized.stake, result.plan);
                    setForm(current => ({ ...current, stake: String(stake) }));
                    // The tick the entry was confirmed on. The buy must go out before the NEXT tick prints, or the trade enters a tick late.
                    const decidedAt = bulkFeed.store[target.symbol]?.times.at(-1) ?? 0;
                    setPendingAuto({ rec: target, nonce: now, decidedAt });
                }
            }
            setMarketsReady(previous => (previous === ready ? previous : ready));
        });
        const clock = window.setInterval(() => setClock(value => value + 1), 1000);
        return () => { offTick(); offStep(); window.clearInterval(clock); };
    }, []);

    // ------------------------------------------------------------------
    // Recommendation -> Trading Deck. Loading never purchases anything.
    // ------------------------------------------------------------------
    const now = Date.now();
    const offered = bulkFeed.rec && bulkFeed.rec.expiresAt >= now ? bulkFeed.rec : null;
    const live = bulkFeed.liveCount(now) > 0;
    void recVersion;
    const rec = locked ? refreshLocked(locked, bulkFeed.verdicts, now) : offered;
    const watch = rec ? null : watching(bulkFeed.verdicts);
    const applyToDeck = (target: Recommendation, scroll = true, barrier = target.barrier) => {
        setLoaded(target); setSymbol(target.symbol);
        if (target.contract === 'DIGITOVER') setOverBarrier(String(barrier)); else setUnderBarrier(String(barrier));
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

    const entry = bulkFeed.store[symbol];
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
    const loadedCheck = loaded ? validateRecommendation(loaded, bulkFeed.verdicts, now, loadedIsLocked) : null;
    const loadedNote = !loaded
        ? 'Load the recommendation, or choose your own market and barrier. Nothing is purchased until you press Over or Under.'
        : loadedCheck && !loadedCheck.ok
            ? `Loaded ${loaded.label} on ${loaded.market} is no longer valid: ${loadedCheck.reason}`
            : `Loaded ${loaded.label} on ${loaded.market} (${loaded.action}). Press ${loaded.label} to run it. Nothing is purchased until you do.`;

    const onForm = (key: keyof BulkForm) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));

    // ------------------------------------------------------------------
    // Switch the auto trader off from inside the page (fail-safe), keeping the reason on screen.
    const haltAuto = (reason: string) => {
        const off = disarmSession(autoRef.current.session, reason);
        autoRef.current.session = off;
        setAutoSession(off);
        setAutoNote(reason);
    };

    // Fills in a settled contract's exit digit when the closing update arrived without one.
    const resolveExitDigit = async (contractId: number, rowId: number | undefined, marketSymbol: string, state: { fills: Map<number, Fill> }) => {
        let digit: number | null = null;
        let waited = 0;
        for (const delay of EXIT_LOOKUP_DELAYS_MS) {
            await sleep(delay - waited);
            waited = delay;
            const places = bulkFeed.store[marketSymbol]?.decimals ?? 2;
            try {
                const result = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId });
                digit = exitDigitFrom(result?.proposal_open_contract, places, epoch => bulkFeed.digitAt(marketSymbol, epoch));
            } catch { /* try again on the next pass; the tick history lookup below still runs */ }
            const fill = state.fills.get(contractId);
            if (digit === null && fill?.exitTime) digit = bulkFeed.digitAt(marketSymbol, fill.exitTime);
            if (digit !== null) break;
        }
        const fill = state.fills.get(contractId);
        if (fill && digit !== null) fill.exitDigit = digit;
        if (!mounted.current) return;
        setSyncNote(settlementText([...state.fills.values()]));
        setLog(rows => rows.map(row => (row.id === rowId ? { ...row, exitDigit: digit, exitFinal: true } : row)));
    };

    // One Run: all N contracts are requested and bought in the same instant, on one tick.
    // ------------------------------------------------------------------
    const execute = async (side: 0 | 1, decidedAtTick = 0) => {
        const token = guard.current.begin();          // repeated clicks / duplicate events cannot start a second run
        if (!token) return;
        const state = { owned: new Map<number, number>(), settled: new Set<number>(), fills: new Map<number, Fill>(), stake: 0 };
        let off: (() => void) | null = null;
        const lookups: Array<Promise<void>> = [];
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
                const check = validateRecommendation(loaded, bulkFeed.verdicts, Date.now(), Boolean(locked && loaded && loaded.id === locked.id));
                if (!check.ok) { setError(check.reason); return; }
            }

            const market = BULK_MARKETS.find(item => item.symbol === symbol) ?? BULK_MARKETS[0];
            const label = contractLabel(contract, barrier);

            stopRef.current = false;
            releasedRef.current = false;
            // The tick this trade was decided on (auto: the entry-confirming tick; manual: the latest tick at the click). A one-tick
            // contract enters on the first tick after Deriv gets the buy and settles on it, so the buy must go out before the NEXT tick.
            const decidedAt = decidedAtTick > 0 ? decidedAtTick : (bulkFeed.store[market.symbol]?.times.at(-1) ?? 0);
            const timingNote = () => {
                const fills = [...state.fills.values()];
                const times = bulkFeed.store[market.symbol]?.times ?? [];
                return [settlementText(fills), slipText(fills.map(fill => entrySlip(times, decidedAt, fill.entryTime)))].filter(Boolean).join(' ');
            };
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
                const places = bulkFeed.store[market.symbol]?.decimals ?? market.pip;
                // Every known exit field, then the contract's tick audit, then the market's own tick history at the exit time.
                const exitDigit = exitDigitFrom(update, places, epoch => bulkFeed.digitAt(market.symbol, epoch));
                state.fills.set(id, {
                    contractId: id, entryTime: numOrNull(update.entry_tick_time ?? update.entry_spot_time),
                    exitTime: numOrNull(update.exit_tick_time ?? update.exit_spot_time ?? update.sell_spot_time), exitDigit,
                });
                tallyRef.current = recordSettled(tallyRef.current, profit);
                if (!mounted.current) return;
                setTally(tallyRef.current);
                setSyncNote(timingNote());
                const rowId = state.owned.get(id);
                setLog(rows => rows.map(row => (row.id === rowId ? { ...row, profit, state: profit > 0 ? 'won' : 'lost', exitDigit, exitFinal: exitDigit !== null } : row)));
                // The closing update did not carry the exit tick yet: ask Deriv again (and re-read the tick history) until it shows.
                if (exitDigit === null) lookups.push(resolveExitDigit(id, rowId, market.symbol, state));
            });

            // No waiting for a tick here: the buy goes out NOW, so the contract enters on the very next tick and settles on it.
            if (stopRef.current) { setStatus('Stopped before any purchase was made.'); return; }

            // Independent final guard in the execution path, immediately before anything is sent.
            assertAllowedContract(contract, barrier);
            if (autoBusy.current) {
                // Auto runs are also checked against the session loss limit here, with the stake and trades that are about to be bought.
                const breach = lossLimitError(autoRef.current.session, autoRef.current.config, exposure(params));
                if (breach) { haltAuto(breach); setError(breach); setStatus('Run stopped: it could pass the session loss limit. Nothing was purchased.'); return; }
            }
            if (autoBusy.current && tickMoved(bulkFeed.store[market.symbol]?.times ?? [], decidedAt)) {
                // A newer tick printed since the entry was confirmed: this buy would enter a tick late, on a digit nobody checked.
                releasedRef.current = true;
                setStatus('A new tick printed before the buy was sent. Nothing was purchased. Re-checking the entry.');
                return;
            }
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
            await Promise.allSettled(lookups);   // every settlement digit is in before the run is reported as done
            const open = state.owned.size - state.settled.size;
            if (mounted.current) {
                setSyncNote(timingNote());
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
        const { rec: target, decidedAt } = pendingAuto;
        setPendingAuto(null);
        void (async () => {
            autoBusy.current = true;
            try {
                if (!autoRef.current.session.armed) return;          // disarmed after the decision was made: nothing is purchased
                tallyRef.current = emptyTally();
                setAutoNote(`Running ${target.label} on ${target.market}…`);
                await execute(target.side, decidedAt);
                if (releasedRef.current) {
                    // Cancelled before any purchase because the entry tick moved on: give the run back and re-check the entry.
                    const notice = 'The entry tick moved on before the buy was sent. Re-checking the entry on the newest ticks.';
                    const back = releaseRun(autoRef.current.session, signalKey(target), Date.now(), notice);
                    autoRef.current.session = back;
                    if (mounted.current) { setAutoSession(back); setAutoNote(notice); }
                    return;
                }
                const t = tallyRef.current;
                const finished = recordAutoRun(
                    autoRef.current.session,
                    { placed: t.placed, failed: t.failed, pnl: t.pnl, unsettled: Math.max(0, t.placed - t.settled) },
                    autoRef.current.config,
                );
                autoRef.current.session = finished;
                if (!mounted.current) return;
                setAutoSession(finished);
                setAutoNote(finished.armed ? waitingNote(autoRef.current.config) : finished.stopReason);
            } catch (err) {
                if (mounted.current) haltAuto(`Stopped: ${errorText(err)}`);
            } finally {
                autoBusy.current = false;
                // The martingale stake and the recovery digit apply to this one run only. Whatever happened (success, rejected purchase,
                // thrown error, early return) the deck goes back to the base stake and the signal's own digit, so nothing leaks into the
                // next trade. The streak that drives the NEXT recovery step lives in the session, so it is untouched.
                if (mounted.current) {
                    setForm(current => ({ ...current, stake: baseStakeRef.current }));
                    if (target.contract === 'DIGITOVER') setOverBarrier(String(target.barrier)); else setUnderBarrier(String(target.barrier));
                }
            }
        })();
    }, [pendingAuto]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggleAuto = () => {
        const current = autoRef.current.session;
        const onScreen = lockedRef.current
            ? refreshLocked(lockedRef.current, bulkFeed.verdicts, Date.now())
            : (bulkFeed.rec && bulkFeed.rec.expiresAt >= Date.now() ? bulkFeed.rec : null);
        if (!current.armed && (autoBusy.current || guard.current.busy)) { setAutoNote('A run is in progress. Arm the auto trader when it has finished.'); return; }
        if (!current.armed) baseStakeRef.current = form.stake;          // the deck stake at arming is the base stake
        const next = current.armed ? disarmSession(current, 'Off.') : armSession(onScreen, autoRef.current.config.grade);
        autoRef.current.session = next;
        setAutoSession(next);
        setAutoNote(next.armed ? waitingNote(autoRef.current.config) : 'Off.');
    };
    const onAutoForm = (key: keyof AutoForm, value: string) => setAutoForm(current => ({ ...current, [key]: value }));

    // What the auto trader would do next, shown in the panel.
    const watched = autoSession.armed ? (locked ? refreshLocked(locked, bulkFeed.verdicts, now) : offered) : null;
    const nextPlan = watched ? planTrade(watched, autoSession.lossStreak, autoConfig) : null;
    const baseStake = sanitizeBulk({ stake: Number(autoSession.armed ? baseStakeRef.current : form.stake) }).stake;
    const entryView = nextPlan && autoConfig.entryTicks > 0 && watched
        ? {
            need: autoConfig.entryTicks, want: nextPlan.contract === 'DIGITOVER' ? 'O' : 'U', waiting: Boolean(autoSession.pending),
            symbols: tickSymbols(bulkFeed.store[watched.symbol]?.digits ?? [], nextPlan.barrier, Math.max(autoConfig.entryTicks, 6)),
        }
        : null;


    return <BulkTraderView
        live={live} marketsReady={marketsReady} rec={rec} watch={watch ? { market: watch.market, label: watch.label } : null} onLoadRec={loadRecommendation}
        locked={Boolean(locked)} canLock={Boolean(offered)} onToggleLock={toggleLock}
        auto={{
            armed: autoSession.armed, form: autoForm, runs: autoSession.runs, pnl: autoSession.pnl, note: autoNote, maxRuns: autoConfig.maxRuns, maxLoss: autoConfig.maxLoss,
            targetProfit: autoConfig.targetProfit, account: authData?.is_virtual === 1 ? 'DEMO' : authData?.is_virtual === 0 ? 'REAL' : '', mode: modeText(autoSession, autoConfig),
            recovery: autoConfig.recovery, entry: entryView,
            next: nextPlan ? `${nextPlan.label} at ${stakeFor(baseStake, nextPlan).toFixed(2)} ${currency}${nextPlan.recovery ? ` (recovery step ${nextPlan.step})` : ''}` : '',
        }}
        onAutoToggle={toggleAuto} onAutoForm={onAutoForm}
        symbol={symbol} onSymbol={setSymbol} price={price} digit={digit} digitPct={digitPct} recent={recent}
        form={form} onForm={onForm} overBarrier={overBarrier} underBarrier={underBarrier} onOverBarrier={setOverBarrier} onUnderBarrier={setUnderBarrier}
        pickSide={pickSide} loadedNote={loadedNote} currency={currency} running={running} status={status} error={error}
        tally={tally} syncNote={syncNote} log={log} onRun={side => void execute(side)} onStop={() => void stop()} traderRef={traderRef}
    />;
};

export default BulkTraderPage;
