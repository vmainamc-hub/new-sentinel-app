// OVERLORD EVEN / ODD ENGINE. Pure and framework-free: the backend Find Market uses when the contract is Even or Odd.
//
// The whole Precision Parity AI tool runs underneath (overlord-engine/parity/*: the statistics, hidden-regime, transition,
// digit-psychology, structural, forecast, deep-reasoning and analyst-panel engines, the hypothesis competition and the
// Chief Analyst). It is copied from the Precision Parity tool and computes exactly what it computes there. Nothing in this
// file re-decides, softens or overrides its verdict:
//   READY       Parity recommends BUY EVEN or BUY ODD. Only READY markets can be picked.
//   BUILDING    a thesis is developing but Parity says do not enter yet (NO_TRADE). Shown, never picked.
//   MONITORING  no conviction yet (NO_TRADE). Shown, never picked.
//   REJECTED    Parity vetoed the market (manipulation, streak protection, contrarian block...). Never picked.
// Overlord's original Even / Odd condition (the share of the last 50 digits that were even / odd, Find Market picked the
// LOWEST) is kept as a number on every read, and as the fallback when no market has enough history for Parity to read.
//
// Honest limit: Deriv digits are generated randomly. Parity ranks how healthy and persistent a parity structure has been and
// avoids the moments its own analysts flag as costly. It cannot create an edge or predict the next tick.
import { LEGACY_WINDOW } from './legacy';
import { analyseMarketParity, DEFAULT_PARITY_SETTINGS, type ParitySettings } from './parity/engine';
import type { MarketParityReport } from './parity/types';

export { DEFAULT_PARITY_SETTINGS };
export type { ParitySettings };

export type ParitySide = 'EVEN' | 'ODD';
export type ParityTier = 'STRONG' | 'BEST' | 'CAUTION' | 'LEGACY';
export type ParityState = MarketParityReport['verdict']['state'];

export type ParitySeries = {
    prices: readonly number[];
    digits: readonly number[];
    /** Decimal places Deriv reports for the market (pip_size). */
    decimals?: number;
};

/** The most ticks the Precision Parity tool reads for one market (its own live window). */
export const PARITY_MAX_TICKS = 2000;
/** Reasons kept on a read for the card, and the longest one. */
const MAX_REASONS = 8;
const MAX_REASON_CHARS = 240;

/** What Precision Parity said about the market, in words, for the card. */
export type ParityNotes = {
    state: ParityState;
    grade: 'A' | 'B' | 'C' | 'D' | null;
    regime: string;
    hiddenRegime: string;
    stability: string | null;
    chief: string | null;
    risk: string | null;
    contrarian: string | null;
    survival: string | null;
    recommendedRuns: number | null;
    forecast: string | null;
    entry: string | null;
    manipulation: number;
    /** Confidence (0-100) of the hypothesis for the other parity. */
    opposite: number;
};

export type ParityRead = {
    symbol: string;
    name: string;
    /** The parity this read is about: the one Parity recommends, or the one it leans to when it does not recommend. */
    side: ParitySide;
    /** Even / Odd have no barrier; kept so a read has the same shape as an Over / Under read. */
    barrier: number;
    label: string;
    state: ParityState;
    /** Parity says buy this parity now. */
    ready: boolean;
    /** Parity's own confidence for the side, 0-100. */
    score: number;
    tier: ParityTier;
    /** Parity vetoed the market. */
    vetoed: boolean;
    vetoReason: string;
    /** Overlord's original number: share (0-100) of the last 50 digits that were of this parity. */
    legacyPct: number | null;
    /** True when the market had too few ticks for Parity and only the original condition could be read. */
    thin: boolean;
    ticks: number;
    reasons: string[];
    /** Supporting evidence for the side, and all evidence weighed (supporting + conflicting). */
    agree: number;
    applied: number;
    parity: ParityNotes | null;
    /** Set after an assessment: how the market held up over the live rounds. */
    steady?: { rounds: number; clearShare: number; topShare: number };
};

export type ParityInput = {
    series: Readonly<Record<string, ParitySeries>>;
    symbols: readonly string[];
    /** The parity chosen on screen. null: Parity may choose the side too. */
    side: ParitySide | null;
    names?: Readonly<Record<string, string>>;
    settings?: ParitySettings;
};

