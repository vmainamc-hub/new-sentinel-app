// ORACLE ENGINE: the scanning back end of the Oracle tool.
//
// It reads the live digit series of every market Oracle trades (1,000+ ticks each, served by the app's Sixfold feed
// over Deriv's public socket), runs the Even/Odd and Over/Under engines on them and returns the signal to trade.
// Rise/Fall and Differs are not served yet.
//
//   EVEN/ODD    strict rules (even-odd.ts). No signal unless every rule holds. Never forces a pick.
//   OVER/UNDER  every contract on every market goes through the ten layers in over-under.ts. A STRONG signal is taken as
//               soon as one appears; when the scan window ends the best contract that no hard layer objects to is offered
//               as BEST AVAILABLE.
//
// The scan is LIVE: it keeps evaluating as ticks arrive, so a market that qualifies a few seconds in is picked up.
import { type FeedSnapshot, SixfoldFeed } from '../../sixfold/feed';
import { type EvenOddCheck, type Parity, readBothParities, EO_MIN_TICKS } from './even-odd';
import { OU_MIN_TICKS, type OverUnderRead, scanOverUnder, type Layer } from './over-under';

export type OracleKind = 'EVEN/ODD' | 'OVER/UNDER';
export const ORACLE_KINDS: readonly OracleKind[] = ['EVEN/ODD', 'OVER/UNDER'];
export const isEngineKind = (kind: string): kind is OracleKind => ORACLE_KINDS.includes(kind as OracleKind);

/** The markets Oracle scans. */
export const ORACLE_MARKETS: ReadonlyArray<readonly [string, string]> = [
    ['R_10', 'Volatility 10'],
    ['R_25', 'Volatility 25'],
    ['R_50', 'Volatility 50'],
    ['R_75', 'Volatility 75'],
    ['R_100', 'Volatility 100'],
    ['1HZ10V', 'Vol 10 (1s)'],
    ['1HZ25V', 'Vol 25 (1s)'],
    ['1HZ30V', 'Vol 30 (1s)'],
    ['1HZ50V', 'Vol 50 (1s)'],
    ['1HZ75V', 'Vol 75 (1s)'],
    ['1HZ100V', 'Vol 100 (1s)'],
];
export const ORACLE_SYMBOLS: string[] = ORACLE_MARKETS.map(m => m[0]);
export const oracleName = (symbol: string): string => ORACLE_MARKETS.find(m => m[0] === symbol)?.[1] ?? symbol;

export type SignalCheck = { label: string; ok: boolean; detail: string; source?: string };

export type OracleSignal = {
    symbol: string;
    name: string;
    contractType: 'EVEN' | 'ODD' | 'OVER' | 'UNDER';
    /** Barrier for Over/Under, null for Even/Odd. */
    barrier: number | null;
    /** 0-100 strength used for ranking and shown as the deviation bar. */
    deviation: number;
    /** STRONG = every rule agrees. BEST = best available, not every layer agrees. */
    tier: 'STRONG' | 'BEST';
    checks: SignalCheck[];
    summary: string;
};

export type OracleScan = {
    kind: OracleKind;
    /** Markets with enough ticks to be read, and the number the scan covers. */
    ready: number;
    total: number;
    /** Every market that qualifies, strongest first. */
    signals: OracleSignal[];
    /** The strongest qualifying signal, or null. */
    best: OracleSignal | null;
    /** The best signal that is not STRONG (Over/Under only). */
    fallback: OracleSignal | null;
    /** The market that came closest, for the readiness card when nothing qualifies. */
    closest: { name: string; contract: string; passed: number; total: number; failing: string[] } | null;
    /** Highest strength seen on any market, whether or not it qualifies. */
    topScore: number;
};

type Series = Readonly<Record<string, readonly number[]>>;

const layerCheck = (l: Layer): SignalCheck => ({ label: l.label, ok: l.ok, detail: l.detail, source: l.engine });
const ruleCheck = (c: EvenOddCheck): SignalCheck => ({ label: c.label, ok: c.ok, detail: c.detail });

