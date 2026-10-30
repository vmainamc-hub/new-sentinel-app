// Sixfold danger gates: losing-side pressure and multi-window health. Pure functions, no I/O.
//
// LOSING-SIDE PRESSURE follows the idea in Sentinel's losing-side-pressure / pressure-windows engines: every digit that
// can make the contract LOSE is watched across nested windows (15 / 30 / 60 / 120 ticks). Pressure is CHANGE as well as
// level: a losing digit that is above its fair share AND climbing across the windows is worse than one noisy spike.
// The whole losing side is folded into one 0-100 index with the same state bands and the same hard verdict:
//   CLEAR (calm or building), CAUTION (pressured / hostile), SUPPRESS (hostile and 2+ losing digits climbing together).
// It uses the contract that is about to be bought, so after a loss it reads Over 3's losing digits 0-3, not Over 2's 0-2.
//
// MULTI-WINDOW HEALTH asks whether the contract has been winning at or above its normal rate across 60 / 120 / 240 / 480
// ticks, not only in the latest window. A strong short window over weak long windows is a THRUST, and is not traded.
//
// Honest framing: Deriv digits are generated randomly. These gates do not forecast the next tick. They keep the bot out
// of markets whose recent ticks are leaning against the contract and out of one-window flukes, and they say why.
import { type Contract, losingDigits, winProbability, winningDigits } from './bot';
import { clamp } from './stats';

// ---------- losing-side pressure ----------

export const PRESSURE_WINDOWS = [15, 30, 60, 120] as const;
export const MIN_PRESSURE_TICKS = 120;
/** |pp| below which a transition between windows counts as flat. */
const FLAT_PP = 0.2;

export type PressureState = 'CALM' | 'BUILDING' | 'PRESSURED' | 'HOSTILE';
export type PressureVerdict = 'CLEAR' | 'CAUTION' | 'SUPPRESS';

export type LosingDigitReading = {
    digit: number;
    /** 0-100 individual threat. */
    threat: number;
    /** Share in the 60-tick window minus its fair 10%, in percentage points. */
    levelPp: number;
    /** Share in the 15-tick window minus the 120-tick window, in percentage points. */
    ratePp: number;
    rising: boolean;
};

export type LosingSidePressure = {
    /** False while there are too few ticks; every other field is neutral then. */
    measurable: boolean;
    /** 0-100 hostility of the whole losing side. */
    index: number;
    state: PressureState;
    verdict: PressureVerdict;
    risingCount: number;
    /** Losing digits, worst first. */
    digits: LosingDigitReading[];
    /** Share of ticks that landed on a losing digit in each window, %, ordered 120, 60, 30, 15. */
    groupPct: number[];
    /** What the losing side would show on a fair stream, %. */
    fairPct: number;
    reason: string;
};

const stateOf = (index: number): PressureState =>
    index >= 72 ? 'HOSTILE' : index >= 50 ? 'PRESSURED' : index >= 28 ? 'BUILDING' : 'CALM';

const verdictOf = (state: PressureState, rising: number): PressureVerdict =>
    state === 'HOSTILE' && rising >= 2 ? 'SUPPRESS' : state === 'HOSTILE' || state === 'PRESSURED' ? 'CAUTION' : 'CLEAR';

const neutral = (fairPct: number, reason: string): LosingSidePressure => ({
    measurable: false,
    index: 0,
    state: 'CALM',
    verdict: 'CLEAR',
    risingCount: 0,
    digits: [],
    groupPct: [],
    fairPct,
    reason,
});

function countsOf(series: readonly number[], w: number): number[] {
    const c = new Array<number>(10).fill(0);
    for (let i = Math.max(0, series.length - w); i < series.length; i++) {
        const d = series[i];
        if (d >= 0 && d <= 9) c[d] += 1;
    }
    return c;
}

