// Bookkeeping for one bulk run. No analysis lives here (that is the engine's job); this only enforces limits and
// reports what actually happened.
//
// A bulk run is ONE decision executed N times at the same instant: all contracts are bought in the same burst so
// they share one entry tick and one exit tick (and so one exit digit). It is not N trades placed one after another.

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;

export type BulkParams = { stake: number; runs: number; duration: number };

export const DEFAULT_BULK: BulkParams = { stake: 0.5, runs: 1, duration: 1 };
export const MIN_STAKE = 0.35;
export const MAX_STAKE = 1000;
export const MAX_BULK_RUNS = 100;
/** Hard cap on stake x trades for one run. Cannot be bypassed from the UI: execution re-checks it. */
export const MAX_EXPOSURE = 2000;

export const sanitizeBulk = (input: Partial<BulkParams>): BulkParams => {
    const n = (value: unknown, fallback: number, min: number, max: number) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
    };
    return {
        stake: round2(n(input.stake, DEFAULT_BULK.stake, MIN_STAKE, MAX_STAKE)),
        runs: Math.trunc(n(input.runs, DEFAULT_BULK.runs, 1, MAX_BULK_RUNS)),
        duration: Math.trunc(n(input.duration, DEFAULT_BULK.duration, 1, 10)),
    };
};

/** Worst-case stake committed by a bulk run. */
export const exposure = (params: BulkParams): number => round2(params.stake * params.runs);

/** Null when the run is within limits, otherwise the reason it must not start. */
export const limitError = (params: BulkParams): string | null =>
    exposure(params) > MAX_EXPOSURE
        ? `Total exposure ${exposure(params).toFixed(2)} exceeds the ${MAX_EXPOSURE} limit. Reduce the stake or number of trades.`
        : null;

export type Tally = { requested: number; placed: number; failed: number; settled: number; wins: number; losses: number; pnl: number };
export const emptyTally = (requested = 0): Tally => ({ requested, placed: 0, failed: 0, settled: 0, wins: 0, losses: 0, pnl: 0 });

export const recordPlaced = (tally: Tally): Tally => ({ ...tally, placed: tally.placed + 1 });
export const recordFailed = (tally: Tally): Tally => ({ ...tally, failed: tally.failed + 1 });
export const recordSettled = (tally: Tally, profit: number): Tally => ({
    ...tally,
    settled: tally.settled + 1,
    wins: tally.wins + (profit > 0 ? 1 : 0),
    losses: tally.losses + (profit > 0 ? 0 : 1),
    pnl: round2(tally.pnl + profit),
});

/** Entry/exit data Deriv reports for one contract (epoch seconds; exitDigit = last digit of the exit spot). */
export type Fill = { contractId: number; entryTime: number | null; exitTime: number | null; exitDigit: number | null };

export type SyncReport = {
    total: number;
    /** Contracts that reported both an entry and an exit time. */
    known: number;
    entryTicks: number;
    exitTicks: number;
    /** Every contract entered on one tick and exited on one tick. */
    synced: boolean;
    /** The shared exit digit when synced, otherwise null. */
    exitDigit: number | null;
};

/** Did the bulk run really land on a single tick? Computed from what Deriv reports after settlement. */
export const syncReport = (fills: Fill[]): SyncReport => {
    const known = fills.filter(f => f.entryTime !== null && f.exitTime !== null);
    const entryTicks = new Set(known.map(f => f.entryTime)).size;
    const exitTicks = new Set(known.map(f => f.exitTime)).size;
    const synced = fills.length > 0 && known.length === fills.length && entryTicks === 1 && exitTicks === 1;
    return { total: fills.length, known: known.length, entryTicks, exitTicks, synced, exitDigit: synced ? known[0].exitDigit : null };
};

/** Plain-English one-liner for the UI. */
export const syncText = (report: SyncReport): string => {
    if (report.total === 0) return '';
    if (report.known < report.total) return `Waiting for entry/exit ticks (${report.known}/${report.total} reported).`;
    return report.synced
        ? `All ${report.total} trades entered and exited on the same tick${report.exitDigit !== null ? ` · exit digit ${report.exitDigit}` : ''}.`
        : `Trades landed on ${report.entryTicks} entry tick(s) and ${report.exitTicks} exit tick(s), so results differ.`;
};

/**
 * Re-entrancy guard for a run: refuses a second start while one is active (double click, duplicate event,
 * re-render) and releases only for the same token.
 */
export class RunGuard {
    private active: string | null = null;
    private seq = 0;

    /** Returns a run token, or null if a run is already active. */
    begin(): string | null {
        if (this.active) return null;
        this.seq += 1;
        this.active = `run-${this.seq}`;
        return this.active;
    }

    end(token: string): void {
        if (this.active === token) this.active = null;
    }

    get busy(): boolean {
        return this.active !== null;
    }
}
