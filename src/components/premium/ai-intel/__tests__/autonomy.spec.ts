import { mulberry32 } from '@/components/premium/sixfold/stats';
import { Autopilot, decidePromotions, DEFAULT_AUTOPILOT, normalizeAutopilot, RESEARCH_MIN_TICKS } from '../autopilot';
import { assess } from '../guard';
import { ForwardMonitor, type Forward } from '../monitor';
import { summarise } from '../performance';
import { OVER_2 } from '../sim';
import type { ExecTrade } from '../executor';
import type { Strategy } from '../registry';

const fair = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};
const strat = (id: string, status: Strategy['status'], over: Partial<Strategy> = {}): Strategy => ({
    familyId: id, version: 1, id, name: id, description: id, direction: 'OVER_2', rule: { digits: [1], prev: { kind: 'ANY', k: 0 } }, ruleKey: `${id}|`, duration: 1, markets: [],
    status, createdAt: 0, trainPeriod: { ticks: 0, trades: 0, rate: null }, validationPeriod: { ticks: 0, trades: 90, rate: 0.8, q: 0.01 }, passedValidation: true, validationNotes: [], history: [], ...over,
});
const fwd = (id: string, trades: number, wins: number, extra: Partial<Forward> = {}): Forward => {
    const rate = trades ? wins / trades : null;
    const se = Math.sqrt(0.7 * 0.3 / Math.max(trades, 1));
    return { strategyId: id, trades, wins, rate, lo: (rate ?? 0) - 2 * se, hi: (rate ?? 0) + 2 * se, baseline: 0.7, since: 0, suspended: false, ...extra };
};

describe('AI guard', () => {
    const req = (over = {}) => ({ mode: 'GUARD' as const, market: 'R_10', contract: OVER_2, recovery: false, strategyId: null, significant: false, trades: 100, ...over });
    it('is inert when off and blocks unreadable markets', () => {
        expect(assess(req({ mode: 'OFF' }), { series: [], forward: [] }).allow).toBe(true);
        expect(assess(req(), { series: fair(50, 1), forward: [] }).allow).toBe(false);
    });
    it('allows a normal fair market and explains why', () => {
        const v = assess(req(), { series: fair(2000, 5), forward: [] });
        expect(v.allow).toBe(true);
        expect(v.reason).toMatch(/regime/);
    });
    it('blocks when the winning digits have dried up', () => {
        const dry = [...fair(1900, 6), ...Array.from({ length: 100 }, (_, i) => i % 3)]; // last 100 ticks: only 0,1,2 (all lose OVER 2)
        const v = assess(req(), { series: dry, forward: [] });
        expect(v.allow).toBe(false);
    });
    it('blocks a signal from a strategy the forward test suspended or is failing', () => {
        const s = fair(2000, 7);
        expect(assess(req({ strategyId: 'a' }), { series: s, forward: [fwd('a', 80, 50, { suspended: true })] }).allow).toBe(false);
        expect(assess(req({ strategyId: 'a' }), { series: s, forward: [fwd('a', 100, 50, { hi: 0.6 })] }).allow).toBe(false);
        expect(assess(req({ strategyId: 'a' }), { series: s, forward: [fwd('a', 100, 75)] }).allow).toBe(true);
    });
    it('STRICT needs proven edge for main contracts, and enough evidence for recovery', () => {
        const s = fair(2000, 8);
        expect(assess(req({ mode: 'STRICT', significant: false }), { series: s, forward: [] }).allow).toBe(false);
        expect(assess(req({ mode: 'STRICT', significant: true }), { series: s, forward: [] }).allow).toBe(true);
        expect(assess(req({ mode: 'STRICT', recovery: true, significant: false }), { series: s, forward: [] }).allow).toBe(true);
        expect(assess(req({ mode: 'STRICT', recovery: true, trades: 10 }), { series: s, forward: [] }).allow).toBe(false);
    });
});

describe('autopilot promotion', () => {
    const cfg = (promote: any, maxActive = 3) => ({ ...DEFAULT_AUTOPILOT, promote, maxActive });
    it('approves validated strategies and never touches ones that failed validation', () => {
        const moves = decidePromotions([strat('ok', 'UNDER_VALIDATION'), strat('bad', 'UNDER_VALIDATION', { passedValidation: false }), strat('gone', 'RETIRED')], [], cfg('BALANCED'));
        expect(moves).toEqual([expect.objectContaining({ id: 'ok', to: 'APPROVED' })]);
        expect(decidePromotions([strat('ok', 'UNDER_VALIDATION')], [], cfg('OFF'))).toEqual([]);
    });
    it('BALANCED activates after 30 forward trades at or above chance, STRICT needs 60 and a floor above chance', () => {
        const a = strat('a', 'APPROVED');
        expect(decidePromotions([a], [fwd('a', 29, 25)], cfg('BALANCED'))).toEqual([]);
        expect(decidePromotions([a], [fwd('a', 30, 20)], cfg('BALANCED'))).toEqual([]); // 66.7% < 70%
        expect(decidePromotions([a], [fwd('a', 30, 23)], cfg('BALANCED'))).toEqual([expect.objectContaining({ to: 'ACTIVE' })]);
        expect(decidePromotions([a], [fwd('a', 60, 45)], cfg('STRICT'))).toEqual([]); // floor below chance
        expect(decidePromotions([a], [fwd('a', 400, 340)], cfg('STRICT'))).toEqual([expect.objectContaining({ to: 'ACTIVE' })]);
        expect(decidePromotions([a], [fwd('a', 400, 340, { suspended: true })], cfg('STRICT'))).toEqual([]);
    });
    it('FAST goes validated -> approved -> active at once, best first, up to the cap', () => {
        const list = [strat('x', 'UNDER_VALIDATION', { validationPeriod: { ticks: 0, trades: 90, rate: 0.75, q: 0.01 } }), strat('y', 'UNDER_VALIDATION', { validationPeriod: { ticks: 0, trades: 90, rate: 0.9, q: 0.01 } }), strat('z', 'APPROVED', { validationPeriod: { ticks: 0, trades: 90, rate: 0.8, q: 0.01 } })];
        const active = decidePromotions(list, [], cfg('FAST', 2)).filter(m => m.to === 'ACTIVE').map(m => m.id);
        expect(active).toEqual(['y', 'z']);
        expect(decidePromotions([strat('on', 'ACTIVE'), strat('n', 'APPROVED')], [], cfg('FAST', 1))).toEqual([]);
    });
});

