// Sixfold Meter guide: turns the Meter's reading into a graded requirement on the scanner. Pure functions, no I/O.
//
// The old Meter gate was a switch (skip cold cells, or not) and sat off by default, so the scanner never really listened
// to the Meter. The guide is graded instead:
//   - A COLD cell (a loss cluster right now) is not bought. That is the one hard rule, and it is per cell, so the other
//     cells stay available and a cluster ends by itself within about 30 ticks.
//   - Everything else is a SCORE BAR that moves smoothly. A poor climate (low Meter, many cold cells) or a weak cell raises
//     the score a contract needs; a good one raises nothing. There is no cliff at 50: a Meter of 49 asks for about one
//     point more, not for the door to close.
//   - Recovery asks for more than a normal trade, and it reads the contract that will actually be bought (Over 3 / Under 6
//     after a loss), not the contract that was armed.
//   - The extra bar fades to zero over the patience window since the last result, so a long bad patch can slow trading
//     down but can never freeze it.
//
// Honest framing: Deriv digits are random. The Meter describes recent clustering; whether it predicts the next result is
// what `meterTrackRecord` measures. The guide only decides how choosy to be, and costs nothing but waiting.
import type { RegimeCell, RegimeSummary, Verdict } from './regime';

/** Most score points the guide can add to the bar. Keeps it from ever becoming a wall. */
export const MAX_METER_BUMP = 20;
/** Recovery trades feel the Meter this much more than normal ones, plus a flat step when the climate is not GO. */
export const RECOVERY_FACTOR = 1.6;
export const RECOVERY_FLAT = 3;
export const DEFAULT_PATIENCE_S = 90;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The market-wide reading: how many cells are cold, how strong the average cell is, and the Meter's verdict. */
export type Climate = { meter: number; coldShare: number; verdict: Verdict };

export const climateOf = (r: RegimeSummary | null | undefined): Climate | null =>
    r && r.total > 0 ? { meter: r.meter, coldShare: r.counts.COLD / r.total, verdict: r.verdict } : null;

export type MeterInput = {
    climate: Climate | null;
    /** The Meter's reading of the contract that will be bought on this market. Null = no reading yet (treated as neutral). */
    cell: Pick<RegimeCell, 'state' | 'strength'> | null;
    recovering: boolean;
    /** Time since the last result (or since Run), and how long the extra bar takes to fade away. */
    waitedMs: number;
    patienceMs: number;
};

export type MeterCall = {
    /** False only for a cell in a loss cluster. */
    allow: boolean;
    /** Score points added to the bar for this cell right now. */
    bump: number;
    /** Small ordering bonus between eligible cells (stronger Meter reading first). Never gates anything. */
    rank: number;
    note: string;
};

export function meterCall(i: MeterInput): MeterCall {
    if (i.cell?.state === 'COLD') {
        return { allow: false, bump: 0, rank: 0, note: 'loss cluster on the Meter' };
    }
    const climatePts = i.climate
        ? clamp((50 - i.climate.meter) * 0.5, 0, 10) + clamp((i.climate.coldShare - 0.25) * 20, 0, 6)
        : 0;
    const cellPts = i.cell ? clamp((50 - i.cell.strength) * 0.25, 0, 6) : 0;
    let raw = climatePts + cellPts;
    if (i.recovering) raw = raw * RECOVERY_FACTOR + (i.climate && i.climate.verdict !== 'GO' ? RECOVERY_FLAT : 0);
    const fade = i.patienceMs > 0 ? clamp(1 - Math.max(0, i.waitedMs) / i.patienceMs, 0, 1) : 0;
    const bump = Math.min(MAX_METER_BUMP, Math.round(raw * fade));
    const rank = i.cell ? clamp((i.cell.strength - 50) * 0.15, -4, 4) : 0;
    const note =
        bump > 0
            ? `Meter asks +${bump} score${i.recovering ? ' for recovery' : ''}${fade < 1 ? ' (easing off while it waits)' : ''}`
            : raw > 0
              ? 'Meter bar eased off after waiting'
              : 'Meter reads well';
    return { allow: true, bump, rank, note };
}

/** What the page shows: the climate and the extra bar an average cell faces right now. */
export type MeterStatus = {
    on: boolean;
    verdict: Verdict;
    meter: number;
    coldShare: number;
    /** Extra score currently asked of an average cell. */
    bump: number;
    recovering: boolean;
    /** Seconds until the extra bar has fully faded (0 when it is not asking for anything). */
    easesInSec: number;
};

export const IDLE_STATUS: MeterStatus = {
    on: false,
    verdict: 'LOADING',
    meter: 0,
    coldShare: 0,
    bump: 0,
    recovering: false,
    easesInSec: 0,
};
