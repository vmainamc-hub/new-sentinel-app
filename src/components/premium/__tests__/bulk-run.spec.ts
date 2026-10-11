import {
    MAX_BULK_RUNS, MAX_EXPOSURE, MAX_STAKE, MIN_STAKE, RunGuard, emptyTally, exposure, limitError, recordFailed, recordPlaced,
    recordSettled, sanitizeBulk, syncReport, syncText, digitOfValue, exitDigitFrom, exitDigitsText, settlementText,
} from '../bulk-run';

describe('input limits', () => {
    it('sanitizes unsafe values', () => {
        expect(sanitizeBulk({ stake: -1 }).stake).toBe(MIN_STAKE);
        expect(sanitizeBulk({ stake: 1e9 }).stake).toBe(MAX_STAKE);
        expect(sanitizeBulk({ runs: 9999 }).runs).toBe(MAX_BULK_RUNS);
        expect(sanitizeBulk({ runs: 0 }).runs).toBe(1);
        expect(sanitizeBulk({ runs: 2.9 }).runs).toBe(2);
        expect(sanitizeBulk({ duration: 50 }).duration).toBe(10);
        expect(sanitizeBulk({ stake: NaN as unknown as number })).toEqual(sanitizeBulk({}));
    });
    it('blocks runs whose total exposure exceeds the cap, however the numbers are reached', () => {
        expect(exposure(sanitizeBulk({ stake: 0.5, runs: 20 }))).toBe(10);
        expect(limitError(sanitizeBulk({ stake: 0.5, runs: 20 }))).toBeNull();
        expect(limitError({ stake: MAX_STAKE, runs: 3, duration: 1 })).not.toBeNull();
        expect(exposure({ stake: 20, runs: 100, duration: 1 })).toBe(MAX_EXPOSURE);
        expect(limitError({ stake: 20, runs: 100, duration: 1 })).toBeNull();
        expect(limitError({ stake: 20.01, runs: 100, duration: 1 })).not.toBeNull();
    });
});

describe('tally', () => {
    it('reports requested, placed, failed, settled and realised P/L separately', () => {
        let t = emptyTally(5);
        t = recordPlaced(recordPlaced(recordPlaced(t)));
        t = recordFailed(recordFailed(t));
        t = recordSettled(t, 0.48);
        t = recordSettled(t, -0.5);
        expect(t).toEqual({ requested: 5, placed: 3, failed: 2, settled: 2, wins: 1, losses: 1, pnl: -0.02 });
    });
});

describe('same-tick report', () => {
    const same = [1, 2, 3].map(id => ({ contractId: id, entryTime: 100, exitTime: 101, exitDigit: 2 }));
    it('is synced only when every contract shares one entry and one exit tick', () => {
        expect(syncReport(same)).toEqual({ total: 3, known: 3, entryTicks: 1, exitTicks: 1, synced: true, exitDigit: 2 });
        const split = syncReport([...same, { contractId: 4, entryTime: 101, exitTime: 102, exitDigit: 7 }]);
        expect(split.synced).toBe(false);
        expect(split.entryTicks).toBe(2);
        expect(split.exitDigit).toBeNull();
    });
    it('never claims sync when ticks are unreported', () => {
        const partial = syncReport([same[0], { contractId: 2, entryTime: null, exitTime: null, exitDigit: null }]);
        expect(partial.synced).toBe(false);
        expect(partial.known).toBe(1);
        expect(syncReport([]).synced).toBe(false);
    });
    it('describes the outcome in plain words', () => {
        expect(syncText(syncReport(same))).toMatch(/same tick/);
        expect(syncText(syncReport(same))).toMatch(/exit digit 2/);
        expect(syncText(syncReport([...same, { contractId: 4, entryTime: 101, exitTime: 102, exitDigit: 7 }]))).toMatch(/differ/);
        expect(syncText(syncReport([]))).toBe('');
    });
});

describe('run guard', () => {
    it('refuses a second start while a run is active and releases only for the same token', () => {
        const guard = new RunGuard();
        const first = guard.begin();
        expect(first).not.toBeNull();
        expect(guard.begin()).toBeNull();
        expect(guard.busy).toBe(true);
        guard.end('run-wrong');
        expect(guard.busy).toBe(true);
        guard.end(first as string);
        expect(guard.busy).toBe(false);
        expect(guard.begin()).not.toBeNull();
    });
});

describe('exit (settlement) digits', () => {
    it('reads the digit from Deriv display strings, keeping trailing zeros', () => {
        expect(digitOfValue('1238.47', 2)).toBe(7);
        expect(digitOfValue('1238.50', 2)).toBe(0);
        expect(digitOfValue(1238.5, 2)).toBe(0);
        expect(digitOfValue(613.63, 2)).toBe(3);
        expect(digitOfValue(undefined, 2)).toBeNull();
        expect(digitOfValue('', 2)).toBeNull();
    });

    it('tries every field Deriv has used for the exit price', () => {
        expect(exitDigitFrom({ exit_tick_display_value: '9464.87' }, 2)).toBe(7);
        expect(exitDigitFrom({ exit_spot_display_value: '9464.21' }, 2)).toBe(1);
        expect(exitDigitFrom({ exit_spot: 9464.3 }, 2)).toBe(0);
        expect(exitDigitFrom({ sell_spot_display_value: '9464.55' }, 2)).toBe(5);
    });

    it('falls back to the contract tick audit, then to the market tick history', () => {
        const audited = { exit_tick_time: 200, audit_details: { all_ticks: [{ epoch: 199, tick_display_value: '1.10' }, { epoch: 200, tick_display_value: '1.23' }] } };
        expect(exitDigitFrom(audited, 2)).toBe(3);
        const timeOnly = { exit_spot_time: 300, status: 'won' };
        expect(exitDigitFrom(timeOnly, 2)).toBeNull();
        expect(exitDigitFrom(timeOnly, 2, epoch => (epoch === 300 ? 4 : null))).toBe(4);
        expect(exitDigitFrom({ status: 'won' }, 2, () => 9)).toBeNull(); // no exit time: never guess
    });

    it('lists EVERY exit digit, not only a shared one', () => {
        const fills = [3, 3, 7].map((digit, i) => ({ contractId: i, entryTime: 100, exitTime: 101 + i, exitDigit: digit }));
        expect(exitDigitsText(fills)).toBe('3 (×2), 7');
        expect(settlementText(fills)).toMatch(/Exit digits: 3 \(×2\), 7\./);
        const same = [1, 2].map(id => ({ contractId: id, entryTime: 100, exitTime: 101, exitDigit: 4 }));
        expect(settlementText(same)).toMatch(/exit digit 4/);
        expect(settlementText([])).toBe('');
        const waiting = [{ contractId: 1, entryTime: 100, exitTime: 101, exitDigit: 6 }, { contractId: 2, entryTime: null, exitTime: null, exitDigit: null }];
        expect(settlementText(waiting)).toMatch(/Exit digits: 6/);
    });
});

