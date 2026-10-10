// Over/Under recommendation layer for the Bulk Trader.
//
// The decision engine is Insight Fusion (Sentinel x DigitPulse), vendored UNMODIFIED under src/lib/**
// (entry point: @/lib/fusion/verdict). This file contains no analysis logic of its own. It only:
//   1. feeds the engine correctly (see engineTick),
//   2. compares the engine's per-market verdicts using the engine's own parameters,
//   3. manages the recommendation lifecycle (stickiness, expiry, re-validation),
//   4. enforces the six-contract allowlist.
// Pure and framework-free so it can be unit-tested without React or a socket.

import type { Tick as EngineFeedTick } from '@/lib/analytics';
import { computeCombinedVerdict, MIN_SAMPLE, type CombinedVerdict, type PropositionVerdict, type VerdictAction } from '@/lib/fusion/verdict';
import type { LiquidityOpportunity } from '@/lib/liquidity/liquidity-v3';
import { PROPOSITIONS, propositionSpec, type Proposition } from '@/lib/propositions';

export { MIN_SAMPLE };
export type { CombinedVerdict, PropositionVerdict, VerdictAction, Proposition };

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------

export type OverUnderContract = 'DIGITOVER' | 'DIGITUNDER';
export type BulkMarket = { symbol: string; name: string; pip: number };

// All 13 continuous volatility indices. `pip` is only a fallback: decimals are inferred from the ticks themselves.
export const BULK_MARKETS: BulkMarket[] = [
    { symbol: 'R_10', name: 'Volatility 10', pip: 3 },
    { symbol: 'R_25', name: 'Volatility 25', pip: 3 },
    { symbol: 'R_50', name: 'Volatility 50', pip: 4 },
    { symbol: 'R_75', name: 'Volatility 75', pip: 4 },
    { symbol: 'R_100', name: 'Volatility 100', pip: 2 },
    { symbol: '1HZ10V', name: 'Volatility 10 (1s)', pip: 2 },
    { symbol: '1HZ15V', name: 'Volatility 15 (1s)', pip: 3 },
    { symbol: '1HZ25V', name: 'Volatility 25 (1s)', pip: 2 },
    { symbol: '1HZ30V', name: 'Volatility 30 (1s)', pip: 3 },
    { symbol: '1HZ50V', name: 'Volatility 50 (1s)', pip: 2 },
    { symbol: '1HZ75V', name: 'Volatility 75 (1s)', pip: 2 },
    { symbol: '1HZ90V', name: 'Volatility 90 (1s)', pip: 3 },
    { symbol: '1HZ100V', name: 'Volatility 100 (1s)', pip: 2 },
];

/** The engine's canonical window: one history request of this size fills it exactly. */
export const ENGINE_TICKS = 1000;
export const MIN_ENGINE_TICKS = 30;

/** The ONLY contracts that may be recommended or executed. */
export const ALLOWED_BARRIERS: Record<OverUnderContract, readonly number[]> = {
    DIGITOVER: [1, 2, 3],
    DIGITUNDER: [8, 7, 6],
};
export const OVER_BARRIERS = ALLOWED_BARRIERS.DIGITOVER;
export const UNDER_BARRIERS = ALLOWED_BARRIERS.DIGITUNDER;

export const isAllowedContract = (contract: unknown, barrier: unknown): contract is OverUnderContract => {
    if (contract !== 'DIGITOVER' && contract !== 'DIGITUNDER') return false;
    const n = typeof barrier === 'string' && barrier.trim() !== '' ? Number(barrier) : barrier;
    return typeof n === 'number' && Number.isInteger(n) && ALLOWED_BARRIERS[contract].includes(n);
};

/** Final defensive gate. Throws on anything outside Over 1/2/3 and Under 8/7/6. */
export const assertAllowedContract = (contract: unknown, barrier: unknown): void => {
    if (isAllowedContract(contract, barrier)) return;
    throw new Error(`${String(contract)} ${String(barrier)} is not permitted. Only Over 1, 2, 3 and Under 8, 7, 6 can be traded.`);
};

export const propositionFor = (contract: OverUnderContract, barrier: number): Proposition | null =>
    isAllowedContract(contract, barrier) ? (`${contract === 'DIGITOVER' ? 'OVER' : 'UNDER'}${barrier}` as Proposition) : null;

