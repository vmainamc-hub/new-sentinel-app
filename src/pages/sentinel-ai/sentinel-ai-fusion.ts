// SENTINEL AI — Insight Fusion side of the machine.
//
// Sentinel AI now carries what used to be the separate Signal Zone: the Sentinel engine and Insight Fusion read the same six
// contracts (Over 1/2/3, Under 8/7/6), and this file turns Fusion's per-market verdicts into a plain opinion on any Sentinel
// signal. Neither engine is modified; this only READS Fusion's verdicts (the same feed the Bulk Trader uses).
//
// "Agree" means the same market, the same side AND the same barrier: Sentinel's entry digit is validated for its own contract only.
//
// Pure apart from `bulkFusionSource`, which is the thin adapter to the app-wide Fusion feed.
import { bulkFeed } from '@/components/premium/bulk-feed';
import {
    BULK_MARKETS,
    RECOMMENDATION_TTL_MS,
    SIGNAL_QUALITY,
    contractFor,
    contractLabel,
    isAllowedContract,
    passesQuality,
    type CombinedVerdict,
    type OverUnderContract,
} from '@/components/premium/over-under-engine';
import { PROPOSITIONS } from '@/lib/propositions';
import type { Consensus, FusionView } from './sentinel-ai-types';

/** Fusion's recommendable contract on one market: it passed Fusion's own quality bar. */
export type FusionCandidate = {
    symbol: string;
    market: string;
    contract: OverUnderContract;
    barrier: number;
    label: string;
    action: string;
    score: number;
    danger: number;
    confirmed: boolean;
    ripe: boolean;
    generatedAt: number;
};

/** Everything the scanner needs from Fusion at one moment. */
export type FusionRead = {
    candidates: FusionCandidate[];
    /** `symbol|contract|barrier` of every contract Fusion currently says STAND DOWN on (with enough data to say so). */
    standDown: Set<string>;
    /** Markets Fusion has analysed enough to give a verdict, and how many it watches. */
    ready: number;
    total: number;
};

export interface FusionSource {
    /** Starts Fusion's feed (idempotent). Returns the release function. */
    retain(): () => void;
    read(now: number): FusionRead;
}

export const EMPTY_FUSION_READ: FusionRead = { candidates: [], standDown: new Set(), ready: 0, total: 0 };

export const fusionKey = (symbol: string, contract: OverUnderContract, barrier: number) =>
    `${symbol}|${contract}|${barrier}`;

/** Fusion's recommendable propositions, one per market and contract, restricted to the allowed contracts and fresh data. */
export const buildFusionCandidates = (verdicts: Record<string, CombinedVerdict>, now: number): FusionCandidate[] => {
    const out: FusionCandidate[] = [];
    for (const [symbol, verdict] of Object.entries(verdicts)) {
        if (!verdict?.ready || now - verdict.generatedAt > RECOMMENDATION_TTL_MS) continue;
        for (const item of verdict.verdicts) {
            if (!PROPOSITIONS.includes(item.proposition) || !passesQuality(item, SIGNAL_QUALITY)) continue;
            const { contract, barrier } = contractFor(item.proposition);
            if (!isAllowedContract(contract, barrier)) continue;
            out.push({
                symbol,
                market: verdict.market || symbol,
                contract,
                barrier,
                label: contractLabel(contract, barrier),
                action: item.action,
                score: item.score,
                danger: item.danger,
                confirmed: item.digitpulse.confirmed,
                ripe: item.digitpulse.ripe,
                generatedAt: verdict.generatedAt,
            });
        }
    }
    return out;
};

/** Contracts Fusion actively stands down on (fresh, with enough data). A stand-down is stronger than silence. */
export const buildStandDown = (verdicts: Record<string, CombinedVerdict>, now: number): Set<string> => {
    const out = new Set<string>();
    for (const [symbol, verdict] of Object.entries(verdicts)) {
        if (!verdict?.ready || now - verdict.generatedAt > RECOMMENDATION_TTL_MS) continue;
        for (const item of verdict.verdicts) {
            if (!PROPOSITIONS.includes(item.proposition) || item.action !== 'STAND_DOWN') continue;
            const { contract, barrier } = contractFor(item.proposition);
            if (isAllowedContract(contract, barrier)) out.add(fusionKey(symbol, contract, barrier));
        }
    }
    return out;
};

export const readFusion = (verdicts: Record<string, CombinedVerdict>, now: number): FusionRead => ({
    candidates: buildFusionCandidates(verdicts, now),
    standDown: buildStandDown(verdicts, now),
    ready: Object.values(verdicts).filter(verdict => verdict?.ready).length,
    total: BULK_MARKETS.length,
});

const SILENT: FusionView = {
    consensus: 'silent',
    score: null,
    danger: null,
    note: 'Insight Fusion has no recommendation on this market.',
};
const OFF: FusionView = { consensus: 'off', score: null, danger: null, note: 'Insight Fusion is not consulted.' };
const WARMING: FusionView = {
    consensus: 'off',
    score: null,
    danger: null,
    note: 'Insight Fusion is still warming up.',
};

export type ContractRef = { symbol: string; contractType: OverUnderContract; barrier: number };

/**
 * What Insight Fusion says about one contract on one market.
 *  - both:     it recommends this exact contract.
 *  - conflict: it stands down on this contract, or recommends the OTHER side on this market.
 *  - partial:  it recommends the same side with another barrier (the barriers differ).
 *  - silent:   it has nothing on this market.
 * `read` null means Fusion is not consulted at all; no data yet reads as "warming up".
 */
export const consensusFor = (target: ContractRef, read: FusionRead | null): FusionView => {
    if (!read) return OFF;
    if (read.ready === 0) return WARMING;
    const label = contractLabel(target.contractType, target.barrier);
    const sameMarket = read.candidates.filter(c => c.symbol === target.symbol);
    const exact = sameMarket.find(c => c.contract === target.contractType && c.barrier === target.barrier);
    if (exact) {
        return {
            consensus: 'both',
            score: exact.score,
            danger: exact.danger,
            note: `Insight Fusion backs ${label} too (${exact.action.toLowerCase()}, score ${Math.round(exact.score)}).`,
        };
    }
    if (read.standDown.has(fusionKey(target.symbol, target.contractType, target.barrier))) {
        return {
            consensus: 'conflict',
            score: null,
            danger: null,
            note: `Insight Fusion stands down on ${label} here.`,
        };
    }
    const opposite = sameMarket.find(c => c.contract !== target.contractType);
    if (opposite) {
        return {
            consensus: 'conflict',
            score: opposite.score,
            danger: opposite.danger,
            note: `Insight Fusion reads ${opposite.label} on this market, the other side.`,
        };
    }
    const sameSide = sameMarket.find(c => c.contract === target.contractType);
    if (sameSide) {
        return {
            consensus: 'partial',
            score: sameSide.score,
            danger: sameSide.danger,
            note: `Insight Fusion reads ${sameSide.label} on this market, not ${label}: the barriers differ.`,
        };
    }
    return SILENT;
};

/** True when a consensus value should count as Fusion actually having an opinion. */
export const hasOpinion = (consensus: Consensus) => consensus !== 'off';

/** The real adapter: the app-wide Fusion feed the Bulk Trader also uses. */
export const bulkFusionSource: FusionSource = {
    retain: () => {
        bulkFeed.start();
        // The feed is app-wide and keeps itself running; releasing this hold has nothing to stop.
        return () => undefined;
    },
    read: now => readFusion(bulkFeed.verdicts, now),
};
