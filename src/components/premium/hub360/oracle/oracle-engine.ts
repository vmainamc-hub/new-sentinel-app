// ORACLE ENGINE: the scanning back end of the Oracle tool.
//
// It reads the live digit series of every market Oracle trades (1,000+ ticks each, served by the app's Sixfold feed
// over Deriv's public socket), runs the Even/Odd and Over/Under engines on them and returns the verdict to trade.
// Rise/Fall and Differs are not served yet.
//
// A scan is an ASSESSMENT, not a lookup. It keeps reading live ticks for a set time (15 s Even/Odd, 18 s Over/Under) and
// only then gives its verdict, so a contract that looks good for one tick and bad for the next does not get through.
//
//   EVEN/ODD    six digit rules (even-odd.ts). When every rule holds on a market it is a STRONG signal. When none does, the
//               scan still answers with the BEST AVAILABLE board and its match percentage, with the rules it passed.
//   OVER/UNDER  every contract on every market goes through the eleven layers in over-under.ts, including the losing-digit
//               risk. A market whose losing digits are running hot is FLAGGED and is never offered. The verdict is the
//               contract with the best score that also stayed healthy across the whole assessment (StabilityTracker).
//
// The scan is LIVE: ticks that arrive during the assessment count, and the verdict is read from the final state.
import { type FeedSnapshot, SixfoldFeed } from '../../sixfold/feed';
import { type EvenOddCheck, type EvenOddRead, type Parity, readBothParities, EO_MIN_TICKS } from './even-odd';
import { OU_MIN_TICKS, type OverUnderRead, type RiskLevel, scanOverUnder, type Layer } from './over-under';

export type OracleKind = 'EVEN/ODD' | 'OVER/UNDER';
export const ORACLE_KINDS: readonly OracleKind[] = ['EVEN/ODD', 'OVER/UNDER'];
export const isEngineKind = (kind: string): kind is OracleKind => ORACLE_KINDS.includes(kind as OracleKind);

/** How long each assessment runs before the verdict (ms). */
export const ASSESS_MS: Record<OracleKind, number> = { 'EVEN/ODD': 15_000, 'OVER/UNDER': 18_000 };

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
    /** 0-100 strength used for ranking and shown as the percentage. */
    deviation: number;
    /** STRONG = every rule agrees. BEST = best available, not every rule agrees. */
    tier: 'STRONG' | 'BEST';
    checks: SignalCheck[];
    summary: string;
    /** Even/Odd: how many of the six rules hold. null for Over/Under. */
    rules: { passed: number; total: number } | null;
    /** Over/Under: how hot the losing digits are running. null for Even/Odd. */
    risk: RiskLevel | null;
};

/** One market's risk call, shown while and after an Over/Under assessment. */
export type MarketCall = {
    symbol: string;
    name: string;
    level: 'CLEAR' | 'WATCH' | 'FLAGGED';
    /** The market's leading contract, e.g. "Over 2". */
    contract: string;
    reason: string;
};

export type OracleScan = {
    kind: OracleKind;
    /** Markets with enough ticks to be read, and the number the scan covers. */
    ready: number;
    total: number;
    /** Every market that qualifies (STRONG), strongest first. */
    signals: OracleSignal[];
    /** The strongest qualifying signal, or null. */
    best: OracleSignal | null;
    /** The best signal that is not STRONG. */
    fallback: OracleSignal | null;
    /** The market that came closest, for the readiness card when nothing qualifies. */
    closest: { name: string; contract: string; passed: number; total: number; failing: string[] } | null;
    /** Highest strength seen on any market, whether or not it qualifies. */
    topScore: number;
    /** Over/Under: every market's risk call. Empty for Even/Odd. */
    markets: MarketCall[];
    /** Over/Under: every contract read, for the stability tracker and the verdict. Empty for Even/Odd. */
    reads: OverUnderRead[];
};

type Series = Readonly<Record<string, readonly number[]>>;

const round1 = (x: number) => Math.round(x * 10) / 10;
const layerCheck = (l: Layer): SignalCheck => ({ label: l.label, ok: l.ok, detail: l.detail, source: l.engine });
const ruleCheck = (c: EvenOddCheck): SignalCheck => ({ label: c.label, ok: c.ok, detail: c.detail });

