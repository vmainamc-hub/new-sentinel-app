import {
    BULK_MARKETS, FAMILIES, FAMILY_ORDER, barrierError, digitsFromTicks, emptyTally, exposure, gapOf, inferDecimals, lastDigit,
    lossLimitHit, normCdf, pairPercents, recordPlaced, recordSettled, sanitizeBulk, scanMarkets, scanWindows, zBinom,
    type Family, type MarketInput,
} from '../bulk-engine';

// Deterministic PRNG so the statistical tests never flake.
const rng = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const uniform = (n: number, rand: () => number, bias?: { p: number; digits: number[] }) =>
    Array.from({ length: n }, () => {
        if (bias && rand() < bias.p) return bias.digits[Math.floor(rand() * bias.digits.length)];
        return Math.floor(rand() * 10);
    });

const markets = (make: (symbol: string, index: number) => number[]): MarketInput[] =>
    BULK_MARKETS.map((market, index) => ({ symbol: market.symbol, name: market.name, digits: make(market.symbol, index) }));

describe('bulk trader strategy families', () => {
    it('keeps all three families visible in the scanner selector', () => {
        expect(FAMILY_ORDER).toEqual(['evenodd', 'overunder', 'matchesdiffers']);
        expect(FAMILY_ORDER.map(family => FAMILIES[family].title)).toEqual(['Even / Odd', 'Over / Under', 'Matches / Differs']);
    });
});

describe('bulk markets', () => {
    it('covers all 13 volatility indices once', () => {
        expect(BULK_MARKETS).toHaveLength(13);
        expect(new Set(BULK_MARKETS.map(m => m.symbol)).size).toBe(13);
    });
});

describe('digit extraction', () => {
    it('uses decimals to read the last digit', () => {
        expect(lastDigit(1259.11, 2)).toBe(1);
        expect(lastDigit(620.17, 2)).toBe(7);
        expect(lastDigit(84.2, 4)).toBe(0);
        expect(digitsFromTicks([1.23, NaN, 4.56], 2)).toEqual([3, 6]);
    });
    it('infers decimals from the tick sample, ignoring stripped trailing zeros', () => {
        const prices = Array.from({ length: 60 }, (_, i) => Number((1000 + i * 0.37).toFixed(2)));
        expect(inferDecimals(prices, 5)).toBe(2);
        expect(inferDecimals([1.5, 2.25], 4)).toBe(4);
    });
    it('finds how long ago a digit last printed', () => {
        expect(gapOf([1, 2, 3, 4], 4)).toBe(0);
        expect(gapOf([1, 2, 3, 4], 1)).toBe(3);
        expect(gapOf([1, 2, 3], 9)).toBe(3);
    });
});

describe('statistics', () => {
    it('normal cdf and z-score are sane', () => {
        expect(Math.abs(normCdf(1.96) - 0.975)).toBeLessThan(0.002);
        expect(Math.abs(zBinom(550, 1000, 0.5) - 3.162)).toBeLessThan(0.01);
        expect(zBinom(0, 0, 0.5)).toBe(0);
    });
    it('chooses 1-3 distinct scan windows no larger than the data', () => {
        expect(scanWindows(1000, 1000)).toEqual([100, 300, 1000]);
        expect(scanWindows(150, 1000)).toEqual([100, 150]);
        expect(scanWindows(60, 1000)).toEqual([60]);
        expect(scanWindows(30, 1000)).toEqual([]);
    });
});

