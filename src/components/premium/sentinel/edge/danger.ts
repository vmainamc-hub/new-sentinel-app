// SENTINEL AI EDGE 2/3: cross-market danger and signal-frequency control. Pure and framework-free.
//
// Two gates that look at the whole book instead of one market, ported from Precision Edge V2 (cross-market-danger, signal-frequency).
// The originals read "manipulation" and "crowding" scores that only the V2 engine produces, so the inputs are rebuilt here from what
// Sentinel has: the live digits of every market. The structure is the same: three components folded into a 0-100 score with a level,
// and a block on every signal when the level is high.
//
//   cold spike     many markets running cold on the contracts Sentinel trades at the same moment
//   common factor  the markets are all skewed the SAME way at once. Independent markets cannot do this: the average skew of n
//                  independent markets has a standard deviation of 1/sqrt(n), so an average several times that is a shared event
//   digit surge    markets where one digit is far above its share
//
// Frequency control is the V2 rule set: a cooldown per market after a trade, a signal must survive N consecutive scans before it is
// traded, and an hourly budget.
//
// Honest limit: Deriv's volatility indices are separate random processes. If they really are independent this gate stays calm and
// blocks nothing, which is the correct answer for them; it earns its keep only when something moves the markets together.
import { type Contract, winningDigits, winProbability } from '../../sixfold/bot';

export type DangerLevel = 'calm' | 'elevated' | 'high' | 'extreme';

export type CrossMarketDanger = {
    level: DangerLevel;
    /** 0-100. */
    score: number;
    reasons: string[];
    /** True when every signal should wait. */
    block: boolean;
    components: { coldSpike: number; commonFactor: number; digitSurge: number };
    /** Markets read. */
    markets: number;
};

/** Fewest markets the common-factor test is meaningful for. */
export const MIN_MARKETS = 4;
/** Ticks each component reads. */
export const COLD_WINDOW = 30;
export const SKEW_WINDOW = 60;
export const COLD_Z = -1.5;
export const SURGE_Z = 3;
export const BLOCK_SCORE = 55;
export const ELEVATED_SCORE = 30;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const winZ = (digits: readonly number[], c: Contract): number => {
    const p = winProbability(c);
    const win = new Set(winningDigits(c));
    let w = 0;
    for (const d of digits) if (win.has(d)) w += 1;
    return (w / digits.length - p) / Math.sqrt((p * (1 - p)) / digits.length);
};

export const assessCrossMarketDanger = (
    series: Readonly<Record<string, readonly number[]>>,
    symbols: readonly string[],
    contracts: readonly Contract[]
): CrossMarketDanger => {
    const ready = symbols.filter(s => (series[s]?.length ?? 0) >= SKEW_WINDOW);
    const calm = (reason: string): CrossMarketDanger => ({
        level: 'calm',
        score: 0,
        reasons: [reason],
        block: false,
        components: { coldSpike: 0, commonFactor: 0, digitSurge: 0 },
        markets: ready.length,
    });
    if (ready.length < MIN_MARKETS || contracts.length === 0) return calm(`only ${ready.length} markets readable`);

    let cold = 0;
    let surge = 0;
    const skew: number[] = [];
    for (const symbol of ready) {
        const digits = series[symbol];
        const recent = digits.slice(-COLD_WINDOW);
        if (mean(contracts.map(c => winZ(recent, c))) <= COLD_Z) cold += 1;

        const long = digits.slice(-SKEW_WINDOW);
        const high = long.filter(d => d >= 5).length / long.length;
        skew.push((high - 0.5) / Math.sqrt(0.25 / long.length));
        const counts = new Array<number>(10).fill(0);
        for (const d of long) counts[d] += 1;
        const sd = Math.sqrt(long.length * 0.1 * 0.9);
        if (Math.max(...counts.map(k => (k - long.length * 0.1) / sd)) >= SURGE_Z) surge += 1;
    }
    const n = ready.length;
    const coldSpike = clamp01((cold / n) * 1.3) * 100;
    // Under independence the mean of n unit-variance skews, times sqrt(n), is itself unit-variance.
    const common = Math.abs(mean(skew)) * Math.sqrt(n);
    const commonFactor = clamp01((common - 1.5) / 2.5) * 100;
    const digitSurge = clamp01((surge / n) * 1.2) * 100;

    const score = 0.4 * coldSpike + 0.35 * commonFactor + 0.25 * digitSurge;
    const level: DangerLevel =
        score >= 75 ? 'extreme' : score >= BLOCK_SCORE ? 'high' : score >= ELEVATED_SCORE ? 'elevated' : 'calm';
    const reasons: string[] = [];
    if (coldSpike > 40) reasons.push(`${cold} of ${n} markets cold at once`);
    if (commonFactor > 40) reasons.push(`markets skewed the same way together (${common.toFixed(1)} sd)`);
    if (digitSurge > 40) reasons.push(`${surge} of ${n} markets with one digit surging`);
    if (reasons.length === 0) reasons.push('no simultaneous anomalies');
    return {
        level,
        score: Math.round(score * 10) / 10,
        reasons,
        block: level === 'high' || level === 'extreme',
        components: { coldSpike, commonFactor, digitSurge },
        markets: n,
    };
};

