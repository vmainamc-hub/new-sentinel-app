// SENTINEL AI (unified): the Sentinel signal producer.
//
// The engine's own surface rule admits a candidate only when FOUR things hold at once: digit psychology SUPPORT 65+, no losing-side
// digit gaining, group threat under 10 and a CONFIRMED liquidity sweep. That is a rare moment, so most of the time the engine
// surfaced nothing and the machine was left to Insight Fusion alone. This producer keeps the engine and its rule exactly as they are
// and reads the engine's whole ranking in three honest tiers, so Sentinel speaks every so often and says how sure it is:
//
//   confirmed  all four surface conditions hold (the engine's own signal)
//   building   a near miss: not blocked, psychology SUPPORT-leaning, at most one losing digit gaining, threat under 20, sweep not required
//   leading    no near miss exists: the best-ranked unblocked contract of the moment, with the danger the engine itself allows
//
// A weaker tier asks the scanner for a higher bar (see overlay.ts), so more signals never means lower standards for a trade.
import { evaluateSurfaceVetting } from '@/sentinel-engine/lib/apex/surface-vetting';
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import { selectTradable } from '@/sentinel-engine/lib/momentum/momentum-gate';

export type SignalTier = 'confirmed' | 'building' | 'leading';

export const BUILDING_PSYCHOLOGY_MIN = 50;
export const BUILDING_THREAT_MAX = 20;
export const BUILDING_RISING_MAX = 1;
/** Most contracts each weaker tier may add per read. */
export const BUILDING_LIMIT = 6;
export const LEADING_LIMIT = 3;
/** The engine's own danger ceiling for a tradable opportunity (DEFAULT_SCAN_OPTIONS.maxDanger). */
export const LEADING_DANGER_MAX = 65;

export type TieredCandidate = { opportunity: RankedOpportunity; tier: SignalTier; blocked: boolean };

const hardBlocked = (o: RankedOpportunity) => Boolean(o.blocked || o.dangerComposition?.isHardBlocked);
const dangerOf = (o: RankedOpportunity): number | null => {
    const n = Number(o.dangerComposition?.total ?? o.intel?.danger);
    return Number.isFinite(n) ? n : null;
};

export const tierOf = (o: RankedOpportunity): SignalTier | null => {
    if (hardBlocked(o)) return null;
    const v = evaluateSurfaceVetting(o);
    if (v.pass) return 'confirmed';
    const psych = o.digitPsychology;
    const psychOk = Boolean(psych) && psych.verdict === 'SUPPORT' && psych.score >= BUILDING_PSYCHOLOGY_MIN;
    const risingOk = v.losingDigitsRising >= 0 && v.losingDigitsRising <= BUILDING_RISING_MAX;
    const threatOk = v.groupThreat !== null && v.groupThreat < BUILDING_THREAT_MAX;
    if (psychOk && risingOk && threatOk) return 'building';
    const danger = dangerOf(o);
    return danger === null || danger <= LEADING_DANGER_MAX ? 'leading' : null;
};

/**
 * Tiers the engine's ranking (best first). `leading` is only used for candidates no better tier covers, and only when the
 * higher tiers produced nothing, so a quiet board still gets a Sentinel opinion but a busy one is not diluted.
 */
export const produceSignals = (ranked: readonly RankedOpportunity[], requireMomentum: boolean): TieredCandidate[] => {
    const confirmed: RankedOpportunity[] = [];
    const building: RankedOpportunity[] = [];
    const leading: RankedOpportunity[] = [];
    for (const o of ranked) {
        const tier = tierOf(o);
        if (tier === 'confirmed') confirmed.push(o);
        else if (tier === 'building' && building.length < BUILDING_LIMIT) building.push(o);
        else if (tier === 'leading' && leading.length < LEADING_LIMIT) leading.push(o);
    }
    const chosen: Array<[RankedOpportunity[], SignalTier]> = [
        [confirmed, 'confirmed'],
        [building, 'building'],
    ];
    if (confirmed.length + building.length === 0) chosen.push([leading, 'leading']);
    const out: TieredCandidate[] = [];
    for (const [list, tier] of chosen) {
        // Momentum is judged by the same gate Sentinel AI always used; blocked ones stay listed so the reason can be shown.
        for (const report of selectTradable(list, { requireMomentum }).reports) {
            out.push({ opportunity: report.candidate, tier, blocked: report.blocked });
        }
    }
    return out;
};
