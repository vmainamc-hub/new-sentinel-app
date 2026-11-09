import {
    removeStalePendingContracts,
    removeStalePendingFromCache,
    parseStoredGmtDate,
} from '../stale-pending-transactions';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09 12:00 GMT
const contract = (date_start: unknown, is_completed = false) => ({
    type: 'contract',
    data: { contract_id: 1, date_start, is_completed },
});

describe('stale pending transactions', () => {
    it('parses the stored GMT format with unpadded month/day', () => {
        expect(parseStoredGmtDate('2026-11-5 07:55:07 GMT')).toBe(Date.UTC(2026, 10, 5, 7, 55, 7));
        expect(parseStoredGmtDate('nonsense')).toBeNaN();
    });

    it('drops an unfinished contract from days ago (the stuck 10 USD row)', () => {
        const list = [contract('2026-11-5 07:55:07 GMT')];
        expect(removeStalePendingContracts(list, NOW)).toEqual([]);
    });

    it('keeps a contract that is running right now', () => {
        const list = [contract('2026-11-9 11:59:30 GMT')];
        expect(removeStalePendingContracts(list, NOW)).toHaveLength(1);
    });

    it('keeps finished contracts however old, dividers, and unknown start times', () => {
        const list = [
            contract('2026-11-1 07:55:07 GMT', true),
            { type: 'divider', data: 'run-1' },
            contract(undefined),
        ];
        expect(removeStalePendingContracts(list, NOW)).toHaveLength(3);
    });

    it('cleans every account in the saved cache', () => {
        const cache = { A: [contract('2026-11-5 07:55:07 GMT')], B: [contract('2026-11-9 11:59:00 GMT')] };
        const cleaned = removeStalePendingFromCache(cache, NOW);
        expect(cleaned.A).toEqual([]);
        expect(cleaned.B).toHaveLength(1);
    });
});