// ---------------- Even / Odd ----------------

/**
 * Match percentage of a board for a parity: half the share of the six rules that hold, half the board's own strength
 * (rising digits, recent digits, climbing digit, parity share). Used for ranking and shown to the user.
 */
export const evenOddMatch = (r: Pick<EvenOddRead, 'passed' | 'total' | 'score'>): number =>
    round1(0.5 * (r.passed / r.total) * 100 + 0.5 * r.score);

const evenOddSignal = (symbol: string, parity: Parity, r: EvenOddRead): OracleSignal => ({
    symbol,
    name: oracleName(symbol),
    contractType: parity,
    barrier: null,
    deviation: evenOddMatch(r),
    tier: r.ok ? 'STRONG' : 'BEST',
    checks: r.checks.map(ruleCheck),
    summary: r.ok
        ? `${parity === 'EVEN' ? 'Even' : 'Odd'}: all ${r.total} digit rules hold`
        : `${parity === 'EVEN' ? 'Even' : 'Odd'}: best available, ${r.passed} of ${r.total} rules hold`,
    rules: { passed: r.passed, total: r.total },
    risk: null,
});

export function scanEvenOdd(series: Series, symbols: readonly string[] = ORACLE_SYMBOLS): OracleScan {
    const all: OracleSignal[] = [];
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
            const signal = evenOddSignal(symbol, parity, r);
            all.push(signal);
            topScore = Math.max(topScore, signal.deviation);
            const key = r.passed * 1000 + signal.deviation;
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
    const byMatch = (a: OracleSignal, b: OracleSignal) => b.deviation - a.deviation;
    const signals = all.filter(s => s.tier === 'STRONG').sort(byMatch);
    const fallback = all.filter(s => s.tier === 'BEST').sort(byMatch)[0] ?? null;
    return {
        kind: 'EVEN/ODD',
        ready,
        total: symbols.length,
        signals,
        best: signals[0] ?? null,
        fallback,
        closest,
        topScore,
        markets: [],
        reads: [],
    };
}

// ---------------- Over / Under ----------------

/**
 * Tracks, across one assessment, how often each contract was STRONG and how often it was clear of every hard layer.
 * A contract that is STRONG on one tick and vetoed on the next is not the one to trade.
 */
export class StabilityTracker {
    private n = 0;
    private strong = new Map<string, number>();
    private clear = new Map<string, number>();

    private static key = (r: OverUnderRead) => `${r.symbol}:${r.label}`;

    observe(reads: readonly OverUnderRead[]): void {
        this.n += 1;
        for (const r of reads) {
            const key = StabilityTracker.key(r);
            if (r.tier !== null) this.clear.set(key, (this.clear.get(key) ?? 0) + 1);
            if (r.tier === 'STRONG') this.strong.set(key, (this.strong.get(key) ?? 0) + 1);
        }
    }

    get evaluations(): number {
        return this.n;
    }

    /** Share of the assessment the contract was STRONG / clear. With nothing observed, the read stands alone. */
    share(r: OverUnderRead): { strong: number; clear: number } {
        if (this.n === 0) return { strong: r.tier === 'STRONG' ? 1 : 0, clear: r.tier !== null ? 1 : 0 };
        const key = StabilityTracker.key(r);
        return { strong: (this.strong.get(key) ?? 0) / this.n, clear: (this.clear.get(key) ?? 0) / this.n };
    }
}

/** A contract needs to have been STRONG in at least this share of the assessment to be called STRONG at the end. */
export const STEADY_SHARE = 0.6;

const overUnderSignal = (
    r: OverUnderRead,
    tier: 'STRONG' | 'BEST',
    strength: number,
    summary: string
): OracleSignal => ({
    symbol: r.symbol,
    name: oracleName(r.symbol),
    contractType: r.side,
    barrier: r.barrier,
    deviation: strength,
    tier,
    checks: r.layers.map(layerCheck),
    summary,
    rules: null,
    risk: r.risk.level,
});

/**
 * The verdict of an Over/Under assessment. Among the contracts no hard layer objects to, the best blend of the final
 * score (60%), how often the contract was STRONG during the assessment (25%) and how often it was clear (15%).
 * STRONG only when it is STRONG now and was STRONG in at least STEADY_SHARE of the assessment.
 */