describe('scanner', () => {
    it('reports markets with too little data as not ready', () => {
        const result = scanMarkets('evenodd', markets(() => [1, 2, 3]), 1000);
        expect(result.marketsReady).toBe(0);
        expect(result.ranked).toHaveLength(0);
        expect(result.markets.every(m => !m.ready && m.best === null)).toBe(true);
    });

    it('finds a planted even bias and calls it strong', () => {
        const rand = rng(1);
        const result = scanMarkets('evenodd', markets(symbol =>
            symbol === 'R_50' ? uniform(2000, rand, { p: 0.2, digits: [0, 2, 4, 6, 8] }) : uniform(2000, rand)), 1000);
        expect(result.ranked[0].symbol).toBe('R_50');
        expect(result.ranked[0].best?.label).toBe('Even');
        expect(result.ranked[0].best?.strength).toBe('strong');
        expect(result.ranked[0].best?.side).toBe(0);
    });

    it('finds a planted hot digit (Matches) and a planted cold digit (Differs)', () => {
        const hot = rng(2);
        const matches = scanMarkets('matchesdiffers', markets(symbol =>
            symbol === 'R_10' ? uniform(2000, hot, { p: 0.15, digits: [7] }) : uniform(2000, hot)), 1000);
        expect(matches.ranked[0].best?.label).toBe('Matches 7');
        expect(matches.ranked[0].best?.contract).toBe('DIGITMATCH');

        const cold = rng(3);
        const others = [0, 1, 2, 4, 5, 6, 7, 8, 9];
        const differs = scanMarkets('matchesdiffers', markets(symbol => {
            const base = uniform(2000, cold);
            return symbol === 'R_10' ? base.map(d => (d === 3 && cold() < 0.7 ? others[Math.floor(cold() * 9)] : d)) : base;
        }), 1000);
        expect(differs.ranked[0].best?.label).toBe('Differs 3');
        expect(differs.ranked[0].best?.contract).toBe('DIGITDIFF');
        expect(differs.ranked[0].best?.side).toBe(1);
    });

    it('never exposes edge digits as Differs picks', () => {
        const rand = rng(41);
        const result = scanMarkets('matchesdiffers', markets(() => uniform(1200, rand)), 1000);
        result.markets.forEach(market => {
            [market.best, ...market.alternatives].forEach(pick => {
                if (pick?.contract === 'DIGITDIFF') expect([2, 3, 4, 5, 6, 7]).toContain(pick.barrier);
            });
        });
    });

    it('finds a market skewed to high digits for Over/Under', () => {
        const rand = rng(4);
        const result = scanMarkets('overunder', markets(symbol =>
            symbol === 'R_100' ? uniform(2000, rand, { p: 0.2, digits: [8, 9] }) : uniform(2000, rand)), 1000);
        expect(result.ranked[0].symbol).toBe('R_100');
        expect(result.ranked[0].best?.label).toMatch(/^Over/);
    });

    it('rarely calls pure random data strong (false-positive control)', () => {
        const rand = rng(5);
        const runs = 120;
        (Object.keys(FAMILIES) as Family[]).forEach(family => {
            let strong = 0;
            for (let i = 0; i < runs; i += 1) {
                const result = scanMarkets(family, markets(() => uniform(1500, rand)), 1000);
                if (result.ranked.some(m => m.best?.strength === 'strong')) strong += 1;
            }
            expect(strong / runs).toBeLessThan(0.15);
        });
    });

    it('projected EV is negative for every family on random data', () => {
        const rand = rng(6);
        (Object.keys(FAMILIES) as Family[]).forEach(family => {
            const result = scanMarkets(family, markets(() => uniform(2000, rand)), 1000);
            result.markets.forEach(m => expect(m.best?.projectedEV ?? -1).toBeLessThan(0));
        });
    });

    it('ranks best first and exposes alternatives and digit frequencies', () => {
        const rand = rng(7);
        const result = scanMarkets('overunder', markets(() => uniform(1000, rand)), 500);
        const scores = result.ranked.map(m => m.best?.score ?? 0);
        expect([...scores].sort((a, b) => b - a)).toEqual(scores);
        expect(result.ranked[0].alternatives).toHaveLength(2);
        expect(result.ranked[0].digitPct).toHaveLength(10);
        expect(result.ranked[0].ticksUsed).toBe(500);
        expect(result.hypotheses).toBe(13 * FAMILIES.overunder.tests);
    });
});

describe('trader panel helpers', () => {
    const pct = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    it('computes the past win-rate of both buttons', () => {
        expect(pairPercents(pct, 'evenodd', 0)).toEqual([50, 50]);
        expect(pairPercents(pct, 'overunder', 3)).toEqual([60, 30]);
        expect(pairPercents(pct, 'matchesdiffers', 3)).toEqual([10, 90]);
    });
    it('validates barriers per contract', () => {
        expect(barrierError('DIGITEVEN', 99)).toBeNull();
        expect(barrierError('DIGITOVER', 8)).toBeNull();
        expect(barrierError('DIGITOVER', 9)).not.toBeNull();
        expect(barrierError('DIGITUNDER', 0)).not.toBeNull();
        expect(barrierError('DIGITUNDER', 9)).toBeNull();
        expect(barrierError('DIGITMATCH', 0)).toBeNull();
        expect(barrierError('DIGITDIFF', 10)).not.toBeNull();
        expect(barrierError('DIGITDIFF', 2.5)).not.toBeNull();
        expect(barrierError('DIGITDIFF', 0)).not.toBeNull();
        expect(barrierError('DIGITDIFF', 1)).not.toBeNull();
        expect(barrierError('DIGITDIFF', 8)).not.toBeNull();
        expect(barrierError('DIGITDIFF', 9)).not.toBeNull();
        expect(barrierError('DIGITDIFF', 2)).toBeNull();
        expect(barrierError('DIGITDIFF', 7)).toBeNull();
    });
});

describe('bulk run bookkeeping', () => {
    it('sanitizes unsafe input', () => {
        expect(sanitizeBulk({ stake: -1 }).stake).toBe(0.35);
        expect(sanitizeBulk({ runs: 9999 }).runs).toBe(100);
        expect(sanitizeBulk({ runs: 0 }).runs).toBe(1);
        expect(sanitizeBulk({ duration: 50 }).duration).toBe(10);
        expect(sanitizeBulk({ maxLoss: -4 }).maxLoss).toBe(0);
        expect(sanitizeBulk({ stake: NaN as unknown as number })).toEqual(sanitizeBulk({}));
    });
    it('tracks placed/settled trades and realised P/L', () => {
        let t = emptyTally();
        t = recordPlaced(recordPlaced(recordPlaced(t)));
        t = recordSettled(t, 0.48);
        t = recordSettled(t, -0.5);
        expect(t).toEqual({ placed: 3, settled: 2, wins: 1, losses: 1, pnl: -0.02 });
    });
    it('loss limit uses realised losses only, and 0 disables it', () => {
        let t = emptyTally();
        t = recordSettled(t, -2); expect(lossLimitHit(t, 5)).toBe(false);
        t = recordSettled(t, -3); expect(lossLimitHit(t, 5)).toBe(true);
        expect(lossLimitHit(t, 0)).toBe(false);
    });
    it('reports worst-case exposure', () => {
        expect(exposure(sanitizeBulk({ stake: 0.5, runs: 20 }))).toBe(10);
    });
});
