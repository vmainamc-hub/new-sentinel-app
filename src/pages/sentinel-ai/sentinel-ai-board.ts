// SENTINEL AI — the scanner board. Pure and framework-free.
//
// Every second the runner hands this module what the engines see right now: the Sentinel engine's vetted candidates (already
// through its surface vetting, the score / danger gate and the momentum read) and Insight Fusion's verdicts. The board turns that
// into ONE ranked list, says for every row whether it may be traded right now and why, and picks the row to arm next.
//
// Neither engine is changed. Sentinel's own order stays the authority: Insight Fusion only moves a signal a few points up when it
// agrees and down when it disagrees (see the constants), and `engines = sentinel` ignores Fusion's opinion for ordering entirely.
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import { contractLabel } from '@/components/premium/over-under-engine';
import { consensusFor, type FusionCandidate, type FusionRead } from './sentinel-ai-fusion';
import type { VettedCandidate } from './sentinel-ai-engine-types';
import { toSentinelAiSignal } from './sentinel-ai-signal';
import type {
    BoardRow,
    BoardRowState,
    EngineMode,
    FusionView,
    MarketDot,
    SentinelAiSettings,
    SentinelAiSignal,
} from './sentinel-ai-types';

/** Points added to a Sentinel signal's rank when Insight Fusion recommends the same contract. */
export const FUSION_AGREE_BONUS = 6;
/** Points taken off when Insight Fusion stands down on it or reads the other side. */
export const FUSION_CONFLICT_PENALTY = 12;
/** In Fusion-leads mode, points added when Sentinel also reads the same contract. */
export const FUSION_LEADS_SENTINEL_BONUS = 4;
/** An armed signal that has not touched its entry is only replaced when a challenger leads by this many rank points. */
export const SWITCH_MARGIN = 8;
/** Extra score asked for right after a loss, and the pause (ms) after which it drops by one point. */
export const PICKY_BUMP = 6;
export const PICKY_FADE_MS = 10_000;
/** The score bar Insight Fusion itself uses for a recommendation (its adapter's quality filter). */
const FUSION_BASE_BAR = 66;
/** Entry statuses the Sentinel engine uses for a validated entry digit (the digit just printed, or armed and waiting). */
const USABLE_ENTRY_STATUS = ['ENTER NOW', 'ARMED'];

export type BoardSettings = Pick<SentinelAiSettings, 'engines' | 'requireMomentum' | 'minScore' | 'pickyAfterLoss'>;

export type BoardInput = {
    /** The Sentinel engine's vetted candidates, in its own rank order. */
    vetted: readonly VettedCandidate[];
    /** Insight Fusion's current read, or null when Fusion is not available at all. */
    fusion: FusionRead | null;
    settings: BoardSettings;
    now: number;
    /** Signal keys already worked (or dropped) that have not left the board since: they wait for a NEW setup. */
    spent: ReadonlySet<string>;
    /** Markets resting after a loss: symbol -> trades left before they return. */
    resting: ReadonlyMap<string, number>;
    /** Extra score currently asked for after a loss (0 when none). */
    pickyBump: number;
    /** Key of the signal being worked, if any. */
    activeKey: string | null;
    /** Cells that must not be traded at all (Deriv refused them, excluded or quarantined markets). Used for Fusion-led rows. */
    isOut: (symbol: string, contractId: string) => boolean;
};

export type Board = {
    /** Every row, best first (rows that may be traded now come before the rest). */
    rows: BoardRow[];
    /** The signal to arm for each row, keyed by row key. */
    signals: Map<string, SentinelAiSignal>;
};

const bonusFor = (engines: EngineMode, view: FusionView): number => {
    if (engines === 'sentinel') return 0;
    if (view.consensus === 'both') return FUSION_AGREE_BONUS;
    if (view.consensus === 'conflict') return -FUSION_CONFLICT_PENALTY;
    return 0;
};

type Draft = {
    row: BoardRow;
    signal: SentinelAiSignal;
    /** Position in the source list, for a stable order. */
    index: number;
    /** Why a rule keeps this row out (momentum / mode), or null. */
    blockedBy: string | null;
};

