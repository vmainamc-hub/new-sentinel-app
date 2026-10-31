import type { LabCandidate, LabConfig } from '../lab';
import { DEFAULT_LAB } from '../lab';
import { rankPicks } from '../picker';
import { type RegistryStorage, type Strategy, StrategyRegistry } from '../registry';

const stats = (trades: number, rate: number) => ({ trades, wins: Math.round(trades * rate), rate, lo: rate - 0.05, hi: rate + 0.05, p: 0.001, baseline: 0.7 });
const cand = (digits: number[], passed: boolean, direction: 'OVER_2' | 'UNDER_7' = 'OVER_2'): LabCandidate => ({
    direction, rule: { digits, prev: { kind: 'ANY', k: 0 } }, description: 'x', train: stats(100, 0.8), validation: stats(80, passed ? 0.8 : 0.69), q: passed ? 0.01 : 0.6,
    degradationPts: 0, passed, reasons: passed ? [] : ['not significant on unseen ticks'],
});
const mem = () => {
    let data: Strategy[] | null = null;
    const storage: RegistryStorage = { load: () => data, save: s => (data = JSON.parse(JSON.stringify(s))) };
    return { storage, get data() { return data; } };
};
const cfg: LabConfig = { ...DEFAULT_LAB, markets: ['R_10', 'R_25'] };

describe('StrategyRegistry', () => {
    it('stores lab results: passed -> UNDER_VALIDATION, failed -> RETIRED with reasons; never approved by itself', () => {
        const m = mem();
        let t = 1000;
        const reg = new StrategyRegistry(m.storage, () => t++);
        const added = reg.addFromLab([cand([4], true), cand([5], false)], cfg, { train: 100, validation: 60 });
        expect(added.map(s => s.status)).toEqual(['UNDER_VALIDATION', 'RETIRED']);
        expect(added[1].history.at(-1)!.note).toMatch(/Failed validation/);
        expect(reg.activeCandidates()).toHaveLength(0);
        expect(m.data).toHaveLength(2); // persisted
    });

    it('skips a rule it already holds, so re-running the lab never duplicates or replaces', () => {
        const reg = new StrategyRegistry(mem().storage);
        reg.addFromLab([cand([4], true)], cfg, null);
        expect(reg.addFromLab([cand([4], true)], cfg, null)).toHaveLength(0);
        expect(reg.getSnapshot()).toHaveLength(1);
    });

    it('enforces the lifecycle and records every change', () => {
        const reg = new StrategyRegistry(mem().storage);
        const [s] = reg.addFromLab([cand([4], true)], cfg, null);
        expect(reg.setStatus(s.id, 'ACTIVE', 'user', 'x')).toMatch(/cannot become/); // must be approved first
        expect(reg.setStatus(s.id, 'APPROVED', 'monitor', 'x')).toMatch(/Only a person/);
        expect(reg.setStatus(s.id, 'APPROVED', 'user', 'looks right')).toBeNull();
        expect(reg.setStatus(s.id, 'ACTIVE', 'user', 'go')).toBeNull();
        expect(reg.activeCandidates()).toEqual([expect.objectContaining({ entry: 'SMART', strategyId: s.id, direction: 'OVER_2', duration: 1 })]);
        expect(reg.setStatus(s.id, 'SUSPENDED', 'monitor', 'deteriorated')).toBeNull(); // monitor may suspend
        expect(reg.activeCandidates()).toHaveLength(0);
        expect(reg.setStatus(s.id, 'ACTIVE', 'monitor', 'x')).toMatch(/cannot become|Only a person/);
        expect(reg.get(s.id)!.history.map(h => h.to)).toEqual(['EXPERIMENTAL', 'UNDER_VALIDATION', 'APPROVED', 'ACTIVE', 'SUSPENDED']);
        expect(reg.setStatus(s.id, 'RETIRED', 'user', 'done')).toBeNull();
        expect(reg.setStatus(s.id, 'APPROVED', 'user', 'back')).toMatch(/cannot become/); // retired is final
    });

    it('a strategy that failed validation needs an explicit, logged override to be approved', () => {
        const reg = new StrategyRegistry(mem().storage);
        const [s] = reg.addFromLab([cand([4], false)], cfg, null);
        expect(s.status).toBe('RETIRED');
        const reg2 = new StrategyRegistry(mem().storage);
        const [u] = reg2.addFromLab([{ ...cand([6], false), passed: false }], cfg, null);
        expect(u.status).toBe('RETIRED');
        // force an under-validation entry that did not pass (as a manual import would)
        const items = reg2.getSnapshot() as Strategy[];
        items[0].status = 'UNDER_VALIDATION';
        expect(reg2.setStatus(u.id, 'APPROVED', 'user', 'x')).toMatch(/override/);
        expect(reg2.setStatus(u.id, 'APPROVED', 'user', 'I accept the risk', { override: true })).toBeNull();
        expect(reg2.get(u.id)!.history.at(-1)!.note).toMatch(/override of failed validation/);
    });

    it('new rule = new version; the old version stays; rollback restores it and suspends the newer one', () => {
        const reg = new StrategyRegistry(mem().storage);
        const [v1] = reg.addFromLab([cand([4], true)], cfg, null);
        reg.setStatus(v1.id, 'APPROVED', 'user', 'a');
        reg.setStatus(v1.id, 'ACTIVE', 'user', 'a');
        const v2 = reg.newVersion(v1.id, { digits: [4, 5], prev: { kind: 'ANY', k: 0 } }, 'widen') as Strategy;
        expect(v2.version).toBe(2);
        expect(v2.status).toBe('EXPERIMENTAL');
        expect(reg.get(v1.id)!.rule.digits).toEqual([4]); // untouched
        expect(reg.newVersion(v1.id, { digits: [4], prev: { kind: 'ANY', k: 0 } }, 'dup')).toMatch(/already exists/);
        reg.setStatus(v2.id, 'UNDER_VALIDATION', 'user', 'a');
        reg.setStatus(v2.id, 'APPROVED', 'user', 'a', { override: true });
        reg.setStatus(v2.id, 'ACTIVE', 'user', 'a');
        expect(reg.rollback(v1.id)).toBeNull();
        expect(reg.get(v1.id)!.status).toBe('ACTIVE');
        expect(reg.get(v2.id)!.status).toBe('SUSPENDED');
        expect(reg.versions(v1.familyId).map(v => v.version)).toEqual([2, 1]);
    });

    it('reloads from storage', () => {
        const m = mem();
        const a = new StrategyRegistry(m.storage);
        a.addFromLab([cand([4], true)], cfg, null);
        expect(new StrategyRegistry(m.storage).getSnapshot()).toHaveLength(1);
    });
});

