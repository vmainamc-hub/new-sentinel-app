// SIXFOLD (fused): the consensus. Every engine gives one small, plain vote on a market x contract; the votes are added up into
// the single verdict the runner already understands (`OverlayCall`: allow / bump / rank / note).
//
// Why a vote and not a gate: in the old Sixfold every engine was a separate hard gate (pressure, window health, winning side,
// Meter, Pulse tier, bot rules...). Each one alone is reasonable; stacked, the chance that ALL of them say yes on the same market
// at the same moment is tiny, so the tool sat silent for minutes. Here an engine that agrees EASES the bar, one that disagrees
// RAISES it, and a quiet spell eases it further (the idle ease). What stays a hard "no", whatever the vote:
//   - the mandatory special-digit rule (digit 1 for Over, digit 8 for Under) and a danger veto from the edge gates,
//   - the runner's own states (trap / hostile / warming), the red-run and loss-abort protections at the entry digit,
//   - the money rules: stop loss, take profit, loss-streak stop, recovery caps.
//
// Honest limit: Deriv digits are random. Agreement between engines decides WHEN a contract is traded, not whether it wins.
import type { OverlayCall } from '../overlay';

export type Engine = 'scanner' | 'pulse' | 'bot' | 'losing' | 'winning' | 'window' | 'digit' | 'gates' | 'idle';

export const ENGINE_LABEL: Record<Engine, string> = {
    scanner: 'Scanner',
    pulse: 'Pulse',
    bot: 'Vanguard bot',
    losing: 'Losing side',
    winning: 'Winning side',
    window: 'Window health',
    digit: 'Entry digit',
    gates: 'Edge gates',
    idle: 'Idle ease',
};

/** One engine's reading. `points` is its effect on the bar: negative eases it (agrees), positive raises it (disagrees), 0 abstains. */
export type Vote = { engine: Engine; points: number; note: string };

/** Most the votes together may raise the bar. The ease side is limited by the scanner itself (MAX_EASE, 30 points). */
export const MAX_RAISE = 20;
export const MAX_EASE_TOTAL = 30;

export type Ballot = {
    votes: Vote[];
    /** Engines that agree / disagree / have no opinion. */
    agree: number;
    disagree: number;
    abstain: number;
    /** Sum of the points before limits (negative = eased). */
    net: number;
    /** What the runner is told: the limited sum. */
    bump: number;
    /** A hard "no" and why, or null. */
    veto: string | null;
};

export const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

/**
 * Adds the votes. `veto` is a hard no that no amount of agreement overrides. The idle ease is a vote like the others, so it shows in
 * the same line, but it is not counted as an engine agreeing.
 */
export function tally(votes: readonly Vote[], veto: string | null = null): Ballot {
    const engines = votes.filter(v => v.engine !== 'idle');
    const net = votes.reduce((t, v) => t + v.points, 0);
    return {
        votes: [...votes],
        agree: engines.filter(v => v.points < 0).length,
        disagree: engines.filter(v => v.points > 0).length,
        abstain: engines.filter(v => v.points === 0).length,
        net,
        bump: Math.max(-MAX_EASE_TOTAL, Math.min(MAX_RAISE, Math.round(net))),
        veto,
    };
}

/** The verdict in the runner's own terms. The rank puts well-supported contracts first when several are eligible. */
export function toCall(b: Ballot, extraRank = 0): OverlayCall {
    if (b.veto) return { allow: false, bump: 0, rank: 0, note: b.veto };
    const parts = b.votes.filter(v => v.points !== 0).map(v => `${ENGINE_LABEL[v.engine]} ${v.points < 0 ? '' : '+'}${Math.round(v.points)}`);
    const head = `${b.agree} agree, ${b.disagree} against${b.abstain ? `, ${b.abstain} no view` : ''}`;
    return {
        allow: true,
        bump: b.bump,
        rank: Math.round((-b.net / 3 + extraRank) * 10) / 10,
        note: parts.length ? `${head} (${parts.join(', ')})` : head,
    };
}
