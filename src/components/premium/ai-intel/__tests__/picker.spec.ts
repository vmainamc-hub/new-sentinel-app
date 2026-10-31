import { mulberry32 } from '@/components/premium/sixfold/stats';
import { BASELINE_CANDIDATES, rankPicks } from '../picker';

const fair = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};
const planted = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? 1 : 8)); // after a 0-2 trigger the next is always a win for OVER 2
const NOW = 10_000;
const fresh = () => NOW - 500;
const base = { duration: 1, directions: 'BOTH' as const };

describe('rankPicks', () => {
    it('picks the planted market/direction/entry first and marks it significant', () => {
        const picks = rankPicks({ A: fair(3000, 1), PLANTED: planted, B: fair(3000, 2) }, fresh, NOW, { ...base, evidenceOnly: true });
        expect(picks.length).toBeGreaterThan(0);
        expect(picks[0]).toMatchObject({ market: 'PLANTED', direction: 'OVER_2', entry: 'SETUP', significant: true });
        expect(picks.every(p => p.significant)).toBe(true);
    });

    it('evidenceOnly returns nothing on fair markets; best-available still ranks them, without claiming an edge', () => {
        const s = { A: fair(4000, 11), B: fair(4000, 12), C: fair(4000, 13) };
        expect(rankPicks(s, fresh, NOW, { ...base, evidenceOnly: true })).toHaveLength(0);
        const any = rankPicks(s, fresh, NOW, { ...base, evidenceOnly: false });
        expect(any.length).toBeGreaterThan(0);
        expect(any[0].significant).toBe(false);
        expect(any[0].reason).toMatch(/no proven edge/);
    });

    it('skips stale markets, short histories and unstable regimes', () => {
        const unstable = [...fair(900, 5), ...Array.from({ length: 200 }, () => 9)];
        const s = { STALE: fair(3000, 1), SHORT: fair(100, 2), UNSTABLE: unstable, OK: fair(3000, 3) };
        const picks = rankPicks(s, m => (m === 'STALE' ? NOW - 60_000 : fresh()), NOW, { ...base, evidenceOnly: false });
        const markets = new Set(picks.map(p => p.market));
        expect(markets.has('STALE')).toBe(false);
        expect(markets.has('SHORT')).toBe(false);
        expect(markets.has('OK')).toBe(true);
    });

    it('respects the direction filter and CUSTOM candidates', () => {
        const only = rankPicks({ A: fair(3000, 7) }, fresh, NOW, { ...base, evidenceOnly: false, directions: 'UNDER_7' });
        expect(only.every(p => p.direction === 'UNDER_7')).toBe(true);
        const custom = rankPicks({ PLANTED: planted }, fresh, NOW, {
            ...base,
            evidenceOnly: true,
            candidates: [{ direction: 'OVER_2', entry: 'CUSTOM', digits: [1], strategyId: 's1', strategyLabel: 'S1' }],
        });
        expect(custom[0]).toMatchObject({ entry: 'CUSTOM', customDigits: [1], strategyId: 's1' });
        expect(BASELINE_CANDIDATES).toHaveLength(4);
    });
});
