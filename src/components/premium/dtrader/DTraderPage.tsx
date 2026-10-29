import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import { bulkFeed } from '../bulk-feed';
import { tickIntervalMs } from '../burst-pace';
import { BULK_MARKETS } from '../over-under-engine';
import { pairOutcome } from './dtrader-catalog';
import { hedgeStats, type PickRow, pickTable, recentPickOdds } from './dtrader-hedge';
import {
decimalsText, describeEntry,     DIGIT_OPS, type DigitOp, digitStats, type EntryRule, FAMILIES, type Family, FAMILY_ORDER, legsFor, offsetError, opNeedsDigit, parseSequence, predictionError,
type SideChoice,
    tickPickError, toCandles, } from './dtrader-engine';
import { preflightContract, type PreflightDeps } from './dtrader-preflight';
import {
configError,     DTraderRunner, emptyTotals, type RunConfig, type RunnerEvent, type RunnerIO, type RunnerState, type Totals, type TradeRow,
} from './dtrader-runner';
import { backtest, backtestText, defaultStrategyId, getStrategy, paramDefaults, resolveParams, sigmaOffset, strategiesFor, type StrategyParams } from './dtrader-strategies';
import './dtrader.scss';

// ---------------------------------------------------------------------------------------------------------------------
// Settings (kept in the browser so the page comes back the way it was left)
// ---------------------------------------------------------------------------------------------------------------------

type EntryMode = 'instant' | 'digit' | 'pattern';
type Form = {
    symbol: string; family: Family; side: SideChoice; prediction: string; /** Low Tick's own tick for the High/Low Tick hedge ('' = same as High Tick's). */ pick2: string; offset: string; duration: string; stake: string; trades: string; martingale: string;
    takeProfit: string; stopLoss: string; mode: 'single' | 'repeat'; entryMode: EntryMode;
    digitOp: DigitOp; digitValue: string;
    patternKind: 'last' | 'sequence'; lastCount: string; lastOp: DigitOp; lastDigit: string; seqText: string; fireAfter: string;
    guard: boolean; chart: 'line' | 'candles'; digitsView: 'default' | 'digits'; candleSize: string; window: string;
    /** Strategy id for the Auto side ('' = the family's standard one) and its settings, kept per strategy. */
    strategy: string; strategyParams: Record<string, Record<string, string>>;
};

const DEFAULT_FORM: Form = {
    symbol: '1HZ100V', family: 'overunder', side: 'second', prediction: '8', pick2: '', offset: '0.5', duration: '1', stake: '1', trades: '1', martingale: '1',
    takeProfit: '', stopLoss: '', mode: 'repeat', entryMode: 'instant', digitOp: '=', digitValue: '2',
    patternKind: 'sequence', lastCount: '2', lastOp: '>=', lastDigit: '9', seqText: '1 2 5', fireAfter: '',
    guard: true, chart: 'line', digitsView: 'default', candleSize: '5', window: '1000', strategy: '', strategyParams: {},
};
const STORAGE_KEY = 'dtrader_form_v1';

const loadForm = (): Form => {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        const saved = raw ? (JSON.parse(raw) as Partial<Form>) : {};
        const merged = { ...DEFAULT_FORM, ...saved };
        return BULK_MARKETS.some(m => m.symbol === merged.symbol) && FAMILIES[merged.family] ? merged : DEFAULT_FORM;
    } catch { return DEFAULT_FORM; }
};
const saveForm = (form: Form) => {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(form)); } catch { /* storage unavailable: settings last for this visit */ }
};

/** Contract length in ticks: fixed for the contracts Deriv offers at one length only (High Tick / Low Tick), else what was typed. */
const ticksFor = (form: Pick<Form, 'family' | 'duration'>) => FAMILIES[form.family].fixedTicks ?? toNumber(form.duration, 1);
/** The Low Tick trade's own tick, only when it is a High + Low Tick pair and a different tick was typed. */
const hedgePick2 = (form: Pick<Form, 'family' | 'side' | 'pick2'>): number | undefined =>
    FAMILIES[form.family].needsTick && form.side === 'both' && form.pick2.trim() !== '' ? toNumber(form.pick2, NaN) : undefined;
const toNumber = (value: string, fallback = NaN) => { const n = Number(value); return value.trim() !== '' && Number.isFinite(n) ? n : fallback; };
const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : (error as { message?: string })?.message || String(error));

/** The strategy Auto will use: the chosen one if it suits the contract, else the contract's standard one. */
const activeStrategyId = (form: Pick<Form, 'family' | 'strategy'>): string => {
    const chosen = getStrategy(form.strategy);
    return chosen && chosen.families.includes(form.family) ? chosen.id : defaultStrategyId(form.family);
};
/** Typed settings of the active strategy, clamped to their allowed ranges. */
const numericParams = (form: Pick<Form, 'family' | 'strategy' | 'strategyParams'>): StrategyParams => {
    const strategy = getStrategy(activeStrategyId(form))!;
    const saved = form.strategyParams[strategy.id] ?? {};
    return resolveParams(strategy, Object.fromEntries(Object.entries(saved).map(([key, value]) => [key, Number(value)])));
};