export function scanEvenOdd(series: Series, symbols: readonly string[] = ORACLE_SYMBOLS): OracleScan {
    const signals: OracleSignal[] = [];
    let ready = 0;
    let topScore = 0;
    let closest: OracleScan['closest'] = null;
    let closestKey = -1;
    for (const symbol of symbols) {
        const digits = series[symbol];
        if (!digits || digits.length < EO_MIN_TICKS) continue;
        ready += 1;
        const both = readBothParities(digits);
        if (!both) continue;
        for (const parity of ['EVEN', 'ODD'] as Parity[]) {
            const r = both[parity];
            topScore = Math.max(topScore, r.score);
            if (r.ok) {
                signals.push({
                    symbol,
                    name: oracleName(symbol),
                    contractType: parity,
                    barrier: null,
                    deviation: r.score,
                    tier: 'STRONG',
                    checks: r.checks.map(ruleCheck),
                    summary: `${parity === 'EVEN' ? 'Even' : 'Odd'}: all ${r.total} digit rules hold`,
                });
            }
            const key = r.passed * 1000 + r.score;
            if (key > closestKey) {
                closestKey = key;
                closest = {
                    name: oracleName(symbol),
                    contract: parity,
                    passed: r.passed,
                    total: r.total,
                    failing: r.checks.filter(c => !c.ok).map(c => c.label),
                };
            }
        }
    }
    signals.sort((a, b) => b.deviation - a.deviation);
    return { kind: 'EVEN/ODD', ready, total: symbols.length, signals, best: signals[0] ?? null, fallback: null, closest, topScore };
}

const toSignal = (r: OverUnderRead): OracleSignal => ({
    symbol: r.symbol,
    name: oracleName(r.symbol),
    contractType: r.side,
    barrier: r.barrier,
    deviation: r.score,
    tier: r.tier === 'STRONG' ? 'STRONG' : 'BEST',
    checks: r.layers.map(layerCheck),
    summary: r.tier === 'STRONG' ? `${r.label}: every engine agrees` : `${r.label}: best available, ${r.layers.filter(l => !l.ok).length} layer(s) not agreeing`,
});

export function scanOverUnderMarkets(series: Series, symbols: readonly string[] = ORACLE_SYMBOLS): OracleScan {
    const ready = symbols.filter(s => (series[s]?.length ?? 0) >= OU_MIN_TICKS).length;
    const reads = scanOverUnder(series, symbols);
    const live = reads.filter(r => r.tier !== null);
    const strong = live.filter(r => r.tier === 'STRONG').map(toSignal);
    const best = live.filter(r => r.tier === 'BEST')[0];
    const top = reads[0];
    const near = live[0] ?? top;
    return {
        kind: 'OVER/UNDER',
        ready,
        total: symbols.length,
        signals: strong,
        best: strong[0] ?? null,
        fallback: best ? toSignal(best) : null,
        closest: near
            ? {
                  name: oracleName(near.symbol),
                  contract: near.label,
                  passed: near.layers.filter(l => l.ok).length,
                  total: near.layers.length,
                  failing: near.layers.filter(l => !l.ok).map(l => l.label),
              }
            : null,
        topScore: top ? top.score : 0,
    };
}

export const runOracleScan = (kind: OracleKind, series: Series, symbols: readonly string[] = ORACLE_SYMBOLS): OracleScan =>
    kind === 'EVEN/ODD' ? scanEvenOdd(series, symbols) : scanOverUnderMarkets(series, symbols);

// ---------------- the live scanner ----------------

export type FeedLike = {
    connect: () => void;
    getStatus: () => string;
    getLiveSeries: () => Series;
    subscribe: (listener: () => void) => () => void;
    isOffered?: (symbol: string, contractType: string) => boolean | null;
    getSnapshot?: () => FeedSnapshot;
};

