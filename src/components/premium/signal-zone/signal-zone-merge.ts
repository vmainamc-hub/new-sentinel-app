// SIGNAL ZONE: merges what Sentinel AI and Insight Fusion say into one ranked list. Pure and framework-free.
//
// Neither engine is touched. This file only compares their outputs. Both engines speak the same six propositions
// (Over 1/2/3, Under 8/7/6), so "agree" means the same market, the same side AND the same barrier. The barrier has to
// match because Sentinel's entry digit is validated for its own contract only.
//
// An entry digit decides WHEN the bot buys. It does not change the odds of the contract.

import { PROPOSITIONS } from '@/lib/propositions';
import {
    RECOMMENDATION_TTL_MS, SIGNAL_QUALITY, contractFor, contractLabel, isAllowedContract, passesQuality,
    type CombinedVerdict, type OverUnderContract,
} from '../over-under-engine';
import type { MergeMode, SignalZoneSettings } from './signal-zone-settings';

export type SentinelCandidate = {
    symbol: string;
    market: string;
    contract: OverUnderContract;
    barrier: number;
    label: string;
    entryDigit: number | null;
    entryStatus: string;
    entryWindow: string;
    /** The engine's own estimate, in percent (null when it gave none). Shown as an estimate, never as a promise. */
    entryWinRate: number | null;
    score: number;
    danger: number | null;
    /** The engine itself marked this candidate blocked. */
    engineBlocked: boolean;
    /** Momentum was required and this candidate failed it. */
    momentumBlocked: boolean;
    receivedAt: number;
};

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

export type ZoneSource = 'both' | 'fusion' | 'sentinel';

export type ZoneCandidate = {
    /** Unique per scan: `${key}@${createdAt}`. */
    id: string;
    /** Stable identity of the proposition: `${symbol}|${contract}|${barrier}`. */
    key: string;
    symbol: string;
    market: string;
    contract: OverUnderContract;
    barrier: number;
    label: string;
    source: ZoneSource;
    sentinel: SentinelCandidate | null;
    fusion: FusionCandidate | null;
    entryDigit: number | null;
    entryStatus: string;
    entryWindow: string;
    entryWinRate: number | null;
    /** Average of the engines' scores that read this contract (one score when only one engine does). */
    rank: number;
    /** The worst (highest) danger among the engines that read this contract; null when none reported one. */
    danger: number | null;
    loadable: boolean;
    /** Plain words: why this cannot be loaded, or null when it can. */
    reason: string | null;
    createdAt: number;
};

export const keyOf = (symbol: string, contract: OverUnderContract, barrier: number) => `${symbol}|${contract}|${barrier}`;

/** A candidate older than this must be re-scanned before it is loaded. */
export const MAX_SCAN_AGE_MS = 60_000;

/** Entry statuses the Sentinel engine uses for a validated entry digit (the digit just printed, or armed and waiting). */
const USABLE_ENTRY_STATUS = ['ENTER NOW', 'ARMED'];

/** Why Sentinel's entry digit cannot be used, or null when it can. */
export const entryProblem = (s: SentinelCandidate | null): string | null => {
    if (!s) return 'Sentinel AI has no entry digit for this contract.';
    if (s.entryDigit === null || !Number.isInteger(s.entryDigit) || s.entryDigit < 0 || s.entryDigit > 9) {
        return 'Sentinel AI gave this signal no entry digit, and none is invented.';
    }
    if (s.entryStatus === 'INVALIDATED') return `Sentinel AI invalidated entry digit ${s.entryDigit}.`;
    if (!USABLE_ENTRY_STATUS.includes(s.entryStatus)) {
        return `Entry digit ${s.entryDigit} is not validated yet (status: ${s.entryStatus.toLowerCase()}).`;
    }
    return null;
};

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
                symbol, market: verdict.market || symbol, contract, barrier, label: contractLabel(contract, barrier),
                action: item.action, score: item.score, danger: item.danger,
                confirmed: item.digitpulse.confirmed, ripe: item.digitpulse.ripe, generatedAt: verdict.generatedAt,
            });
        }
    }
    return out;
};

type Gates = Pick<SignalZoneSettings, 'minScore' | 'maxDanger' | 'skipBlocked' | 'excludedMarkets'>;

