// SENTINEL AI — the narrow interface the runner needs from the Sentinel Signal Engine.
// Kept separate from the real adapter so the runner can be unit-tested with a fake engine.
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { EngineInfo } from './sentinel-ai-types';

/** Plain summary of the momentum evaluation of one candidate. */
export type MomentumInfo = { pass: boolean; measurable: boolean; score: number; blockers: string[] };

/** A candidate that passed the engine's surface vetting, with its momentum result. */
export type VettedCandidate = { opportunity: RankedOpportunity; momentum: MomentumInfo; blocked: boolean };

export type EngineSample = {
    info: EngineInfo;
    /**
     * The candidate that may be traded right now: the first surface-vetted candidate, in the engine's rank order, that
     * also passes momentum when momentum is required (or simply the first one when it is not), or null.
     */
    surfaced: RankedOpportunity | null;
    /** Every surface-vetted candidate with its momentum result, in rank order. Optional for simple engines. */
    vetted?: VettedCandidate[];
};

export type SampleOptions = {
    /** Only candidates whose recent digit movement favours the contract may be traded. Default false here. */
    requireMomentum?: boolean;
};

/** Lets the runner keep a cell out of the feed (e.g. Deriv refused that contract) so the next-best signal surfaces. */
export type SignalExclusion = (symbol: string, contractId: string, opportunity: RankedOpportunity) => boolean;

export interface SentinelAiEngine {
    /** Starts continuous analysis (reference-counted by the engine). Returns the release function. */
    retain(): () => void;
    /** Samples the engine's current state. Cheap enough to call about once per second. */
    sample(exclude?: SignalExclusion, options?: SampleOptions): EngineSample;
    /** Calls back after every tick of every analysed market (symbol only; read the digit via getLastDigit). */
    onTick(callback: (symbol: string) => void): () => void;
    /** The most recent printed digit for a market, or null when nothing has printed yet. */
    getLastDigit(symbol: string): number | null;
    /** Every market the engine analyses, for the radar. Optional for simple engines. */
    markets?(): Array<{ symbol: string; name: string }>;
}
