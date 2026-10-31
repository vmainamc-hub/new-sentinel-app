import { buildBoard, createSentinelOverlay, keyOf } from '../overlay';
import type { PulseRead, PulseSnapshot, PulseTier } from '../pulse';
import { DEFAULT_ENGINE, type EngineSettings } from '../settings';

const read = (
    symbol: string,
    side: 'OVER' | 'UNDER',
    param: number,
    tier: PulseTier | null,
    score = 60
): PulseRead => ({
    symbol,
    contract: { side, param },
    rates: [0.9, 0.9, 0.9, 0.9],
    fair: 0.8,
    agree: 4,
    recentLosses: 0,
    tier,
    score,
});
const snap = (reads: PulseRead[]): PulseSnapshot => ({ markets: 1, reads });
const cell = (symbol: string, side: 'OVER' | 'UNDER', param: number) =>
    ({ symbol, contract: { side, param } }) as never;
const mode = (m: EngineSettings['mode']): EngineSettings => ({ ...DEFAULT_ENGINE, mode: m });

describe('buildBoard', () => {
    const reads = [
        read('A', 'OVER', 1, 'watch'),
        read('A', 'OVER', 2, 'steady', 70),
        read('A', 'UNDER', 8, 'strong', 80),
        read('A', 'UNDER', 7, null),
    ];
    it('keeps only the tiers each mode accepts, strongest first', () => {
        expect(buildBoard(snap(reads), mode('careful')).map(r => r.tier)).toEqual(['strong']);
        expect(buildBoard(snap(reads), mode('balanced')).map(r => r.tier)).toEqual(['strong', 'steady']);
        expect(buildBoard(snap(reads), mode('active')).map(r => r.tier)).toEqual(['strong', 'steady', 'watch']);
    });
    it('respects the contracts switched off', () => {
        const engine = { ...mode('active'), propositions: ['UNDER:8'] };
        expect(buildBoard(snap(reads), engine).map(r => r.label)).toEqual(['Under 8']);
    });
});

describe('Sentinel overlay', () => {
    const make = (engine: EngineSettings, reads: PulseRead[]) => {
        const o = createSentinelOverlay({ getEngine: () => engine, read: () => snap(reads) });
        o.refresh!(1, ['A']);
        return o;
    };

    it('eases the bar for a strong signal and ranks it above a steady one', () => {
        const o = make(mode('balanced'), [read('A', 'UNDER', 8, 'strong', 80), read('A', 'OVER', 2, 'steady', 70)]);
        const strong = o.call(cell('A', 'UNDER', 8), {} as never);
        const steady = o.call(cell('A', 'OVER', 2), {} as never);
        expect(strong.allow).toBe(true);
        expect(strong.bump).toBeLessThan(steady.bump);
        expect(strong.rank).toBeGreaterThan(steady.rank);
    });

    it('vetoes a contract with no accepted signal in careful and balanced, but only raises the bar in active', () => {
        const reads = [read('A', 'OVER', 1, 'watch')];
        expect(make(mode('careful'), reads).call(cell('A', 'OVER', 1), {} as never).allow).toBe(false);
        expect(make(mode('balanced'), reads).call(cell('A', 'OVER', 1), {} as never)).toMatchObject({ allow: false });
        expect(make(mode('active'), reads).call(cell('A', 'OVER', 3), {} as never)).toMatchObject({
            allow: true,
            bump: 6,
        });
    });

    it('backs nothing and reports the error when the read fails', () => {
        const o = createSentinelOverlay({
            getEngine: () => mode('active'),
            read: () => {
                throw new Error('boom');
            },
        });
        o.refresh!(1, ['A']);
        expect(o.board()).toEqual([]);
        expect(o.funnel()?.error).toBe('boom');
    });

    it('counts the tiers and the board in the funnel', () => {
        const o = make(mode('balanced'), [
            read('A', 'UNDER', 8, 'strong'),
            read('A', 'OVER', 1, 'watch'),
            read('A', 'OVER', 2, null),
        ]);
        expect(o.funnel()).toMatchObject({ markets: 1, reads: 3, strong: 1, watch: 1, none: 1, board: 1 });
        expect(keyOf('A', 'UNDER', 8)).toBe('A|DIGITUNDER|8');
    });
});
