import type { Cell } from '../../sixfold/scanner';
import { buildBoard, createSentinelOverlay, type Sources } from '../overlay';
import { DEFAULT_ENGINE, type EngineSettings } from '../settings';

const row = (symbol: string, contract: 'DIGITOVER' | 'DIGITUNDER', barrier: number, score: number) => ({
    symbol,
    market: symbol,
    contract,
    barrier,
    label: `${contract === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`,
    score,
});
const sent = (
    symbol: string,
    contract: 'DIGITOVER' | 'DIGITUNDER',
    barrier: number,
    score: number,
    entryDigit: number | null,
    entryUsable: boolean,
    tier: 'confirmed' | 'building' | 'leading' = 'confirmed'
) => ({
    ...row(symbol, contract, barrier, score),
    danger: null,
    tier,
    entryDigit,
    entryUsable,
});
const cell = (symbol: string, side: 'OVER' | 'UNDER', param: number) =>
    ({ symbol, contract: { side, param } }) as unknown as Cell;
const engine = (patch: Partial<EngineSettings>): EngineSettings => ({ ...DEFAULT_ENGINE, ...patch });

const src: Sources = {
    sentinel: [sent('A', 'DIGITOVER', 2, 70, 4, true), sent('B', 'DIGITUNDER', 7, 60, 8, false)],
    fusion: [row('A', 'DIGITOVER', 2, 80), row('C', 'DIGITOVER', 1, 50)],
    standDown: new Set<string>(),
};

describe('sentinel overlay board', () => {
    it('careful: only contracts both engines back', () => {
        const rows = buildBoard(src, engine({ mode: 'careful' }));
        expect(rows.map(r => r.key)).toEqual(['A|DIGITOVER|2']);
        expect(rows[0].source).toBe('both');
        expect(rows[0].score).toBe(75);
    });
    it('balanced: Sentinel leads. Fusion alone cannot start a trade; both-agreeing comes first; only a validated entry digit is kept', () => {
        const rows = buildBoard(src, engine({ mode: 'balanced' }));
        expect(rows.map(r => r.key)).toEqual(['A|DIGITOVER|2', 'B|DIGITUNDER|7']);
        expect(rows[0].entryDigit).toBe(4);
        expect(rows[1].entryDigit).toBeNull(); // not validated
        expect(rows.map(r => r.key)).not.toContain('C|DIGITOVER|1'); // Fusion only
    });
    it('active: Fusion may lead', () => {
        expect(buildBoard(src, engine({ mode: 'active' })).map(r => r.key)).toContain('C|DIGITOVER|1');
    });
    it('careful: a merely leading Sentinel read is not enough, even when Fusion agrees', () => {
        const weak: Sources = { ...src, sentinel: [sent('A', 'DIGITOVER', 2, 70, 4, true, 'leading')] };
        expect(buildBoard(weak, engine({ mode: 'careful' }))).toEqual([]);
    });
    it('a Fusion stand-down is a veto, except in active mode', () => {
        const stood = { ...src, standDown: new Set(['A|DIGITOVER|2']) };
        expect(buildBoard(stood, engine({ mode: 'balanced' })).map(r => r.key)).not.toContain('A|DIGITOVER|2');
        expect(buildBoard(stood, engine({ mode: 'active' })).map(r => r.key)).toContain('A|DIGITOVER|2');
    });
    it('respects the switched-on propositions', () => {
        const rows = buildBoard(src, engine({ mode: 'balanced', propositions: ['OVER:2'] }));
        expect(rows.map(r => r.key)).toEqual(['A|DIGITOVER|2']);
    });
});

describe('sentinel overlay calls', () => {
    const make = (mode: EngineSettings['mode'], read: () => Sources = () => src) => {
        const o = createSentinelOverlay({ getEngine: () => engine({ mode }), read });
        o.refresh?.(0, []);
        return o;
    };
    it('eases the bar when both agree and hands over the engine entry digit', () => {
        const o = make('balanced');
        const c = o.call(cell('A', 'OVER', 2), { recovering: false, now: 0 });
        expect(c).toMatchObject({ allow: true, bump: -12 }); // confirmed (-6) and Fusion agrees (-6)
        expect(o.entryDigits?.(cell('A', 'OVER', 2), { recovering: false })).toEqual([4]);
        expect(o.entryDigits?.(cell('B', 'UNDER', 7), { recovering: false })).toBeNull();
    });
    it('a weaker Sentinel tier asks for a higher bar than a confirmed one', () => {
        const mk = (tier: 'confirmed' | 'building' | 'leading') =>
            createSentinelOverlay({
                getEngine: () => engine({ mode: 'balanced' }),
                read: () => ({
                    sentinel: [sent('A', 'DIGITOVER', 2, 70, 4, true, tier)],
                    fusion: [],
                    standDown: new Set(),
                }),
            });
        const bump = (tier: 'confirmed' | 'building' | 'leading') => {
            const o = mk(tier);
            o.refresh?.(0, []);
            return o.call(cell('A', 'OVER', 2), { recovering: false, now: 0 }).bump;
        };
        expect([bump('confirmed'), bump('building'), bump('leading')]).toEqual([-6, 0, 4]);
    });
    it('vetoes an unbacked cell in careful and balanced, raises the bar in active', () => {
        expect(make('careful').call(cell('Z', 'OVER', 2), { recovering: false, now: 0 }).allow).toBe(false);
        expect(make('balanced').call(cell('Z', 'OVER', 2), { recovering: false, now: 0 }).allow).toBe(false);
        expect(make('active').call(cell('Z', 'OVER', 2), { recovering: false, now: 0 })).toMatchObject({
            allow: true,
            bump: 6,
        });
    });
    it('an engine failure backs nothing, so gated modes do not trade', () => {
        const o = make('balanced', () => {
            throw new Error('engine down');
        });
        expect(o.board()).toEqual([]);
        expect(o.call(cell('A', 'OVER', 2), { recovering: false, now: 0 }).allow).toBe(false);
    });
});
