import { mulberry32 } from '../../sixfold/stats';
import { assessContract, GROUP_SHARE, isTradableBarrier, type MarketSeries, scanOverlord } from '../engine';
import { lastDigit, LEGACY_WINDOW, legacyPercentage } from '../legacy';

/** A random-walk price series at 2 decimals with the last digits derived from it, like a real Deriv volatility index. */
const market = (seed: number, n: number, bias?: (i: number, r: () => number) => number | null): MarketSeries => {
    const r = mulberry32(seed);
    const prices: number[] = [];
    const digits: number[] = [];
    let p = 1000;
    for (let i = 0; i < n; i += 1) {
        const forced = bias ? bias(i, r) : null;
        if (forced === null) {
            p += (r() - 0.5) * 2;
        } else {
            // move the price so that the last digit is the forced one
            p = Math.floor(p * 10) / 10 + forced / 100;
        }
        const rounded = Math.round(p * 100) / 100;
        prices.push(rounded);
        digits.push(lastDigit(rounded, 2));
    }
    return { prices, digits };
};

const SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V'];
const series = (n = 1500) => Object.fromEntries(SYMBOLS.map((s, i) => [s, market(100 + i, n)]));

describe('legacy Overlord condition', () => {
    it('is the share of the last 50 digits that win, exactly as Overlord counted it', () => {
        const digits = [...Array(100).fill(0), ...Array(25).fill(9), ...Array(25).fill(1)];
        expect(legacyPercentage(digits, 'OVER', 3)).toBe(50);
        expect(legacyPercentage(digits, 'UNDER', 3)).toBe(50);
        expect(LEGACY_WINDOW).toBe(50);
        expect(legacyPercentage([], 'OVER', 3)).toBeNull();
    });

    it('reads the last digit at the market precision, keeping trailing zeros', () => {
        expect(lastDigit(1234.5, 2)).toBe(0);
        expect(lastDigit(1234.567, 3)).toBe(7);
    });
});

describe('barriers', () => {
    it('only allows contracts Deriv sells', () => {
        expect(isTradableBarrier('OVER', 9)).toBe(false);
        expect(isTradableBarrier('OVER', 0)).toBe(true);
        expect(isTradableBarrier('UNDER', 0)).toBe(false);
        expect(isTradableBarrier('UNDER', 9)).toBe(true);
        expect(isTradableBarrier('OVER', 2.5)).toBe(false);
    });
});

