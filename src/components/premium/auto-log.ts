// Auto Trader run log: one row per auto run, so each entry rule can be judged on results after a few thousand trades
// instead of by one bad night. Pure helpers plus a small, failure-tolerant localStorage store.

import type { EntryInfo } from './auto-trader';

export type AutoLogRow = {
    id: number;
    at: number;
    market: string;
    contract: string;
    mode: string;
    stake: number;
    trades: number;
    rule: string;
    pattern: string;
    digits: string;
    waitedSec: number;
    pressure: string;
    exits: string;
    wins: number;
    losses: number;
    pnl: number;
    result: 'WIN' | 'LOSS' | 'MIXED' | 'OPEN';
};

export const LOG_KEY = 'apex_auto_log_v1';
export const LOG_CAP = 500;

export type LogInput = {
    id: number;
    at: number;
    market: string;
    stake: number;
    trades: number;
    entry: EntryInfo | null;
    exitDigits: Array<number | null>;
    wins: number;
    losses: number;
    pnl: number;
    unsettled: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export const buildLogRow = (input: LogInput): AutoLogRow => {
    const { entry } = input;
    const result: AutoLogRow['result'] = input.unsettled > 0 ? 'OPEN' : input.pnl > 0 ? 'WIN' : input.pnl < 0 ? 'LOSS' : 'MIXED';
    return {
        id: input.id, at: input.at, market: input.market, contract: entry?.label ?? '',
        mode: entry ? (entry.recovery ? `RECOVERY ${entry.step}` : 'NORMAL') : '',
        stake: input.stake, trades: input.trades,
        rule: entry?.rule ?? 'no entry record', pattern: entry?.pattern ?? '', digits: entry ? entry.digits.join(' ') : '',
        waitedSec: entry ? Math.round(entry.waitedMs / 100) / 10 : 0,
        pressure: entry?.pressure ? `${Math.round(entry.pressure.observed * 100)}% vs ${Math.round(entry.pressure.expected * 100)}%` : '',
        // Every settlement digit, in order. A missing one is shown as "?" so a gap is never silently blank.
        exits: input.exitDigits.map(digit => (digit === null ? '?' : String(digit))).join(' '),
        wins: input.wins, losses: input.losses, pnl: round2(input.pnl), result,
    };
};

const COLUMNS: Array<[string, (row: AutoLogRow) => string | number]> = [
    ['time', row => new Date(row.at).toISOString()], ['market', row => row.market], ['contract', row => row.contract], ['mode', row => row.mode],
    ['stake', row => row.stake], ['trades', row => row.trades], ['entry_rule', row => row.rule], ['tick_pattern', row => row.pattern],
    ['entry_digits', row => row.digits], ['waited_s', row => row.waitedSec], ['pressure', row => row.pressure], ['exit_digits', row => row.exits],
    ['wins', row => row.wins], ['losses', row => row.losses], ['pnl', row => row.pnl], ['result', row => row.result],
];

const cell = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (rows: AutoLogRow[]): string =>
    [COLUMNS.map(([name]) => name).join(','), ...rows.map(row => COLUMNS.map(([, get]) => cell(get(row))).join(','))].join('\n');

export const loadLog = (): AutoLogRow[] => {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(LOG_KEY) || '[]');
        return Array.isArray(parsed) ? (parsed.slice(0, LOG_CAP) as AutoLogRow[]) : [];
    } catch {
        return [];
    }
};

export const saveLog = (rows: AutoLogRow[]) => {
    try {
        window.localStorage.setItem(LOG_KEY, JSON.stringify(rows.slice(0, LOG_CAP)));
    } catch {
        /* storage can be unavailable or full; the log still works for this visit */
    }
};

/** Newest first, capped. */
export const addLogRow = (rows: AutoLogRow[], row: AutoLogRow): AutoLogRow[] => [row, ...rows].slice(0, LOG_CAP);
