import { keyOf } from '../../sentinel/overlay';
import type { SixfoldSettings } from '../../sixfold/money';
import type { Cell } from '../../sixfold/scanner';
import { mulberry32 } from '../../sixfold/stats';
import { cellToRow, STEADY_FROM, STRONG_FROM, tierOfScore } from '../cell-row';
import { createEngineGates } from '../runner-gates';

const MARKETS = Array.from({ length: 6 }, (_, i) => `M${i}`);
const fair = (seed: number, n = 700): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};
/** Under 7 wins on 0-6: a series winning at `p`. */
const winning = (p: number, seed: number, n = 700): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => (rnd() < p ? Math.floor(rnd() * 7) : 7 + Math.floor(rnd() * 3)));
};
const cell = (symbol: string, side: 'OVER' | 'UNDER', param: number, score = 66): Cell =>
    ({
        symbol,
        contract: { side, param },
        score,
        label: `${side === 'OVER' ? 'Over' : 'Under'} ${param}`,
        key: `${side}:${param}`,
    }) as unknown as Cell;
const ctx = (now = 0, recovering = false) => ({ now, recovering });
const notice = (symbol: string) =>
    ({
        contractId: 1,
        symbol,
        armed: { side: 'UNDER', param: 7 },
        bought: { side: 'UNDER', param: 7 },
        recovery: false,
        stake: 1,
        entryDigit: null,
    }) as never;

type Setup = {
    series: Record<string, number[]>;
    edge?: Record<string, unknown>;
    now?: () => number;
    /** Leave Sentinel AI's mandatory digit 1 / 8 rule on. Off by default so the gate tests below judge the gates alone. */
    rule?: boolean;
};
const make = (o: Setup) => {
    const g = createEngineGates({
        moduleId: 'sixfold',
        name: 'Sixfold',
        contracts: () => [{ side: 'UNDER', param: 7 }],
        series: () => o.series,
        settingsKey: 'test.edge.settings',
        ledgerKey: 'test.edge.ledger',
        handle: 'testEdge',
        now: o.now ?? (() => 0),
        specialDigits: o.rule === true,
    });
    // Only the gate under test is on, unless the test says otherwise.
    g.controls.set({
        kalman: false,
        danger: false,
        frequency: false,
        arbiter: false,
        cooldownMs: 0,
        minHoldScans: 0,
        hourlyBudget: 0,
        shadow: false,
        ...o.edge,
    });
    g.overlay.contracts({} as SixfoldSettings);
    g.overlay.refresh!(0, MARKETS);
    return g;
};
const book = (f: (s: string, i: number) => number[]) => Object.fromEntries(MARKETS.map((s, i) => [s, f(s, i)]));

describe('cell to board row', () => {
    it('tiers a cell by the scanner bars, and keeps the score and the Sentinel row key', () => {
        expect(tierOfScore(STRONG_FROM)).toBe('strong');
        expect(tierOfScore(STRONG_FROM - 0.1)).toBe('steady');
        expect(tierOfScore(STEADY_FROM)).toBe('steady');
        expect(tierOfScore(STEADY_FROM - 0.1)).toBe('watch');
        const row = cellToRow(cell('M0', 'UNDER', 7, 75));
        expect(row).toMatchObject({
            symbol: 'M0',
            contract: 'DIGITUNDER',
            barrier: 7,
            label: 'Under 7',
            tier: 'strong',
            score: 75,
        });
        expect(row.key).toBe(keyOf('M0', 'UNDER', 7));
        expect(cellToRow(cell('M0', 'OVER', 2, 50))).toMatchObject({ contract: 'DIGITOVER', tier: 'watch' });
    });
});