describe('autopilot service', () => {
    const lab = (state = 'idle') => {
        const started: any[] = [];
        return { started, getSnapshot: () => ({ state }) as any, start: (c: any) => started.push(c) };
    };
    const make = (over: any = {}) => {
        let t = 1_000_000;
        const l = over.lab ?? lab();
        const moves: any[] = [];
        const ap = new Autopilot({
            strategies: () => over.strategies ?? [],
            forward: () => [],
            setStatus: (id, to, by, note) => (moves.push({ id, to, by, note }), null),
            lab: l,
            series: () => over.series ?? { A: fair(RESEARCH_MIN_TICKS, 1), B: fair(10, 2) },
            duration: () => 1,
            now: () => t,
        });
        return { ap, l, moves, advance: (ms: number) => (t += ms) };
    };
    it('starts research on markets with enough ticks, with a fresh seed each time, and waits between runs', () => {
        const { ap, l, advance } = make();
        ap.cycle();
        expect(l.started).toHaveLength(1);
        expect(l.started[0]).toMatchObject({ markets: ['A'], direction: 'BOTH', duration: 1 });
        ap.cycle();
        expect(l.started).toHaveLength(1); // not again before everyMin
        advance(11 * 60_000);
        ap.cycle();
        expect(l.started).toHaveLength(2);
        expect(l.started[1].seed).not.toBe(l.started[0].seed);
    });
    it('does not start while the lab is busy, when research is off, or with too little data', () => {
        const busy = make({ lab: lab('running') });
        busy.ap.cycle();
        expect(busy.l.started).toHaveLength(0);
        const off = make();
        off.ap.configure({ research: false });
        off.ap.cycle();
        expect(off.l.started).toHaveLength(0);
        const thin = make({ series: { A: fair(100, 1) } });
        thin.ap.cycle();
        expect(thin.l.started).toHaveLength(0);
    });
    it('applies promotions as `auto` and records them', () => {
        const { ap, moves } = make({ strategies: [strat('ok', 'UNDER_VALIDATION')] });
        ap.cycle();
        expect(moves).toEqual([expect.objectContaining({ id: 'ok', to: 'APPROVED', by: 'auto' })]);
        expect(ap.getSnapshot().moves[0]).toMatchObject({ id: 'ok', ok: true });
    });
    it('normalises settings', () => {
        expect(normalizeAutopilot({ promote: 'WAT' as any, maxActive: 99, everyMin: 0 })).toMatchObject({ promote: 'BALANCED', maxActive: 10, everyMin: 2 });
    });
});

describe('forward monitor keeps its counts across a reload', () => {
    it('saves counts and restores them', () => {
        const list = [strat('S@v1', 'ACTIVE')];
        let saved: any = null;
        const store = { load: () => saved, save: (c: any) => (saved = JSON.parse(JSON.stringify(c))) };
        const a = new ForwardMonitor(() => list, () => null, () => 1, store);
        const digits = fair(200, 9);
        digits.forEach((d, i) => a.handleTick('R_10', d, i));
        const n = a.getSnapshot()[0].trades;
        expect(n).toBeGreaterThan(0);
        const b = new ForwardMonitor(() => list, () => null, () => 2, store);
        expect(b.getSnapshot()[0].trades).toBe(n);
    });
});

describe('performance summary', () => {
    const t = (over: Partial<ExecTrade>): ExecTrade => ({ id: String(Math.random()), contractId: 1, at: 0, market: 'R_10', label: 'Over 2', recovery: false, step: 0, stake: 1, duration: 1, triggerDigit: 1, exitDigit: 5, profit: 0.4, status: 'won', ...over });
    it('computes totals, drawdown, losing run and groups (newest first input)', () => {
        const newestFirst = [t({ profit: 0.4 }), t({ status: 'lost', profit: -2, recovery: true, step: 1, label: 'Over 3', market: 'R_50' }), t({ status: 'lost', profit: -1 }), t({ profit: 0.4 })];
        const p = summarise(newestFirst);
        expect(p.trades).toBe(4);
        expect(p.pnl).toBe(-2.2);
        expect(p.curve).toEqual([0, 0.4, -0.6, -2.6, -2.2]);
        expect(p.maxDrawdown).toBe(3);
        expect(p.longestLosingRun).toBe(2);
        expect(p.winRate).toBe(0.5);
        expect(p.byMarket.map(g => g.key)).toEqual(['R_10', 'R_50']);
        expect(p.byRecoveryStep.find(g => g.key === 'Recovery step 1')).toMatchObject({ trades: 1, pnl: -2 });
    });
    it('keeps paper trades and unconfirmed trades apart from the real figures', () => {
        const all = [t({ virtual: true, profit: 0.4 }), t({ status: 'unconfirmed', profit: null }), t({})];
        expect(summarise(all, false)).toMatchObject({ trades: 1, unconfirmed: 1 });
        expect(summarise(all, true)).toMatchObject({ trades: 1 });
    });
});
