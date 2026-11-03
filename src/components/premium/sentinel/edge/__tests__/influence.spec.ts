import { mulberry32 } from '../../../sixfold/stats';
import type { BoardRow } from '../../overlay';
import { createSentinelOverlay } from '../../overlay';
import type { PulseRead, PulseSnapshot, PulseTier } from '../../pulse';
import { DEFAULT_ENGINE, type EngineSettings, PROPOSITION_KEYS } from '../../settings';
import { createEdgeInfluence, describeReport, type EdgeReport } from '../influence';
import { DEFAULT_EDGE, type EdgeSettings, normalizeEdge } from '../settings';

const SYMBOLS = Array.from({ length: 6 }, (_, i) => `M${i}`);
const fair = (seed: number, n = 700): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};
/** Under 7 wins on 0-6: a series winning at `p`. */
const winning = (p: number, seed: number, n = 700): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => (rnd() < p ? Math.floor(rnd() * 7) : 7 + Math.floor(rnd() * 3)));
};
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
    fair: 0.7,
    agree: 4,
    recentLosses: 0,
    tier,
    score,
});
const mode = (m: EngineSettings['mode']): EngineSettings => ({
    ...DEFAULT_ENGINE,
    mode: m,
    propositions: [...PROPOSITION_KEYS],
});
const cell = (symbol: string, side: 'OVER' | 'UNDER', param: number) =>
    ({ symbol, contract: { side, param } }) as never;
const ctx = (now = 0, recovering = false) => ({ now, recovering }) as never;

type Setup = {
    series: Record<string, number[]>;
    reads: PulseRead[];
    other?: PulseRead[];
    edge?: Partial<EdgeSettings>;
    engine?: EngineSettings;
    now?: () => number;
};
const make = (o: Setup) => {
    let settings: EdgeSettings = normalizeEdge({
        ...DEFAULT_EDGE,
        minHoldScans: 0,
        cooldownMs: 0,
        hourlyBudget: 0,
        ...o.edge,
    });
    const edge = createEdgeInfluence({
        getSettings: () => settings,
        series: () => o.series,
        now: o.now ?? (() => 0),
        storage: null,
    });
    const engine = o.engine ?? mode('balanced');
    const snap = (reads: PulseRead[]): PulseSnapshot => ({ markets: SYMBOLS.length, reads });
    const overlay = createSentinelOverlay({
        getEngine: () => engine,
        // no `series` here: that switches on the mandatory special-digit rule, which these tests are not about
        read: () => snap(o.reads),
        readOther: o.other ? () => snap(o.other as PulseRead[]) : undefined,
        edge,
        now: o.now,
    });
    overlay.refresh!(0, SYMBOLS);
    return { overlay, edge, setEdge: (p: Partial<EdgeSettings>) => (settings = normalizeEdge({ ...settings, ...p })) };
};
const bookOf = (f: (s: string) => number[]) => Object.fromEntries(SYMBOLS.map(s => [s, f(s)]));

describe('overlay without the gates', () => {
    it('is exactly the old behaviour: the gates add nothing when none are configured', () => {
        const base = createSentinelOverlay({
            getEngine: () => mode('balanced'),
            read: () => ({ markets: 1, reads: [read('M0', 'UNDER', 7, 'steady')] }),
        });
        base.refresh!(0, SYMBOLS);
        expect(base.call(cell('M0', 'UNDER', 7), ctx())).toMatchObject({ allow: true });
    });
});

describe('Kalman gate in the overlay', () => {
    it('stands down a signal whose filtered win rate is not above fair, and says so in the engine note', () => {
        const series = bookOf(() => winning(0.35, 3)); // Pulse is told (below) it is a steady signal, but the ticks say otherwise
        const { overlay } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { danger: false, arbiter: false, frequency: false },
        });
        const call = overlay.call(cell('M0', 'UNDER', 7), ctx());
        expect(call.allow).toBe(false);
        expect(call.note).toMatch(/Kalman/);
    });
    it('eases the bar and ranks higher for a confidently winning signal than for a bare one', () => {
        const series = bookOf(() => winning(0.88, 4));
        const { overlay } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { danger: false, arbiter: false, frequency: false },
        });
        const { overlay: bare } = make({
            series: bookOf(() => fair(9)),
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { kalman: false, danger: false, arbiter: false, frequency: false },
        });
        const confident = overlay.call(cell('M0', 'UNDER', 7), ctx());
        const plain = bare.call(cell('M0', 'UNDER', 7), ctx());
        expect(confident.allow).toBe(true);
        expect(confident.bump).toBeLessThan(plain.bump);
        expect(confident.rank).toBeGreaterThan(plain.rank);
    });
    it('does not veto in the Hunter', () => {
        const series = bookOf(() => winning(0.35, 3));
        const { overlay } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            engine: mode('hunter'),
            edge: { danger: false, arbiter: false, frequency: false },
        });
        const call = overlay.call(cell('M0', 'UNDER', 7), ctx());
        expect(call.allow).toBe(true);
        expect(call.bump).toBeGreaterThan(0);
    });
});

