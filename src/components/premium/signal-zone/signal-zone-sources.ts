// SIGNAL ZONE: reads the two engines (read-only) and hands plain candidates to the merge. Neither engine is modified.
import { sentinelAiEngine } from '@/pages/sentinel-ai/sentinel-ai-engine';
import { dangerOf } from '@/pages/sentinel-ai/sentinel-ai-quality';
import { toSentinelAiSignal } from '@/pages/sentinel-ai/sentinel-ai-signal';
import { bulkFeed } from '../bulk-feed';
import { BULK_MARKETS } from '../over-under-engine';
import { buildFusionCandidates, type FusionCandidate, type SentinelCandidate } from './signal-zone-merge';

export type SourceStatus = {
    sentinelOnline: number;
    sentinelTotal: number;
    fusionReady: number;
    fusionTotal: number;
    /** True when both engines have enough data for a meaningful scan. */
    warm: boolean;
};

export type SourceRead = { sentinel: SentinelCandidate[]; fusion: FusionCandidate[]; status: SourceStatus };

/** Keeps both engines running while a page uses them. Returns the release function. */
export const attachSources = (): (() => void) => {
    bulkFeed.start();
    return sentinelAiEngine.retain();
};

/** One snapshot of both engines. Cheap enough to call on every Scan press and again just before Load Bot. */
export const readSources = (requireMomentum: boolean, now: number): SourceRead => {
    const sample = sentinelAiEngine.sample(undefined, { requireMomentum });
    const vetted = sample.vetted ?? (sample.surfaced ? [{ opportunity: sample.surfaced, momentum: { pass: true, measurable: true, score: 0, blockers: [] }, blocked: false }] : []);

    const sentinel: SentinelCandidate[] = vetted.map(({ opportunity, blocked }) => {
        const signal = toSentinelAiSignal(opportunity, now);
        return {
            symbol: signal.symbol,
            market: signal.marketName,
            contract: signal.contractType,
            barrier: signal.barrier,
            label: signal.label,
            entryDigit: signal.entryDigit,
            entryStatus: signal.entryStatus,
            entryWindow: signal.entryWindow,
            entryWinRate: signal.entryWinRate,
            score: signal.score,
            danger: dangerOf(opportunity) === null ? null : signal.danger,
            engineBlocked: Boolean(opportunity.blocked || opportunity.dangerComposition?.isHardBlocked),
            momentumBlocked: blocked,
            receivedAt: now,
        };
    });

    const fusion = buildFusionCandidates(bulkFeed.verdicts, now);
    const fusionReady = Object.values(bulkFeed.verdicts).filter(verdict => verdict?.ready).length;
    const sentinelOnline = sample.info.online;
    return {
        sentinel,
        fusion,
        status: {
            sentinelOnline,
            sentinelTotal: sample.info.total,
            fusionReady,
            fusionTotal: BULK_MARKETS.length,
            warm: sentinelOnline > 0 && fusionReady > 0,
        },
    };
};
