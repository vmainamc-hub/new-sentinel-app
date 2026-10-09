// Pure, framework-free logic for the Apex Sentinel AI Bulk Trader (scanner + bulk-run bookkeeping).
// No React, no network: everything here is deterministic and unit-tested in __tests__/bulk-engine.spec.ts.
//
// What the scanner does: for each of the 13 volatility indices it measures how far recent last-digit
// frequencies sit from theory for every candidate trade in the chosen family, corrects for the number
// of candidates examined, and ranks the result. It describes past ticks. It does not predict the next one.

export type Family = 'evenodd' | 'overunder' | 'matchesdiffers';
export type DigitContract = 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF';
export type Strength = 'strong' | 'moderate' | 'weak' | 'none';

export type FamilyDef = {
    title: string;
    sides: [string, string];
    contracts: [DigitContract, DigitContract];
    /** Candidates examined per market (used for the multiple-testing correction). */
    tests: number;
};

export const FAMILIES: Record<Family, FamilyDef> = {
    evenodd: { title: 'Even / Odd', sides: ['Even', 'Odd'], contracts: ['DIGITEVEN', 'DIGITODD'], tests: 2 },
    overunder: { title: 'Over / Under', sides: ['Over', 'Under'], contracts: ['DIGITOVER', 'DIGITUNDER'], tests: 18 },
    matchesdiffers: { title: 'Matches / Differs', sides: ['Matches', 'Differs'], contracts: ['DIGITMATCH', 'DIGITDIFF'], tests: 20 },
};

export const FAMILY_ORDER: Family[] = ['evenodd', 'overunder', 'matchesdiffers'];

export type BulkMarket = { symbol: string; name: string; pip: number };

// Volatility and requested Jump indices. The page checks Deriv's live contract capabilities
// before adding any Jump market to the digit scanner; `pip` is a fallback only.
export const BULK_MARKETS: BulkMarket[] = [
    { symbol: 'R_10', name: 'Volatility 10', pip: 3 },
    { symbol: 'R_25', name: 'Volatility 25', pip: 3 },
    { symbol: 'R_50', name: 'Volatility 50', pip: 4 },
    { symbol: 'R_75', name: 'Volatility 75', pip: 4 },
    { symbol: 'R_100', name: 'Volatility 100', pip: 2 },
    { symbol: '1HZ10V', name: 'Volatility 10 (1s)', pip: 2 },
    { symbol: '1HZ15V', name: 'Volatility 15 (1s)', pip: 3 },
    { symbol: '1HZ25V', name: 'Volatility 25 (1s)', pip: 2 },
    { symbol: '1HZ30V', name: 'Volatility 30 (1s)', pip: 3 },
    { symbol: '1HZ50V', name: 'Volatility 50 (1s)', pip: 2 },
    { symbol: '1HZ75V', name: 'Volatility 75 (1s)', pip: 2 },
    { symbol: '1HZ90V', name: 'Volatility 90 (1s)', pip: 3 },
    { symbol: '1HZ100V', name: 'Volatility 100 (1s)', pip: 2 },
    { symbol: 'JD10', name: 'Jump 10 Index', pip: 2 },
    { symbol: 'JD25', name: 'Jump 25 Index', pip: 2 },
    { symbol: 'JD50', name: 'Jump 50 Index', pip: 2 },
    { symbol: 'JD75', name: 'Jump 75 Index', pip: 2 },
    { symbol: 'JD100', name: 'Jump 100 Index', pip: 2 },
];

export const MIN_SCAN_TICKS = 100;
export const MAX_HISTORY = 5000;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
export const normCdf = (x: number): number => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
};

/** z-score of k successes in n trials against a theoretical probability p0. */
export const zBinom = (k: number, n: number, p0: number): number =>
    n <= 0 ? 0 : (k - n * p0) / Math.sqrt(n * p0 * (1 - p0));

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10000) / 10000;

/**
 * Decimal places actually present in a tick sample. Deriv strips trailing zeros from JSON numbers, so the
 * maximum over a few dozen ticks is the market's pip size. Falls back to `fallback` for tiny samples.
 */
export const inferDecimals = (prices: number[], fallback: number): number => {
    if (prices.length < 30) return fallback;
    let max = 0;
    for (const price of prices) {
        const text = String(price);
        if (!Number.isFinite(price) || text.includes('e')) continue;
        const dot = text.indexOf('.');
        if (dot >= 0) max = Math.max(max, text.length - dot - 1);
    }
    return Math.min(max, 6);
};

