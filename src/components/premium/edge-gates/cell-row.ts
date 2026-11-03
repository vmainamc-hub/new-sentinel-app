// EDGE GATES for engines that have no Pulse board (Sixfold, Vanguard): a scanner cell, read as a board row the arbiter understands.
//
// Sentinel AI's arbiter works on rows of Pulse signals (tier, score). Sixfold and Vanguard score every market x contract with the
// scanner instead (0-100). The arbiter only needs an ordering and a rough strength, so a cell becomes a row with the tier its score
// would earn at the scanner's own selectivity bars: 70 and up is what Strict asks for, 62 what Balanced asks for, anything lower
// is the loose bar. The score itself is passed through unchanged.
import type { BoardRow } from '../sentinel/overlay';
import { keyOf } from '../sentinel/overlay';
import type { PulseTier } from '../sentinel/pulse';
import type { Cell } from '../sixfold/scanner';

export const STRONG_FROM = 70;
export const STEADY_FROM = 62;

export const tierOfScore = (score: number): PulseTier =>
    score >= STRONG_FROM ? 'strong' : score >= STEADY_FROM ? 'steady' : 'watch';

export const cellToRow = (cell: Cell): BoardRow => ({
    key: keyOf(cell.symbol, cell.contract.side, cell.contract.param),
    symbol: cell.symbol,
    contract: cell.contract.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER',
    barrier: cell.contract.param,
    label: cell.label,
    tier: tierOfScore(cell.score),
    score: cell.score,
    // Pulse's "windows above fair" has no counterpart here; the arbiter does not read it.
    agree: 0,
});