export function losingSidePressure(series: readonly number[], contract: Contract): LosingSidePressure {
    const losers = losingDigits(contract);
    const fair = losers.length / 10;
    if (series.length < MIN_PRESSURE_TICKS || losers.length === 0 || losers.length === 10) {
        return neutral(fair * 100, `Needs ${MIN_PRESSURE_TICKS} ticks to read the losing side.`);
    }
    const c120 = countsOf(series, 120);
    const c60 = countsOf(series, 60);
    const c30 = countsOf(series, 30);
    const c15 = countsOf(series, 15);

    const digits: LosingDigitReading[] = losers.map(d => {
        const s = [c120[d] / 120, c60[d] / 60, c30[d] / 30, c15[d] / 15];
        const zLevel = (s[1] - 0.1) / Math.sqrt(0.09 / 60);
        const ratePp = (s[3] - s[0]) * 100;
        const steps = [s[1] - s[0], s[2] - s[1], s[3] - s[2]].map(x => x * 100);
        const sign = Math.sign(ratePp);
        const agree = steps.filter(t => Math.abs(t) >= FLAT_PP && Math.sign(t) === sign).length;
        const rising = ratePp > 0 && agree / 3 >= 0.66;
        const zRise = (s[3] - s[0]) / Math.sqrt(0.09 / 15);
        const threat = clamp(18 * Math.max(0, zLevel) + 10 * Math.max(0, zRise) * (rising ? 1 : 0.5), 0, 100);
        return { digit: d, threat, levelPp: (s[1] - 0.1) * 100, ratePp, rising };
    });
    digits.sort((a, b) => b.threat - a.threat);

    const group = (c: number[], w: number) => losers.reduce((sum, d) => sum + c[d], 0) / w;
    const g = [group(c120, 120), group(c60, 60), group(c30, 30), group(c15, 15)];
    const zGroup = (g[1] - fair) / Math.sqrt((fair * (1 - fair)) / 60);
    const zGroupRise = (g[3] - g[0]) / Math.sqrt((fair * (1 - fair)) / 15);
    const groupThreat = clamp(18 * Math.max(0, zGroup) + 10 * Math.max(0, zGroupRise), 0, 100);
    const massDrift = clamp(20 * Math.max(0, zGroupRise), 0, 100);

    const worst = digits[0]?.threat ?? 0;
    const mean = digits.reduce((s, x) => s + x.threat, 0) / digits.length;
    const risingCount = digits.filter(x => x.rising).length;
    const breadth = (risingCount / digits.length) * 100;
    const index = clamp(0.3 * worst + 0.2 * mean + 0.2 * breadth + 0.2 * groupThreat + 0.1 * massDrift, 0, 100);

    const state = stateOf(index);
    const verdict = verdictOf(state, risingCount);
    const top = digits
        .slice(0, 3)
        .map(x => `${x.digit} (${x.levelPp >= 0 ? '+' : ''}${x.levelPp.toFixed(0)}pp${x.rising ? ' ↑' : ''})`)
        .join(', ');
    return {
        measurable: true,
        index: Math.round(index),
        state,
        verdict,
        risingCount,
        digits,
        groupPct: g.map(x => x * 100),
        fairPct: fair * 100,
        reason: `Losing digits ${losers.join('/')} at ${(g[1] * 100).toFixed(0)}% of the last 60 ticks (fair ${(fair * 100).toFixed(0)}%), ${risingCount}/${losers.length} climbing; worst ${top}. Pressure ${Math.round(index)}/100 (${state.toLowerCase()}).`,
    };
}

/** Default ceiling on the pressure index for a market to be traded. */
export const DEFAULT_PRESSURE_MAX = 35;

export type GateResult = { ok: boolean; reason: string };

/**
 * Pressure gate: the losing side must be quiet enough. A SUPPRESS verdict always blocks, whatever the ceiling.
 * Not measurable yet (too few ticks) passes, because the scanner already needs its own history before it arms anything.
 */
export function pressureGate(p: LosingSidePressure, max = DEFAULT_PRESSURE_MAX): GateResult {
    if (!p.measurable) return { ok: true, reason: p.reason };
    if (p.verdict === 'SUPPRESS') return { ok: false, reason: `Losing side hostile and broad: ${p.reason}` };
    if (p.index > max) return { ok: false, reason: `Losing-side pressure ${p.index} is above ${max}: ${p.reason}` };
    return { ok: true, reason: p.reason };
}

// ---------- winning-side pressure ----------

export type WinningSideState = 'RISING' | 'DORMANT' | 'FALLING';

export type WinningSidePressure = {
    measurable: boolean;
    state: WinningSideState;
    /** Share of ticks that would have won the contract in each window, %, ordered 120, 60, 30, 15. */
    groupPct: number[];
    fairPct: number;
    /** Latest window (15) minus the longest (120), in percentage points. */
    ratePp: number;
    /** Window-to-window changes 120>60, 60>30, 30>15, in percentage points. */
    steps: number[];
    reason: string;
};

/**
 * The mirror of losing-side pressure. Calm losers are not enough: the digits that WIN the contract should be gaining share
 * across the nested windows (120, 60, 30, 15), step after step, and the latest window should be at or above its fair share.
 * A winning side that merely sits at its normal rate is DORMANT, and a falling one is FALLING; only RISING passes the gate.
 */
