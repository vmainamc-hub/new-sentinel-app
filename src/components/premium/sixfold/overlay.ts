// The plug-in point that lets another tool (Sentinel AI) drive the Sixfold runner. Types only.
//
// Sixfold's runner already knows how to scan, arm, wait for an entry digit, buy, settle, size a recovery, rest a market after
// a loss and listen to the Meter. An overlay adds a second opinion to every step without copying any of that:
//   - which contracts are scanned at all (`contracts`),
//   - a per-cell verdict (`call`): a veto, extra score asked for (bump > 0) or an easing of the bar (bump < 0), and an ordering bonus,
//   - the entry digit to wait for (`entryDigits`), and
//   - notices when a trade is bought and settled (`onBought`, `onSettled`).
// With no overlay the runner behaves exactly as before.
import type { Contract } from './bot';
import type { SixfoldSettings } from './money';
import type { Cell } from './scanner';

export type OverlayCall = {
    /** False vetoes the cell outright (nothing arms or buys it). */
    allow: boolean;
    /** Score points added to the bar (> 0) or taken off it (< 0, limited by the scanner). */
    bump: number;
    /** Ordering bonus among eligible cells. Never gates anything. */
    rank: number;
    /** Plain words for the queue and the log. */
    note: string;
};

export type TradeNotice = {
    contractId: number;
    symbol: string;
    /** The contract the scanner armed, and the one actually bought (the recovery barrier after a loss). */
    armed: Contract;
    bought: Contract;
    recovery: boolean;
    stake: number;
    entryDigit: number | null;
};

export type RunnerOverlay = {
    /** Run Panel module id, e.g. 'sentinel-ai'. */
    moduleId: string;
    /** Name used in messages, e.g. 'Sentinel AI'. */
    name: string;
    /** The contracts to scan and trade. */
    contracts: (settings: SixfoldSettings) => Contract[];
    /** Called at the start of every scan, before cells are judged. */
    refresh?: (now: number, symbols: readonly string[]) => void;
    call: (cell: Cell, ctx: { recovering: boolean; now: number }) => OverlayCall;
    /** Entry digits to wait for instead of the runner's own, or null to let the runner choose. */
    entryDigits?: (cell: Cell, ctx: { recovering: boolean }) => number[] | null;
    onBought?: (notice: TradeNotice) => void;
    /** profit is null when Deriv's result could not be confirmed. */
    onSettled?: (notice: TradeNotice & { profit: number | null }) => void;
};

export const NEUTRAL_CALL: OverlayCall = { allow: true, bump: 0, rank: 0, note: '' };
