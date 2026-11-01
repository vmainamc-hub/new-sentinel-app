import { mulberry32 } from '@/components/premium/sixfold/stats';
import { entryMetNow, longestRuns, MODEL_VERSION, probAbove, runAgents, transitionDependence, winCorrelation, type IntelInput } from '../agents';
import { ForwardMonitor } from '../monitor';
import { type Pick, rankPicks } from '../picker';
import type { Strategy } from '../registry';

const fair = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};
const NOW = 100_000;
const fresh = () => NOW - 1000;
const planted = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? 1 : 8));
const input = (series: Record<string, number[]>, over: Partial<IntelInput> = {}): IntelInput => ({
    now: NOW, series, lastTickAt: fresh, duration: 1,
    picks: rankPicks(series, fresh, NOW, { duration: 1, evidenceOnly: false, directions: 'BOTH' }),
    strategies: [], forward: [], lab: { state: 'idle', note: null, results: 0, passed: 0 }, exec: { running: false, trades: 0, pnl: 0, market: null }, ...over,
});

describe('measurements', () => {
    it('transition test: independent on fair digits, dependent on a deterministic cycle', () => {
        expect(transitionDependence(fair(20000, 1)).p).toBeGreaterThan(0.01);
        expect(transitionDependence(Array.from({ length: 5000 }, (_, i) => i % 10)).p).toBeLessThan(1e-6);
        expect(transitionDependence(fair(100, 1)).p).toBeNull();
    });
    it('runs, Bayesian probability and cross-market correlation', () => {
        expect(longestRuns([5, 6, 7, 1, 5], d => d > 2)).toEqual({ win: 3, lose: 1 });
        expect(probAbove(900, 1000, 0.7)!).toBeGreaterThan(0.99);
        expect(probAbove(700, 1000, 0.7)!).toBeGreaterThan(0.3);
        expect(probAbove(700, 1000, 0.7)!).toBeLessThan(0.7);
        expect(probAbove(5, 10, 0.7)).toBeNull();
        const a = fair(1000, 3);
        expect(winCorrelation(a, a, d => d > 2).r).toBeCloseTo(1, 5);
        expect(Math.abs(winCorrelation(a, fair(1000, 4), d => d > 2).r!)).toBeLessThan(0.15);
        expect(winCorrelation(a.slice(0, 50), a, d => d > 2).r).toBeNull();
    });
});

const strat = (status: Strategy['status'] = 'ACTIVE'): Strategy => ({
    familyId: 'S', version: 1, id: 'S@v1', name: 'x', description: 'x', direction: 'OVER_2', rule: { digits: [1], prev: { kind: 'ANY', k: 0 } }, ruleKey: '1|ANY0', duration: 1,
    markets: ['M'], status, createdAt: 0, trainPeriod: { ticks: 0, trades: 0, rate: null }, validationPeriod: { ticks: 0, trades: 0, rate: null, q: null }, passedValidation: true, validationNotes: [], history: [],
});