const sentinelDraft = (candidate: VettedCandidate, index: number, input: BoardInput): Draft => {
    const opp: RankedOpportunity = candidate.opportunity;
    const signal = toSentinelAiSignal(opp, input.now);
    const view = consensusFor(
        { symbol: signal.symbol, contractType: signal.contractType, barrier: signal.barrier },
        input.fusion
    );
    const engines = input.settings.engines;
    let blockedBy: string | null = null;
    if (input.settings.requireMomentum && candidate.blocked) {
        blockedBy = `Momentum: ${candidate.momentum.blockers[0] ?? 'recent digit movement does not favour this contract'}`;
    } else if (engines === 'require' && view.consensus !== 'both') {
        blockedBy =
            view.consensus === 'off'
                ? 'Needs Insight Fusion to agree, and it has no read yet'
                : `Needs both engines: ${view.note}`;
    } else if (engines === 'fusion_leads') {
        blockedBy = 'Insight Fusion picks the contract, and it does not back this one';
    }
    return {
        index,
        signal,
        blockedBy,
        row: {
            key: signal.key,
            symbol: signal.symbol,
            marketName: signal.marketName,
            label: signal.label,
            contractType: signal.contractType,
            barrier: signal.barrier,
            source: 'sentinel',
            score: signal.score,
            danger: signal.danger,
            rank: signal.score + bonusFor(engines, view),
            entryDigit: signal.entryDigit,
            entryStatus: signal.entryStatus,
            fusion: view,
            eligible: false,
            state: 'held',
            reason: '',
        },
    };
};

const contractIdOf = (f: FusionCandidate) => `${f.contract === 'DIGITOVER' ? 'OVER' : 'UNDER'}${f.barrier}`;

const fusionDraft = (
    f: FusionCandidate,
    index: number,
    sentinel: SentinelAiSignal | null,
    input: BoardInput
): Draft => {
    const key = `${f.symbol}|${contractIdOf(f)}`;
    const usable =
        sentinel !== null && sentinel.entryDigit !== null && USABLE_ENTRY_STATUS.includes(sentinel.entryStatus);
    const view: FusionView = {
        consensus: 'both',
        score: f.score,
        danger: f.danger,
        note: sentinel
            ? `Insight Fusion leads (${f.action.toLowerCase()}, score ${Math.round(f.score)}); Sentinel reads it too.`
            : `Insight Fusion leads (${f.action.toLowerCase()}, score ${Math.round(f.score)}); Sentinel has no read on it.`,
    };
    const signal: SentinelAiSignal = {
        id: `${key}@${input.now}`,
        key,
        symbol: f.symbol,
        marketName: f.market,
        contractId: contractIdOf(f),
        contractType: f.contract,
        barrier: f.barrier,
        label: contractLabel(f.contract, f.barrier),
        entryDigit: usable ? sentinel!.entryDigit : null,
        entryStatus: usable ? sentinel!.entryStatus : 'DEFAULT',
        entryWindow: usable ? sentinel!.entryWindow : '',
        entryWinRate: usable ? sentinel!.entryWinRate : null,
        score: Math.round(f.score),
        danger: Math.round(f.danger),
        confidence: Math.round(f.score),
        status: f.action,
        reason: sentinel?.reason ?? '',
        receivedAt: input.now,
    };
    return {
        index,
        signal,
        blockedBy: null,
        row: {
            key,
            symbol: f.symbol,
            marketName: f.market,
            label: signal.label,
            contractType: f.contract,
            barrier: f.barrier,
            source: 'fusion',
            score: signal.score,
            danger: signal.danger,
            rank: f.score + (sentinel ? FUSION_LEADS_SENTINEL_BONUS : 0),
            entryDigit: signal.entryDigit,
            entryStatus: signal.entryStatus,
            fusion: view,
            eligible: false,
            state: 'held',
            reason: '',
        },
    };
};

/** The reason a draft may not be traded right now, or null when it can. Order matters: the first rule that applies is shown. */
const gate = (draft: Draft, input: BoardInput): string | null => {
    const { row } = draft;
    const rest = input.resting.get(row.symbol);
    if (rest !== undefined) return `Resting after a loss on this market (${rest} trade${rest === 1 ? '' : 's'} left)`;
    if (input.spent.has(row.key)) return 'Already worked: it waits for a new setup';
    if (draft.blockedBy) return draft.blockedBy;
    if (input.pickyBump > 0 && input.settings.pickyAfterLoss) {
        const base = row.source === 'fusion' ? FUSION_BASE_BAR : input.settings.minScore;
        if (base > 0 && row.score < base + input.pickyBump) {
            return `Score ${row.score} is under ${base + input.pickyBump}: the bar is raised for a moment after a loss`;
        }
    }
    return null;
};