/** The form -> a run configuration, or the reason it is not ready. */
export const buildRun = (form: Form, currency: string): { config: RunConfig } | { error: string } => {
    let entry: EntryRule;
    if (form.entryMode === 'instant') entry = { mode: 'instant' };
    else if (form.entryMode === 'digit') entry = { mode: 'digit', op: form.digitOp, digit: toNumber(form.digitValue, 0) };
    else if (form.patternKind === 'last') entry = { mode: 'pattern', pattern: { kind: 'last', count: toNumber(form.lastCount, 0), op: form.lastOp, digit: toNumber(form.lastDigit, 0) } };
    else {
        const digits = parseSequence(form.seqText);
        if (!digits) return { error: 'Type the pattern as single digits, for example 1 2 5.' };
        entry = { mode: 'pattern', pattern: { kind: 'sequence', digits, fireAfter: toNumber(form.fireAfter, digits.length) } };
    }
    const config: RunConfig = {
        symbol: form.symbol, family: form.family, side: form.side, prediction: toNumber(form.prediction, 0), ...(hedgePick2(form) !== undefined ? { prediction2: hedgePick2(form) } : {}), offset: toNumber(form.offset, 0), duration: ticksFor(form),
        stake: toNumber(form.stake, 0), tradesPerEntry: toNumber(form.trades, 1), martingale: toNumber(form.martingale, 1),
        takeProfit: Math.max(0, toNumber(form.takeProfit, 0)), stopLoss: Math.max(0, toNumber(form.stopLoss, 0)),
        mode: form.mode, entry, sameTickGuard: form.guard, currency,
        ...(form.side === 'auto' ? { strategy: { id: activeStrategyId(form), params: numericParams(form) } } : {}),
    };
    const error = configError(config);
    return error ? { error } : { config };
};

// ---------------------------------------------------------------------------------------------------------------------
// Live market data (the app-wide feed, so nothing new is subscribed and nothing is lost when you leave the tab)
// ---------------------------------------------------------------------------------------------------------------------

const useLiveMarket = (symbol: string) => {
    const [, bump] = useState(0);
    useEffect(() => {
        bulkFeed.start();
        let frame = 0;
        const off = bulkFeed.onTick(changed => {
            if (changed !== symbol || frame) return;
            frame = window.requestAnimationFrame(() => { frame = 0; bump(n => n + 1); });
        });
        const timer = window.setInterval(() => bump(n => n + 1), 2000);
        return () => { off(); window.clearInterval(timer); if (frame) window.cancelAnimationFrame(frame); };
    }, [symbol]);
    return bulkFeed.store[symbol];
};

const preflightDeps: PreflightDeps = {
    contractsFor: symbol => PremiumDerivApiService.contractsFor(symbol),
    proposal: parameters => PremiumDerivApiService.proposal(parameters),
};

const makeIO = (): RunnerIO => ({
    now: () => Date.now(),
    market: symbol => bulkFeed.store[symbol],
    onTick: listener => bulkFeed.onTick(listener),
    buy: (params, price) => PremiumDerivApiService.buyNow(params, price),
    onContractUpdate: listener => PremiumDerivApiService.onContractUpdate(listener),
    isClosed: contract => PremiumDerivApiService.isContractClosed(contract),
    digitAt: (symbol, epoch) => bulkFeed.digitAt(symbol, epoch),
    sleep: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
    preflight: input => preflightContract(preflightDeps, input),
    lookupContract: async id => (await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: id })).proposal_open_contract,
});

// ---------------------------------------------------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------------------------------------------------

const W = 1000;
const H = 430;
const PAD = { left: 12, right: 78, top: 18, bottom: 30 };

const Chart = ({ prices, times, decimals, mode, candleSize }: { prices: number[]; times: number[]; decimals: number; mode: 'line' | 'candles'; candleSize: number }) => {
    const view = useMemo(() => {
        if (prices.length < 2) return null;
        if (mode === 'candles') {
            const candles = toCandles(prices.slice(-candleSize * 60), times.slice(-candleSize * 60), candleSize).slice(-60);
            return { kind: 'candles' as const, candles, lows: candles.map(c => c.low), highs: candles.map(c => c.high), stamps: candles.map(c => c.time) };
        }
        const p = prices.slice(-120);
        return { kind: 'line' as const, points: p, lows: p, highs: p, stamps: times.slice(-120) };
    }, [prices.length ? prices[prices.length - 1] : 0, prices.length, mode, candleSize]);  // eslint-disable-line react-hooks/exhaustive-deps

    if (!view) return <div className='dt-chart-empty'>Waiting for live ticks…</div>;
    const lo = Math.min(...view.lows);
    const hi = Math.max(...view.highs);
    const span = hi - lo || 1;
    const min = lo - span * 0.12;
    const max = hi + span * 0.12;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const y = (value: number) => PAD.top + (1 - (value - min) / (max - min)) * innerH;
    const count = view.kind === 'line' ? view.points.length : view.candles.length;
    const x = (i: number) => PAD.left + (count <= 1 ? innerW : (i / (count - 1)) * innerW);
    const last = prices[prices.length - 1];
    const gridValues = [0, 1, 2, 3, 4].map(i => min + ((max - min) * i) / 4);
    const stampIdx = [0, 0.33, 0.66, 1].map(f => Math.min(count - 1, Math.round(f * (count - 1))));
    const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

    return (
        <svg className='dt-chart' viewBox={`0 0 ${W} ${H}`} role='img' aria-label='Live price chart'>
            {gridValues.map(value => (
                <g key={value}>
                    <line x1={PAD.left} x2={W - PAD.right} y1={y(value)} y2={y(value)} className='dt-grid' />
                    <text x={W - PAD.right + 8} y={y(value) + 4} className='dt-axis'>{decimalsText(value, decimals)}</text>
                </g>
            ))}
            {stampIdx.map(i => <text key={i} x={x(i)} y={H - 8} className='dt-axis' textAnchor='middle'>{clock(view.stamps[i])}</text>)}
            {view.kind === 'line' ? (
                <>
                    <path d={`M${x(0)},${H - PAD.bottom} ${view.points.map((p, i) => `L${x(i)},${y(p)}`).join(' ')} L${x(count - 1)},${H - PAD.bottom} Z`} className='dt-area' />
                    <polyline points={view.points.map((p, i) => `${x(i)},${y(p)}`).join(' ')} className='dt-line' />
                </>
            ) : (
                view.candles.map((c, i) => {
                    const up = c.close >= c.open;
                    const width = Math.max(3, (innerW / Math.max(count, 1)) * 0.6);
                    return (
                        <g key={c.time} className={up ? 'dt-up' : 'dt-down'}>
                            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} />
                            <rect x={x(i) - width / 2} y={Math.min(y(c.open), y(c.close))} width={width} height={Math.max(1.5, Math.abs(y(c.open) - y(c.close)))} />
                        </g>
                    );
                })
            )}
            <line x1={PAD.left} x2={W - PAD.right} y1={y(last)} y2={y(last)} className='dt-last-line' />
            <circle cx={x(count - 1)} cy={y(last)} r={5} className='dt-last-dot' />
            <rect x={W - PAD.right + 2} y={y(last) - 13} width={PAD.right - 4} height={26} rx={4} className='dt-last-tag' />
            <text x={W - PAD.right + PAD.right / 2} y={y(last) + 5} textAnchor='middle' className='dt-last-text'>{decimalsText(last, decimals)}</text>
        </svg>
    );
};