export const lastDigit = (price: number, decimals: number): number =>
    Number(Number(price).toFixed(clamp(decimals, 0, 10)).slice(-1));

export const digitsFromTicks = (prices: number[], decimals: number): number[] =>
    prices.filter(Number.isFinite).map(price => lastDigit(price, decimals));

const histogram = (digits: number[], window: number): number[] => {
    const counts = new Array<number>(10).fill(0);
    for (let i = Math.max(0, digits.length - window); i < digits.length; i += 1) counts[digits[i]] += 1;
    return counts;
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Estimated return-to-player of Deriv digit contracts. The real payout comes from Deriv's proposal at buy time;
// this is used only to show a break-even hit rate.
export const RTP = 0.955;
export const payoutMultiple = (p0: number): number => RTP / p0;
export const breakEvenRate = (p0: number): number => p0 / RTP;

export const scanWindows = (available: number, requested: number): number[] => {
    const top = Math.min(available, requested);
    return [...new Set([Math.min(top, 100), Math.min(top, 300), top].filter(w => w >= 50))].sort((a, b) => a - b);
};

export type WindowStat = { window: number; hitPct: number; z: number };

export type ScanPick = {
    family: Family;
    label: string;
    contract: DigitContract;
    /** Index into FAMILIES[family].sides / contracts (0 = first button, 1 = second). */
    side: 0 | 1;
    barrier: number | null;
    z: number;
    /** 0-100 ranking score. NOT a win probability. */
    score: number;
    strength: Strength;
    hitPct: number;
    theoryPct: number;
    breakEvenPct: number;
    /** One-sided p-value for this candidate on its own. */
    rawP: number;
    /** p-value after correcting for every candidate examined across all markets. */
    adjP: number;
    agree: string;
    windows: WindowStat[];
    /** Historical return had this trade been placed on the sampled ticks (in-sample, not a forecast). */
    observedEV: number;
    /** Return after shrinking the observed deviation toward theory. Normally negative. */
    projectedEV: number;
    gap: number | null;
    reason: string;
};

type Candidate = {
    label: string; contract: DigitContract; side: 0 | 1; barrier: number | null;
    win: number[]; p0: number; gap?: number; describe: (hitPct: number, z: number, window: number) => string;
};

const signed = (z: number) => `${z >= 0 ? '+' : ''}${z}`;

const evaluate = (family: Family, c: Candidate, hists: number[][], windows: number[], tests: number): ScanPick => {
    const win = new Set(c.win);
    const per = windows.map((window, i) => {
        let k = 0;
        hists[i].forEach((count, digit) => { if (win.has(digit)) k += count; });
        return { window, hit: k / window, z: zBinom(k, window, c.p0) };
    });
    const long = per[per.length - 1];
    const sign = Math.sign(long.z) || 1;
    const agreeing = per.filter(s => Math.sign(s.z) === sign && Math.abs(s.z) >= 0.5).length;
    const confirm = agreeing / per.length;

    const rawP = 1 - normCdf(long.z);
    const adjP = Math.min(1, rawP * tests);
    // Judged AFTER correcting for how many candidates were scanned, so picking the best of ~200 noisy
    // candidates cannot pass itself off as a finding.
    const strength: Strength = adjP < 0.05 ? 'strong'
        : adjP < 0.25 && confirm >= 0.66 ? 'moderate'
        : rawP < 0.05 ? 'weak' : 'none';
    const score = Math.round(clamp(18 * Math.max(0, long.z) * (0.5 + 0.5 * confirm), 0, 100));

    // These indices are driven by a random-number generator, so the honest prior is that true deviations from
    // theory are ~0 (tau = 0.1 percentage points). Only a vastly larger sample could move this estimate.
    const tau2 = 0.001 ** 2;
    const sampling = (c.p0 * (1 - c.p0)) / long.window;
    const lambda = tau2 / (tau2 + sampling);
    const shrunk = c.p0 + lambda * (long.hit - c.p0);

    return {
        family, label: c.label, contract: c.contract, side: c.side, barrier: c.barrier,
        z: round2(long.z), score, strength,
        hitPct: round1(long.hit * 100), theoryPct: round1(c.p0 * 100), breakEvenPct: round1(breakEvenRate(c.p0) * 100),
        rawP: round4(rawP), adjP: round4(adjP),
        agree: `${agreeing}/${per.length}`,
        windows: per.map(s => ({ window: s.window, hitPct: round1(s.hit * 100), z: round2(s.z) })),
        observedEV: round1((long.hit * payoutMultiple(c.p0) - 1) * 100),
        projectedEV: round1((shrunk * payoutMultiple(c.p0) - 1) * 100),
        gap: c.gap ?? null,
        reason: c.describe(round1(long.hit * 100), round2(long.z), long.window),
    };
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Ticks since digit `d` last printed (0 = it was the latest tick). */
export const gapOf = (digits: number[], d: number): number => {
    for (let i = digits.length - 1, gap = 0; i >= 0; i -= 1, gap += 1) if (digits[i] === d) return gap;
    return digits.length;
};

const candidatesFor = (family: Family, digits: number[]): Candidate[] => {
    if (family === 'evenodd') {
        return [
            { label: 'Even', contract: 'DIGITEVEN', side: 0, barrier: null, win: [0, 2, 4, 6, 8], p0: 0.5,
                describe: (h, z, w) => `Even ${h}% over ${w} ticks (z ${signed(z)}).` },
            { label: 'Odd', contract: 'DIGITODD', side: 1, barrier: null, win: [1, 3, 5, 7, 9], p0: 0.5,
                describe: (h, z, w) => `Odd ${h}% over ${w} ticks (z ${signed(z)}).` },
        ];
    }
    if (family === 'overunder') {
        const out: Candidate[] = [];
        for (let b = 0; b <= 8; b += 1) {
            const win = range(b + 1, 9);
            out.push({ label: `Over ${b}`, contract: 'DIGITOVER', side: 0, barrier: b, win, p0: win.length / 10,
                describe: (h, z, w) => `Digits above ${b} hit ${h}% vs ${win.length * 10}% expected over ${w} ticks (z ${signed(z)}).` });
        }
        for (let b = 1; b <= 9; b += 1) {
            const win = range(0, b - 1);
            out.push({ label: `Under ${b}`, contract: 'DIGITUNDER', side: 1, barrier: b, win, p0: win.length / 10,
                describe: (h, z, w) => `Digits below ${b} hit ${h}% vs ${win.length * 10}% expected over ${w} ticks (z ${signed(z)}).` });
        }
        return out;
    }
    const out: Candidate[] = [];
    for (let d = 0; d <= 9; d += 1) {
        const gap = gapOf(digits, d);
        out.push({ label: `Matches ${d}`, contract: 'DIGITMATCH', side: 0, barrier: d, win: [d], p0: 0.1, gap,
            describe: (h, z, w) => `Digit ${d} printed ${h}% vs 10% expected over ${w} ticks (z ${signed(z)}); last seen ${gap} ticks ago.` });
        out.push({ label: `Differs ${d}`, contract: 'DIGITDIFF', side: 1, barrier: d, win: range(0, 9).filter(x => x !== d), p0: 0.9, gap,
            describe: (h, z, w) => `Digit ${d} printed only ${round1(100 - h)}% vs 10% expected over ${w} ticks (z ${signed(z)}); last seen ${gap} ticks ago.` });
    }
    return out;
};

// ---------------------------------------------------------------------------
// Scanning all markets
// ---------------------------------------------------------------------------

export type MarketInput = { symbol: string; name: string; digits: number[]; price?: number | null };

export type MarketScan = {
    symbol: string;
    name: string;
    ready: boolean;
    n: number;
    ticksUsed: number;
    lastDigit: number | null;
    lastPrice: number | null;
    recent: number[];
    /** Digit frequencies (%) over the scan window. */
    digitPct: number[];
    best: ScanPick | null;
    alternatives: ScanPick[];
};

export type ScanResult = {
    family: Family;
    ticks: number;
    marketsReady: number;
    hypotheses: number;
    markets: MarketScan[];
    /** Ready markets, best first. */
    ranked: MarketScan[];
    note: string;
};

const byStrength = (a: ScanPick, b: ScanPick) => b.score - a.score || b.z - a.z;

export const scanMarkets = (family: Family, inputs: MarketInput[], ticks: number): ScanResult => {
    const def = FAMILIES[family];
    const ready = inputs.filter(input => input.digits.length >= MIN_SCAN_TICKS).length;
    const tests = Math.max(1, ready * def.tests);

    const markets: MarketScan[] = inputs.map(input => {
        const { digits } = input;
        if (digits.length < MIN_SCAN_TICKS) {
            return {
                symbol: input.symbol, name: input.name, ready: false, n: digits.length, ticksUsed: 0, lastDigit: null,
                lastPrice: input.price ?? null, recent: digits.slice(-12), digitPct: new Array<number>(10).fill(0),
                best: null, alternatives: [],
            };
        }
        const windows = scanWindows(digits.length, ticks);
        const hists = windows.map(window => histogram(digits, window));
        const used = windows[windows.length - 1];
        const picks = candidatesFor(family, digits).map(c => evaluate(family, c, hists, windows, tests)).sort(byStrength);
        return {
            symbol: input.symbol, name: input.name, ready: true, n: digits.length, ticksUsed: used,
            lastDigit: digits[digits.length - 1], lastPrice: input.price ?? null, recent: digits.slice(-12),
            digitPct: histogram(digits, used).map(count => round1((count / used) * 100)),
            best: picks[0], alternatives: picks.slice(1, 3),
        };
    });

    const ranked = markets
        .filter(market => market.ready && market.best)
        .sort((a, b) => byStrength(a.best as ScanPick, b.best as ScanPick) || (a.best as ScanPick).adjP - (b.best as ScanPick).adjP);

    const top = ranked[0]?.best;
    const note = !ranked.length
        ? 'Collecting ticks…'
        : top && top.strength === 'none'
            ? 'No statistically meaningful deviation right now. Rankings are noise-level.'
            : '';

    return { family, ticks, marketsReady: ready, hypotheses: tests, markets, ranked, note };
};

// ---------------------------------------------------------------------------
// Trader panel helpers
// ---------------------------------------------------------------------------

/** Past win-rate (%) of the two buttons for the current barrier, from the digit frequencies. */
export const pairPercents = (digitPct: number[], family: Family, barrier: number): [number, number] => {
    const sum = (test: (digit: number) => boolean) => round1(digitPct.reduce((acc, pct, digit) => acc + (test(digit) ? pct : 0), 0));
    if (family === 'evenodd') return [sum(d => d % 2 === 0), sum(d => d % 2 === 1)];
    if (family === 'overunder') return [sum(d => d > barrier), sum(d => d < barrier)];
    return [sum(d => d === barrier), sum(d => d !== barrier)];
};

export const needsBarrier = (contract: DigitContract): boolean =>
    contract === 'DIGITOVER' || contract === 'DIGITUNDER' || contract === 'DIGITMATCH' || contract === 'DIGITDIFF';

/** Deriv only offers Over 0-8 and Under 1-9; Matches/Differs accept 0-9. */
export const barrierError = (contract: DigitContract, barrier: number): string | null => {
    if (!needsBarrier(contract)) return null;
    if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) return 'Barrier must be a digit from 0 to 9.';
    if (contract === 'DIGITOVER' && barrier > 8) return 'Over supports barriers 0 to 8.';
    if (contract === 'DIGITUNDER' && barrier < 1) return 'Under supports barriers 1 to 9.';
    return null;
};

// ---------------------------------------------------------------------------
// Bulk run bookkeeping
// ---------------------------------------------------------------------------

export type BulkParams = { stake: number; runs: number; duration: number; maxLoss: number };

export const DEFAULT_BULK: BulkParams = { stake: 0.5, runs: 1, duration: 1, maxLoss: 5 };
export const MAX_BULK_RUNS = 100;

export const sanitizeBulk = (input: Partial<BulkParams>): BulkParams => {
    const n = (value: unknown, fallback: number, min: number, max: number) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
    };
    return {
        stake: round2(n(input.stake, DEFAULT_BULK.stake, 0.35, 1000)),
        runs: Math.trunc(n(input.runs, DEFAULT_BULK.runs, 1, MAX_BULK_RUNS)),
        duration: Math.trunc(n(input.duration, DEFAULT_BULK.duration, 1, 10)),
        // 0 means "no loss limit".
        maxLoss: round2(n(input.maxLoss, DEFAULT_BULK.maxLoss, 0, 100000)),
    };
};

export type Tally = { placed: number; settled: number; wins: number; losses: number; pnl: number };
export const emptyTally = (): Tally => ({ placed: 0, settled: 0, wins: 0, losses: 0, pnl: 0 });

export const recordPlaced = (tally: Tally): Tally => ({ ...tally, placed: tally.placed + 1 });

export const recordSettled = (tally: Tally, profit: number): Tally => ({
    ...tally,
    settled: tally.settled + 1,
    wins: tally.wins + (profit > 0 ? 1 : 0),
    losses: tally.losses + (profit > 0 ? 0 : 1),
    pnl: round2(tally.pnl + profit),
});

/** Realised losses (settled trades only) have reached the limit. A limit of 0 disables the check. */
export const lossLimitHit = (tally: Tally, maxLoss: number): boolean => maxLoss > 0 && tally.pnl <= -maxLoss;

/** Worst-case stake committed by a bulk run. */
export const exposure = (params: BulkParams): number => round2(params.stake * params.runs);
