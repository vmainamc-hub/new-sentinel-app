import { MAX_HISTORY, addEntry, entryFor, finishLatest, summarize, type HistoryEntry } from '../signal-zone-history';
import type { ZoneCandidate } from '../signal-zone-merge';

const candidate = (over: Partial<ZoneCandidate> = {}): ZoneCandidate => ({
    id: 'R_25|DIGITUNDER|8@1', key: 'R_25|DIGITUNDER|8', symbol: 'R_25', market: 'Volatility 25', contract: 'DIGITUNDER', barrier: 8, label: 'Under 8',
    source: 'both', sentinel: null, fusion: null, entryDigit: 4, entrySource: 'engine', entryNote: null, entryStatus: 'ARMED', entryWindow: '', entryWinRate: null, rank: 75,
    loadable: true, reason: null, createdAt: 1, ...over,
});
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({ ...entryFor(candidate(), 'both', 1), ...over });

describe('history', () => {
    it('keeps newest first and caps the list', () => {
        let list: HistoryEntry[] = [];
        for (let i = 0; i < MAX_HISTORY + 5; i += 1) list = addEntry(list, entry({ id: `e${i}` }));
        expect(list).toHaveLength(MAX_HISTORY);
        expect(list[0].id).toBe(`e${MAX_HISTORY + 4}`);
    });
    it('closes the newest open entry when a run ends', () => {
        const list = finishLatest([entry({ id: 'new' }), entry({ id: 'old', finished: true, pnl: 1 })], -4, 'Stop loss reached (-4.00)');
        expect(list[0]).toMatchObject({ id: 'new', finished: true, pnl: -4, stoppedBy: 'Stop loss reached (-4.00)' });
        expect(list[1].pnl).toBe(1);
    });
    it('ignores a run when nothing is open', () => {
        const list = [entry({ finished: true, pnl: 2 })];
        expect(finishLatest(list, -1, null)).toBe(list);
    });
    it('counts finished runs by mode and source without drawing conclusions', () => {
        const groups = summarize([
            entry({ id: 'a', finished: true, pnl: 2 }), entry({ id: 'b', finished: true, pnl: -1 }), entry({ id: 'c' }),
            entry({ id: 'd', mode: 'sentinel_only', source: 'sentinel', finished: true, pnl: 3 }),
        ]);
        const both = groups.find(g => g.mode === 'both');
        expect(both).toMatchObject({ loads: 3, finished: 2, wins: 1, net: 1 });
        expect(groups.find(g => g.mode === 'sentinel_only')).toMatchObject({ loads: 1, finished: 1, wins: 1, net: 3 });
    });
});