export function pickOverUnder(reads: readonly OverUnderRead[], tracker: StabilityTracker): OracleSignal | null {
    const ranked = reads
        .filter(r => r.tier !== null)
        .map(r => {
            const s = tracker.share(r);
            return { r, s, strength: round1(0.6 * r.score + 0.25 * s.strong * 100 + 0.15 * s.clear * 100) };
        })
        .sort((a, b) => b.strength - a.strength);
    const top = ranked[0];
    if (!top) return null;
    const steady = top.r.tier === 'STRONG' && top.s.strong >= STEADY_SHARE;
    const failing = top.r.layers.filter(l => !l.ok).length;
    return overUnderSignal(
        top.r,
        steady ? 'STRONG' : 'BEST',
        top.strength,
        steady
            ? `${top.r.label}: every engine agreed through the assessment`
            : `${top.r.label}: best available, ${failing} layer(s) not agreeing`
    );
}

const shortReason = (lead: OverUnderRead): string => {
    const hard = lead.layers.find(l => l.hard && !l.ok);
    if (hard) return hard.key === 'risk' ? hard.detail : `${hard.engine}: ${hard.detail}`;
    if (lead.risk.level !== 'LOW') return lead.risk.detail;
    const bad = lead.layers.find(l => !l.ok && l.required);
    return bad ? bad.detail : '';
};

const ORDER: Record<MarketCall['level'], number> = { FLAGGED: 0, WATCH: 1, CLEAR: 2 };

/** One call per market, from its leading (highest scoring) contract. FLAGGED = that contract is vetoed. */
const callLevel = (r: OverUnderRead): MarketCall['level'] => {
    if (r.vetoed) return 'FLAGGED';
    return r.risk.level !== 'LOW' || r.tier === 'BEST' ? 'WATCH' : 'CLEAR';
};

export const marketCalls = (reads: readonly OverUnderRead[]): MarketCall[] => {
    const lead = new Map<string, OverUnderRead>();
    for (const r of reads) {
        const cur = lead.get(r.symbol);
        if (!cur || r.score > cur.score) lead.set(r.symbol, r);
    }
    return [...lead.values()]
        .map(r => ({
            symbol: r.symbol,
            name: oracleName(r.symbol),
            level: callLevel(r),
            contract: r.label,
            reason: shortReason(r),
        }))
        .sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.name.localeCompare(b.name));
};

export function scanOverUnderMarkets(series: Series, symbols: readonly string[] = ORACLE_SYMBOLS): OracleScan {
    const ready = symbols.filter(s => (series[s]?.length ?? 0) >= OU_MIN_TICKS).length;
    const reads = scanOverUnder(series, symbols);
    const live = reads.filter(r => r.tier !== null);
    const strong = live
        .filter(r => r.tier === 'STRONG')
        .map(r => overUnderSignal(r, 'STRONG', r.score, `${r.label}: every engine agrees`));
    const best = live.filter(r => r.tier === 'BEST')[0];
    const top = reads[0];
    const near = live[0] ?? top;
    return {
        kind: 'OVER/UNDER',
        ready,
        total: symbols.length,
        signals: strong,
        best: strong[0] ?? null,
        fallback: best
            ? overUnderSignal(
                  best,
                  'BEST',
                  best.score,
                  `${best.label}: best available, ${best.layers.filter(l => !l.ok).length} layer(s) not agreeing`
              )
            : null,
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
        markets: marketCalls(reads),
        reads,
    };
}

export const runOracleScan = (
    kind: OracleKind,
    series: Series,
    symbols: readonly string[] = ORACLE_SYMBOLS
): OracleScan =>
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

export type ScanInfo = { elapsedMs: number; assessMs: number; evaluations: number };

export type ScanHooks = {
    /** Called on every evaluation while assessing. */
    onProgress?: (scan: OracleScan, currentName: string, info: ScanInfo) => void;
    /** The verdict: STRONG, or BEST available. */
    onSignal: (signal: OracleSignal, scan: OracleScan) => void;
    /** The assessment ended with nothing to trade. */
    onNone?: (scan: OracleScan) => void;
};