export type ParityScan = {
    /** Every market read, ready first. */
    reads: ParityRead[];
    /** The one market to trade, or null. Only ever a READY market, or the original condition's pick when nothing could be read. */
    best: ParityRead | null;
    /** When there is no best: the closest developing market for the chosen parity, for display only. Never traded. */
    watch: ParityRead | null;
    /** When a parity was chosen and there is no best: the best READY market for the other parity, for display only. */
    opposite: ParityRead | null;
    /** True when no market had enough ticks for Parity and the answer comes from the original condition alone. */
    legacyOnly: boolean;
    /** Markets Parity read. */
    evaluated: number;
};

const round1 = (x: number) => Math.round(x * 10) / 10;
const clip = (s: string) => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s);
const sideOf = (contract: 'BUY_EVEN' | 'BUY_ODD'): ParitySide => (contract === 'BUY_ODD' ? 'ODD' : 'EVEN');
const labelOf = (side: ParitySide) => (side === 'EVEN' ? 'Even' : 'Odd');
const TIER_RANK: Record<ParityTier, number> = { STRONG: 0, BEST: 1, CAUTION: 2, LEGACY: 3 };

/**
 * Share (0-100) of the last 50 digits that were of the parity. This is Overlord's original Even / Odd number; null when
 * there are no digits.
 */
export const legacyParityPct = (digits: readonly number[], side: ParitySide): number | null => {
    const window = digits.slice(-LEGACY_WINDOW);
    if (window.length === 0) return null;
    const hits = window.filter(d => (side === 'EVEN' ? d % 2 === 0 : d % 2 !== 0)).length;
    return (hits / window.length) * 100;
};

/**
 * Digits to the ticks Parity reads. Parity takes a tick's last digit as round(price * 100) % 10, which is only the real Deriv
 * digit for two-decimal markets, so each tick is handed over as digit / 100. The digit Overlord already read at the market's
 * own precision then reaches Parity unchanged, whatever the market's decimals. (Parity reads nothing else from a tick.)
 */
export const toParityTicks = (digits: readonly number[], max = PARITY_MAX_TICKS): { t: number; price: number }[] => {
    const tail = digits.length > max ? digits.slice(-max) : digits;
    return tail.map((d, i) => ({ t: i, price: d / 100 }));
};

/** Compares reads: ready first, then STRONG before BEST, then Parity's own confidence. */
export const compareParity = (a: ParityRead, b: ParityRead): number =>
    Number(b.ready) - Number(a.ready) ||
    Number(a.thin) - Number(b.thin) ||
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    b.score - a.score;

const thinRead = (symbol: string, name: string, digits: readonly number[], side: ParitySide): ParityRead => ({
    symbol,
    name,
    side,
    barrier: 0,
    label: labelOf(side),
    state: 'MONITORING',
    ready: false,
    score: 0,
    tier: 'LEGACY',
    vetoed: false,
    vetoReason: '',
    legacyPct: legacyParityPct(digits, side),
    thin: true,
    ticks: digits.length,
    reasons: [`Only ${digits.length} ticks, too few for Precision Parity; only the original ${labelOf(side)} count could be read.`],
    agree: 0,
    applied: 0,
    parity: null,
});

const notesOf = (report: MarketParityReport, side: ParitySide): ParityNotes => {
    const v = report.verdict;
    const other = v.hypotheses.find(h => h.contract === (side === 'EVEN' ? 'BUY_ODD' : 'BUY_EVEN'));
    const survival = v.panel?.dbotSurvival;
    return {
        state: v.state,
        grade: v.panel?.intelligenceGrade ?? null,
        regime: report.regime.toLowerCase(),
        hiddenRegime: report.hiddenRegime.toLowerCase().replace(/_/g, ' '),
        stability: v.stability ? `${v.stability.label.toLowerCase()} (${Math.round(v.stability.score)})` : null,
        chief: v.panel ? v.panel.chief.decision.toLowerCase() : null,
        risk: v.risk ? v.risk.verdict.toLowerCase() : null,
        contrarian: v.panel ? v.panel.contrarian.verdict.toLowerCase() : null,
        survival: survival
            ? `${survival.durability.toLowerCase().replace(/_/g, ' ')}, ${Math.round(survival.flipProbability5 * 100)}% flip risk over 5`
            : null,
        recommendedRuns: survival ? survival.recommendedRuns : null,
        forecast: report.forecast ? clip(report.forecast.narrative) : null,
        entry: v.plan ? clip(v.plan.entryDirective) : null,
        manipulation: Math.round(report.manipulation),
        opposite: other ? Math.round(other.confidence) : 0,
    };
};

