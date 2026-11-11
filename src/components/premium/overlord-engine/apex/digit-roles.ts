// DIGIT ROLE ASSIGNMENT — single source of truth for the five sensitive
// digits (hot, hot 2, cold, cold 2, rising) and for the barrier-digit colour
// veto.
//
// OPERATOR LAW: digits 2, 3, 6 and 7 may NEVER carry a distinguished colour
// shade. None of the five sensitive roles — green bar (most appearing),
// second green bar (2nd most appearing), red bar (least appearing), second red
// bar (2nd least appearing) and the most-increasing (rising) shade — may land
// on them. They are the bot's own barrier digits, so colouring them would read
// as an edge where none exists. When a vetoed digit would have won a role, the
// role passes to the next eligible digit instead.

/** Digits that can never hold a distinguished colour role. */
export const VETOED_ROLE_DIGITS: readonly number[] = [2, 3, 6, 7];

export function isVetoedRoleDigit(d: number): boolean {
    return VETOED_ROLE_DIGITS.includes(d);
}

export type DigitRole = 'HOT' | 'HOT 2' | 'COLD' | 'COLD 2' | 'RISING';

export interface DigitRoles {
    hot: number;
    hot2: number;
    cold: number;
    cold2: number;
    rising: number;
    /** Raw (un-vetoed) ranking, kept so engines can detect barrier-digit dominance. */
    raw: { hot: number; hot2: number; cold: number; cold2: number; rising: number };
    /** True when the veto actually displaced at least one role. */
    vetoApplied: boolean;
}

const NONE = -1;

/**
 * Assign the five distinguished roles from a per-digit percentage array and a
 * per-digit recent delta array. Pure. Digits 2, 3, 6 and 7 are always excluded.
 */
export function assignDigitRoles(pct: number[], delta: number[], risingMin = 0.01): DigitRoles {
    const ranked = pct.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p || a.i - b.i);
    const eligible = ranked.filter(r => !isVetoedRoleDigit(r.i));

    const raw = {
        hot: ranked[0]?.i ?? NONE,
        hot2: ranked[1]?.i ?? NONE,
        cold: ranked[ranked.length - 1]?.i ?? NONE,
        cold2: ranked[ranked.length - 2]?.i ?? NONE,
        rising: pickRising(delta, risingMin, false),
    };

    const hot = eligible[0]?.i ?? NONE;
    const hot2 = eligible[1]?.i ?? NONE;
    const cold = eligible[eligible.length - 1]?.i ?? NONE;
    const cold2 = eligible[eligible.length - 2]?.i ?? NONE;
    const rising = pickRising(delta, risingMin, true);

    const vetoApplied =
        raw.hot !== hot || raw.hot2 !== hot2 || raw.cold !== cold || raw.cold2 !== cold2 || raw.rising !== rising;

    return { hot, hot2, cold, cold2, rising, raw, vetoApplied };
}

function pickRising(delta: number[], risingMin: number, applyVeto: boolean): number {
    let best = NONE;
    for (let i = 0; i < delta.length; i++) {
        if (applyVeto && isVetoedRoleDigit(i)) continue;
        if (best === NONE || delta[i] > delta[best]) best = i;
    }
    if (best === NONE) return NONE;
    return delta[best] > risingMin ? best : NONE;
}

/**
 * Does the raw ranking put a vetoed barrier digit into one of the four
 * frequency-extreme roles? Used as a hard veto in the bot signal layer.
 */
export function vetoedDigitsDominate(roles: DigitRoles): number[] {
    const raws = [roles.raw.hot, roles.raw.hot2, roles.raw.cold, roles.raw.cold2];
    return [...new Set(raws.filter(isVetoedRoleDigit))];
}

/** Convenience: percentages + recent deltas from a digit stream. */
export function digitRoleStats(digits: number[], recentWindow = 150) {
    const freq = new Array(10).fill(0);
    digits.forEach(d => freq[d]++);
    const total = digits.length || 1;
    const pct = freq.map(c => (c / total) * 100);

    const recent = digits.slice(-recentWindow);
    const prior = digits.slice(-recentWindow * 2, -recentWindow);
    const rc = new Array(10).fill(0);
    const pc = new Array(10).fill(0);
    recent.forEach(d => rc[d]++);
    prior.forEach(d => pc[d]++);
    const rTot = recent.length || 1;
    const pTot = prior.length || 1;
    const delta = rc.map((c, i) => c / rTot - pc[i] / pTot);

    return { freq, pct, delta, total: digits.length };
}