export type ScannerOptions = {
    /** How long the assessment runs before the verdict. Defaults: ASSESS_MS for the kind. */
    assessMs?: number;
    /** Longest wait for the markets to have enough ticks before answering anyway. Default: assessMs + 12 s. */
    capMs?: number;
    /** Do not give a verdict before this share of the markets has enough ticks (until capMs). */
    minReadyShare?: number;
    /** Fewest ms between evaluations triggered by ticks. */
    throttleMs?: number;
    /** Heartbeat that keeps the countdown moving between ticks. */
    heartbeatMs?: number;
    now?: () => number;
};

const offeredType = (kind: OracleKind) => (kind === 'EVEN/ODD' ? ['DIGITEVEN', 'DIGITODD'] : ['DIGITOVER', 'DIGITUNDER']);

export class OracleScanner {
    private stopFn: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private beat: ReturnType<typeof setInterval> | null = null;
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
        if (this.beat) clearInterval(this.beat);
        this.timer = null;
        this.beat = null;
    };

    /** Markets Deriv says do not offer this kind of contract are left out; unknown stays allowed. */
    symbolsFor = (kind: OracleKind): string[] =>
        ORACLE_SYMBOLS.filter(s => offeredType(kind).every(t => this.feed.isOffered?.(s, t) !== false));

    start = (kind: OracleKind, hooks: ScanHooks) => {
        this.stop();
        const mine = this.session;
        const assessMs = this.opts.assessMs ?? ASSESS_MS[kind];
        const capMs = Math.max(assessMs, this.opts.capMs ?? assessMs + 12_000);
        const throttle = this.opts.throttleMs ?? 700;
        const heartbeat = this.opts.heartbeatMs ?? 1000;
        const minShare = this.opts.minReadyShare ?? 0.7;
        const now = this.opts.now ?? (() => Date.now());
        const startedAt = now();
        const tracker = new StabilityTracker();
        let lastRun = 0;
        let cursor = 0;

        const finish = (scan: OracleScan, signal: OracleSignal | null) => {
            if (mine !== this.session) return;
            this.stop();
            if (signal) hooks.onSignal(signal, scan);
            else hooks.onNone?.(scan);
        };

        // `fresh` = triggered by new ticks (counts towards stability); the heartbeat only moves the clock.
        const evaluate = (fresh: boolean) => {
            if (mine !== this.session) return;
            const symbols = this.symbolsFor(kind);
            const scan = runOracleScan(kind, this.feed.getLiveSeries(), symbols);
            if (fresh && kind === 'OVER/UNDER') tracker.observe(scan.reads);
            const names = symbols.map(oracleName);
            cursor = (cursor + 1) % Math.max(1, names.length);
            const elapsed = now() - startedAt;
            hooks.onProgress?.(scan, names[cursor] ?? '', { elapsedMs: elapsed, assessMs, evaluations: tracker.evaluations });
            const warmed = scan.ready >= Math.ceil(scan.total * minShare);
            if (elapsed < assessMs) return;
            if (!warmed && elapsed < capMs) return;
            const verdict = kind === 'OVER/UNDER' ? pickOverUnder(scan.reads, tracker) : scan.best ?? scan.fallback;
            finish(scan, scan.ready > 0 ? verdict : null);
        };

        this.stopFn = this.feed.subscribe(() => {
            const t = now();
            if (t - lastRun < throttle) {
                if (!this.timer) {
                    this.timer = setTimeout(() => {
                        this.timer = null;
                        lastRun = now();
                        evaluate(true);
                    }, throttle);
                }
                return;
            }
            lastRun = t;
            evaluate(true);
        });
        // Not live yet (or never started): connect. A feed that is already connecting or live is left alone.
        const status = this.feed.getStatus();
        if (status === 'offline' || status === 'error') this.feed.connect();
        this.beat = setInterval(() => evaluate(false), heartbeat);
        evaluate(true);
    };
}

/** One feed for Oracle, over the app's Sixfold feed class. Connected the first time a scan starts. */
export const oracleFeed = new SixfoldFeed(undefined, undefined, ORACLE_SYMBOLS);
export const oracleScanner = new OracleScanner(oracleFeed as unknown as FeedLike);