const readFromReport = (
    report: MarketParityReport,
    digits: readonly number[],
    requested: ParitySide | null
): ParityRead => {
    const v = report.verdict;
    const hEven = v.hypotheses.find(h => h.contract === 'BUY_EVEN');
    const hOdd = v.hypotheses.find(h => h.contract === 'BUY_ODD');
    const lean = hEven && hOdd ? (hOdd.confidence > hEven.confidence ? hOdd : hEven) : (hEven ?? hOdd);
    const ready = v.state === 'READY' && v.recommendation !== 'NO_TRADE';
    // The side is what Parity recommends; when it recommends nothing, the parity it leans to (or the one chosen on screen).
    const side: ParitySide =
        v.recommendation !== 'NO_TRADE' ? sideOf(v.recommendation) : lean ? sideOf(lean.contract) : (requested ?? 'EVEN');
    const hyp = side === 'ODD' ? hOdd : hEven;
    const score = round1(v.confidence);
    const vetoed = v.state === 'REJECTED';
    const lead = ready
        ? `Precision Parity: READY, buy ${labelOf(side)}, confidence ${score}%.`
        : `Precision Parity: ${v.state.toLowerCase()}, leaning ${labelOf(side)} at confidence ${score}%, no entry yet.`;
    return {
        symbol: report.market,
        name: report.name,
        side,
        barrier: 0,
        label: labelOf(side),
        state: v.state,
        ready,
        score,
        // A single scan: READY is Parity's top state. An assessment may lower it to BEST when it did not hold across rounds.
        tier: ready ? 'STRONG' : 'CAUTION',
        vetoed,
        vetoReason: vetoed ? clip(v.reasons[0] ?? 'Precision Parity vetoed this market.') : '',
        legacyPct: legacyParityPct(digits, side),
        thin: false,
        ticks: report.ticks,
        reasons: [lead, ...v.reasons].map(clip).slice(0, MAX_REASONS),
        agree: hyp ? hyp.supports.length : 0,
        applied: hyp ? hyp.supports.length + hyp.conflicts.length : 0,
        parity: notesOf(report, side),
    };
};

/**
 * Chooses what Find Market shows from the reads (already sorted with compareParity). Pure, and shared with the assessment so
 * the live rounds and the final answer follow the same rules.
 */
export function pickFromReads(
    reads: readonly ParityRead[],
    chosen: ParitySide | null
): Pick<ParityScan, 'best' | 'watch' | 'opposite' | 'legacyOnly' | 'evaluated'> {
    const deep = reads.filter(r => !r.thin);
    if (deep.length === 0) {
        // Nothing could be read by Parity: the original condition decides, exactly as it always has (lowest share wins).
        const thin = reads.filter(r => r.legacyPct !== null).sort((a, b) => (a.legacyPct ?? 0) - (b.legacyPct ?? 0));
        return { best: thin[0] ?? null, watch: null, opposite: null, legacyOnly: reads.length > 0, evaluated: 0 };
    }
    const matches = (r: ParityRead) => chosen === null || r.side === chosen;
    const best = deep.find(r => r.ready && matches(r)) ?? null;
    if (best) return { best, watch: null, opposite: null, legacyOnly: false, evaluated: deep.length };
    const watch = deep.filter(r => !r.ready && !r.vetoed && matches(r)).sort((a, b) => b.score - a.score)[0] ?? null;
    const opposite = chosen === null ? null : (deep.find(r => r.ready && r.side !== chosen) ?? null);
    return { best: null, watch, opposite, legacyOnly: false, evaluated: deep.length };
}

/** Reads every market with the whole Precision Parity tool and picks the one market to trade, if Parity says there is one. */
export function scanParity(input: ParityInput): ParityScan {
    const settings = input.settings ?? DEFAULT_PARITY_SETTINGS;
    const reads: ParityRead[] = [];
    for (const symbol of input.symbols) {
        const series = input.series[symbol];
        if (!series || series.digits.length === 0) continue;
        const name = input.names?.[symbol] ?? symbol;
        if (series.digits.length < settings.minTicks) {
            reads.push(thinRead(symbol, name, series.digits, input.side ?? 'EVEN'));
            continue;
        }
        const report = analyseMarketParity(symbol, name, toParityTicks(series.digits), settings);
        reads.push(readFromReport(report, series.digits, input.side));
    }
    reads.sort(compareParity);
    return { reads, ...pickFromReads(reads, input.side) };
}
