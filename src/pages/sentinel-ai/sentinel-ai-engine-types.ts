// SENTINEL AI — the narrow interface the runner needs from the Sentinel Signal Engine.
// Kept separate from the real adapter so the runner can be unit-tested with a fake engine.
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { EngineInfo } from './sentinel-ai-types';

export type EngineSample = {
    info: EngineInfo;
    /** The engine's authoritative surfaced candidate right now (passes the mandatory surface gate), or null. */
    surfaced: RankedOpportunity | null;
};

/** Lets the runner keep a cell out of the feed (e.g. Deriv refused that contract) so the next-best signal surfaces. */
export type SignalExclusion = (symbol: string, contractId: string) => boolean;

export interface SentinelAiEngine {
    /** Starts continuous analysis (reference-counted by the engine). Returns the release function. */
    retain(): () => void;
    /** Samples the engine's current state. Cheap enough to call about once per second. */
    sample(exclude?: SignalExclusion): EngineSample;
    /** Calls back after every tick of every analysed market (symbol only; read the digit via getLastDigit). */
    onTick(callback: (symbol: string) => void): () => void;
    /** The most recent printed digit for a market, or null when nothing has printed yet. */
    getLastDigit(symbol: string): number | null;
}