describe('picker with SMART strategies', () => {
    it('evaluates an active strategy rule on live ticks and carries the rule into the pick', () => {
        const planted = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? 1 : 8));
        const picks = rankPicks({ R_10: planted, R_75: planted }, () => 9500, 10000, {
            duration: 1, evidenceOnly: true, directions: 'BOTH',
            candidates: [{ direction: 'OVER_2', entry: 'SMART', rule: { digits: [1], prev: { kind: 'ANY', k: 0 } }, strategyId: 's@v1', strategyLabel: 'S', markets: ['R_10'], duration: 1 }],
        });
        expect(picks).toHaveLength(1); // R_75 is not in the strategy's markets
        expect(picks[0]).toMatchObject({ market: 'R_10', entry: 'SMART', strategyId: 's@v1', significant: true });
        expect(picks[0].rule).toEqual({ digits: [1], prev: { kind: 'ANY', k: 0 } });
        const other = rankPicks({ R_10: planted }, () => 9500, 10000, {
            duration: 3, evidenceOnly: false, directions: 'BOTH',
            candidates: [{ direction: 'OVER_2', entry: 'SMART', rule: { digits: [1], prev: { kind: 'ANY', k: 0 } }, duration: 1 }],
        });
        expect(other).toHaveLength(0); // validated for 1 tick, run asks for 3
    });
});
