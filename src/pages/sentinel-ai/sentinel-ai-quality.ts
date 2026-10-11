// SENTINEL AI — signal quality gate (score, danger, blocked).
//
// Why this exists: the engine's operator surface rule only checks digit psychology, rising losing digits, group threat
// and the liquidity sweep. It does not look at the candidate's overall score, danger or `blocked` flag, so a candidate
// the engine itself scored 0 (hard-blocked) can still surface. The gate below runs in the Sentinel AI layer, BEFORE the
// engine's own surfacing rule, so a rejected candidate never hides the next-best one and the engine is never modified.
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { SentinelAiSettings } from './sentinel-ai-types';

export type QualityVerdict = { ok: boolean; reason: string | null };

const finite = (value: unknown): number | null => {
    const n = Number(value);
    return value !== null && value !== undefined && Number.isFinite(n) ? n : null;
};

/** Danger of the candidate on a 0-100 scale: the composed danger when present, else the market's raw danger. */
export const dangerOf = (opp: Pick<RankedOpportunity, 'dangerComposition' | 'intel'>): number | null =>
    finite(opp.dangerComposition?.total) ?? finite(opp.intel?.danger);

export const qualityVerdict = (
    opp: Pick<RankedOpportunity, 'score' | 'blocked' | 'dangerComposition' | 'intel'>,
    settings: Pick<SentinelAiSettings, 'minScore' | 'maxDanger' | 'skipBlocked'>,
    /** Widens the score and danger limits by this many points (used for a signal that is already waiting). */
    tolerance = 0
): QualityVerdict => {
    if (settings.skipBlocked && (opp.blocked || opp.dangerComposition?.isHardBlocked)) {
        return { ok: false, reason: 'blocked by the engine' };
    }
    const score = finite(opp.score) ?? 0;
    if (settings.minScore > 0 && score < settings.minScore - tolerance) {
        return { ok: false, reason: `score ${Math.round(score)} is below ${settings.minScore}` };
    }
    const danger = dangerOf(opp);
    if (settings.maxDanger > 0 && danger !== null && danger > settings.maxDanger + tolerance) {
        return { ok: false, reason: `danger ${Math.round(danger)} is above ${settings.maxDanger}` };
    }
    return { ok: true, reason: null };
};
