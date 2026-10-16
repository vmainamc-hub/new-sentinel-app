// Reads a simulated bot's recent trades and puts a plain-language state on the contract.
//
// These states describe how the contract has BEEN behaving for the bot (recent W/L versus what it normally does and
// versus what it must do to break even). They are not forecasts: on a fair digit stream a contract that has just run
// hot or cold is no more likely to continue than to reverse.

import { type BotRun, breakEvenRate, type Contract, windowStats, winProbability } from './bot';
import { zScore } from './stats';

export type ViabilityState =
    /** Not enough simulated trades yet to say anything. */
    | 'WARMING'
    /** Running at or above break-even recently, and the short and long windows agree. */
    | 'VIABLE'
    /** At its normal rate, which is below break-even once the payout margin is paid. The usual state. */
    | 'STEADY'
    /** The short window disagrees with the long one: the contract is swinging. */
    | 'UNSTABLE'
    /** Was winning (looked attractive), then recently delivered the opposite: buyers of this contract were trapped. */
    | 'TRAP'
    /** Running well below its normal rate: what players call "manipulated" against this side. Statistical, not proof. */
    | 'HOSTILE';

export const STATE_TEXT: Record<ViabilityState, { label: string; blurb: string }> = {
    WARMING: { label: 'WARMING UP', blurb: 'Too few simulated trades to judge.' },
    VIABLE: { label: 'VIABLE', blurb: 'Recent trades are at or above break-even and the windows agree.' },
    STEADY: { label: 'STEADY', blurb: 'Behaving normally: below break-even, as the payout margin implies.' },
    UNSTABLE: { label: 'UNSTABLE', blurb: 'Short and long windows disagree: results are swinging.' },
    TRAP: { label: 'TRAP', blurb: 'It looked good, then delivered the opposite: buyers of this side are caught.' },
    HOSTILE: {
        label: 'HOSTILE',
        blurb: 'Running well below its normal rate. Looks manipulated against this side, but that is a statistical reading.',
    },
};

export const THRESHOLDS = {
    minTrades: 20,
    /** |z(last 20) - z(last 50)| at or above this marks the contract unstable. */
    unstableGap: 1.75,
    /** Hostile when the last 50 trades sit this many sigmas below the normal rate, or the last 20 this many. */
    hostile50: -1.5,
    hostile20: -2.0,
    /** Trap: the 30 trades before the last 20 were at least this many sigmas above normal, and the last 20 this far below. */
    trapBait: 1.0,
    trapDelivery: -1.0,
} as const;

export type Assessment = {
    state: ViabilityState;
    reasons: string[];
    p0: number;
    breakEven: number;
    trades: number;
    last20: { n: number; wins: number; rate: number | null; z: number };
    last50: { n: number; wins: number; rate: number | null; z: number };
    all: { n: number; wins: number; rate: number | null; z: number };
    /** Last-20 win rate minus break-even, in percentage points. Positive = beating the payout recently. */
    edge20pp: number | null;
    /** z of the 30 trades before the last 20 (the "bait" window), if they exist. */
    baitZ: number | null;
};

const withZ = (trades: BotRun['trades'], count: number | undefined, p0: number) => {
    const w = windowStats(trades, count);
    return { ...w, z: zScore(w.wins, w.n, p0) };
};

export function assessRun(run: BotRun): Assessment {
    const c: Contract = run.contract;
    const p0 = winProbability(c),
        be = breakEvenRate(p0, run.config.margin);
    const t = run.trades;
    const last20 = withZ(t, 20, p0),
        last50 = withZ(t, 50, p0),
        all = withZ(t, undefined, p0);
    // Bait window = the up-to-30 trades just before the last 20.
    const before = t.slice(Math.max(0, t.length - 50), Math.max(0, t.length - 20));
    const bw = before.filter(x => x.won).length;
    const baitZ = before.length >= 15 ? zScore(bw, before.length, p0) : null;
    const edge20pp = last20.rate === null ? null : (last20.rate - be) * 100;
    const reasons: string[] = [];
    const base = { p0, breakEven: be, trades: t.length, last20, last50, all, edge20pp, baitZ };

    if (t.length < THRESHOLDS.minTrades) {
        reasons.push(`Only ${t.length} simulated trades so far (need ${THRESHOLDS.minTrades}).`);
        return { state: 'WARMING', reasons, ...base };
    }
    const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);

    if (baitZ !== null && baitZ >= THRESHOLDS.trapBait && last20.z <= THRESHOLDS.trapDelivery) {
        reasons.push(
            `Earlier trades ran hot (${baitZ.toFixed(1)}σ above normal), then the last 20 fell to ${pct(last20.rate)} (${last20.z.toFixed(1)}σ).`
        );
        return { state: 'TRAP', reasons, ...base };
    }
    if (last50.z <= THRESHOLDS.hostile50 || last20.z <= THRESHOLDS.hostile20) {
        reasons.push(
            `Last 20 trades won ${pct(last20.rate)} and the last 50 won ${pct(last50.rate)}, against a normal ${pct(p0)}.`
        );
        return { state: 'HOSTILE', reasons, ...base };
    }
    if (Math.abs(last20.z - last50.z) >= THRESHOLDS.unstableGap) {
        reasons.push(`Last 20 won ${pct(last20.rate)} but the last 50 won ${pct(last50.rate)}: the windows disagree.`);
        return { state: 'UNSTABLE', reasons, ...base };
    }
    if ((last50.rate ?? 0) >= be && (last20.rate ?? 0) >= be - 0.03) {
        reasons.push(
            `Last 50 won ${pct(last50.rate)} and the last 20 won ${pct(last20.rate)}; break-even is ${pct(be)}.`
        );
        return { state: 'VIABLE', reasons, ...base };
    }
    reasons.push(`Last 20 won ${pct(last20.rate)}, last 50 won ${pct(last50.rate)}; break-even is ${pct(be)}.`);
    return { state: 'STEADY', reasons, ...base };
}