// ---------------------------------------------------------------------------------------------------------------------
// Digit circles
// ---------------------------------------------------------------------------------------------------------------------

const DigitCircles = ({ digits, window, view, current }: { digits: number[]; window: number; view: 'default' | 'digits'; current: number | null }) => {
    const stats = useMemo(() => digitStats(digits, window), [digits.length, window, digits.length ? digits[digits.length - 1] : -1]);  // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <div className={`dt-digits dt-digits--${view}`} aria-label={`Last digit frequency over ${stats.total} ticks`}>
            {Array.from({ length: 10 }, (_, digit) => {
                const pct = stats.pct[digit];
                const tone = digit === stats.most ? 'most' : digit === stats.least ? 'least' : pct >= 10 ? 'above' : 'below';
                const arc = Math.min(1, pct / 20);
                return (
                    <div key={digit} className={`dt-digit dt-digit--${tone} ${current === digit ? 'is-current' : ''}`} title={`${digit}: ${pct}% of the last ${stats.total} ticks`}>
                        <svg viewBox='0 0 44 44' aria-hidden='true'>
                            <circle cx='22' cy='22' r='19' className='dt-ring-bg' />
                            <circle cx='22' cy='22' r='19' className='dt-ring' strokeDasharray={`${arc * 119.4} 119.4`} transform='rotate(-90 22 22)' />
                        </svg>
                        <b>{digit}</b><span>{pct.toFixed(1)}%</span>
                        {current === digit && <i className='dt-marker' />}
                    </div>
                );
            })}
        </div>
    );
};

// ---------------------------------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------------------------------

type JournalLine = { id: number; time: string; text: string; level: 'info' | 'warn' | 'error' | 'success' };
type SideTab = 'summary' | 'transactions' | 'journal';

const stateLabel: Record<RunnerState, string> = { idle: 'Not running', waiting: 'Waiting for entry', placing: 'Placing trades', settling: 'Settling', stopping: 'Stopping' };

