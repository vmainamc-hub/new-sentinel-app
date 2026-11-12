import { lastDigit as parityLastDigit } from '@/lib/analytics';
import { resetParityMemory } from '../parity/engine';
import {
    compareParity,
    legacyParityPct,
    type ParityRead,
    type ParitySeries,
    type ParitySide,
    pickFromReads,
    scanParity,
    toParityTicks,
} from '../parity-engine';

const rng = (seed: number) => {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** A digit series where each tick is even with probability pEven (drifting by `drift` over the series). */
const biased = (seed: number, n: number, pEven: number, drift = 0): ParitySeries => {
    const r = rng(seed);
    const digits: number[] = [];
    for (let k = 0; k < n; k += 1) {
        const even = r() < Math.min(0.9, pEven + drift * (k / n));
        const pick = Math.floor(r() * 5);
        digits.push(even ? pick * 2 : pick * 2 + 1);
    }
    return { prices: digits, digits, decimals: 2 };
};

const SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', '1HZ30V'];
const PARAMS: [number, number][] = [
    [0.5, 0],
    [0.56, 0],
    [0.6, 0],
    [0.65, 0],
    [0.5, 0.15],
    [0.45, 0.2],
    [0.4, 0],
    [0.35, 0],
    [0.55, 0.1],
    [0.3, 0.2],
    [0.62, 0.05],
];
const markets = (n = 5000): Record<string, ParitySeries> =>
    Object.fromEntries(SYMBOLS.map((s, i) => [s, biased(7 + i + 1, n, PARAMS[i][0], PARAMS[i][1])]));

beforeEach(() => {
    resetParityMemory();
    // Precision Parity's virtual-trade check draws random numbers; seed them so the specs are repeatable.
    const next = rng(2026);
    jest.spyOn(Math, 'random').mockImplementation(next);
});
afterEach(() => {
    jest.restoreAllMocks();
});

describe('toParityTicks', () => {
    it('hands every digit to Precision Parity unchanged, whatever the market decimals', () => {
        const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        expect(toParityTicks(all).map(t => parityLastDigit(t.price))).toEqual(all);
        const long = Array.from({ length: 500 }, (_, i) => (i * 7) % 10);
        expect(toParityTicks(long).map(t => parityLastDigit(t.price))).toEqual(long);
    });
    it('keeps only the most recent 2000 ticks, the window Parity reads', () => {
        const digits = Array.from({ length: 3000 }, (_, i) => i % 10);
        const ticks = toParityTicks(digits);
        expect(ticks).toHaveLength(2000);
        expect(parityLastDigit(ticks[1999].price)).toBe(digits[2999]);
    });
});

describe('legacyParityPct (Overlord original Even / Odd number)', () => {
    it('is the share of the last 50 digits of the parity', () => {
        const digits = [...Array(100).fill(1), ...Array(40).fill(2), ...Array(10).fill(3)];
        expect(legacyParityPct(digits, 'EVEN')).toBe(80);
        expect(legacyParityPct(digits, 'ODD')).toBe(20);
    });
    it('is null without digits', () => {
        expect(legacyParityPct([], 'EVEN')).toBeNull();
    });
});

describe('scanParity', () => {
    it('falls back to the original condition, lowest share wins, when no market has enough ticks for Parity', () => {
        const mk = (evenShare: number): ParitySeries => {
            const digits = Array.from({ length: 100 }, (_, i) => (i < evenShare ? 2 : 3));
            return { prices: digits, digits, decimals: 2 };
        };
        const scan = scanParity({ series: { A: mk(70), B: mk(30), C: mk(55) }, symbols: ['A', 'B', 'C'], side: 'EVEN' });
        expect(scan.legacyOnly).toBe(true);
        expect(scan.evaluated).toBe(0);
        expect(scan.best?.symbol).toBe('B');
        expect(scan.best?.tier).toBe('LEGACY');
        expect(scan.best?.ready).toBe(false);
    });

    it('skips markets that have no digits at all', () => {
        const scan = scanParity({ series: { R_10: biased(1, 1000, 0.5) }, symbols: ['R_10', 'R_25'], side: 'EVEN' });
        expect(scan.reads.map(r => r.symbol)).toEqual(['R_10']);
    });

    it('reads every market with the whole tool and reports what Parity said about it', () => {
        const scan = scanParity({ series: markets(), symbols: SYMBOLS, side: null });
        expect(scan.legacyOnly).toBe(false);
        expect(scan.evaluated).toBe(SYMBOLS.length);
        for (const r of scan.reads) {
            expect(r.thin).toBe(false);
            expect(r.ticks).toBe(2000);
            expect(['READY', 'BUILDING', 'MONITORING', 'REJECTED']).toContain(r.state);
            expect(r.parity?.state).toBe(r.state);
            expect(r.legacyPct).not.toBeNull();
            expect(r.reasons.length).toBeGreaterThan(0);
            expect(r.reasons.length).toBeLessThanOrEqual(8);
            expect(r.applied).toBeGreaterThanOrEqual(r.agree);
        }
    });

    it('never picks a market Parity did not mark READY, and never picks the other parity, over repeated scans', () => {
        const series = markets();
        let sawReady = false;
        for (const side of ['EVEN', 'ODD', null, 'EVEN', 'ODD', null, 'EVEN', 'ODD'] as (ParitySide | null)[]) {
            const scan = scanParity({ series, symbols: SYMBOLS, side });
            if (scan.best) {
                expect(scan.best.ready).toBe(true);
                expect(scan.best.state).toBe('READY');
                expect(scan.best.vetoed).toBe(false);
                if (side !== null) expect(scan.best.side).toBe(side);
                sawReady = true;
                // nothing READY for the chosen parity is ranked below something that is not
                const readyForSide = scan.reads.filter(r => r.ready && (side === null || r.side === side));
                expect(readyForSide[0].symbol).toBe(scan.best.symbol);
            } else {
                expect(scan.watch === null || (!scan.watch.ready && !scan.watch.vetoed)).toBe(true);
                if (side !== null && scan.opposite) {
                    expect(scan.opposite.ready).toBe(true);
                    expect(scan.opposite.side).not.toBe(side);
                }
                if (side !== null && scan.watch) expect(scan.watch.side).toBe(side);
            }
            // a market Parity vetoed is never the pick or the watch
            expect(scan.best?.vetoed ?? false).toBe(false);
            expect(scan.watch?.vetoed ?? false).toBe(false);
        }
        // the data is built so Parity does reach READY on some market during these scans
        expect(sawReady).toBe(true);
    });

    it('does not turn a NO_TRADE into a trade: with no READY market the answer is null, with a watch for display only', () => {
        // pure noise, one scan: Parity has no conviction anywhere
        const noise = Object.fromEntries(SYMBOLS.map((s, i) => [s, biased(900 + i, 5000, 0.5)]));
        const scan = scanParity({ series: noise, symbols: SYMBOLS, side: 'EVEN' });
        expect(scan.reads.some(r => r.ready)).toBe(false);
        expect(scan.best).toBeNull();
        expect(scan.legacyOnly).toBe(false);
    });
});

describe('pickFromReads and compareParity', () => {
    const base = (over: Partial<ParityRead>): ParityRead => ({
        symbol: 'X',
        name: 'X',
        side: 'EVEN',
        barrier: 0,
        label: 'Even',
        state: 'READY',
        ready: true,
        score: 70,
        tier: 'STRONG',
        vetoed: false,
        vetoReason: '',
        legacyPct: 50,
        thin: false,
        ticks: 2000,
        reasons: [],
        agree: 5,
        applied: 6,
        parity: null,
        ...over,
    });

    it('ranks READY before everything else, then STRONG before BEST, then Parity confidence', () => {
        const a = base({ symbol: 'a', score: 90, ready: false, state: 'BUILDING', tier: 'CAUTION' });
        const b = base({ symbol: 'b', score: 60, tier: 'BEST' });
        const c = base({ symbol: 'c', score: 65, tier: 'STRONG' });
        const d = base({ symbol: 'd', score: 80, tier: 'STRONG' });
        expect([a, b, c, d].sort(compareParity).map(r => r.symbol)).toEqual(['d', 'c', 'b', 'a']);
    });

    it('picks the best READY market of the chosen parity and shows the other parity only as a note', () => {
        const odd = base({ symbol: 'o', side: 'ODD', label: 'Odd', score: 95 });
        const even = base({ symbol: 'e', score: 70 });
        const sorted = [odd, even].sort(compareParity);
        expect(pickFromReads(sorted, 'EVEN').best?.symbol).toBe('e');
        expect(pickFromReads(sorted, 'ODD').best?.symbol).toBe('o');
        expect(pickFromReads(sorted, null).best?.symbol).toBe('o');
        const onlyOdd = pickFromReads([odd], 'EVEN');
        expect(onlyOdd.best).toBeNull();
        expect(onlyOdd.opposite?.symbol).toBe('o');
    });

    it('never uses a rejected market as the watch', () => {
        const rej = base({ symbol: 'r', ready: false, state: 'REJECTED', vetoed: true, tier: 'CAUTION', score: 99 });
        const dev = base({ symbol: 'd', ready: false, state: 'BUILDING', tier: 'CAUTION', score: 55 });
        const picked = pickFromReads([rej, dev], 'EVEN');
        expect(picked.best).toBeNull();
        expect(picked.watch?.symbol).toBe('d');
    });
});