describe('gate overlay for the Sixfold runner', () => {
    it('keeps the runner its own id and name, and the contracts it is given', () => {
        const g = make({ series: book(() => fair(1)) });
        expect(g.overlay.moduleId).toBe('sixfold');
        expect(g.overlay.name).toBe('Sixfold');
        expect(g.overlay.contracts({} as SixfoldSettings)).toEqual([{ side: 'UNDER', param: 7 }]);
    });

    it('with every gate off it changes nothing', () => {
        const g = make({ series: book(() => winning(0.5, 3)) });
        g.overlay.arbitrate!([cell('M0', 'UNDER', 7)], 0);
        expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx())).toEqual({ allow: true, bump: 0, rank: 0, note: '' });
    });

    describe('Kalman health', () => {
        it('stands down a signal whose filtered win rate is not above fair, and says so', () => {
            const g = make({ series: book(() => winning(0.5, 4)), edge: { kalman: true } });
            const call = g.overlay.call(cell('M0', 'UNDER', 7), ctx());
            expect(call.allow).toBe(false);
            expect(call.note).toMatch(/Kalman/);
        });

        it('lets a healthy signal through and eases the bar for it', () => {
            const g = make({ series: book(() => winning(0.85, 5)), edge: { kalman: true } });
            const call = g.overlay.call(cell('M0', 'UNDER', 7), ctx());
            expect(call.allow).toBe(true);
            expect(call.bump).toBeLessThan(0);
        });

        it('never refuses a recovery trade for a weak level', () => {
            const g = make({ series: book(() => winning(0.6, 6)), edge: { kalman: true } });
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx(0, true)).allow).toBe(true);
        });

        it('shadow mode reads and records but changes nothing the runner sees', () => {
            const g = make({ series: book(() => winning(0.5, 4)), edge: { kalman: true, shadow: true } });
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx())).toEqual({ allow: true, bump: 0, rank: 0, note: '' });
            expect(g.influence.report().gates.kalman.vetoed).toBe(1);
        });
    });

    describe('cross-market danger', () => {
        it('holds every signal when the whole book turns cold together', () => {
            const g = make({ series: book((_, i) => winning(0.2, 10 + i)), edge: { danger: true } });
            const call = g.overlay.call(cell('M0', 'UNDER', 7), ctx());
            expect(call.allow).toBe(false);
            expect(call.note).toMatch(/Danger/);
            expect(g.overlay.guard!('M0', { side: 'UNDER', param: 7 }, [])).toMatchObject({ ok: false });
        });

        it('stays out of the way on a calm book', () => {
            const g = make({ series: book((_, i) => fair(20 + i)), edge: { danger: true } });
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(true);
        });
    });

    describe('frequency', () => {
        it('holds a signal until it has stayed eligible for the minimum number of scans', () => {
            const g = make({ series: book(() => fair(30)), edge: { frequency: true, minHoldScans: 2 } });
            g.overlay.arbitrate!([cell('M0', 'UNDER', 7)], 0);
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx()).note).toMatch(/held 1 of 2/);
            g.overlay.refresh!(1, MARKETS);
            g.overlay.arbitrate!([cell('M0', 'UNDER', 7)], 1);
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(true);
        });

        it('a signal that left the eligible set loses its hold', () => {
            const g = make({ series: book(() => fair(31)), edge: { frequency: true, minHoldScans: 2 } });
            g.overlay.arbitrate!([cell('M0', 'UNDER', 7)], 0);
            g.overlay.arbitrate!([], 1); // gone for a scan
            g.overlay.arbitrate!([cell('M0', 'UNDER', 7)], 2);
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(false);
        });

        it('rests a market after a trade, but never delays a recovery step', () => {
            const g = make({
                series: book(() => fair(32)),
                edge: { frequency: true, cooldownMs: 20_000 },
                now: () => 0,
            });
            g.overlay.onBought!(notice('M0')); // bought at t = 0
            const call = g.overlay.call(cell('M0', 'UNDER', 7), ctx(5_000));
            expect(call.allow).toBe(false);
            expect(call.note).toMatch(/rests/);
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx(5_000, true)).allow).toBe(true);
            expect(g.overlay.call(cell('M1', 'UNDER', 7), ctx(5_000)).allow).toBe(true); // another market is free
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx(21_000)).allow).toBe(true);
        });

        it('stops at the hourly budget', () => {
            const g = make({ series: book(() => fair(33)), edge: { frequency: true, hourlyBudget: 2 } });
            g.overlay.onBought!(notice('M0'));
            g.overlay.onBought!(notice('M1'));
            expect(g.overlay.call(cell('M2', 'UNDER', 7), ctx(1_000)).note).toMatch(/hourly budget/);
        });
    });

    describe('arbiter on the runner cells', () => {
        it('abstains on a market where Over and Under are about equally strong', () => {
            const g = make({ series: book(() => fair(40)), edge: { arbiter: true } });
            const over = cell('M0', 'OVER', 2, 66);
            const under = cell('M0', 'UNDER', 7, 66);
            g.overlay.arbitrate!([over, under], 0);
            expect(g.overlay.call(over, ctx())).toMatchObject({ allow: false });
            expect(g.overlay.call(over, ctx()).note).toMatch(/contradict/);
            expect(g.overlay.call(under, ctx()).allow).toBe(false);
        });

        it('trades one signal per market: the stronger of two on the same side', () => {
            const g = make({ series: book(() => fair(41)), edge: { arbiter: true } });
            const strong = cell('M0', 'UNDER', 7, 80);
            const weak = cell('M0', 'UNDER', 6, 63);
            g.overlay.arbitrate!([strong, weak], 0);
            expect(g.overlay.call(strong, ctx()).allow).toBe(true);
            const beaten = g.overlay.call(weak, ctx());
            expect(beaten.allow).toBe(false);
            expect(beaten.note).toMatch(/Under 7 is the pick/);
        });

        it('keeps its pick when a challenger is only slightly stronger (sticky)', () => {
            const g = make({ series: book(() => fair(42)), edge: { arbiter: true } });
            const a = cell('M0', 'UNDER', 7, 70);
            const b = cell('M0', 'UNDER', 6, 70);
            g.overlay.arbitrate!([a, b], 0);
            const first = g.overlay.call(a, ctx()).allow ? 'a' : 'b';
            const slightly = { ...(first === 'a' ? b : a), score: 71 } as Cell;
            g.overlay.arbitrate!(first === 'a' ? [a, slightly] : [slightly, b], 1);
            expect(g.overlay.call(first === 'a' ? a : b, ctx()).allow).toBe(true);
        });

        it('a signal the runner never listed is not judged by the arbiter', () => {
            const g = make({ series: book(() => fair(43)), edge: { arbiter: true } });
            g.overlay.arbitrate!([], 0);
            expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(true);
        });
    });

    it('records the evidence: what the next tick did after a signal was stood down', () => {
        const g = make({ series: book(() => winning(0.5, 4)), edge: { kalman: true } });
        g.overlay.call(cell('M0', 'UNDER', 7), ctx());
        g.onTick('M0', 3); // Under 7 wins on 3
        const r = g.influence.report();
        expect(r.gates.kalman).toMatchObject({ vetoed: 1, resolved: 1, wouldWin: 1 });
    });

    it('a gate that throws never stops the runner', () => {
        const g = make({ series: book(() => fair(44)), edge: { kalman: true } });
        const boom = () => {
            throw new Error('boom');
        };
        g.influence.call = boom as never;
        g.influence.guard = boom as never;
        g.influence.refresh = boom as never;
        g.influence.arbitrate = boom as never;
        g.influence.onBought = boom as never;
        g.influence.onSettled = boom as never;
        expect(g.overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(true);
        expect(g.overlay.guard!('M0', { side: 'UNDER', param: 7 }, [])).toEqual({ ok: true, note: '' });
        expect(() => g.overlay.refresh!(0, MARKETS)).not.toThrow();
        expect(() => g.overlay.arbitrate!([cell('M0', 'UNDER', 7)], 0)).not.toThrow();
        expect(() => g.overlay.onBought!(notice('M0'))).not.toThrow();
        expect(() => g.overlay.onSettled!({ ...(notice('M0') as object), profit: 1 } as never)).not.toThrow();
    });

    describe("Sentinel AI's mandatory digit 1 / digit 8 rule (Sixfold and Vanguard)", () => {
        // 150 ticks, each digit at the given positions counted back from the newest tick (0 = newest); filler is 5.
        const put = (spec: Record<number, number[]>): number[] => {
            const s = Array(150).fill(5);
            for (const [digit, backs] of Object.entries(spec)) for (const p of backs) s[149 - p] = Number(digit);
            return s;
        };
        const BUILDING = [1, 3, 6, 9, 20, 40];
        const BUILDING_B = [0, 2, 5, 8, 21, 41];
        const overGood = put({ 8: BUILDING }); // digit 1 dormant, digit 8 increasing: Over may trade
        const overBad = put({ 1: BUILDING, 8: BUILDING_B }); // digit 1 building: Over must wait
        const underGood = put({ 1: BUILDING }); // digit 8 dormant, digit 1 increasing: Under may trade
        const rule = (series: number[], edge: Record<string, unknown> = {}) =>
            make({ series: book(() => series), edge, rule: true });

        it('Over: digit 1 must be dormant or falling and digit 8 increasing', () => {
            expect(rule(overGood).overlay.call(cell('M0', 'OVER', 2), ctx()).allow).toBe(true);
            const held = rule(overBad).overlay.call(cell('M0', 'OVER', 2), ctx());
            expect(held.allow).toBe(false);
            expect(held.note).toMatch(/digit 1 loses this contract and is building/);
            const quiet = rule(put({})).overlay.call(cell('M0', 'OVER', 2), ctx());
            expect(quiet.allow).toBe(false);
            expect(quiet.note).toMatch(/digit 8 wins this contract but is not increasing/);
        });

        it('Under mirrors it: digit 8 dormant or falling, digit 1 increasing', () => {
            expect(rule(underGood).overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(true);
            expect(rule(overBad).overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(false);
            expect(rule(overGood).overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(false);
        });

        it('holds a contract back when there are too few ticks to judge', () => {
            const call = rule(Array(60).fill(5)).overlay.call(cell('M0', 'OVER', 2), ctx());
            expect(call.allow).toBe(false);
            expect(call.note).toMatch(/ticks/);
        });

        it('applies to recovery steps and cannot be shadowed or switched off with the gates', () => {
            expect(rule(overBad).overlay.call(cell('M0', 'OVER', 3), ctx(0, true)).allow).toBe(false);
            const shadow = rule(overBad, {
                shadow: true,
                kalman: false,
                danger: false,
                frequency: false,
                arbiter: false,
            });
            expect(shadow.overlay.call(cell('M0', 'OVER', 2), ctx()).allow).toBe(false);
        });

        it('keeps the gates working behind it, and shows what the rule saw in the note', () => {
            const g = rule(overGood, { frequency: true, cooldownMs: 20_000 });
            expect(g.overlay.call(cell('M0', 'OVER', 2), ctx()).note).toMatch(/digit 1 dormant or falling/);
            g.overlay.onBought!(notice('M0')); // bought at t = 0: the market now rests
            expect(g.overlay.call(cell('M0', 'OVER', 2), ctx(5_000)).allow).toBe(false);
        });

        it('is read again on the buy tick, for the contract that would be bought', () => {
            const g = rule(overGood);
            const pass = g.overlay.guard!('M0', { side: 'OVER', param: 2 }, overGood);
            expect(pass.ok).toBe(true);
            expect(pass.note).toMatch(/digit 1 dormant or falling/);
            expect(g.overlay.guard!('M0', { side: 'OVER', param: 2 }, overBad).ok).toBe(false);
            expect(g.overlay.guard!('M0', { side: 'UNDER', param: 7 }, overGood).ok).toBe(false);
            expect(g.overlay.guard!('M0', { side: 'OVER', param: 3 }, []).ok).toBe(false);
        });

        it('a gate that throws behind it never lets a refused signal through', () => {
            const g = rule(overBad);
            g.influence.call = (() => {
                throw new Error('boom');
            }) as never;
            g.influence.guard = g.influence.call;
            expect(g.overlay.call(cell('M0', 'OVER', 2), ctx()).allow).toBe(false);
            expect(g.overlay.guard!('M0', { side: 'OVER', param: 2 }, overBad).ok).toBe(false);
        });

        it('the production wiring has the rule on (Sixfold and Vanguard are built the same way)', () => {
            const g = createEngineGates({
                moduleId: 'vanguard',
                name: 'Vanguard',
                contracts: () => [{ side: 'OVER', param: 2 }],
                series: () => ({ M0: overBad }),
                settingsKey: 'prod.edge.settings',
                ledgerKey: 'prod.edge.ledger',
                handle: 'prodEdge',
                now: () => 0,
            });
            expect(g.overlay.call(cell('M0', 'OVER', 2), ctx()).allow).toBe(false);
            expect(g.overlay.guard!('M0', { side: 'OVER', param: 2 }, overBad).ok).toBe(false);
        });
    });

    it('each engine has its own switches and evidence', () => {
        const a = make({ series: book(() => fair(50)), edge: { kalman: true } });
        const b = createEngineGates({
            moduleId: 'vanguard',
            name: 'Vanguard',
            contracts: () => [],
            series: () => ({}),
            settingsKey: 'other.edge.settings',
            ledgerKey: 'other.edge.ledger',
            handle: 'otherEdge',
        });
        b.controls.set({ kalman: false });
        expect(a.controls.get().kalman).toBe(true);
        expect(b.controls.print()).toMatch(/^Vanguard edge gates/);
    });
});