// ---------------------------------------------------------------------------
// Signal frequency
// ---------------------------------------------------------------------------

export type FrequencyConfig = {
    /** Rest after a trade on a market, ms. 0 = off. */
    cooldownMs: number;
    /** Consecutive scans a signal must stay on the board before it is traded. 0 or 1 = off. */
    minHoldScans: number;
    /** Most trades per rolling hour. 0 = off. */
    hourlyBudget: number;
};

export const DEFAULT_FREQUENCY: FrequencyConfig = { cooldownMs: 20_000, minHoldScans: 2, hourlyBudget: 40 };

export type FrequencyVerdict = { allow: boolean; reason: string };

const HOUR_MS = 3_600_000;

/** Mutable on purpose: one gate lives for the session, the way the runner's own guards do. */
export class FrequencyGate {
    private hold = new Map<string, number>();
    private lastTrade = new Map<string, number>();
    private trades: number[] = [];

    /** Call once per scan with the keys currently on the board. A key that left the board loses its hold. */
    observe(keys: Iterable<string>): void {
        const present = new Set(keys);
        const next = new Map<string, number>();
        for (const key of present) next.set(key, (this.hold.get(key) ?? 0) + 1);
        this.hold = next;
    }

    /** Call when a trade on `symbol` is bought. */
    record(symbol: string, now: number): void {
        this.lastTrade.set(symbol, now);
        this.trades.push(now);
    }

    held(key: string): number {
        return this.hold.get(key) ?? 0;
    }

    tradesInLastHour(now: number): number {
        this.trades = this.trades.filter(t => now - t <= HOUR_MS);
        return this.trades.length;
    }

    /**
     * `recovering` trades skip all three rules: a martingale step that is delayed or dropped strands the stake already lost.
     * `budget` false skips the hourly budget (the Hunter, whose job is to always have a candidate).
     */
    check(
        symbol: string,
        key: string,
        now: number,
        cfg: FrequencyConfig,
        opts: { recovering: boolean; budget: boolean }
    ): FrequencyVerdict {
        if (opts.recovering) return { allow: true, reason: '' };
        const last = this.lastTrade.get(symbol);
        if (cfg.cooldownMs > 0 && last !== undefined && now - last < cfg.cooldownMs)
            return {
                allow: false,
                reason: `Frequency: ${symbol} rests ${Math.ceil((cfg.cooldownMs - (now - last)) / 1000)}s after its last trade`,
            };
        const held = this.held(key);
        if (cfg.minHoldScans > 1 && held < cfg.minHoldScans)
            return { allow: false, reason: `Frequency: signal held ${held} of ${cfg.minHoldScans} scans` };
        if (opts.budget && cfg.hourlyBudget > 0) {
            const used = this.tradesInLastHour(now);
            if (used >= cfg.hourlyBudget)
                return { allow: false, reason: `Frequency: hourly budget used (${used} of ${cfg.hourlyBudget})` };
        }
        return { allow: true, reason: '' };
    }

    reset(): void {
        this.hold.clear();
        this.lastTrade.clear();
        this.trades = [];
    }
}