describe('danger gate in the overlay', () => {
    it('holds every signal when the markets turn hostile together, and lets them through again when it clears', () => {
        const hostile = bookOf(s => winning(0.1, s.length + 5, 200)); // every market cold on Under 7 at once
        const reads = SYMBOLS.map(s => read(s, 'UNDER', 7, 'strong'));
        const a = make({ series: hostile, reads, edge: { kalman: false, arbiter: false, frequency: false } });
        const call = a.overlay.call(cell('M0', 'UNDER', 7), ctx());
        expect(call.allow).toBe(false);
        expect(call.note).toMatch(/Danger/);
        const calm = make({
            series: bookOf(s => fair(s.charCodeAt(1), 200)),
            reads,
            edge: { kalman: false, arbiter: false, frequency: false },
        });
        expect(calm.overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(true);
    });
    it('also stops the buy on the last look', () => {
        const hostile = bookOf(s => winning(0.1, s.length + 5, 200));
        const { edge } = make({
            series: hostile,
            reads: SYMBOLS.map(s => read(s, 'UNDER', 7, 'strong')),
            edge: { kalman: false, arbiter: false, frequency: false },
        });
        const verdict = edge.guard('M0', { side: 'UNDER', param: 7 }, hostile.M0);
        expect(verdict.ok).toBe(false);
    });
});

describe('frequency gate in the overlay', () => {
    it('rests a market after a buy and makes a new signal wait for its scans', () => {
        let now = 0;
        const series = bookOf(() => winning(0.85, 6));
        const { overlay, edge } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            now: () => now,
            edge: { kalman: false, danger: false, arbiter: false, cooldownMs: 20_000, minHoldScans: 2 },
        });
        expect(overlay.call(cell('M0', 'UNDER', 7), ctx(now)).allow).toBe(false); // seen on 1 scan only
        overlay.refresh!(1500, SYMBOLS);
        expect(overlay.call(cell('M0', 'UNDER', 7), ctx(1500)).allow).toBe(true);
        overlay.onBought!({ symbol: 'M0' } as never);
        now = 5000;
        const rest = overlay.call(cell('M0', 'UNDER', 7), ctx(now));
        expect(rest.allow).toBe(false);
        expect(rest.note).toMatch(/rests/);
        expect(edge.report().gates.frequency.vetoed).toBeGreaterThan(0);
    });
    it('never delays a recovery trade', () => {
        const series = bookOf(() => winning(0.85, 6));
        const { overlay } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { kalman: false, danger: false, arbiter: false, cooldownMs: 60_000, minHoldScans: 5 },
        });
        overlay.onBought!({ symbol: 'M0' } as never);
        expect(overlay.call(cell('M0', 'UNDER', 7), ctx(1, true)).allow).toBe(true);
    });
});

describe('arbiter in the overlay', () => {
    const series = bookOf(() => winning(0.8, 7));
    const off = { kalman: false, danger: false, frequency: false };
    it('lets one signal per market come up and stands the others down', () => {
        const { overlay } = make({
            series,
            reads: [read('M0', 'OVER', 2, 'steady', 60), read('M0', 'OVER', 3, 'strong', 90)],
            edge: off,
        });
        expect(overlay.call(cell('M0', 'OVER', 3), ctx()).allow).toBe(true);
        const beaten = overlay.call(cell('M0', 'OVER', 2), ctx());
        expect(beaten.allow).toBe(false);
        expect(beaten.note).toMatch(/Over 3 is the pick/);
    });
    it('abstains where Over and Under contradict about equally', () => {
        const { overlay } = make({
            series,
            reads: [read('M0', 'OVER', 2, 'steady', 60), read('M0', 'UNDER', 7, 'steady', 60)],
            edge: off,
        });
        expect(overlay.call(cell('M0', 'OVER', 2), ctx()).allow).toBe(false);
        expect(overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(false);
    });
    it('ranks a signal both sources list above one only a single source lists', () => {
        const mine = [read('M0', 'UNDER', 7, 'steady', 60), read('M1', 'UNDER', 7, 'steady', 60)];
        const { overlay } = make({ series, reads: mine, other: [read('M0', 'UNDER', 7, 'strong', 70)], edge: off });
        const both = overlay.call(cell('M0', 'UNDER', 7), ctx());
        const alone = overlay.call(cell('M1', 'UNDER', 7), ctx());
        expect(both.rank).toBeGreaterThan(alone.rank);
    });
    it('skips signals the engine already stood down', () => {
        const { overlay, edge } = make({ series, reads: [read('M0', 'UNDER', 7, 'watch')], edge: off });
        expect(overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(false); // balanced mode: no watch signal
        expect(edge.report().gates.arbiter.vetoed).toBe(0);
    });
});

describe('shadow mode', () => {
    it('changes nothing the runner sees but still keeps the evidence', () => {
        const series = bookOf(() => winning(0.35, 3));
        const { overlay, edge, setEdge } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { danger: false, arbiter: false, frequency: false },
        });
        expect(overlay.call(cell('M0', 'UNDER', 7), ctx()).allow).toBe(false);
        setEdge({ shadow: true });
        const shadow = overlay.call(cell('M0', 'UNDER', 7), ctx(30_000));
        expect(shadow).toMatchObject({ allow: true });
        expect(edge.report().gates.kalman.vetoed).toBe(2);
        expect(edge.guard('M0', { side: 'UNDER', param: 7 }, series.M0).ok).toBe(true);
    });
});

