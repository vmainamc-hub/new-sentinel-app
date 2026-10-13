import { LOG_CAP, addLogRow, buildLogRow, loadLog, saveLog, toCsv } from '../auto-log';
import type { EntryInfo } from '../auto-trader';

const entry: EntryInfo = {
    mode: 'DYNAMIC', rule: 'need 4 ticks, 20s window (base 3: after a loss +1)', baseTicks: 3, ticks: 4, windowSec: 20, pattern: 'O O O O', digits: [4, 5, 6, 7],
    barrier: 3, label: 'Over 3', recovery: true, step: 1, lossStreak: 1, waitedMs: 3400, pressure: { observed: 0.35, expected: 0.4 },
};
const input = { id: 1, at: Date.UTC(2026, 9, 12, 10, 0, 0), market: 'Volatility 50', stake: 1, trades: 3, entry, exitDigits: [6, 6, null], wins: 2, losses: 1, pnl: 0.8, unsettled: 0 };

describe('run log', () => {
    it('records the rule, the tick pattern, every exit digit and the result', () => {
        const row = buildLogRow(input);
        expect(row).toMatchObject({ contract: 'Over 3', mode: 'RECOVERY 1', rule: entry.rule, pattern: 'O O O O', digits: '4 5 6 7', waitedSec: 3.4, pressure: '35% vs 40%', result: 'WIN', pnl: 0.8 });
        expect(row.exits).toBe('6 6 ?');                       // a missing settlement digit is shown, never left blank
    });
    it('classifies results and flags runs that did not fully settle', () => {
        expect(buildLogRow({ ...input, pnl: -2 }).result).toBe('LOSS');
        expect(buildLogRow({ ...input, pnl: 0 }).result).toBe('MIXED');
        expect(buildLogRow({ ...input, unsettled: 1 }).result).toBe('OPEN');
    });
    it('copes with a run that has no entry record', () => {
        const row = buildLogRow({ ...input, entry: null });
        expect(row.rule).toBe('no entry record');
        expect(row.mode).toBe('');
    });
    it('exports CSV with a header, quoting, and one line per run', () => {
        const csv = toCsv([buildLogRow(input), buildLogRow({ ...input, id: 2, market: 'Vol, "50"' })]);
        const lines = csv.split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/^time,market,contract,mode,stake,trades,entry_rule,tick_pattern,entry_digits,waited_s,pressure,exit_digits,wins,losses,pnl,result$/);
        expect(lines[2]).toContain('"Vol, ""50"""');
    });
    it('keeps newest first, caps the length, and survives broken storage', () => {
        let rows = [] as ReturnType<typeof buildLogRow>[];
        for (let i = 0; i < LOG_CAP + 5; i++) rows = addLogRow(rows, buildLogRow({ ...input, id: i }));
        expect(rows).toHaveLength(LOG_CAP);
        expect(rows[0].id).toBe(LOG_CAP + 4);
        saveLog(rows.slice(0, 3));
        expect(loadLog()).toHaveLength(3);
        window.localStorage.setItem('apex_auto_log_v1', '{not json');
        expect(loadLog()).toEqual([]);
    });
});