describe('scanOverlord', () => {
    it('ranks every market for the selected contract and returns one best market', () => {
        const scan = scanOverlord({ series: series(), symbols: SYMBOLS, side: 'UNDER', barrier: 7 });
        expect(scan.legacyOnly).toBe(false);
        expect(scan.reads).toHaveLength(SYMBOLS.length);
        expect(scan.reads.every(r => r.side === 'UNDER' && r.barrier === 7)).toBe(true);
        expect(scan.best).toBe(scan.reads[0]);
        expect(scan.best?.tier).not.toBe('LEGACY');
    });

    it('is deterministic', () => {
        const a = scanOverlord({ series: series(), symbols: SYMBOLS, side: 'OVER', barrier: 2 });
        const b = scanOverlord({ series: series(), symbols: SYMBOLS, side: 'OVER', barrier: 2 });
        expect(a.best?.symbol).toBe(b.best?.symbol);
        expect(a.reads.map(r => r.score)).toEqual(b.reads.map(r => r.score));
    });

    it('smart mode reads every Oracle contract plus the selected one on every market', () => {
        const scan = scanOverlord({
            series: series(),
            symbols: SYMBOLS,
            side: 'OVER',
            barrier: 3,
            mode: 'smart',
            ensembleTop: 0,
        });
        const keys = new Set(scan.reads.map(r => `${r.side}${r.barrier}`));
        ['OVER1', 'OVER2', 'OVER3', 'OVER4', 'UNDER5', 'UNDER6', 'UNDER7', 'UNDER8'].forEach(k =>
            expect(keys.has(k)).toBe(true)
        );
        expect(scan.reads).toHaveLength(SYMBOLS.length * 8);
    });

    it('never ranks a vetoed contract above one that was not vetoed', () => {
        const scan = scanOverlord({
            series: series(),
            symbols: SYMBOLS,
            side: 'OVER',
            barrier: 2,
            mode: 'smart',
            ensembleTop: 0,
        });
        const firstVetoed = scan.reads.findIndex(r => r.vetoed);
        if (firstVetoed >= 0) expect(scan.reads.slice(firstVetoed).every(r => r.vetoed)).toBe(true);
        for (const r of scan.reads) expect(r.tier === 'CAUTION').toBe(r.vetoed);
    });

    it('vetoes a contract whose losing digits are flooding the last ticks', () => {
        // Under 7 loses on 7, 8, 9. Flood the most recent 80 ticks with 8 and 9.
        const hot = market(7, 1500, (i, r) => (i >= 1420 ? (r() < 0.5 ? 8 : 9) : null));
        const read = assessContract('R_10', hot, 'UNDER', 7, null);
        expect(read.vetoed || read.tier !== 'STRONG').toBe(true);
        const scan = scanOverlord({
            series: { R_10: hot, R_25: market(8, 1500) },
            symbols: ['R_10', 'R_25'],
            side: 'UNDER',
            barrier: 7,
        });
        const hotRead = scan.reads.find(r => r.symbol === 'R_10');
        expect(hotRead?.tier === 'STRONG').toBe(false);
    });

    it('falls back to the original lowest-share rule when no market has enough history', () => {
        const thin = {
            A: { prices: [], digits: Array(50).fill(9) },
            B: { prices: [], digits: Array(50).fill(0) },
            C: { prices: [], digits: Array.from({ length: 50 }, (_, i) => i % 10) },
        };
        const scan = scanOverlord({ series: thin, symbols: ['A', 'B', 'C'], side: 'OVER', barrier: 3 });
        expect(scan.legacyOnly).toBe(true);
        expect(scan.best?.symbol).toBe('B'); // 0% of digits over 3: the lowest, as Overlord always picked
        expect(scan.best?.tier).toBe('LEGACY');
    });

    it('returns nothing for a contract Deriv does not sell, and nothing for markets with no ticks', () => {
        const scan = scanOverlord({ series: series(400), symbols: SYMBOLS, side: 'OVER', barrier: 9 });
        expect(scan.reads).toHaveLength(0);
        expect(scan.best).toBeNull();
        expect(scanOverlord({ series: {}, symbols: SYMBOLS, side: 'OVER', barrier: 2 }).best).toBeNull();
    });

    it('balances the three groups of layers to one', () => {
        const scan = scanOverlord({ series: series(), symbols: ['R_10'], side: 'UNDER', barrier: 7 });
        const read = scan.reads[0];
        const total = read.layers.reduce((t, l) => t + l.weight, 0);
        expect(total).toBeCloseTo(1, 6);
        const group = (names: string[]) =>
            read.layers.filter(l => names.includes(l.engine)).reduce((t, l) => t + l.weight, 0);
        expect(group(['Overlord'])).toBeCloseTo(GROUP_SHARE.overlord, 6);
        expect(group(['Apex Sentinel'])).toBeCloseTo(GROUP_SHARE.apex, 6);
        expect(group(['Sentinel AI', 'Sixfold', 'Apex Intel', 'Vanguard', 'Oracle'])).toBeCloseTo(
            GROUP_SHARE.oracle,
            6
        );
    });

    it('carries all three engines on every deep read and reports why', () => {
        const scan = scanOverlord({ series: series(), symbols: ['R_10'], side: 'OVER', barrier: 2 });
        const engines = new Set(scan.reads[0].layers.map(l => l.engine));
        expect(engines.has('Overlord')).toBe(true);
        expect(engines.has('Apex Sentinel')).toBe(true);
        expect(engines.has('Sixfold')).toBe(true);
        expect(scan.reads[0].reasons.length).toBeGreaterThan(0);
        expect(scan.reads[0].score).toBeGreaterThanOrEqual(0);
        expect(scan.reads[0].score).toBeLessThanOrEqual(100);
    });

    it('still reads a market with 300-ish ticks (Oracle + Apex both have their minimums)', () => {
        const scan = scanOverlord({ series: series(320), symbols: SYMBOLS, side: 'UNDER', barrier: 6 });
        expect(scan.legacyOnly).toBe(false);
    });

    it('finishes a full 11-market, 5000-tick selected scan quickly enough for a button press', () => {
        const syms = Array.from({ length: 11 }, (_, i) => `M${i}`);
        const big = Object.fromEntries(syms.map((s, i) => [s, market(500 + i, 5000)]));
        const t0 = Date.now();
        const scan = scanOverlord({ series: big, symbols: syms, side: 'UNDER', barrier: 7 });
        const ms = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`selected scan, 11 markets x 5000 ticks: ${ms} ms`);
        expect(scan.best).not.toBeNull();
        expect(ms).toBeLessThan(20000);
    });
});
