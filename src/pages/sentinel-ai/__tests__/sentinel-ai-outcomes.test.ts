import {
    MAX_RECORDS,
    MIN_SIGNALS,
    GONE_AFTER_MS,
    UNRESOLVED_AFTER_MS,
    baseRate,
    contractWins,
    csvCell,
    emptyLogState,
    inferDecimals,
    lastDigit,
    logSurfaced,
    markTraded,
    parseStoredRecords,
    resolveRecord,
    summarize,
    toCsv,
    wilson95,
    type SignalLogRecord,
    type SurfacedSignalInput,
} from '../sentinel-ai-outcomes';

const input = (over: Partial<SurfacedSignalInput> = {}): SurfacedSignalInput => ({
    symbol: 'R_100',
    contract: 'UNDER',
    barrier: 7,
    label: 'Under 7',
    psychologyScore: 70,
    momentumPass: true,
    momentumScore: 60,
    momentumBlocked: false,
    ...over,
});

const record = (over: Partial<SignalLogRecord> = {}): SignalLogRecord => ({
    id: 'a',
    surfacedAt: 1000,
    symbol: 'R_100',
    contract: 'UNDER',
    barrier: 7,
    label: 'Under 7',
    decisionTickEpoch: 5000,
    outcomeTickEpoch: null,
    outcomeDigit: null,
    won: null,
    state: 'pending',
    psychologyScore: 70,
    momentumPass: true,
    momentumScore: 60,
    momentumBlocked: false,
    traded: false,
    ...over,
});

describe('contract rules', () => {
    it('Over / Under are strict', () => {
        expect(contractWins('OVER', 2, 3)).toBe(true);
        expect(contractWins('OVER', 2, 2)).toBe(false);
        expect(contractWins('UNDER', 7, 6)).toBe(true);
        expect(contractWins('UNDER', 7, 7)).toBe(false);
    });
    it('Even/Odd, Matches/Differs', () => {
        expect(contractWins('EVEN', null, 4)).toBe(true);
        expect(contractWins('EVEN', null, 3)).toBe(false);
        expect(contractWins('ODD', null, 3)).toBe(true);
        expect(contractWins('MATCH', 5, 5)).toBe(true);
        expect(contractWins('MATCH', 5, 4)).toBe(false);
        expect(contractWins('DIFFER', 5, 4)).toBe(true);
        expect(contractWins('DIFFER', 5, 5)).toBe(false);
    });
    it('base rates', () => {
        expect(baseRate('OVER', 2)).toBeCloseTo(0.7);
        expect(baseRate('UNDER', 7)).toBeCloseTo(0.7);
        expect(baseRate('OVER', 4)).toBeCloseTo(0.5);
        expect(baseRate('EVEN', null)).toBe(0.5);
        expect(baseRate('MATCH', 3)).toBe(0.1);
        expect(baseRate('DIFFER', 3)).toBe(0.9);
    });
});

describe('digit derivation (same as bulk-feed)', () => {
    it('uses the market decimals, so trailing zeros count', () => {
        const prices = Array.from({ length: 40 }, (_, i) => 100 + i * 0.13);
        expect(inferDecimals(prices, 2)).toBe(2);
        expect(lastDigit(1234.5, 2)).toBe(0);
        expect(lastDigit(1234.56, 2)).toBe(6);
        expect(lastDigit(12.3, 3)).toBe(0);
    });
});

describe('outcome resolution', () => {
    const ticks = [
        { t: 4000, price: 10.11 },
        { t: 5000, price: 10.12 },
        { t: 7000, price: 10.14 },
    ];
    it('never uses the decision tick: the first tick strictly after it decides', () => {
        const next = resolveRecord(record(), ticks, 2, 8000);
        expect(next.state).toBe('resolved');
        expect(next.outcomeTickEpoch).toBe(7000);
        expect(next.outcomeDigit).toBe(4);
        expect(next.won).toBe(true);
    });
    it('a losing digit is recorded as a loss', () => {
        const next = resolveRecord(record({ contract: 'OVER', barrier: 4 }), ticks, 2, 8000);
        expect(next.won).toBe(false);
    });
    it('stays pending until a later tick arrives, then goes unresolved after 30 s', () => {
        const only = [{ t: 5000, price: 10.12 }];
        const same = record();
        expect(resolveRecord(same, only, 2, 6000)).toBe(same);
        const late = resolveRecord(same, only, 2, 1000 + UNRESOLVED_AFTER_MS + 1);
        expect(late.state).toBe('unresolved');
        expect(late.won).toBeNull();
    });
    it('a first tick that comes more than 30 s after the decision is unresolved, not a result', () => {
        const next = resolveRecord(record(), [{ t: 5000 + UNRESOLVED_AFTER_MS + 1, price: 10.15 }], 2, 100000);
        expect(next.state).toBe('unresolved');
    });
    it('no decision tick means unresolved; resolved records are left alone', () => {
        expect(resolveRecord(record({ decisionTickEpoch: null }), ticks, 2, 0).state).toBe('unresolved');
        const done = record({ state: 'resolved', won: true });
        expect(resolveRecord(done, ticks, 2, 0)).toBe(done);
    });
});

