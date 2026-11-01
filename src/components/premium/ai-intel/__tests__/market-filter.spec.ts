import { filterSeries, isApexMarket } from '../market-filter';

const offers = (table: Record<string, Record<string, boolean>>) => ({ isOffered: (s: string, t: string) => (table[s] ? (table[s][t] ?? null) : null) });

describe('market filter', () => {
    it('keeps Volatility indices and drops Jump and anything else', () => {
        const f = offers({});
        for (const ok of ['R_10', 'R_100', '1HZ10V', '1HZ250V']) expect(isApexMarket(ok, f)).toBe(true);
        for (const no of ['JD10', 'CRASH500', 'stpRNG', 'frxEURUSD', 'R_', '']) expect(isApexMarket(no, f)).toBe(false);
    });
    it('drops a market only when Deriv said an Over/Under digit contract is NOT offered; unknown stays allowed', () => {
        const f = offers({ R_25: { DIGITOVER: true, DIGITUNDER: true }, R_50: { DIGITOVER: false, DIGITUNDER: true }, R_75: { DIGITOVER: true, DIGITUNDER: false } });
        expect(isApexMarket('R_25', f)).toBe(true);
        expect(isApexMarket('R_50', f)).toBe(false);
        expect(isApexMarket('R_75', f)).toBe(false);
        expect(isApexMarket('R_10', f)).toBe(true); // not asked yet
    });
    it('filters a series map without touching the arrays', () => {
        const a = [1, 2, 3];
        const out = filterSeries({ R_10: a, JD10: [4], R_50: [5] }, offers({ R_50: { DIGITOVER: false } }));
        expect(Object.keys(out)).toEqual(['R_10']);
        expect(out.R_10).toBe(a);
    });
});
