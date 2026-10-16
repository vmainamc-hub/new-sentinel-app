// DBot-style trade simulator.
//
// It takes trades exactly the way a Deriv bot does:
//   1. wait for an ENTRY digit (the setup),
//   2. buy on the next tick; the contract settles `duration` ticks later on the EXIT digit,
//   3. only ONE contract is open at a time, and the exit tick is not reused as the next entry,
//   4. then go back to waiting.
// So the digits 1 4 7 2 4 with "Over 2 / enter on 0-1-2" give exactly two trades (1->4 and 2->4).

import { type ContractSide, outcome } from './engine';
import { breakEvenRate, evPerTrade, profitMultiple } from './stats';

export type Contract = {
    side: ContractSide;
    /** Barrier for Over/Under, target digit for Matches/Differs, unused (0) for Even/Odd. */
    param: number;
    /**
     * Matches/Differs only: the target digit is not fixed, it is taken per trade (by default the digit that armed the bot,
     * i.e. "Differs on the last digit"). `target()` in the simulator hooks can override it.
     */
    dynamic?: boolean;
};

export const contractKey = (c: Contract) => `${c.side}:${c.dynamic ? 'D' : c.param}`;

export const contractLabel = (c: Contract): string => {
    switch (c.side) {
        case 'OVER':
            return `Over ${c.param}`;
        case 'UNDER':
            return `Under ${c.param}`;
        case 'EVEN':
            return 'Even';
        case 'ODD':
            return 'Odd';
        case 'MATCHES':
            return c.dynamic ? 'Matches · last digit' : `Matches ${c.param}`;
        case 'DIFFERS':
            return c.dynamic ? 'Differs · last digit' : `Differs ${c.param}`;
    }
};

/** Over barriers run 0-8 and Under barriers 1-9 on Deriv; anything else has no winning (or no losing) digit. */
export const isValidContract = (c: Contract): boolean => {
    if (c.side === 'OVER') return Number.isInteger(c.param) && c.param >= 0 && c.param <= 8;
    if (c.side === 'UNDER') return Number.isInteger(c.param) && c.param >= 1 && c.param <= 9;
    if (c.side === 'MATCHES' || c.side === 'DIFFERS')
        return c.dynamic || (Number.isInteger(c.param) && c.param >= 0 && c.param <= 9);
    return true;
};

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Digits that win this contract. For a dynamic contract pass the target digit. */
export function winningDigits(c: Contract, target?: number): number[] {
    const t = c.dynamic ? (target ?? 0) : c.param;
    return DIGITS.filter(d => outcome(c.side, d, t));
}
export const losingDigits = (c: Contract, target?: number): number[] => {
    const win = new Set(winningDigits(c, target));
    return DIGITS.filter(d => !win.has(d));
};

/** Theoretical win probability of one tick, assuming digits are uniform. */
export const winProbability = (c: Contract): number =>
    c.dynamic ? (c.side === 'MATCHES' ? 0.1 : 0.9) : winningDigits(c).length / 10;

/** The exact opposite contract: it wins on precisely the digits this one loses. */
export function complementOf(c: Contract): Contract {
    switch (c.side) {
        case 'OVER':
            return { side: 'UNDER', param: c.param + 1 };
        case 'UNDER':
            return { side: 'OVER', param: c.param - 1 };
        case 'EVEN':
            return { side: 'ODD', param: 0 };
        case 'ODD':
            return { side: 'EVEN', param: 0 };
        case 'MATCHES':
            return { side: 'DIFFERS', param: c.param, dynamic: c.dynamic };
        case 'DIFFERS':
            return { side: 'MATCHES', param: c.param, dynamic: c.dynamic };
    }
}

export const OVER_LADDER: Contract[] = Array.from({ length: 9 }, (_, i) => ({ side: 'OVER' as const, param: i }));
export const UNDER_LADDER: Contract[] = Array.from({ length: 9 }, (_, i) => ({ side: 'UNDER' as const, param: i + 1 }));

// ---------- bot configuration ----------

export type EntryMode =
    /** Wait for a digit that would have LOST this contract (Over/Under/Even/Odd) or for the target digit (Matches/Differs). */
    | 'SETUP'
    /** No setup: buy as soon as the bot is free. */
    | 'ANY'
    /** Wait for any of the chosen digits. */
    | 'CUSTOM';

export type BotConfig = {
    /** Contract length in ticks (1-10). The exit digit is the last digit of the contract. */
    duration: number;
    entry: { mode: EntryMode; digits?: number[] };
    /** Platform margin used to estimate the payout (the real quote comes from Deriv's proposal). */
    margin: number;
};