export type ScanHooks = {
    /** Called on every evaluation while scanning. */
    onProgress?: (scan: OracleScan, currentName: string) => void;
    /** A signal was found (STRONG, or BEST at the end of an Over/Under scan). */
    onSignal: (signal: OracleSignal, scan: OracleScan) => void;
    /** The scan window ended with nothing to trade. */
    onNone?: (scan: OracleScan) => void;
};

export type ScannerOptions = {
    /** How long a scan keeps looking. Defaults: 120 s for Even/Odd (strict rules, no fallback), 30 s for Over/Under. */
    maxMs?: number;
    /** Do not accept a signal before this share of the markets has enough ticks (or `warmupMs` has passed). */
    minReadyShare?: number;
    warmupMs?: number;
    /** Fewest ms between evaluations. */
    throttleMs?: number;
    now?: () => number;
};

const offeredType = (kind: OracleKind) => (kind === 'EVEN/ODD' ? ['DIGITEVEN', 'DIGITODD'] : ['DIGITOVER', 'DIGITUNDER']);

export class OracleScanner {
    private stopFn: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private deadline: ReturnType<typeof setTimeout> | null = null;
    private session = 0;

    constructor(
        private feed: FeedLike,
        private opts: ScannerOptions = {}
    ) {}

    isScanning = () => this.stopFn !== null;

    stop = () => {
        this.session += 1;
        this.stopFn?.();
        this.stopFn = null;
        if (this.timer) clearTimeout(this.timer);
        if (this.deadline) clearTimeout(this.deadline);
        this.timer = null;
        this.deadline = null;
    };

    /** Markets Deriv says do not offer this kind of contract are left out; unknown stays allowed. */
    symbolsFor = (kind: OracleKind): string[] =>
        ORACLE_SYMBOLS.filter(s => offeredType(kind).every(t => this.feed.isOffered?.(s, t) !== false));

    start = (kind: OracleKind, hooks: ScanHooks) => {
        this.stop();
        const mine = this.session;
        const maxMs = this.opts.maxMs ?? (kind === 'EVEN/ODD' ? 120_000 : 30_000);
        const throttle = this.opts.throttleMs ?? 700;
        const warmup = this.opts.warmupMs ?? 12_000;
        const minShare = this.opts.minReadyShare ?? 0.7;
        const now = this.opts.now ?? (() => Date.now());
        const startedAt = now();
        let lastRun = 0;
        let cursor = 0;

        const finish = (scan: OracleScan, signal: OracleSignal | null) => {
            if (mine !== this.session) return;
            this.stop();
            if (signal) hooks.onSignal(signal, scan);
            else hooks.onNone?.(scan);
        };

        const evaluate = (final = false) => {
            if (mine !== this.session) return;
            const symbols = this.symbolsFor(kind);
            const scan = runOracleScan(kind, this.feed.getLiveSeries(), symbols);
            const names = symbols.map(oracleName);
            cursor = (cursor + 1) % Math.max(1, names.length);
            hooks.onProgress?.(scan, names[cursor] ?? '');
            const elapsed = now() - startedAt;
            const warmed = scan.ready >= Math.ceil(scan.total * minShare) || elapsed >= warmup;
            if (scan.best && warmed) return finish(scan, scan.best);
            if (final) return finish(scan, scan.fallback);
        };

        this.stopFn = this.feed.subscribe(() => {
            const t = now();
            if (t - lastRun < throttle) {
                if (!this.timer) this.timer = setTimeout(() => { this.timer = null; lastRun = now(); evaluate(); }, throttle);
                return;
            }
            lastRun = t;
            evaluate();
        });
        // Not live yet (or never started): connect. A feed that is already connecting or live is left alone.
        const status = this.feed.getStatus();
        if (status === 'offline' || status === 'error') this.feed.connect();
        this.deadline = setTimeout(() => evaluate(true), maxMs);
        evaluate();
    };
}

/** One feed for Oracle, over the app's Sixfold feed class. Connected the first time a scan starts. */
export const oracleFeed = new SixfoldFeed(undefined, undefined, ORACLE_SYMBOLS);
export const oracleScanner = new OracleScanner(oracleFeed as unknown as FeedLike);