describe('agents and Chief', () => {
    it('on fair random markets the Chief says NO TRADE and says why (no proven edge)', () => {
        const rep = runAgents(input({ A: fair(4000, 11), B: fair(4000, 12), C: fair(4000, 13) }));
        expect(rep.agents.map(a => a.id)).toEqual(['scanner', 'sequence', 'probability', 'regime', 'research', 'validation', 'competition', 'live', 'performance', 'chief']);
        expect(rep.decision.decision).toBe('NO_TRADE');
        expect(rep.decision.explanation.join(' ')).toMatch(/No proven edge/);
        expect(rep.decision.modelVersion).toBe(MODEL_VERSION);
        expect(rep.decision.evidence!.model.learned).toBe(false);
        expect(rep.rejected.length).toBeGreaterThan(0);
    });
    it('ENTER only when every gate passes: significant, stable, fresh, strategy active, entry met on the latest tick', () => {
        const r = mulberry32(77);
        const base: number[] = [];
        while (base.length < 6000) {
            const d = Math.floor(r() * 10);
            base.push(d);
            if (d === 4 && base.length >= 3 && base[base.length - 2] > 2 && base[base.length - 3] > 2) base.push(3 + Math.floor(r() * 7)); // planted: a winning digit always follows (keeps digits near-uniform)
        }
        const S = (tail: number[]) => ({ M: [...base.slice(0, 5990), ...tail] });
        const rule = { digits: [4], prev: { kind: 'ALL_WIN' as const, k: 2 } };
        const active = strat('ACTIVE');
        const candidates = [{ direction: 'OVER_2' as const, entry: 'SMART' as const, rule, strategyId: 'S@v1', strategyLabel: 'x', markets: ['M'], duration: 1 }];
        const mk = (tail: number[], extra: Partial<IntelInput> = {}) => {
            const series = S(tail);
            return input(series, { strategies: [active], picks: rankPicks(series, fresh, NOW, { duration: 1, evidenceOnly: false, directions: 'BOTH', candidates }), ...extra });
        };
        const yes = runAgents(mk([5, 6, 4]));
        expect(yes.decision).toMatchObject({ decision: 'ENTER', market: 'M', direction: 'OVER_2', barrier: 2, entryMetNow: true, validationStatus: 'VALIDATED_STRATEGY', strategyVersion: 1 });
        expect(yes.decision.evidence!.statistical.significant).toBe(true);
        expect(yes.decision.evidence!.outOfSample).not.toBeNull();
        const notNow = runAgents(mk([5, 6, 7]));
        expect(notNow.decision.decision).toBe('NO_TRADE');
        expect(notNow.decision.explanation.join(' ')).toMatch(/not met on the latest tick/);
        const stale = runAgents({ ...mk([5, 6, 4]), lastTickAt: () => NOW - 60_000 });
        expect(stale.decision.decision).toBe('NO_TRADE');
        const suspended = runAgents(mk([5, 6, 4], { strategies: [strat('SUSPENDED')] }));
        expect(suspended.decision.decision).toBe('NO_TRADE');
        expect(suspended.decision.explanation.join(' ')).toMatch(/suspended/);
    });
    it('reports no data without inventing anything', () => {
        const rep = runAgents(input({}));
        expect(rep.decision).toMatchObject({ decision: 'NO_TRADE', market: null });
        expect(rep.agents.find(a => a.id === 'scanner')!.state).toBe('idle');
    });
    it('entryMetNow reads only the latest tick and history', () => {
        const pick = { market: 'M', direction: 'OVER_2', entry: 'SETUP', customDigits: [], rule: null } as unknown as Pick;
        expect(entryMetNow(pick, { M: [5, 1] })).toBe(true);
        expect(entryMetNow(pick, { M: [1, 5] })).toBe(false);
        expect(entryMetNow(pick, {})).toBe(false);
    });
});

describe('ForwardMonitor', () => {
    it('paper-trades active strategies on live ticks and suspends one that deteriorates, only after enough trades', () => {
        const list = [strat()];
        const suspended: string[] = [];
        const mon = new ForwardMonitor(() => list, (id, note) => (suspended.push(note), (list[0].status = 'SUSPENDED'), null));
        // every trigger (1) is followed by 0: each contract LOSES
        for (let i = 0; i < 59; i++) { mon.handleTick('M', 1); mon.handleTick('M', 0); }
        expect(suspended).toHaveLength(0);
        expect(mon.getSnapshot()[0]).toMatchObject({ trades: 59, wins: 0 });
        mon.handleTick('M', 1);
        mon.handleTick('M', 0); // 60th losing trade
        expect(suspended).toHaveLength(1);
        expect(suspended[0]).toMatch(/Forward test/);
        // a suspended strategy is no longer traded
        mon.handleTick('M', 1);
        expect(mon.getSnapshot().find(f => f.strategyId === 'S@v1')!.trades).toBe(60);
    });
    it('ignores other markets and non-approved strategies, and never suspends a good one', () => {
        const list = [strat(), { ...strat('UNDER_VALIDATION'), id: 'T@v1' }];
        const mon = new ForwardMonitor(() => list, () => 'should not be called');
        for (let i = 0; i < 200; i++) { mon.handleTick('OTHER', 1); mon.handleTick('OTHER', 0); mon.handleTick('M', 1); mon.handleTick('M', 9); }
        const f = mon.getSnapshot();
        expect(f.map(x => x.strategyId)).toEqual(['S@v1']);
        expect(f[0]).toMatchObject({ trades: 200, wins: 200, suspended: false });
    });
});