/** Sentinel's own quality gate (the same settings Sentinel AI uses). Returns the reason it fails, or null. */
export const sentinelGate = (s: SentinelCandidate, gates: Gates): string | null => {
    if (!isAllowedContract(s.contract, s.barrier)) return `${s.label} is not a permitted contract.`;
    if (gates.excludedMarkets.includes(s.symbol)) return `${s.market} is excluded in the settings.`;
    if (gates.skipBlocked && s.engineBlocked) return 'Sentinel AI marked this signal blocked.';
    if (s.momentumBlocked) return 'Recent digit movement does not favour this contract.';
    if (gates.minScore > 0 && s.score < gates.minScore) return `Sentinel score ${Math.round(s.score)} is below ${gates.minScore}.`;
    if (gates.maxDanger > 0 && s.danger !== null && s.danger > gates.maxDanger) return `Sentinel danger ${Math.round(s.danger)} is above ${gates.maxDanger}.`;
    return null;
};

const worstDanger = (s: SentinelCandidate | null, f: FusionCandidate | null): number | null => {
    const values = [s?.danger ?? null, f?.danger ?? null].filter((v): v is number => v !== null && Number.isFinite(v));
    return values.length ? Math.max(...values) : null;
};

const meanScore = (s: SentinelCandidate | null, f: FusionCandidate | null): number => {
    const values = [s?.score, f?.score].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

type Draft = {
    s: SentinelCandidate | null;
    f: FusionCandidate | null;
    source: ZoneSource;
    problem: string | null;
};

/** What the other engine says about the same market, in plain words (used for the "why not both" explanation). */
const disagreement = (
    from: 'sentinel' | 'fusion', symbol: string, contract: OverUnderContract, barrier: number,
    other: Array<{ symbol: string; contract: OverUnderContract; barrier: number; label: string }>,
): string => {
    const otherName = from === 'sentinel' ? 'Insight Fusion' : 'Sentinel AI';
    const sameMarket = other.filter(o => o.symbol === symbol);
    const sameSide = sameMarket.find(o => o.contract === contract);
    if (sameSide) return `${otherName} reads ${sameSide.label} on this market, not ${contractLabel(contract, barrier)}: the barriers differ.`;
    if (sameMarket.length) return `${otherName} reads ${sameMarket[0].label} on this market: the sides disagree.`;
    return `${otherName} does not back this signal.`;
};

/**
 * Builds the ranked list for the chosen merge mode.
 *  - both:          loadable only where both engines read the same market, side and barrier and Sentinel has a usable entry digit.
 *  - fusion_leads:  Insight Fusion picks the contract; Sentinel supplies the entry digit for that exact contract.
 *  - sentinel_only: Sentinel AI picks the contract and the entry digit (Fusion agreement is shown for information).
 * Candidates that cannot be loaded are still listed (with the reason), after the loadable ones.
 */
export const mergeCandidates = (
    sentinel: SentinelCandidate[], fusion: FusionCandidate[], settings: SignalZoneSettings, now: number,
): ZoneCandidate[] => {
    const mode: MergeMode = settings.mergeMode;
    const excluded = (symbol: string) => settings.excludedMarkets.includes(symbol);
    const allowedSentinel = sentinel.filter(s => isAllowedContract(s.contract, s.barrier));
    const allowedFusion = fusion.filter(f => isAllowedContract(f.contract, f.barrier) && !excluded(f.symbol));
    const findSentinel = (f: FusionCandidate) => allowedSentinel.find(s => s.symbol === f.symbol && s.contract === f.contract && s.barrier === f.barrier) ?? null;
    const findFusion = (s: SentinelCandidate) => allowedFusion.find(f => f.symbol === s.symbol && f.contract === s.contract && f.barrier === s.barrier) ?? null;

    const drafts: Draft[] = [];
    const seen = new Set<string>();
    const push = (draft: Draft) => {
        const base = draft.s ?? draft.f;
        if (!base) return;
        const key = keyOf(base.symbol, base.contract, base.barrier);
        if (seen.has(key)) return;
        seen.add(key);
        drafts.push(draft);
    };

    if (mode === 'fusion_leads') {
        for (const f of allowedFusion) {
            const s = findSentinel(f);
            const problem = entryProblem(s);
            push({ s, f, source: s ? 'both' : 'fusion', problem });
        }
        // Sentinel signals Fusion does not back are shown for information only.
        for (const s of allowedSentinel) {
            if (findFusion(s) || excluded(s.symbol)) continue;
            push({ s, f: null, source: 'sentinel', problem: disagreement('sentinel', s.symbol, s.contract, s.barrier, allowedFusion) });
        }
    } else {
        for (const s of allowedSentinel) {
            const gate = sentinelGate(s, settings);
            const f = findFusion(s);
            if (mode === 'sentinel_only') {
                push({ s, f, source: f ? 'both' : 'sentinel', problem: gate ?? entryProblem(s) });
            } else if (f) {
                push({ s, f, source: 'both', problem: gate ?? entryProblem(s) });
            } else {
                push({ s, f: null, source: 'sentinel', problem: gate ?? disagreement('sentinel', s.symbol, s.contract, s.barrier, allowedFusion) });
            }
        }
        if (mode === 'both') {
            for (const f of allowedFusion) {
                if (findSentinel(f)) continue;
                push({ s: null, f, source: 'fusion', problem: disagreement('fusion', f.symbol, f.contract, f.barrier, allowedSentinel) });
            }
        }
    }

    const result: ZoneCandidate[] = drafts.map(({ s, f, source, problem }) => {
        const base = (s ?? f) as SentinelCandidate | FusionCandidate;
        const key = keyOf(base.symbol, base.contract, base.barrier);
        const entry = s && entryProblem(s) === null ? s : null;
        return {
            id: `${key}@${now}`,
            key,
            symbol: base.symbol,
            market: base.market,
            contract: base.contract,
            barrier: base.barrier,
            label: base.label,
            source,
            sentinel: s,
            fusion: f,
            entryDigit: entry ? entry.entryDigit : s?.entryDigit ?? null,
            entryStatus: s?.entryStatus ?? 'NONE',
            entryWindow: s?.entryWindow ?? '',
            entryWinRate: s?.entryWinRate ?? null,
            rank: Math.round(meanScore(s, f) * 10) / 10,
            danger: worstDanger(s, f),
            loadable: problem === null && entry !== null,
            reason: problem,
            createdAt: now,
        };
    });

    return result.sort((a, b) =>
        Number(b.loadable) - Number(a.loadable)
        || Number(b.source === 'both') - Number(a.source === 'both')
        || b.rank - a.rank
        || (a.danger ?? 100) - (b.danger ?? 100)
        || a.symbol.localeCompare(b.symbol)
        || a.barrier - b.barrier);
};

export type Revalidation = { ok: true; candidate: ZoneCandidate } | { ok: false; reason: string };

/**
 * Before loading, the chosen candidate is checked against a FRESH merge. It must still exist, still be loadable, and keep the
 * same entry digit; otherwise the user is asked to scan again. A stale signal is never loaded silently.
 */
export const revalidate = (chosen: ZoneCandidate | null, fresh: ZoneCandidate[], now: number): Revalidation => {
    if (!chosen) return { ok: false, reason: 'Scan first: there is no signal to load.' };
    if (!isAllowedContract(chosen.contract, chosen.barrier)) return { ok: false, reason: `${chosen.label} is not a permitted contract.` };
    if (now - chosen.createdAt > MAX_SCAN_AGE_MS && fresh.length === 0) return { ok: false, reason: 'This scan is out of date. Scan again.' };
    const current = fresh.find(c => c.key === chosen.key);
    if (!current) return { ok: false, reason: `${chosen.label} on ${chosen.market} is no longer on the board. Scan again.` };
    if (!current.loadable) return { ok: false, reason: current.reason ?? `${chosen.label} on ${chosen.market} can no longer be loaded.` };
    if (current.entryDigit !== chosen.entryDigit) {
        return { ok: false, reason: `The entry digit for ${chosen.label} on ${chosen.market} changed from ${chosen.entryDigit} to ${current.entryDigit}. Scan again.` };
    }
    return { ok: true, candidate: current };
};