describe('evidence', () => {
    it('settles a vetoed signal on the next tick of its market and compares it with the fair rate', () => {
        const series = bookOf(() => winning(0.35, 3));
        const { overlay, edge } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { danger: false, arbiter: false, frequency: false },
        });
        overlay.call(cell('M0', 'UNDER', 7), ctx());
        edge.onTick('M1', 0); // another market: not this one's tick
        edge.onTick('M0', 3); // 3 wins Under 7
        const g = edge.report().gates.kalman;
        expect(g).toMatchObject({ vetoed: 1, resolved: 1, wouldWin: 1 });
        expect(g.fairSum).toBeCloseTo(0.7);
    });
    it('counts a repeated veto of the same signal only once per window', () => {
        const series = bookOf(() => winning(0.35, 3));
        const { overlay, edge } = make({
            series,
            reads: [read('M0', 'UNDER', 7, 'steady')],
            edge: { danger: false, arbiter: false, frequency: false },
        });
        for (let i = 0; i < 5; i += 1) overlay.call(cell('M0', 'UNDER', 7), ctx(i * 1000));
        expect(edge.report().gates.kalman.vetoed).toBe(1);
    });
    it('records real settled trades under live or shadow, and prints a readable report', () => {
        const { overlay, edge, setEdge } = make({ series: bookOf(() => fair(1)), reads: [] });
        const notice = { symbol: 'M0', bought: { side: 'UNDER', param: 7 }, profit: 1 } as never;
        overlay.onSettled!(notice);
        setEdge({ shadow: true });
        overlay.onSettled!({ ...(notice as object), profit: -1 } as never);
        const r: EdgeReport = edge.report();
        expect(r.real.live).toMatchObject({ settled: 1, wins: 1 });
        expect(r.real.shadow).toMatchObject({ settled: 1, wins: 0 });
        expect(describeReport(r)).toMatch(/gates live/);
    });
    it('ignores a result Deriv could not confirm', () => {
        const { overlay, edge } = make({ series: bookOf(() => fair(1)), reads: [] });
        overlay.onSettled!({ symbol: 'M0', bought: { side: 'UNDER', param: 7 }, profit: null } as never);
        expect(edge.report().real.live.settled).toBe(0);
    });
});

describe('failure isolation', () => {
    it('a gate that throws never takes the engine down with it', () => {
        const broken = {
            refresh: () => {
                throw new Error('x');
            },
            call: () => {
                throw new Error('x');
            },
            guard: () => {
                throw new Error('x');
            },
            onBought: () => {
                throw new Error('x');
            },
            onSettled: () => {
                throw new Error('x');
            },
        } as never;
        const o = createSentinelOverlay({
            getEngine: () => mode('balanced'),
            read: () => ({ markets: 1, reads: [read('M0', 'UNDER', 7, 'steady')] }),
            edge: broken,
        });
        expect(() => o.refresh!(0, SYMBOLS)).not.toThrow();
        expect(o.call(cell('M0', 'UNDER', 7), ctx())).toMatchObject({ allow: true });
        expect(() => o.onBought!({} as never)).not.toThrow();
        expect(() => o.onSettled!({} as never)).not.toThrow();
    });
});

describe('edge settings', () => {
    it('defaults to every gate on, live', () => {
        expect(normalizeEdge(null)).toMatchObject({
            kalman: true,
            danger: true,
            frequency: true,
            arbiter: true,
            shadow: false,
        });
    });
    it('clamps and coerces whatever was saved', () => {
        expect(normalizeEdge({ cooldownMs: -5, minHoldScans: 999, hourlyBudget: 'x', kalman: 'yes' })).toMatchObject({
            cooldownMs: 0,
            minHoldScans: 20,
            hourlyBudget: DEFAULT_EDGE.hourlyBudget,
            kalman: true,
        });
    });
});

export type { BoardRow };