const eligibleReason = (row: BoardRow, engines: EngineMode): string => {
    if (row.source === 'fusion') return row.fusion.note;
    if (engines === 'sentinel') return 'Sentinel signal ready';
    if (row.fusion.consensus === 'both') return 'Both engines agree';
    if (row.fusion.consensus === 'conflict') return 'Ready, ranked lower: Insight Fusion disagrees';
    return 'Sentinel signal ready';
};

/** Builds the board. Never mutates its input. */
export const buildBoard = (input: BoardInput): Board => {
    const engines = input.settings.engines;
    const sentinelDrafts = input.vetted.map((candidate, index) => sentinelDraft(candidate, index, input));
    let drafts: Draft[];

    if (engines === 'fusion_leads' && input.fusion) {
        const bySentinel = new Map(sentinelDrafts.map(d => [d.row.key, d] as const));
        const fusionDrafts: Draft[] = [];
        const matched = new Set<string>();
        input.fusion.candidates.forEach((f, index) => {
            if (input.isOut(f.symbol, contractIdOf(f))) return;
            const key = `${f.symbol}|${contractIdOf(f)}`;
            const match = bySentinel.get(key) ?? null;
            if (match) matched.add(key);
            fusionDrafts.push(fusionDraft(f, index, match ? match.signal : null, input));
        });
        // Sentinel signals Fusion does not back stay on the board for information, but are not traded in this mode.
        drafts = [...fusionDrafts, ...sentinelDrafts.filter(d => !matched.has(d.row.key))];
    } else {
        drafts = sentinelDrafts;
    }

    const signals = new Map<string, SentinelAiSignal>();
    for (const draft of drafts) {
        const reason = gate(draft, input);
        draft.row.eligible = reason === null;
        draft.row.reason = reason ?? eligibleReason(draft.row, engines);
        draft.row.state = draftState(draft, reason, input);
        if (!signals.has(draft.row.key) || draft.row.source === 'fusion') signals.set(draft.row.key, draft.signal);
    }

    const byEngineOrder = engines === 'sentinel';
    drafts.sort(
        (a, b) =>
            Number(b.row.eligible) - Number(a.row.eligible) ||
            (byEngineOrder ? 0 : b.row.rank - a.row.rank) ||
            a.index - b.index
    );
    return { rows: drafts.map(d => d.row), signals };
};

const draftState = (draft: Draft, reason: string | null, input: BoardInput): BoardRowState => {
    const { row } = draft;
    if (row.key === input.activeKey && reason === null) return 'armed';
    if (reason === null) return 'next';
    if (input.resting.has(row.symbol)) return 'resting';
    if (input.spent.has(row.key)) return 'spent';
    return 'held';
};

export type ActiveRef = {
    key: string;
    /** True while the armed signal is only waiting for its entry (not touched, no trade in flight): it may be swapped for a clearly better one. */
    hold: boolean;
};

/**
 * The row to arm next. Sentinel's own order wins in `sentinel` mode (no hysteresis). Otherwise a waiting signal is kept unless a
 * challenger leads it by SWITCH_MARGIN rank points, so the scanner does not flap between two near-equal setups.
 */
export const choosePick = (board: Board, active: ActiveRef | null, engines: EngineMode): BoardRow | null => {
    const top = board.rows.find(row => row.eligible) ?? null;
    if (!top || !active || !active.hold || active.key === top.key || engines === 'sentinel') return top;
    const current = board.rows.find(row => row.eligible && row.key === active.key);
    if (current && top.rank - current.rank < SWITCH_MARGIN) return current;
    return top;
};

/** One dot per market with its best row (null when the market has no candidate). */
export const marketDots = (board: Board, markets: ReadonlyArray<{ symbol: string; name: string }>): MarketDot[] => {
    const best = new Map<string, BoardRow>();
    for (const row of board.rows) if (!best.has(row.symbol)) best.set(row.symbol, row);
    return markets.map(market => ({ symbol: market.symbol, name: market.name, best: best.get(market.symbol) ?? null }));
};

/** How much extra score is asked for `sinceResult` ms after a loss: it starts at PICKY_BUMP and fades by itself. */
export const pickyBumpAfterLoss = (consecutiveLosses: number, sinceResultMs: number): number =>
    consecutiveLosses <= 0 ? 0 : Math.max(0, PICKY_BUMP - Math.floor(Math.max(0, sinceResultMs) / PICKY_FADE_MS));