export const contractFor = (proposition: Proposition): { contract: OverUnderContract; barrier: number; side: 0 | 1 } => {
    const spec = propositionSpec(proposition);
    return { contract: spec.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER', barrier: spec.threshold, side: spec.side === 'OVER' ? 0 : 1 };
};

export const contractLabel = (contract: OverUnderContract, barrier: number): string =>
    `${contract === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`;

// ---------------------------------------------------------------------------
// Ticks -> digits (precision-aware)
// ---------------------------------------------------------------------------

/**
 * Decimal places actually present in a tick sample. Deriv strips trailing zeros from JSON numbers, so the
 * maximum over a few dozen ticks is the market's pip size. Falls back to `fallback` for tiny samples.
 */
export const inferDecimals = (prices: number[], fallback: number): number => {
    if (prices.length < 30) return fallback;
    let max = 0;
    for (const price of prices) {
        const text = String(price);
        if (!Number.isFinite(price) || text.includes('e')) continue;
        const dot = text.indexOf('.');
        if (dot >= 0) max = Math.max(max, text.length - dot - 1);
    }
    return Math.min(max, 6);
};

/** True last digit of a quote at the market's real precision. */
export const lastDigit = (price: number, decimals: number): number =>
    Number(Number(price).toFixed(Math.min(10, Math.max(0, decimals))).slice(-1));

export const digitsFromPrices = (prices: number[], decimals: number): number[] =>
    prices.filter(Number.isFinite).map(price => lastDigit(price, decimals));

/**
 * The vendored engine derives digits with `lastDigit(p) = round(p * 100) % 10`, which is only correct for markets
 * quoted to 2 decimals. Rather than edit the engine, rescale the quote so that formula yields the TRUE last digit
 * for any precision (price * 10^(decimals-2), kept to 2 decimals). Direction and relative moves are preserved.
 */
export const engineTick = (price: number, t: number, decimals: number): EngineFeedTick => ({
    t,
    price: Number((Number(price) * 10 ** (decimals - 2)).toFixed(2)),
});

export const buildEngineTicks = (prices: number[], times: number[], decimals: number): EngineFeedTick[] =>
    prices.map((price, index) => engineTick(price, times[index] ?? index, decimals));

/** Digit frequencies (%) over the last `window` digits. */
export const digitPercents = (digits: number[], window: number): number[] => {
    const counts = new Array<number>(10).fill(0);
    const start = Math.max(0, digits.length - window);
    for (let i = start; i < digits.length; i += 1) counts[digits[i]] += 1;
    const used = Math.max(1, digits.length - start);
    return counts.map(count => Math.round((count / used) * 1000) / 10);
};

/** Past hit rate (%) of a contract, from digit percentages. */
export const hitRate = (pct: number[], contract: OverUnderContract, barrier: number): number =>
    Math.round(pct.reduce((acc, value, digit) => acc + ((contract === 'DIGITOVER' ? digit > barrier : digit < barrier) ? value : 0), 0) * 10) / 10;

// ---------------------------------------------------------------------------
// Running the engine (one market at a time, carrying its v3 state exactly as the original app does)
// ---------------------------------------------------------------------------

export class OverUnderEngine {
    private previous = new Map<string, Record<string, LiquidityOpportunity>>();

    analyse(symbol: string, ticks: EngineFeedTick[]): CombinedVerdict {
        const verdict = computeCombinedVerdict(symbol, ticks, this.previous.get(symbol) ?? {});
        const next = verdict.analysis?.v3Opportunities;
        if (next) this.previous.set(symbol, next);
        return verdict;
    }

    reset(symbol?: string): void {
        if (symbol) this.previous.delete(symbol);
        else this.previous.clear();
    }
}

// ---------------------------------------------------------------------------
// Cross-market comparison (uses only parameters the engine itself reports)
// ---------------------------------------------------------------------------

export const ACTION_RANK: Record<VerdictAction, number> = { EXECUTE: 3, PREPARE: 2, OBSERVE: 1, STAND_DOWN: 0 };
export const RECOMMENDABLE: readonly VerdictAction[] = ['EXECUTE', 'PREPARE'];
/** A recommendation is kept this long after the engine last confirmed it. */
export const RECOMMENDATION_TTL_MS = 30_000;
/**
 * Adapter-level quality filters; the underlying engine is unchanged.
 */
export type QualityOptions = {
    minScore: number; maxDanger: number; minIndependence: number; minStreak: number;
    stickyMargin: number; holdMs: number; holdBypassMargin: number;
};
export const LEGACY_QUALITY: QualityOptions = {
    minScore: 0, maxDanger: 101, minIndependence: 0, minStreak: 1, stickyMargin: 5, holdMs: 0, holdBypassMargin: Infinity,
};
export const SIGNAL_QUALITY: QualityOptions = {
    minScore: 66, maxDanger: 40, minIndependence: 0, minStreak: 3, stickyMargin: 8, holdMs: 20_000, holdBypassMargin: 12,
};
export const passesQuality = (item: PropositionVerdict, quality: QualityOptions = SIGNAL_QUALITY): boolean =>
    RECOMMENDABLE.includes(item.action) && (item.action === 'EXECUTE' || item.score >= quality.minScore)
    && item.danger < quality.maxDanger && item.independence >= quality.minIndependence;
export class SignalStability {
    private streaks = new Map<string, number>();
    observe(symbol: string, verdict: CombinedVerdict, quality: QualityOptions = SIGNAL_QUALITY): void {
        for (const proposition of PROPOSITIONS) {
            const item = verdict.verdicts.find(v => v.proposition === proposition);
            const key = `${symbol}:${proposition}`;
            const ok = verdict.ready && !!item && passesQuality(item, quality);
            this.streaks.set(key, ok ? (this.streaks.get(key) ?? 0) + 1 : 0);
        }
    }
    streak(symbol: string, proposition: Proposition): number { return this.streaks.get(`${symbol}:${proposition}`) ?? 0; }
    reset(): void { this.streaks.clear(); }
};

export type Candidate = { symbol: string; verdict: CombinedVerdict; item: PropositionVerdict };

/** Better first: engine action, then score, then lower danger, higher independence, confirmed/ripe, then barrier. */
export const compareCandidates = (a: Candidate, b: Candidate): number =>
    ACTION_RANK[b.item.action] - ACTION_RANK[a.item.action]
    || b.item.score - a.item.score
    || a.item.danger - b.item.danger
    || b.item.independence - a.item.independence
    || Number(b.item.digitpulse.confirmed && b.item.digitpulse.ripe) - Number(a.item.digitpulse.confirmed && a.item.digitpulse.ripe)
    || a.item.spec.threshold - b.item.spec.threshold
    || a.symbol.localeCompare(b.symbol);

const candidates = (verdicts: Record<string, CombinedVerdict>): Candidate[] =>
    Object.entries(verdicts).flatMap(([symbol, verdict]) =>
        verdict.ready ? verdict.verdicts.filter(item => PROPOSITIONS.includes(item.proposition)).map(item => ({ symbol, verdict, item })) : []);

export type Recommendation = {
    id: string;
    engine: 'insight-fusion';
    symbol: string;
    market: string;
    proposition: Proposition;
    contract: OverUnderContract;
    barrier: number;
    side: 0 | 1;
    label: string;
    /** A locked signal can later reflect OBSERVE or STAND_DOWN. */
    action: VerdictAction;
    score: number;
    danger: number;
    independence: number;
    confirmed: boolean;
    ripe: boolean;
    sample: number;
    reasons: string[];
    createdAt: number;
    refreshedAt: number;
    expiresAt: number;
    locked?: boolean;
};

const marketName = (symbol: string) => BULK_MARKETS.find(market => market.symbol === symbol)?.name ?? symbol;

const toRecommendation = (c: Candidate, now: number, createdAt = now, id?: string): Recommendation => {
    const { contract, barrier, side } = contractFor(c.item.proposition);
    return {
        id: id ?? `${c.symbol}:${c.item.proposition}:${now}`,
        engine: 'insight-fusion', symbol: c.symbol, market: marketName(c.symbol),
        proposition: c.item.proposition, contract, barrier, side, label: contractLabel(contract, barrier),
        action: c.item.action, score: c.item.score, danger: c.item.danger, independence: c.item.independence,
        confirmed: c.item.digitpulse.confirmed, ripe: c.item.digitpulse.ripe, sample: c.verdict.sample,
        reasons: c.item.reasons.slice(0, 4), createdAt, refreshedAt: now, expiresAt: now + RECOMMENDATION_TTL_MS,
    };
};

/**
 * Stable recommendation selection with quality, streak, grade, margin, and hold-time rules.
 */
export const recommend = (
    verdicts: Record<string, CombinedVerdict>, now: number, previous: Recommendation | null = null,
    stability: SignalStability | null = null, quality: QualityOptions = SIGNAL_QUALITY,
): Recommendation | null => {
    const all = candidates(verdicts);
    const offered = all.filter(c => passesQuality(c.item, quality)
        && (!stability || stability.streak(c.symbol, c.item.proposition) >= quality.minStreak)).sort(compareCandidates);
    const best = offered[0];
    if (previous) {
        const current = all.find(c => c.symbol === previous.symbol && c.item.proposition === previous.proposition && passesQuality(c.item, quality));
        if (current) {
            const challenger = best && best !== current ? best : null;
            const lead = challenger ? challenger.item.score - current.item.score : 0;
            const higherGrade = challenger ? ACTION_RANK[challenger.item.action] > ACTION_RANK[current.item.action] : false;
            const held = now - previous.createdAt >= quality.holdMs;
            const replace = Boolean(challenger) && (higherGrade || (lead >= quality.stickyMargin && (held || lead >= quality.holdBypassMargin)));
            if (!replace) return toRecommendation(current, now, previous.createdAt, previous.id);
        }
    }
    return best ? toRecommendation(best, now) : null;
};

/** Best market that is merely OBSERVE-grade, for a one-line "watching" hint when nothing is actionable. */
export const watching = (verdicts: Record<string, CombinedVerdict>): { symbol: string; market: string; label: string; score: number } | null => {
    const c = candidates(verdicts).filter(x => x.item.action === 'OBSERVE').sort(compareCandidates)[0];
    if (!c) return null;
    const { contract, barrier } = contractFor(c.item.proposition);
    return { symbol: c.symbol, market: marketName(c.symbol), label: contractLabel(contract, barrier), score: c.item.score };
};

// ---------------------------------------------------------------------------
// Re-validation before execution
// ---------------------------------------------------------------------------

export type Validity = { ok: true } | { ok: false; reason: string };

/**
 * A loaded recommendation must be re-checked against the LIVE engine state immediately before it is traded.
 * Returns the reason in plain words so the UI can ask for a refreshed recommendation.
 */
export const validateRecommendation = (
    rec: Recommendation | null, verdicts: Record<string, CombinedVerdict>, now: number, locked = false,
): Validity => {
    if (!rec) return { ok: false, reason: 'No recommendation is loaded.' };
    if (!isAllowedContract(rec.contract, rec.barrier) || propositionFor(rec.contract, rec.barrier) !== rec.proposition) {
        return { ok: false, reason: `${rec.label} is not a permitted contract.` };
    }
    const verdict = verdicts[rec.symbol];
    if (!verdict || !verdict.ready) return { ok: false, reason: `Not enough live data for ${rec.market} yet.` };
    if (now - verdict.generatedAt > RECOMMENDATION_TTL_MS) return { ok: false, reason: 'The analysis is stale. Wait for a refreshed recommendation.' };
    const item = verdict.verdicts.find(v => v.proposition === rec.proposition);
    if (!item) return { ok: false, reason: `${rec.label} is no longer produced by the engine.` };
    const allowed: readonly VerdictAction[] = locked ? [...RECOMMENDABLE, 'OBSERVE'] : RECOMMENDABLE;
    if (!allowed.includes(item.action)) {
        return { ok: false, reason: `The engine now says ${item.action.replace('_', ' ')} for ${rec.label} on ${rec.market}. ${locked ? 'Unlock to see current signals.' : 'Load a refreshed recommendation.'}` };
    }
    return { ok: true };
};
export const refreshLocked = (locked: Recommendation, verdicts: Record<string, CombinedVerdict>, now: number): Recommendation => {
    const verdict = verdicts[locked.symbol];
    const item = verdict?.verdicts.find(v => v.proposition === locked.proposition);
    if (!verdict || !item) return { ...locked, locked: true, expiresAt: Infinity };
    return { ...locked, locked: true, action: item.action, score: item.score, danger: item.danger, independence: item.independence,
        confirmed: item.digitpulse.confirmed, ripe: item.digitpulse.ripe, sample: verdict.sample, reasons: item.reasons.slice(0, 4),
        refreshedAt: now, expiresAt: Infinity };
};
