import { createSentinelOverlay } from '../overlay';
import { DEFAULT_ENGINE, type EngineSettings, PROPOSITION_KEYS } from '../settings';
import { CHECK_MIRROR_SURGE, readSpecialDigits, specialDigitsFor } from '../special-digits';

// Builds 150 ticks where `digit` appears at the given positions counted back from the newest tick (0 = newest), filler is 5.
const withDigit = (digit: number, backPositions: number[], other: Array<[number, number]> = []): number[] => {
    const s = Array(150).fill(5);
    for (const p of backPositions) s[149 - p] = digit;
    for (const [d, p] of other) s[149 - p] = d;
    return s;
};
const spread = (from: number, to: number, step: number) => {
    const out: number[] = [];
    for (let p = from; p < to; p += step) out.push(p);
    return out;
};

describe('special digits', () => {
    it('watches digit 1 for Over and digit 8 for Under, and the other one for a surge', () => {
        expect(specialDigitsFor('OVER')).toEqual({ watched: 1, mirror: 8 });
        expect(specialDigitsFor('UNDER')).toEqual({ watched: 8, mirror: 1 });
    });

    it('holds a contract back when there are too few ticks to judge', () => {
        const r = readSpecialDigits(Array(60).fill(5), 'OVER');
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/ticks/);
        expect(readSpecialDigits(undefined, 'UNDER').ok).toBe(false);
    });

    it('passes Over when digit 1 is dormant', () => {
        expect(readSpecialDigits(Array(150).fill(5), 'OVER').ok).toBe(true);
    });

    it('passes Over when digit 1 is falling between windows', () => {
        // 4 prints in 60..30 back, 3 in the last 30 (spread so the 15-tick halves are level or falling), 5 before that.
        const s = withDigit(1, [3, 20, 28, 35, 40, 50, 55, 62, 66, 70, 75, 80]);
        const r = readSpecialDigits(s, 'OVER');
        expect(r.counts && r.counts.c30 <= r.counts.b30).toBe(true);
        expect(r.ok).toBe(true);
    });

    it('blocks Over when digit 1 is building in the latest windows', () => {
        // 4 prints in the last 15 ticks, 1 in the 15 before, 1 in the 30 before that.
        const s = withDigit(1, [1, 3, 6, 9, 20, 40]);
        const r = readSpecialDigits(s, 'OVER');
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/digit 1/);
    });

    it('blocks Over when digit 1 has risen in every 30-tick window', () => {
        // 1 print, then 2, then 3 per 30-tick window, evenly spread inside each 15-tick half so only the 3-window climb trips it.
        const s = withDigit(1, [5, 18, 25, 36, 50, 75]);
        const r = readSpecialDigits(s, 'OVER');
        expect(r.counts).toMatchObject({ c30: 3, b30: 2, a30: 1 });
        expect(r.ok).toBe(false);
    });

    it('applies the same rule to digit 8 on Under contracts, not to digit 1', () => {
        const s = withDigit(8, [1, 3, 6, 9, 20, 40]);
        expect(readSpecialDigits(s, 'UNDER').ok).toBe(false);
        // The same ticks have no digit 1, so an Over contract reads them as dormant (digit 8 is its mirror, and it is surging here).
        const over = readSpecialDigits(s, 'OVER');
        expect(over.counts).toMatchObject({ c30: 0, b30: 0 });
    });

    it('blocks Over on a sudden surge of digit 8 even while digit 1 is dormant', () => {
        if (!CHECK_MIRROR_SURGE) return;
        const s = withDigit(8, [0, 2, 4, 6, 8, 12]);
        const r = readSpecialDigits(s, 'OVER');
        expect(r.counts).toMatchObject({ c30: 0 });
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/digit 8/);
    });

    it('blocks Under on a sudden surge of digit 1 even while digit 8 is dormant', () => {
        if (!CHECK_MIRROR_SURGE) return;
        const s = withDigit(1, [0, 2, 4, 6, 8, 12]);
        const r = readSpecialDigits(s, 'UNDER');
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/digit 1/);
    });

    it('does not call a steady 10% share a surge', () => {
        const s = withDigit(8, spread(0, 150, 10));
        expect(readSpecialDigits(s, 'OVER').ok).toBe(true);
    });
});

describe('the overlay applies the rule in every mode', () => {
    const cell = (side: 'OVER' | 'UNDER', param: number) => ({ symbol: 'A', contract: { side, param } }) as never;
    const build = (series: number[], m: EngineSettings['mode']) =>
        createSentinelOverlay({
            getEngine: () => ({ ...DEFAULT_ENGINE, mode: m, propositions: [...PROPOSITION_KEYS] }),
            read: () => ({ markets: 1, reads: [] }),
            series: () => ({ A: series }),
            now: () => 0,
        });
    const building = withDigit(1, [1, 3, 6, 9, 20, 40]);

    it('vetoes a building digit 1 for Over even in the Hunter', () => {
        for (const m of ['hunter', 'careful', 'balanced', 'active'] as const) {
            const o = build(building, m);
            o.refresh?.(0, ['A']);
            expect(o.call(cell('OVER', 2), { recovering: false, now: 0 }).allow).toBe(false);
        }
    });

    it('lets a dormant market through the Hunter', () => {
        const o = build(Array(150).fill(5), 'hunter');
        o.refresh?.(0, ['A']);
        expect(o.call(cell('OVER', 2), { recovering: false, now: 0 }).allow).toBe(true);
    });

    it('exposes the same rule as the buy-time guard, using the contract that would be bought', () => {
        const o = build(Array(150).fill(5), 'hunter');
        expect(o.guard?.('A', { side: 'OVER', param: 2 }, building).ok).toBe(false);
        expect(o.guard?.('A', { side: 'OVER', param: 2 }, Array(150).fill(5)).ok).toBe(true);
    });
});
