// SENTINEL AI EDGE 1/3: Kalman signal health. Pure and framework-free.
//
// Pulse asks "has this contract been winning more than its fair share in 4 windows?". That is a snapshot. This module adds what the
// snapshot lacks: a filtered estimate of the contract's win rate with its UNCERTAINTY, and which way it is drifting. The maths is the
// constant-velocity Kalman filter from the Precision Edge V2 engine (migration-kalman), run over blocks of recent ticks instead of a
// hand-made trend rule. Out of it come three things the runner can act on:
//   - the filtered win rate and whether its lower bound clears the fair rate (a confident signal),
//   - the drift in standard errors (a rising or a decaying signal),
//   - the ticks of life left if it keeps drifting toward the fair rate (a signal about to expire is not entered).
// Honest limit: Deriv digits are generated randomly. A filtered rate above fair does not make the next digit likelier to win. This
// decides which signals are young and which are dying, so the bot does not enter on stale ones. It cannot create an edge.
import { type Contract, winningDigits, winProbability } from '../../sixfold/bot';

/** Ticks per observation. A binomial share over 25 ticks has a standard deviation of about 9 points at a 70% rate. */
export const BLOCK = 25;
/** Newest blocks used (24 x 25 = 600 ticks). */
export const MAX_BLOCKS = 24;
/** Fewest blocks before the filter is trusted (12 x 25 = 300 ticks, Pulse's own minimum). */
export const MIN_BLOCKS = 12;
/** Process noise: how fast the true rate may wander (level) and change its drift (velocity), per block. */
export const Q_LEVEL = 1e-4;
export const Q_VELOCITY = 5e-6;
/** The drift must be this many standard errors from zero to count as rising or falling. */
export const TREND_Z = 1.5;
/** A signal expected to last fewer ticks than this is dying. */
export const MIN_LIFE_TICKS = 20;
/** One-sided 95% multiplier for the lower bound. */
const Z95 = 1.645;

