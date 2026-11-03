// SENTINEL AI EDGE 3/3: the signal arbiter. Pure and framework-free.
//
// Sentinel's board can hold several signals on one market at once: Over 1, Over 2 and Under 7 on the same index, from Pulse and from
// Digits Analysis. The runner ranks them across markets, but nothing stops it arming Over 2 on a market whose best read is Under 7, or
// trading a signal the other source disagrees with. This is the Chief Investment Office rule from Precision Edge (cio.ts), applied to
// Sentinel's own board:
//   - ONE pick per market. The strongest signal on a market is its pick; the others on that market are stood down.
//   - Never publish contradictions. When the best Over and the best Under on a market are about equally strong, the market abstains.
//   - The second source counts. A signal the other source also lists is worth more, one it contradicts is worth less.
//   - Sticky. A pick is kept unless a challenger is clearly stronger, so the order does not flip-flop scan to scan.
// Honest limit: this decides WHICH of the signals Sentinel already has is traded. It adds no signal and no edge.
import type { BoardRow } from '../overlay';
import type { PulseTier } from '../pulse';

export const TIER_POINTS: Record<PulseTier, number> = { strong: 30, steady: 20, watch: 10 };
/** Strength points by which the best Over and the best Under must differ, or the market abstains. */
export const ABSTAIN_MARGIN = 4;
/** Strength points a challenger needs to take the pick from the incumbent. */
export const SWITCH_MARGIN = 3;
export const AGREE_BONUS = 4;
export const CONFLICT_PENALTY = 4;

export type SecondOpinion = 'agree' | 'conflict' | 'none';

export type Candidate = {
    row: BoardRow;
    /** Rank points from the Kalman health read (0 when it is off). */
    healthLift: number;
    second: SecondOpinion;
};

export const strengthOf = (c: Candidate): number =>
    TIER_POINTS[c.row.tier] +
    c.row.score * 0.5 +
    c.healthLift * 2.5 +
    (c.second === 'agree' ? AGREE_BONUS : c.second === 'conflict' ? -CONFLICT_PENALTY : 0);

export type Role = 'pick' | 'beaten' | 'abstain';
export type ArbiterVerdict = { role: Role; strength: number; note: string };

const side = (row: BoardRow) => (row.contract === 'DIGITOVER' ? 'OVER' : 'UNDER');

export class Arbiter {
    /** Last pick per market, by row key. */
    private picks = new Map<string, string>();

    /** One verdict per candidate, keyed by the row key. */
    decide(candidates: readonly Candidate[]): Map<string, ArbiterVerdict> {
        const out = new Map<string, ArbiterVerdict>();
        const byMarket = new Map<string, Array<Candidate & { strength: number }>>();
        for (const c of candidates) {
            const list = byMarket.get(c.row.symbol) ?? [];
            list.push({ ...c, strength: strengthOf(c) });
            byMarket.set(c.row.symbol, list);
        }
        const keep = new Map<string, string>();
        for (const [symbol, list] of byMarket) {
            list.sort((a, b) => b.strength - a.strength || a.row.key.localeCompare(b.row.key));
            const top = list[0];
            const rival = list.find(c => side(c.row) !== side(top.row));
            if (rival && top.strength - rival.strength < ABSTAIN_MARGIN) {
                const note = `Arbiter: ${top.row.label} and ${rival.row.label} contradict on ${symbol} (${top.strength.toFixed(0)} vs ${rival.strength.toFixed(0)})`;
                for (const c of list) out.set(c.row.key, { role: 'abstain', strength: c.strength, note });
                continue;
            }
            const incumbent = list.find(c => c.row.key === this.picks.get(symbol));
            const winner = incumbent && top.strength - incumbent.strength < SWITCH_MARGIN ? incumbent : top;
            keep.set(symbol, winner.row.key);
            for (const c of list) {
                out.set(
                    c.row.key,
                    c === winner
                        ? {
                              role: 'pick',
                              strength: c.strength,
                              note:
                                  c.second === 'agree'
                                      ? `Arbiter: pick on ${symbol}, both sources agree`
                                      : c.second === 'conflict'
                                        ? `Arbiter: pick on ${symbol}, the other source disagrees`
                                        : `Arbiter: pick on ${symbol}`,
                          }
                        : {
                              role: 'beaten',
                              strength: c.strength,
                              note: `Arbiter: ${winner.row.label} is the pick on ${symbol}`,
                          }
                );
            }
        }
        this.picks = keep;
        return out;
    }

    reset(): void {
        this.picks.clear();
    }
}

/** What the other source says about a row: it lists the same contract, or only the opposite side on that market, or nothing. */
export const secondOpinion = (row: BoardRow, other: readonly BoardRow[] | null): SecondOpinion => {
    if (!other) return 'none';
    const sameMarket = other.filter(o => o.symbol === row.symbol);
    if (sameMarket.some(o => o.key === row.key)) return 'agree';
    const opposite = sameMarket.some(o => o.contract !== row.contract);
    const sameSide = sameMarket.some(o => o.contract === row.contract);
    return opposite && !sameSide ? 'conflict' : 'none';
};