const DTraderPage = () => {
    const { authData, isAuthorized } = useApiBase();
    const currency = authData?.currency || 'USD';
    const [form, setForm] = useState<Form>(loadForm);
    const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
    useEffect(() => saveForm(form), [form]);

    const [runState, setRunState] = useState<RunnerState>('idle');
    const [note, setNote] = useState('Bot is not running.');
    const [rows, setRows] = useState<TradeRow[]>([]);
    const [totals, setTotals] = useState<Totals>(emptyTotals());
    const [journal, setJournal] = useState<JournalLine[]>([]);
    const [sync, setSync] = useState<{ text: string; ok: boolean | null } | null>(null);
    const [tab, setTab] = useState<SideTab>('summary');
    const [error, setError] = useState('');
    const lineSeq = useRef(0);

    const onEvent = useCallback((event: RunnerEvent) => {
        switch (event.type) {
            case 'state': setRunState(event.state); setNote(event.note); break;
            case 'journal': setJournal(lines => [{ id: (lineSeq.current += 1), time: new Date().toLocaleTimeString(), text: event.text, level: event.level }, ...lines].slice(0, 300)); break;
            case 'trade': setRows(current => (current.some(r => r.id === event.row.id) ? current.map(r => (r.id === event.row.id ? event.row : r)) : [event.row, ...current].slice(0, 500))); break;
            case 'totals': setTotals(event.totals); break;
            case 'sync': setSync({ text: event.text, ok: event.ok }); break;
            default: break;
        }
    }, []);
    const runner = useMemo(() => new DTraderRunner(makeIO(), onEvent), [onEvent]);
    useEffect(() => () => runner.stop(), [runner]);

    const market = useLiveMarket(form.symbol);
    const marketInfo = BULK_MARKETS.find(m => m.symbol === form.symbol) ?? BULK_MARKETS[0];
    const decimals = market?.decimals ?? marketInfo.pip;
    const lastPrice = market?.prices.length ? market.prices[market.prices.length - 1] : null;
    const prevPrice = market && market.prices.length > 1 ? market.prices[market.prices.length - 2] : null;
    const change = lastPrice !== null && prevPrice !== null ? lastPrice - prevPrice : 0;
    const currentDigit = market?.digits.length ? market.digits[market.digits.length - 1] : null;

    const running = runState !== 'idle';
    const family = FAMILIES[form.family];
    const prepared = useMemo(() => buildRun(form, currency), [form, currency]);
    const predictionIssue = predictionError(form.family, form.side === 'auto' ? 'both' : form.side, toNumber(form.prediction, 0)) ?? tickPickError(form.family, toNumber(form.prediction, 0)) ?? (hedgePick2(form) !== undefined ? tickPickError(form.family, hedgePick2(form)!) : null);
    const offsetIssue = offsetError(form.family, toNumber(form.offset, 0));

    // Real payout from Deriv for the chosen contract(s), refreshed when the contract setup changes.
    const [payouts, setPayouts] = useState<Array<{ label: string; payout: string }>>([]);
    const [quoteError, setQuoteError] = useState('');
    const [preflightNotes, setPreflightNotes] = useState<string[]>([]);
    useEffect(() => {
        const stake = toNumber(form.stake, 0);
        const duration = ticksFor(form);
        const side = form.side === 'auto' ? 'first' : form.side;
        if (!(stake > 0) || !Number.isInteger(duration) || duration < 1) { setPayouts([]); return undefined; }
        let alive = true;
        const timer = window.setTimeout(async () => {
            try {
                if (FAMILIES[form.family].needsOffset) {
                    // Higher/Lower and Ends Between/Outside only accept the durations and barriers Deriv lists for the market, so the
                    // panel asks Deriv (quotes only, nothing is bought) and shows what it will really use.
                    const feed = bulkFeed.store[form.symbol];
                    const interval = tickIntervalMs(feed?.times ?? []);
                    const checked = await preflightContract(preflightDeps, {
                        symbol: form.symbol, family: form.family, side: form.side, prediction: toNumber(form.prediction, 0), offset: toNumber(form.offset, 0),
                        ticks: duration, stake, currency, decimals, tickSeconds: interval ? interval / 1000 : 1,
                        volatilityOffset: feed && feed.prices.length > 20 ? sigmaOffset(feed.prices, duration, 1, decimals) : undefined,
                    });
                    if (!alive) return;
                    if (checked.ok) { setPreflightNotes(checked.notes); setPayouts(checked.quotes.map(q => ({ label: q.label, payout: q.payout.toFixed(2) }))); setQuoteError(''); }
                    else { setPreflightNotes([]); setPayouts([]); setQuoteError(checked.error); }
                    return;
                }
                setPreflightNotes([]);
                const legs = legsFor(form.family, side, toNumber(form.prediction, 0), toNumber(form.offset, 0), undefined, hedgePick2(form)).filter(() => !predictionIssue && !offsetIssue);
                const quotes = await Promise.all(legs.map(async leg => {
                    const proposal = await PremiumDerivApiService.proposal({
                        amount: stake, basis: 'stake', contract_type: leg.contract, currency, underlying_symbol: form.symbol, duration, duration_unit: 't', ...(leg.barrier !== undefined ? { barrier: leg.barrier } : {}), ...(leg.barrier2 !== undefined ? { barrier2: leg.barrier2 } : {}), ...(leg.selectedTick !== undefined ? { selected_tick: leg.selectedTick } : {}),
                    });
                    return { label: leg.label, payout: Number(proposal.payout).toFixed(2) };
                }));
                if (alive) { setPayouts(quotes); setQuoteError(''); }
            } catch (err) { if (alive) { setPayouts([]); setQuoteError(errorText(err)); } }
        }, 800);
        return () => { alive = false; window.clearTimeout(timer); };
    }, [form.family, form.side, form.prediction, form.pick2, form.offset, form.stake, form.duration, form.symbol, currency, predictionIssue, offsetIssue]);

    // Auto: the strategy in use, its settings, and how it would have scored on the recent past.
    const strategyList = strategiesFor(form.family);
    const activeStrategy = getStrategy(activeStrategyId(form))!;
    const strategyValues = numericParams(form);
    const strategyKey = JSON.stringify(strategyValues);
    const [score, setScore] = useState('');
    const feedBucket = Math.floor((market?.digits.length ?? 0) / 25);
    useEffect(() => {
        if (form.side !== 'auto' || !market || market.digits.length < 80) { setScore(''); return undefined; }
        const timer = window.setTimeout(() => {
            const result = backtest(
                activeStrategy,
                { family: form.family, prediction: toNumber(form.prediction, 0), offset: toNumber(form.offset, 0.5), ticks: Math.max(1, ticksFor(form)), decimals },
                market.digits, market.prices, strategyValues, { limit: 600 },
            );
            setScore(backtestText(result));
        }, 400);
        return () => window.clearTimeout(timer);
    }, [form.side, form.family, form.prediction, form.offset, form.duration, form.symbol, activeStrategy.id, strategyKey, feedBucket, decimals]);  // eslint-disable-line react-hooks/exhaustive-deps

    // High Tick / Low Tick hedge: what the pair really does at the quoted payouts, and a per-tick table on request.
    const hedge = form.family === 'tickhighlow' && form.side === 'both' && payouts.length === 2 && !predictionIssue
        ? hedgeStats({
            stake: toNumber(form.stake, 0), highPick: toNumber(form.prediction, 0), lowPick: hedgePick2(form) ?? toNumber(form.prediction, 0),
            highPayout: Number(payouts[0].payout), lowPayout: Number(payouts[1].payout),
        })
        : null;
    const [tickRows, setTickRows] = useState<PickRow[] | null>(null);
    const [tickRowsBusy, setTickRowsBusy] = useState(false);
    const [tickRowsError, setTickRowsError] = useState('');
    const quoteAllTicks = async () => {
        const stake = toNumber(form.stake, 0);
        if (!(stake > 0)) { setTickRowsError('Enter a stake first.'); return; }
        setTickRowsBusy(true); setTickRowsError('');
        try {
            const ask = async (contract: string, pick: number) => {
                try {
                    const q = await PremiumDerivApiService.proposal({ amount: stake, basis: 'stake', contract_type: contract, currency, underlying_symbol: form.symbol, duration: 5, duration_unit: 't', selected_tick: pick });
                    const payout = Number(q.payout);
                    return Number.isFinite(payout) ? payout : null;
                } catch { return null; }
            };
            const quotes = await Promise.all([1, 2, 3, 4, 5].map(async pick => ({ high: await ask('TICKHIGH', pick), low: await ask('TICKLOW', pick) })));
            if (quotes.every(q => q.high === null && q.low === null)) setTickRowsError('Deriv did not return a quote for any tick. Check you are logged in and the market is open.');
            setTickRows(pickTable(stake, quotes, recentPickOdds(bulkFeed.store[form.symbol]?.prices ?? [])));
        } finally { setTickRowsBusy(false); }
    };

    const pair = form.side === 'both' && form.family !== 'tickhighlow' && payouts.length === 2
        ? pairOutcome(toNumber(form.stake, 0), Number(payouts[0].payout), Number(payouts[1].payout), !['matchesdiffers', 'evenodd'].includes(form.family))
        : null;

    const start = (override?: Partial<Form>) => {
        setError('');
        if (!isAuthorized) { setError('Log in to a Deriv account to trade.'); return; }
        const built = buildRun({ ...form, ...override }, currency);
        if ('error' in built) { setError(built.error); return; }
        void runner.run(built.config);
    };
    const reset = () => { runner.resetTotals(); setRows([]); setSync(null); setError(''); setNote('Bot is not running.'); };

    const win = Number(form.window);
    const seqDigits = parseSequence(form.seqText);
    const fireOptions = seqDigits ? seqDigits.map((_, i) => i + 1) : [];
    const planned = 'config' in prepared ? prepared.config : null;
    const totalPerEntry = planned ? planned.tradesPerEntry * (planned.side === 'both' ? 2 : 1) : 0;

    return (
        <div className='dt'>
            <div className='dt-main'>
                {/* ------------------------------ chart + digits ------------------------------ */}
                <section className='dt-chartcard'>
                    <div className='dt-toolbar'>
                        <div className='dt-seg' role='group' aria-label='Digit style'>
                            <button type='button' className={form.digitsView === 'default' ? 'on' : ''} onClick={() => set('digitsView', 'default')}>Default</button>
                            <button type='button' className={form.digitsView === 'digits' ? 'on' : ''} onClick={() => set('digitsView', 'digits')}>Digits</button>
                        </div>
                        <div className='dt-seg' role='group' aria-label='Chart type'>
                            <button type='button' className={form.chart === 'line' ? 'on' : ''} onClick={() => set('chart', 'line')}>Line</button>
                            <button type='button' className={form.chart === 'candles' ? 'on' : ''} onClick={() => set('chart', 'candles')}>Candles</button>
                        </div>
                        {form.chart === 'candles' && (
                            <label className='dt-mini'>Candle<select value={form.candleSize} onChange={e => set('candleSize', e.target.value)}>
                                {[1, 2, 5, 10, 30].map(n => <option key={n} value={n}>{n} tick{n > 1 ? 's' : ''}</option>)}
                            </select></label>
                        )}
                        <label className='dt-mini'>Digit window<select value={form.window} onChange={e => set('window', e.target.value)}>
                            {[100, 300, 1000].map(n => <option key={n} value={n}>{n} ticks</option>)}
                        </select></label>
                    </div>
                    <div className='dt-market'>
                        <select value={form.symbol} disabled={running} onChange={e => set('symbol', e.target.value)} aria-label='Market'>
                            {BULK_MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.name} Index</option>)}
                        </select>
                        <div className='dt-quote'>
                            <b>{lastPrice === null ? '—' : decimalsText(lastPrice, decimals)}</b>
                            <span className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(decimals)}</span>
                        </div>
                    </div>
                    <div className='dt-chartbox'>
                        <Chart prices={market?.prices ?? []} times={market?.times ?? []} decimals={decimals} mode={form.chart} candleSize={Number(form.candleSize)} />
                        <DigitCircles digits={market?.digits ?? []} window={win} view={form.digitsView} current={currentDigit} />
                    </div>
                </section>

                {/* ------------------------------ trade panel ------------------------------ */}
                <section className='dt-panel' aria-label='Trade setup'>
                    <label className='dt-field dt-field--wide'>Contract
                        <select value={form.family} disabled={running} onChange={e => {
                            const f = e.target.value as Family;
                            setForm(current => ({ ...current, family: f, ...(FAMILIES[f].needsTick && tickPickError(f, Number(current.prediction)) ? { prediction: String(FAMILIES[f].fixedTicks ?? 5) } : {}) }));
                        }}>
                            {FAMILY_ORDER.map(f => <option key={f} value={f}>{FAMILIES[f].title}</option>)}
                        </select>
                    </label>

                    <div className='dt-row'>
                        <label className='dt-field'>Ticks<input inputMode='numeric' value={family.fixedTicks ?? form.duration} disabled={running || family.fixedTicks !== undefined} title={family.fixedTicks !== undefined ? `${family.title} always runs ${family.fixedTicks} ticks.` : undefined} onChange={e => set('duration', e.target.value)} /></label>
                        <label className='dt-field'>Entry
                            <select value={form.entryMode} disabled={running} onChange={e => set('entryMode', e.target.value as EntryMode)}>
                                <option value='instant'>Instant</option><option value='digit'>Digit</option><option value='pattern'>Pattern</option>
                            </select>
                        </label>
                    </div>

                    {form.entryMode === 'digit' && (
                        <div className='dt-row'>
                            <label className='dt-field'>Last digit
                                <select value={form.digitOp} disabled={running} onChange={e => set('digitOp', e.target.value as DigitOp)}>{DIGIT_OPS.filter(o => o.value !== 'same').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                            </label>
                            {opNeedsDigit(form.digitOp) && <label className='dt-field'>Digit<input inputMode='numeric' value={form.digitValue} disabled={running} onChange={e => set('digitValue', e.target.value)} /></label>}
                        </div>
                    )}

                    {form.entryMode === 'pattern' && (
                        <div className='dt-pattern'>
                            <div className='dt-seg dt-seg--small' role='group' aria-label='Pattern type'>
                                <button type='button' className={form.patternKind === 'sequence' ? 'on' : ''} disabled={running} onClick={() => set('patternKind', 'sequence')}>Digit sequence</button>
                                <button type='button' className={form.patternKind === 'last' ? 'on' : ''} disabled={running} onClick={() => set('patternKind', 'last')}>Last N digits</button>
                            </div>
                            {form.patternKind === 'sequence' ? (
                                <div className='dt-row'>
                                    <label className='dt-field'>Pattern<input value={form.seqText} disabled={running} placeholder='1 2 5' onChange={e => set('seqText', e.target.value)} /></label>
                                    <label className='dt-field'>Buy after step
                                        <select value={form.fireAfter || String(fireOptions.length || 1)} disabled={running || !seqDigits} onChange={e => set('fireAfter', e.target.value)}>
                                            {fireOptions.map(n => <option key={n} value={n}>{n} ({seqDigits![n - 1]})</option>)}
                                        </select>
                                    </label>
                                </div>
                            ) : (
                                <div className='dt-row dt-row--3'>
                                    <label className='dt-field'>Last<input inputMode='numeric' value={form.lastCount} disabled={running} onChange={e => set('lastCount', e.target.value)} /></label>
                                    <label className='dt-field'>Digits<select value={form.lastOp} disabled={running} onChange={e => set('lastOp', e.target.value as DigitOp)}>{DIGIT_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
                                    {opNeedsDigit(form.lastOp) && <label className='dt-field'>Digit<input inputMode='numeric' value={form.lastDigit} disabled={running} onChange={e => set('lastDigit', e.target.value)} /></label>}
                                </div>
                            )}
                        </div>
                    )}
                    {planned && <p className='dt-hint'>{describeEntry(planned.entry)}.</p>}

                    <div className='dt-sides' role='group' aria-label='Side'>
                        {([['first', family.sides[0]], ['second', family.sides[1]], ['both', 'Both'], ['auto', 'Auto']] as Array<[SideChoice, string]>)
                            .map(([value, label]) => (
                                <button key={value} type='button' disabled={running} className={`dt-side dt-side--${value} ${form.side === value ? 'on' : ''}`} onClick={() => set('side', value)}>
                                    {label}{value === 'both' && <small>{family.sides[0]} + {family.sides[1]}</small>}{value === 'auto' && <small>Strategy</small>}
                                </button>
                            ))}
                    </div>
                    {form.side === 'auto' && (
                        <div className='dt-strategy'>
                            <label className='dt-field dt-field--wide'>Strategy
                                <select value={activeStrategy.id} disabled={running} onChange={e => set('strategy', e.target.value)}>
                                    {strategyList.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                                </select>
                            </label>
                            <p className='dt-hint'>{activeStrategy.summary}</p>
                            {activeStrategy.params.length > 0 && (
                                <div className='dt-row dt-row--params'>
                                    {activeStrategy.params.filter(param => param.key !== 'sigmaK' || form.family === 'highlow').map(param => (
                                        <label key={param.key} className='dt-field' title={param.hint}>{param.label}
                                            <input
                                                inputMode='decimal' disabled={running} aria-label={param.label}
                                                value={form.strategyParams[activeStrategy.id]?.[param.key] ?? String(paramDefaults(activeStrategy)[param.key])}
                                                onChange={e => set('strategyParams', { ...form.strategyParams, [activeStrategy.id]: { ...form.strategyParams[activeStrategy.id], [param.key]: e.target.value } })}
                                            />
                                        </label>
                                    ))}
                                </div>
                            )}
                            {score && <p className='dt-hint'>{score}</p>}
                            <p className='dt-hint'>Last digits and tick moves on these markets are random, so no strategy can promise a win. A strategy chooses when and what to trade and keeps you out when its conditions are not met.</p>
                        </div>
                    )}

                    {family.needsDigit && (
                        <label className='dt-field dt-field--wide'>Prediction digit
                            <input inputMode='numeric' value={form.prediction} disabled={running} onChange={e => set('prediction', e.target.value)} aria-invalid={Boolean(predictionIssue)} />
                        </label>
                    )}

                    {family.needsTick && (
                        <label className='dt-field dt-field--wide'>Tick to pick (1 to {family.fixedTicks})
                            <input inputMode='numeric' value={form.prediction} disabled={running} onChange={e => set('prediction', e.target.value)} aria-invalid={Boolean(predictionIssue)} />
                            <small className='dt-hint'>{family.sides[0]} wins if that tick is the highest of the next {family.fixedTicks}; {family.sides[1]} wins if it is the lowest. There is no barrier.</small>
                        </label>
                    )}

                    {family.needsTick && form.side === 'both' && (
                        <label className='dt-field dt-field--wide'>Low Tick pick (blank = same tick as High Tick)
                            <input inputMode='numeric' value={form.pick2} placeholder={form.prediction} disabled={running} onChange={e => set('pick2', e.target.value)} />
                        </label>
                    )}

                    {family.needsOffset && (
                        <label className='dt-field dt-field--wide'>Barrier offset (price distance from the entry spot)
                            <input inputMode='decimal' value={form.offset} disabled={running} onChange={e => set('offset', e.target.value)} aria-invalid={Boolean(offsetIssue)} />
                        </label>
                    )}

                    <div className='dt-row'>
                        <label className='dt-field'>Stake ({currency})<input inputMode='decimal' value={form.stake} disabled={running} onChange={e => set('stake', e.target.value)} /></label>
                        <label className='dt-field'>Run
                            <select value={form.mode} disabled={running} onChange={e => set('mode', e.target.value as 'single' | 'repeat')}><option value='single'>Single</option><option value='repeat'>Repeat</option></select>
                        </label>
                    </div>

                    <div className='dt-bulk'>
                        <label className='dt-field'>Trades per entry<input inputMode='numeric' value={form.trades} disabled={running} onChange={e => set('trades', e.target.value)} aria-label='Trades per entry' /></label>
                        <label className='dt-check'><input type='checkbox' checked={form.guard} disabled={running} onChange={e => set('guard', e.target.checked)} /> Same-tick guard</label>
                        <p className='dt-hint'>
                            One entry sends {totalPerEntry || '…'} trade{totalPerEntry === 1 ? '' : 's'} in a single burst. Every trade enters on the same tick and settles on the same tick.
                            {form.guard ? ' If the burst cannot reach Deriv before the next tick, it is trimmed so they stay together.' : ' The guard is off: a big burst may spill onto the next tick.'}
                        </p>
                    </div>

                    <div className='dt-row dt-row--3'>
                        <label className='dt-field'>TP<input inputMode='decimal' value={form.takeProfit} placeholder='off' disabled={running} onChange={e => set('takeProfit', e.target.value)} /></label>
                        <label className='dt-field'>SL<input inputMode='decimal' value={form.stopLoss} placeholder='off' disabled={running} onChange={e => set('stopLoss', e.target.value)} /></label>
                        <label className='dt-field'>×<input inputMode='decimal' value={form.martingale} disabled={running} onChange={e => set('martingale', e.target.value)} aria-label='Stake multiplier after a loss' /></label>
                    </div>

                    <div className='dt-payout'>
                        {payouts.length ? payouts.map(p => <div key={p.label}><span>Payout · {p.label}</span><b>{p.payout} {currency}</b></div>) : <div><span>Payout</span><b>—</b></div>}
                        <div><span>Stake per entry</span><b>{(toNumber(form.stake, 0) * (totalPerEntry || 1)).toFixed(2)} {currency}</b></div>
                    </div>
                    {preflightNotes.map(note => <p key={note} className='dt-hint dt-hint--note'>{note}</p>)}
                    {family.needsTick && (
                        <div className='dt-hedge'>
                            {hedge && (
                                <>
                                    <p className={`dt-hint ${hedge.oneWinCoversBoth ? '' : 'dt-hint--bad'}`}>
                                        Hedge pair per entry ({hedge.cost.toFixed(2)} {currency} staked): if only High Tick wins {hedge.netHighOnly >= 0 ? '+' : ''}{hedge.netHighOnly.toFixed(2)},
                                        if only Low Tick wins {hedge.netLowOnly >= 0 ? '+' : ''}{hedge.netLowOnly.toFixed(2)}, if neither wins {hedge.netNeither.toFixed(2)}
                                        {hedge.pBothWin > 0 ? `, if both win +${hedge.netBoth.toFixed(2)}` : ''}.
                                    </p>
                                    <p className='dt-hint dt-hint--note'>
                                        {hedge.note} At these quotes the average result is {hedge.expected >= 0 ? '+' : ''}{hedge.expected.toFixed(2)} {currency} per entry ({(hedge.expectedPerStake * 100).toFixed(1)}% of the money staked),
                                        by the chance model below. {hedge.oneWinCoversBoth ? 'One winning trade pays back both stakes.' : 'One winning trade does NOT pay back both stakes.'}
                                    </p>
                                </>
                            )}
                            <button type='button' className='dt-link' disabled={tickRowsBusy} onClick={() => void quoteAllTicks()}>{tickRowsBusy ? 'Asking Deriv…' : 'Quote all 5 ticks'}</button>
                            {tickRowsError && <p className='dt-error'>{tickRowsError}</p>}
                            {tickRows && (
                                <table className='dt-hedge-table'>
                                    <thead><tr><th>Tick</th><th>Chance</th><th>Recent</th><th>High pays</th><th>High avg</th><th>Low pays</th><th>Low avg</th></tr></thead>
                                    <tbody>
                                        {tickRows.map(row => (
                                            <tr key={row.pick}>
                                                <td>{row.pick}</td>
                                                <td>{(row.modelOdds * 100).toFixed(1)}%</td>
                                                <td>{row.recentOdds === null ? '—' : `${(row.recentOdds * 100).toFixed(1)}%`}</td>
                                                <td>{row.highPayout === null ? '—' : row.highPayout.toFixed(2)}</td>
                                                <td className={row.highEdge !== null && row.highEdge < 0 ? 'dt-neg' : 'dt-pos'}>{row.highEdge === null ? '—' : `${(row.highEdge * 100).toFixed(1)}%`}</td>
                                                <td>{row.lowPayout === null ? '—' : row.lowPayout.toFixed(2)}</td>
                                                <td className={row.lowEdge !== null && row.lowEdge < 0 ? 'dt-neg' : 'dt-pos'}>{row.lowEdge === null ? '—' : `${(row.lowEdge * 100).toFixed(1)}%`}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                            <p className='dt-hint'>
                                The highest (or lowest) of 5 ticks is the first or last tick about 27% of the time and a middle tick about 14 to 16%. "Avg" is the average result per 1 staked from the payout Deriv quotes and that chance
                                (negative = you lose on average). It assumes each tick moves independently, so check it against "Recent" and try a demo account first. Two opposite trades never change the average, only how often you win.
                            </p>
                        </div>
                    )}

                    {pair && (
                        <p className={`dt-hint ${pair.locked ? 'dt-hint--bad' : ''}`}>
                            Pair per entry ({payouts[0].label} + {payouts[1].label}, {pair.total.toFixed(2)} {currency} staked): if {payouts[0].label} wins {pair.ifFirstWins >= 0 ? '+' : ''}{pair.ifFirstWins.toFixed(2)},
                            if {payouts[1].label} wins {pair.ifSecondWins >= 0 ? '+' : ''}{pair.ifSecondWins.toFixed(2)}{pair.note ? `, if neither ${pair.ifNeither.toFixed(2)}. ${pair.note}` : '.'}
                        </p>
                    )}
                    {(predictionIssue || offsetIssue || quoteError) && <p className='dt-error'>{predictionIssue || offsetIssue || quoteError}</p>}
                    {error && <p className='dt-error' role='alert'>{error}</p>}
                    {!isAuthorized && <p className='dt-hint'>Log in to a Deriv account to place trades. Demo first is a good idea.</p>}

                    <button type='button' className='dt-buynow' disabled={running} onClick={() => start({ entryMode: 'instant', mode: 'single' })}>Buy now (one entry, instant)</button>
                </section>

                {/* ------------------------------ summary / transactions / journal ------------------------------ */}
                <aside className='dt-side-panel' aria-label='Results'>
                    <div className='dt-tabs' role='tablist'>
                        {(['summary', 'transactions', 'journal'] as SideTab[]).map(t => (
                            <button key={t} type='button' role='tab' aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
                        ))}
                    </div>
                    <div className='dt-tabbody'>
                        {tab === 'summary' && (
                            <div className='dt-summary'>
                                <div className={`dt-state dt-state--${runState}`}><i />{stateLabel[runState]}<span>{note}</span></div>
                                {sync && <div className={`dt-sync ${sync.ok === false ? 'bad' : sync.ok ? 'good' : ''}`}><b>{sync.ok ? 'Same tick ✓' : sync.ok === false ? 'Not on one tick' : 'Settlement'}</b><span>{sync.text}</span></div>}
                                <dl>
                                    <div><dt>Total stake</dt><dd>{money(totals.stake, currency)}</dd></div>
                                    <div><dt>Total payout</dt><dd>{money(totals.payout, currency)}</dd></div>
                                    <div><dt>Contracts bought</dt><dd>{totals.contracts}</dd></div>
                                    <div title='Trades the same-tick guard held back. They were never sent to Deriv, so no money was used.'><dt>Not sent (no money used)</dt><dd>{totals.notSent} of {totals.requested} asked</dd></div>
                                    <div><dt>Won / Lost</dt><dd>{totals.won} / {totals.lost}</dd></div>
                                    <div><dt>Failed buys</dt><dd>{totals.failed}</dd></div>
                                    <div><dt>Net profit</dt><dd className={totals.pnl > 0 ? 'up' : totals.pnl < 0 ? 'down' : ''}>{money(totals.pnl, currency)}</dd></div>
                                </dl>
                            </div>
                        )}
                        {tab === 'transactions' && (rows.length ? (
                            <div className='dt-tablewrap'>
                                <table className='dt-table'>
                                    <thead><tr><th>Type</th><th>Entry / Exit</th><th>Stake</th><th>P/L</th></tr></thead>
                                    <tbody>
                                        {rows.map(row => (
                                            <tr key={row.id} className={`is-${row.state}`}>
                                                <td>{row.label}<small>#{row.batch} · {row.time}</small></td>
                                                <td>{row.state === 'failed' ? <em title={row.note}>{row.note || 'Failed'}</em> : <>{row.entrySpot || '…'}<small>{row.exitSpot || '…'}{row.exitDigit !== null ? ` · digit ${row.exitDigit}` : ''}</small></>}</td>
                                                <td>{row.stake.toFixed(2)}</td>
                                                <td className={row.profit > 0 ? 'up' : row.profit < 0 ? 'down' : ''}>{row.state === 'open' ? 'open' : row.state === 'failed' ? '—' : row.profit.toFixed(2)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : <p className='dt-empty'>There are no transactions to display.<small>The bot is not running, or the stats were cleared.</small></p>)}
                        {tab === 'journal' && (journal.length ? (
                            <ul className='dt-journal'>{journal.map(line => <li key={line.id} className={`is-${line.level}`}><time>{line.time}</time>{line.text}</li>)}</ul>
                        ) : <p className='dt-empty'>The journal is empty.<small>Run messages and the same-tick checks appear here.</small></p>)}
                    </div>
                </aside>
            </div>

            {/* ------------------------------ run bar ------------------------------ */}
            <footer className='dt-runbar'>
                <button type='button' className='dt-reset' disabled={running} onClick={reset}>↺ Reset</button>
                {running
                    ? <button type='button' className='dt-run dt-run--stop' onClick={() => runner.stop()}>■ Stop</button>
                    : <button type='button' className='dt-run' onClick={() => start()}>▶ Run</button>}
                <div className='dt-runnote' aria-live='polite'><small>{running ? 'STATUS' : 'READY'}</small><b>{stateLabel[runState]}</b></div>
                <div className='dt-counters'>
                    <div><small>Stake</small><b>{totals.stake.toFixed(2)}</b></div>
                    <div><small>Payout</small><b>{totals.payout.toFixed(2)}</b></div>
                    <div><small>Runs</small><b>{totals.contracts}</b></div>
                    <div><small>Won</small><b>{totals.won}</b></div>
                    <div><small>Lost</small><b>{totals.lost}</b></div>
                    <div><small>P/L</small><b className={totals.pnl > 0 ? 'up' : totals.pnl < 0 ? 'down' : ''}>{totals.pnl > 0 ? '+' : ''}{totals.pnl.toFixed(2)}</b></div>
                </div>
            </footer>
        </div>
    );
};

export default DTraderPage;