export type KalmanState = {
    /** Filtered win share, 0..1. */
    p: number;
    /** Filtered drift, change of the share per block. */
    v: number;
    /** Error covariance, row-major [P00, P01, P10, P11]. */
    cov: [number, number, number, number];
    n: number;
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const initKalman = (p0: number, priorVar = 0.01): KalmanState => ({
    p: clamp01(p0),
    v: 0,
    cov: [priorVar, 0, 0, 1e-4],
    n: 0,
});

/** Absorbs one block share `z` whose sampling variance is `r`. Returns a new state. */
export const stepKalman = (s: KalmanState, z: number, r: number): KalmanState => {
    const pPred = clamp01(s.p + s.v);
    const [c00, c01, c10, c11] = s.cov;
    // P' = F P F' + Q with F = [[1, 1], [0, 1]]
    const p00 = c00 + c01 + c10 + c11 + Q_LEVEL;
    const p01 = c01 + c11;
    const p10 = c10 + c11;
    const p11 = c11 + Q_VELOCITY;
    const y = clamp01(z) - pPred;
    const sInv = 1 / (p00 + r);
    const k0 = p00 * sInv;
    const k1 = p10 * sInv;
    return {
        p: clamp01(pPred + k0 * y),
        v: s.v + k1 * y,
        cov: [(1 - k0) * p00, (1 - k0) * p01, p10 - k1 * p00, p11 - k1 * p01],
        n: s.n + 1,
    };
};

export type Trend = 'rising' | 'falling' | 'steady';

export type Health = {
    /** Blocks absorbed. */
    blocks: number;
    /** False until MIN_BLOCKS: the read is then neutral and never vetoes. */
    ready: boolean;
    fair: number;
    /** Filtered win rate and its standard deviation. */
    level: number;
    sigma: number;
    /** Level minus 1.645 sigma. Above `fair` means the signal is confident, not just a lucky window. */
    lowerBound: number;
    /** Drift per tick, and in standard errors. */
    velocity: number;
    velocityZ: number;
    trend: Trend;
    /** Ticks until the level reaches the fair rate at the current drift, or null when it is not drifting toward it. */
    lifeTicks: number | null;
};

const blockShares = (series: readonly number[], c: Contract): number[] => {
    const win = new Set(winningDigits(c));
    const use = series.slice(-BLOCK * MAX_BLOCKS);
    const full = Math.floor(use.length / BLOCK);
    const start = use.length - full * BLOCK; // align on the newest tick
    const shares: number[] = [];
    for (let k = 0; k < full; k += 1) {
        let w = 0;
        for (let i = start + k * BLOCK; i < start + (k + 1) * BLOCK; i += 1) if (win.has(use[i])) w += 1;
        shares.push(w / BLOCK);
    }
    return shares;
};

export const readHealth = (series: readonly number[], c: Contract): Health => {
    const fair = winProbability(c);
    const shares = blockShares(series, c);
    const r = (fair * (1 - fair)) / BLOCK;
    let s = initKalman(fair);
    for (const z of shares) s = stepKalman(s, z, r);
    const sigma = Math.sqrt(Math.max(0, s.cov[0]));
    const vSigma = Math.sqrt(Math.max(1e-12, s.cov[3]));
    const velocityZ = s.v / vSigma;
    const trend: Trend = velocityZ >= TREND_Z ? 'rising' : velocityZ <= -TREND_Z ? 'falling' : 'steady';
    const perTick = s.v / BLOCK;
    const lifeTicks = s.p > fair && perTick < 0 ? Math.min(600, (s.p - fair) / -perTick) : null;
    return {
        blocks: shares.length,
        ready: shares.length >= MIN_BLOCKS,
        fair,
        level: s.p,
        sigma,
        lowerBound: s.p - Z95 * sigma,
        velocity: perTick,
        velocityZ,
        trend,
        lifeTicks,
    };
};

export type HealthCall = { allow: boolean; bump: number; rank: number; note: string };
const NEUTRAL: HealthCall = { allow: true, bump: 0, rank: 0, note: '' };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * What the health read means for one signal.
 *  - `hunter`: the Hunter's signal source is a voice, never a gate, so health only moves the bar and the order.
 *  - `recovering`: a recovery trade is only ever delayed by a dying signal, never refused for a weak level (the martingale step
 *    has to be taken somewhere, and waiting costs nothing).
 */
export const judgeHealth = (h: Health, opts: { hunter: boolean; recovering: boolean }): HealthCall => {
    if (!h.ready) return NEUTRAL;
    const rank = Math.max(-3, Math.min(5, (h.level - h.fair) / Math.max(h.sigma, 1e-6))) * 0.8;
    const dying = h.trend === 'falling' && h.lifeTicks !== null && h.lifeTicks < MIN_LIFE_TICKS;
    const gone = h.level <= h.fair;
    if (!opts.hunter && dying)
        return {
            allow: false,
            bump: 0,
            rank,
            note: `Kalman: signal decaying, about ${Math.round(h.lifeTicks ?? 0)} ticks of life left`,
        };
    if (!opts.hunter && !opts.recovering && gone)
        return {
            allow: false,
            bump: 0,
            rank,
            note: `Kalman: filtered win rate ${pct(h.level)} is not above the fair ${pct(h.fair)}`,
        };
    if (h.trend === 'falling')
        return {
            allow: true,
            bump: dying || gone ? 6 : 4,
            rank,
            note: `Kalman: drifting down (${h.velocityZ.toFixed(1)} sd)`,
        };
    if (h.lowerBound > h.fair && h.trend === 'rising')
        return {
            allow: true,
            bump: -3,
            rank,
            note: `Kalman: confident and rising (${pct(h.level)}, floor ${pct(h.lowerBound)})`,
        };
    if (h.lowerBound > h.fair)
        return { allow: true, bump: -1, rank, note: `Kalman: confident (${pct(h.level)}, floor ${pct(h.lowerBound)})` };
    return { allow: true, bump: gone ? 3 : 0, rank, note: `Kalman: ${pct(h.level)} filtered, not yet confident` };
};
