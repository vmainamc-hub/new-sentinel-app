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
    entryUsable: boolean
) => ({
    ...row(symbol, contract, barrier, score),
    danger: null,
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
    it('balanced: either engine, both-agreeing first, only a validated entry digit is kept', () => {
        const rows = buildBoard(src, engine({ mode: 'balanced' }));
        expect(rows.map(r => r.key)).toEqual(['A|DIGITOVER|2', 'B|DIGITUNDER|7', 'C|DIGITOVER|1']);
        expect(rows[0].entryDigit).toBe(4);
        expect(rows[1].entryDigit).toBeNull(); // not validated
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
        expect(c).toMatchObject({ allow: true, bump: -8 });
        expect(o.entryDigits?.(cell('A', 'OVER', 2), { recovering: false })).toEqual([4]);
        expect(o.entryDigits?.(cell('B', 'UNDER', 7), { recovering: false })).toBeNull();
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