export const DEFAULT_BOT: BotConfig = { duration: 1, entry: { mode: 'SETUP' }, margin: 0.05 };

export function entryDigitsFor(c: Contract, entry: BotConfig['entry']): Set<number> {
    if (entry.mode === 'ANY') return new Set(DIGITS);
    if (entry.mode === 'CUSTOM') return new Set((entry.digits ?? []).filter(d => d >= 0 && d <= 9));
    if (c.dynamic) return new Set(DIGITS);
    if (c.side === 'MATCHES' || c.side === 'DIFFERS') return new Set([c.param]);
    return new Set(losingDigits(c));
}

// ---------- simulation ----------

export type Trade = {
    /** Index of the tick whose digit armed the bot. The contract is bought on the next tick. */
    entryIndex: number;
    entryDigit: number;
    /** Index of the settlement tick. */
    exitIndex: number;
    exitDigit: number;
    /** Target digit for Matches/Differs. */
    target: number | null;
    won: boolean;
};

export type OpenTrade = { entryIndex: number; entryDigit: number; ticksLeft: number };

export type BotRun = {
    contract: Contract;
    config: BotConfig;
    /** Number of ticks simulated. */
    n: number;
    trades: Trade[];
    /** A contract that was bought but has not settled yet (its exit tick has not printed). */
    open: OpenTrade | null;
    /** Ticks since the last settlement; null if no trade has settled. */
    ticksSinceTrade: number | null;
};

export type SimHooks = {
    /** Extra gate: the bot may only arm on tick `index` when this returns true. */
    gate?: (index: number) => boolean;
    /** Target digit for a dynamic Matches/Differs contract; defaults to the digit that armed the bot. */
    target?: (index: number) => number | undefined;
};

export function simulateBot(
    digits: readonly number[],
    contract: Contract,
    cfg: BotConfig = DEFAULT_BOT,
    hooks: SimHooks = {}
): BotRun {
    const n = digits.length;
    const duration = Math.max(1, Math.min(10, Math.trunc(cfg.duration) || 1));
    const entries = entryDigitsFor(contract, cfg.entry);
    const trades: Trade[] = [];
    let open: OpenTrade | null = null;
    let i = 0;
    while (i < n) {
        const d = digits[i];
        if (entries.has(d) && (!hooks.gate || hooks.gate(i))) {
            const exitIndex = i + duration;
            if (exitIndex >= n) {
                open = { entryIndex: i, entryDigit: d, ticksLeft: exitIndex - (n - 1) };
                break;
            }
            const target = contract.dynamic
                ? (hooks.target?.(i) ?? d)
                : contract.side === 'MATCHES' || contract.side === 'DIFFERS'
                  ? contract.param
                  : null;
            const exitDigit = digits[exitIndex];
            const won = outcome(contract.side, exitDigit, contract.dynamic ? (target as number) : contract.param);
            trades.push({ entryIndex: i, entryDigit: d, exitIndex, exitDigit, target, won });
            i = exitIndex + 1;
        } else i++;
    }
    const last = trades.at(-1);
    return { contract, config: cfg, n, trades, open, ticksSinceTrade: last ? n - 1 - last.exitIndex : null };
}

// ---------- summaries ----------

export type StreakInfo = { kind: 'W' | 'L' | null; length: number; longestLoss: number; longestWin: number };

export function streaks(trades: readonly Trade[]): StreakInfo {
    let longestLoss = 0,
        longestWin = 0,
        runW = 0,
        runL = 0;
    for (const t of trades) {
        if (t.won) {
            runW++;
            runL = 0;
            if (runW > longestWin) longestWin = runW;
        } else {
            runL++;
            runW = 0;
            if (runL > longestLoss) longestLoss = runL;
        }
    }
    return { kind: runW ? 'W' : runL ? 'L' : null, length: runW || runL, longestLoss, longestWin };
}

/** Cumulative profit at a flat 1-unit stake, using the estimated payout. Starts at 0. */
export function equityCurve(trades: readonly Trade[], p: number, margin: number): number[] {
    const win = profitMultiple(p, margin);
    const out = [0];
    for (const t of trades) out.push(out[out.length - 1] + (t.won ? win : -1));
    return out;
}

export type WindowStats = { n: number; wins: number; rate: number | null };
export function windowStats(trades: readonly Trade[], count?: number): WindowStats {
    const slice = count === undefined ? trades : trades.slice(-count);
    const wins = slice.filter(t => t.won).length;
    return { n: slice.length, wins, rate: slice.length ? wins / slice.length : null };
}

export { breakEvenRate, evPerTrade, profitMultiple };
