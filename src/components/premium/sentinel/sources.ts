// SENTINEL AI (unified): reads the two real engines (read-only) into the overlay's plain shapes.
import { sentinelAiEngine } from '@/pages/sentinel-ai/sentinel-ai-engine';
import { bulkFusionSource } from '@/pages/sentinel-ai/sentinel-ai-fusion';
import { dangerOf, qualityVerdict } from '@/pages/sentinel-ai/sentinel-ai-quality';
import { toSentinelAiSignal } from '@/pages/sentinel-ai/sentinel-ai-signal';
import type { Sources } from './overlay';
import { produceSignals } from './producer';
import type { EngineSettings } from './settings';

const USABLE = ['ENTER NOW', 'ARMED'];

export const readEngines = (engine: EngineSettings, now: number): Sources => {
    const sample = sentinelAiEngine.sample(undefined, { requireMomentum: engine.requireMomentum });
    // The engine's whole ranking, in tiers (see producer.ts): Sentinel speaks every so often, not only on a four-way coincidence.
    const tiered = sample.ranked
        ? produceSignals(sample.ranked, engine.requireMomentum)
        : (sample.vetted ?? []).map(v => ({
              opportunity: v.opportunity,
              tier: 'confirmed' as const,
              blocked: v.blocked,
          }));
    const sentinel: Sources['sentinel'] = [];
    for (const { opportunity, tier, blocked } of tiered) {
        if (blocked) continue; // momentum required and failed
        if (!qualityVerdict(opportunity, engine).ok) continue;
        const sig = toSentinelAiSignal(opportunity, now);
        const digit = sig.entryDigit;
        sentinel.push({
            symbol: sig.symbol,
            market: sig.marketName,
            contract: sig.contractType,
            barrier: sig.barrier,
            label: sig.label,
            score: sig.score,
            danger: dangerOf(opportunity),
            tier,
            entryDigit: digit,
            entryUsable:
                digit !== null &&
                Number.isInteger(digit) &&
                digit >= 0 &&
                digit <= 9 &&
                USABLE.includes(sig.entryStatus),
        });
    }
    const read = bulkFusionSource.read(now);
    const fusion = read.candidates.map(c => ({
        symbol: c.symbol,
        market: c.market,
        contract: c.contract,
        barrier: c.barrier,
        label: c.label,
        score: c.score,
    }));
    return { sentinel, fusion, standDown: read.standDown };
};