export function winningSidePressure(series: readonly number[], contract: Contract, minRisePp = 2): WinningSidePressure {
    const winners = winningDigits(contract);
    const fair = winners.length / 10;
    if (series.length < MIN_PRESSURE_TICKS || winners.length === 0 || winners.length === 10) {
        return { measurable: false, state: 'DORMANT', groupPct: [], fairPct: fair * 100, ratePp: 0, steps: [], reason: `Needs ${MIN_PRESSURE_TICKS} ticks to read the winning side.` };
    }
    const win = new Set(winners);
    const share = (w: number) => {
        let c = 0;
        for (let i = series.length - w; i < series.length; i++) if (win.has(series[i])) c += 1;
        return c / w;
    };
    const g = [share(120), share(60), share(30), share(15)];
    const steps = [g[1] - g[0], g[2] - g[1], g[3] - g[2]].map(x => x * 100);
    const ratePp = (g[3] - g[0]) * 100;
    const up = steps.filter(t => t >= FLAT_PP).length;
    const down = steps.filter(t => t <= -FLAT_PP).length;
    const state: WinningSideState = ratePp >= minRisePp && up >= 2 && g[3] >= fair ? 'RISING' : ratePp <= -minRisePp && down >= 2 ? 'FALLING' : 'DORMANT';
    const text = `Winning digits ${winners.join('/')} at ${g.map(x => `${(x * 100).toFixed(0)}%`).join(' > ')} over the last 120 / 60 / 30 / 15 ticks (fair ${(fair * 100).toFixed(0)}%)`;
    return { measurable: true, state, groupPct: g.map(x => x * 100), fairPct: fair * 100, ratePp, steps, reason: `${text}, ${state.toLowerCase()} (${ratePp >= 0 ? '+' : ''}${ratePp.toFixed(1)}pp).` };
}

/** Winning-side gate: the winning side must be visibly gaining across the windows, not dormant. Too few ticks passes. */
export function winningSideGate(p: WinningSidePressure): GateResult {
    if (!p.measurable || p.state === 'RISING') return { ok: true, reason: p.reason };
    return { ok: false, reason: `Winning side ${p.state === 'FALLING' ? 'falling' : 'dormant'}, not building: ${p.reason}` };
}

// ---------- multi-window health ----------

export const HEALTH_WINDOWS = [60, 120, 240, 480] as const;
export const MIN_HEALTH_TICKS = 480;

export type HealthVerdict = 'LOADING' | 'CONSISTENT' | 'THRUST' | 'FADING' | 'WEAK';

export type WindowRow = {
    window: number;
    /** Share of ticks in the window that would have won the contract. */
    rate: number;
    /** Distance from the contract's normal win rate, in standard errors. */
    z: number;
};

export type MultiWindowHealth = {
    verdict: HealthVerdict;
    rows: WindowRow[];
    normal: number;
    /** Windows at or above the normal rate. */
    above: number;
    reason: string;
};

export function multiWindowHealth(series: readonly number[], contract: Contract): MultiWindowHealth {
    const p = winProbability(contract);
    if (series.length < MIN_HEALTH_TICKS) {
        return { verdict: 'LOADING', rows: [], normal: p, above: 0, reason: `Needs ${MIN_HEALTH_TICKS} ticks to compare windows.` };
    }
    const win = new Set(winningDigits(contract));
    const rows: WindowRow[] = HEALTH_WINDOWS.map(window => {
        let wins = 0;
        for (let i = series.length - window; i < series.length; i++) if (win.has(series[i])) wins += 1;
        const rate = wins / window;
        return { window, rate, z: (rate - p) / Math.sqrt((p * (1 - p)) / window) };
    });
    const above = rows.filter(r => r.z >= 0).length;
    const shortest = rows[0];
    const longer = rows.slice(1);
    const worstZ = Math.min(...rows.map(r => r.z));
    const text = rows.map(r => `${r.window}: ${(r.rate * 100).toFixed(0)}%`).join(' · ');
    const tail = `${text} (normal ${(p * 100).toFixed(0)}%)`;
    let verdict: HealthVerdict;
    let why: string;
    if (shortest.z >= 1 && longer.filter(r => r.z < 0).length >= 2) {
        verdict = 'THRUST';
        why = 'Strong only in the latest window; the longer windows are not backing it.';
    } else if (above >= 3 && worstZ > -1.5) {
        verdict = 'CONSISTENT';
        why = `At or above normal in ${above} of 4 windows.`;
    } else if (shortest.z < -1 && longer.filter(r => r.z >= 0).length >= 2) {
        verdict = 'FADING';
        why = 'Longer windows are fine but the latest one has turned down.';
    } else {
        verdict = 'WEAK';
        why = `At or above normal in only ${above} of 4 windows.`;
    }
    return { verdict, rows, normal: p, above, reason: `${why} ${tail}` };
}

/** Multi-window gate: only a CONSISTENT contract passes. Still loading passes, as for the pressure gate. */
export function multiWindowGate(h: MultiWindowHealth): GateResult {
    if (h.verdict === 'LOADING' || h.verdict === 'CONSISTENT') return { ok: true, reason: h.reason };
    return { ok: false, reason: `${h.verdict.toLowerCase()}: ${h.reason}` };
}