describe('logging, de-duplication and the cap', () => {
    const epoch = () => 5000;
    it('logs a signal once while it stays surfaced', () => {
        let state = logSurfaced(emptyLogState(), [input()], 1000, epoch);
        state = logSurfaced(state, [input()], 2000, epoch);
        state = logSurfaced(state, [input()], 3000, epoch);
        expect(state.records).toHaveLength(1);
        expect(state.records[0].decisionTickEpoch).toBe(5000);
        expect(state.records[0].state).toBe('pending');
    });
    it('a one-sample flicker is not logged twice, a real absence is', () => {
        let state = logSurfaced(emptyLogState(), [input()], 1000, epoch);
        state = logSurfaced(state, [], 2000, epoch);
        state = logSurfaced(state, [input()], 3000, epoch);
        expect(state.records).toHaveLength(1);
        state = logSurfaced(state, [], 4000, epoch);
        state = logSurfaced(state, [], 4000 + GONE_AFTER_MS + 1, epoch);
        state = logSurfaced(state, [input()], 4000 + GONE_AFTER_MS + 2, epoch);
        expect(state.records).toHaveLength(2);
    });
    it('the key is symbol + contract + barrier', () => {
        const state = logSurfaced(
            emptyLogState(),
            [input(), input({ barrier: 6, label: 'Under 6' }), input({ symbol: 'R_50' }), input({ contract: 'OVER', barrier: 2 })],
            1000,
            epoch
        );
        expect(state.records).toHaveLength(4);
    });
    it('momentum-blocked signals are logged too, with the flags', () => {
        const state = logSurfaced(
            emptyLogState(),
            [input({ momentumPass: false, momentumBlocked: true, momentumScore: 10 })],
            1000,
            epoch
        );
        expect(state.records[0]).toMatchObject({ momentumPass: false, momentumBlocked: true, traded: false });
    });
    it('no tick available is logged as unresolved', () => {
        const state = logSurfaced(emptyLogState(), [input()], 1000, () => null);
        expect(state.records[0].state).toBe('unresolved');
    });
    it('drops the oldest beyond 5000 and does not mutate the previous state', () => {
        const base = emptyLogState(Array.from({ length: MAX_RECORDS }, (_, i) => record({ id: `old-${i}` })));
        const before = base.records;
        const next = logSurfaced(base, [input({ symbol: 'R_75' })], 9000, epoch);
        expect(next.records).toHaveLength(MAX_RECORDS);
        expect(next.records[0].id).toBe('old-1');
        expect(next.records[MAX_RECORDS - 1].symbol).toBe('R_75');
        expect(before).toHaveLength(MAX_RECORDS);
        expect(before[0].id).toBe('old-0');
    });
    it('marks the newest record of a signal as traded', () => {
        const records = [record({ id: '1' }), record({ id: '2' }), record({ id: '3', symbol: 'R_50' })];
        const next = markTraded(records, 'R_100|UNDER|7');
        expect(next[1].traded).toBe(true);
        expect(next[0].traded).toBe(false);
        expect(markTraded(records, 'X|OVER|1')).toBe(records);
    });
});

describe('CSV', () => {
    it('escapes commas, quotes and line breaks', () => {
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('x\ny')).toBe('"x\ny"');
        expect(csvCell(null)).toBe('');
        expect(csvCell(false)).toBe('false');
    });
    it('has a header and one row per record', () => {
        const csv = toCsv([record({ label: 'Under, 7' })]);
        const lines = csv.split('\r\n');
        expect(lines[0].startsWith('id,surfacedAt,symbol,contract,barrier,label')).toBe(true);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('"Under, 7"');
    });
});

describe('statistics', () => {
    it('Wilson interval', () => {
        const w = wilson95(70, 100)!;
        expect(w.low).toBeCloseTo(0.6038, 2);
        expect(w.high).toBeCloseTo(0.781, 3);
        expect(wilson95(0, 0)).toBeNull();
    });
    it('summary uses break-even p0 / 0.955 and refuses a verdict below the minimum', () => {
        const records = Array.from({ length: 10 }, (_, i) =>
            record({ id: String(i), state: 'resolved', won: i < 7, momentumPass: i % 2 === 0 })
        );
        records.push(record({ id: 'p', state: 'pending' }), record({ id: 'u', state: 'unresolved' }));
        const summary = summarize(records);
        const row = summary.byType[0];
        expect(row.resolved).toBe(10);
        expect(row.wins).toBe(7);
        expect(row.winPct).toBe(70);
        expect(row.breakEvenPct).toBeCloseTo(73.3, 1);
        expect(row.note).toBe('too few signals to judge');
        expect(summary.pending).toBe(1);
        expect(summary.unresolved).toBe(1);
        expect(summary.momentumPassed.resolved + summary.momentumFailed.resolved).toBe(10);
    });
    it('gives a neutral reading once there are enough signals', () => {
        const records = Array.from({ length: MIN_SIGNALS }, (_, i) =>
            record({ id: String(i), state: 'resolved', won: i < MIN_SIGNALS * 0.9 })
        );
        expect(summarize(records).byType[0].note).toBe('interval is above break-even');
        const weak = Array.from({ length: MIN_SIGNALS }, (_, i) =>
            record({ id: String(i), state: 'resolved', won: i < MIN_SIGNALS * 0.5 })
        );
        expect(summarize(weak).byType[0].note).toBe('interval is below break-even');
    });
});

describe('stored records', () => {
    it('keeps only well-formed records and never throws', () => {
        expect(parseStoredRecords('nope')).toEqual([]);
        expect(parseStoredRecords([null, 3, { id: 1 }, record(), { ...record(), contract: 'BAD' }])).toHaveLength(1);
    });
});
