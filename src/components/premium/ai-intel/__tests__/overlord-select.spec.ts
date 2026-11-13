import type { Contract } from '@/components/premium/sixfold/bot';
import type { OverlordRead, OverlordTier } from '../../overlord-engine/engine';
import {
    createOverlordReader,
    DEFAULT_READ_CONTRACTS,
    MIN_ROUNDS,
    normalizeSelection,
    type OverlordView,
    ROUND_WINDOW,
    selectByOverlord,
    type SelectionMode,
    summariseBlocked,
} from '../overlord-select';

type Cand = { market: string; label: string; contract: Contract; score: number };
const OVER_2: Contract = { side: 'OVER', param: 2 };
const UNDER_7: Contract = { side: 'UNDER', param: 7 };

const read = (o: Partial<OverlordRead> & { tier?: OverlordTier }): OverlordRead =>
    ({ tier: 'STRONG', score: 60, vetoed: false, vetoReason: '', thin: false, ...o }) as OverlordRead;
const view = (o: Partial<OverlordView> & { read?: Partial<OverlordRead> } = {}): OverlordView => ({
    read: read(o.read ?? {}),
    rounds: o.rounds ?? MIN_ROUNDS,
    clearShare: o.clearShare ?? 1,
    at: 0,
});
const cand = (market: string, contract: Contract, score = 0.05): Cand => ({ market, contract, score, label: `${contract.side} ${contract.param}` });

const run = (items: Cand[], views: Record<string, OverlordView | null>, mode: SelectionMode) =>
    selectByOverlord(items, {
        mode,
        contractOf: c => c.contract,
        viewOf: (m, c) => views[`${m}:${c.side}:${c.param}`] ?? null,
        hasEdge: c => c.score > 0,
    });

describe('selectByOverlord', () => {
    it('STANDARD hands back the very same list and blocks nothing', () => {
        const items = [cand('A', OVER_2), cand('B', UNDER_7)];
        const out = run(items, {}, 'STANDARD');
        expect(out.items).toBe(items);
        expect(out.blocked).toEqual([]);
    });

    it('OVERLORD ranks by tier, then score, then the picker order', () => {
        const items = [cand('A', OVER_2), cand('B', OVER_2), cand('C', OVER_2), cand('D', OVER_2)];
        const out = run(
            items,
            {
                'A:OVER:2': view({ read: { tier: 'BEST', score: 90 } }),
                'B:OVER:2': view({ read: { tier: 'STRONG', score: 55 } }),
                'C:OVER:2': view({ read: { tier: 'STRONG', score: 70 } }),
                'D:OVER:2': view({ read: { tier: 'STRONG', score: 70 } }),
            },
            'OVERLORD'
        );
        expect(out.items.map(i => i.market)).toEqual(['C', 'D', 'B', 'A']);
    });

    it('drops, with a reason, what Overlord cannot read, vetoes, or has not seen steadily', () => {
        const items = ['none', 'thin', 'veto', 'watch', 'shaky', 'ok'].map(m => cand(m, OVER_2));
        const out = run(
            items,
            {
                'thin:OVER:2': view({ read: { thin: true, tier: 'LEGACY' } }),
                'veto:OVER:2': view({ read: { vetoed: true, tier: 'CAUTION', vetoReason: 'Apex Sentinel: danger clearance failed' } }),
                'watch:OVER:2': view({ rounds: MIN_ROUNDS - 1 }),
                'shaky:OVER:2': view({ clearShare: 0.4 }),
                'ok:OVER:2': view(),
            },
            'OVERLORD'
        );
        expect(out.items.map(i => i.market)).toEqual(['ok']);
        expect(Object.fromEntries(out.blocked.map(b => [b.market, b.reason]))).toEqual({
            none: 'no-read',
            thin: 'thin',
            veto: 'veto',
            watch: 'watching',
            shaky: 'unsteady',
        });
        expect(out.blocked.find(b => b.market === 'veto')?.text).toContain('danger clearance');
        expect(summariseBlocked(out.blocked)).toContain('1 vetoed');
    });

    it('COMBINED also needs the picker’s own edge; OVERLORD does not', () => {
        const items = [cand('A', OVER_2, 0.04), cand('B', OVER_2, -0.02)];
        const views = { 'A:OVER:2': view(), 'B:OVER:2': view({ read: { score: 99 } }) };
        expect(run(items, views, 'OVERLORD').items.map(i => i.market)).toEqual(['B', 'A']);
        const both = run(items, views, 'COMBINED');
        expect(both.items.map(i => i.market)).toEqual(['A']);
        expect(both.blocked[0].reason).toBe('edge');
    });

    it('picks the contract per market: the better-read direction comes first for that market', () => {
        const items = [cand('A', OVER_2), cand('A', UNDER_7)];
        const out = run(items, { 'A:OVER:2': view({ read: { score: 40, tier: 'BEST' } }), 'A:UNDER:7': view({ read: { score: 80 } }) }, 'OVERLORD');
        expect(out.items[0].contract).toEqual(UNDER_7);
    });

    it('NO DILUTION (property): never adds, changes or duplicates a candidate, and COMBINED is a subset of OVERLORD', () => {
        let seed = 7;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
        const tiers: OverlordTier[] = ['STRONG', 'BEST', 'CAUTION', 'LEGACY'];
        for (let trial = 0; trial < 200; trial += 1) {
            const items: Cand[] = [];
            const views: Record<string, OverlordView | null> = {};
            for (let m = 0; m < 8; m += 1) {
                for (const c of [OVER_2, UNDER_7]) {
                    if (rnd() < 0.8) items.push(cand(`M${m}`, c, rnd() - 0.4));
                    const tier = tiers[Math.floor(rnd() * 4)];
                    views[`M${m}:${c.side}:${c.param}`] =
                        rnd() < 0.1
                            ? null
                            : view({ read: { tier, score: Math.round(rnd() * 100), vetoed: tier === 'CAUTION', thin: tier === 'LEGACY' }, rounds: Math.floor(rnd() * 7), clearShare: rnd() });
                }
            }
            const standard = run(items, views, 'STANDARD').items;
            const over = run(items, views, 'OVERLORD');
            const both = run(items, views, 'COMBINED');
            for (const out of [over, both]) {
                expect(out.items.every(i => items.includes(i))).toBe(true); // only what the picker offered, untouched
                expect(new Set(out.items).size).toBe(out.items.length);
                expect(out.items.length + out.blocked.length).toBe(items.length); // every candidate is kept or accounted for
            }
            expect(both.items.every(i => over.items.includes(i))).toBe(true);
            expect(over.items.every(i => standard.includes(i))).toBe(true);
        }
    });

    it('annotate can describe the choice without changing what is traded', () => {
        const out = selectByOverlord([cand('A', OVER_2)], {
            mode: 'OVERLORD',
            contractOf: c => c.contract,
            viewOf: () => view({ read: { tier: 'BEST', score: 61 } }),
            hasEdge: () => true,
            annotate: (c, v) => ({ ...c, label: `${c.label} · Overlord ${v.read.tier} ${v.read.score}` }),
        });
        expect(out.items[0].label).toBe('OVER 2 · Overlord BEST 61');
        expect(out.items[0].contract).toEqual(OVER_2);
    });
});

describe('selectByOverlord with the least-bad fallback (OVERLORD always names a market)', () => {
    const fb = (items: Cand[], views: Record<string, OverlordView | null>, mode: SelectionMode, fallback = 3) =>
        selectByOverlord(items, {
            mode,
            contractOf: c => c.contract,
            viewOf: (m, c) => views[`${m}:${c.side}:${c.param}`] ?? null,
            hasEdge: c => c.score > 0,
            fallback,
            annotate: (c, _v, leastBad) => (leastBad ? { ...c, label: `${c.label} (least-bad)` } : c),
        });

    it('when nothing clears, returns the least-bad few by tier then score, labelled, with why each did not clear', () => {
        const items = [cand('A', OVER_2), cand('B', OVER_2), cand('C', OVER_2), cand('D', OVER_2), cand('N', OVER_2)];
        const out = fb(
            items,
            {
                'A:OVER:2': view({ read: { tier: 'CAUTION', vetoed: true, score: 30, vetoReason: 'a' } }),
                'B:OVER:2': view({ read: { tier: 'CAUTION', vetoed: true, score: 55, vetoReason: 'b' } }),
                'C:OVER:2': view({ read: { tier: 'BEST', score: 40 }, rounds: 1 }), // still watching: not CAUTION, outranks it
                'D:OVER:2': view({ read: { tier: 'CAUTION', vetoed: true, score: 10, vetoReason: 'd' } }),
            },
            'OVERLORD'
        );
        expect(out.leastBad).toBe(true);
        expect(out.items.map(i => i.market)).toEqual(['C', 'B', 'A']);
        expect(out.items.every(i => i.label.endsWith('(least-bad)'))).toBe(true);
        expect(out.caution.map(c => c.reason)).toEqual(['watching', 'veto', 'veto']);
        expect(out.blocked.map(b => b.market).sort()).toEqual(['D', 'N']); // the rest, and the one with no reading at all
    });

    it('a contract with no reading is never nominated, even as a last resort', () => {
        const out = fb([cand('N', OVER_2)], {}, 'OVERLORD');
        expect(out.items).toEqual([]);
        expect(out.leastBad).toBe(false);
        expect(out.blocked[0].reason).toBe('no-read');
    });

    it('a contract that clears always beats a least-bad one, and the least-bad ones are then left out', () => {
        const items = [cand('A', OVER_2), cand('B', OVER_2)];
        const out = fb(items, { 'A:OVER:2': view({ read: { tier: 'CAUTION', vetoed: true, score: 99 } }), 'B:OVER:2': view({ read: { tier: 'BEST', score: 20 } }) }, 'OVERLORD');
        expect(out.leastBad).toBe(false);
        expect(out.items.map(i => i.market)).toEqual(['B']);
        expect(out.blocked.map(b => b.market)).toEqual(['A']);
    });

    it('COMBINED has no fallback: nothing clears, nothing is returned', () => {
        const items = [cand('A', OVER_2)];
        const out = fb(items, { 'A:OVER:2': view({ read: { tier: 'CAUTION', vetoed: true } }) }, 'COMBINED', 0);
        expect(out.items).toEqual([]);
        expect(out.leastBad).toBe(false);
    });

    it('NO DILUTION (property): the fallback only ever returns what the picker offered, at most `fallback` of them', () => {
        let seed = 3;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
        const tiers: OverlordTier[] = ['STRONG', 'BEST', 'CAUTION', 'LEGACY'];
        for (let trial = 0; trial < 200; trial += 1) {
            const items: Cand[] = [];
            const views: Record<string, OverlordView | null> = {};
            for (let m = 0; m < 6; m += 1)
                for (const c of [OVER_2, UNDER_7]) {
                    if (rnd() < 0.8) items.push(cand(`M${m}`, c, rnd() - 0.4));
                    const tier = tiers[Math.floor(rnd() * 4)];
                    views[`M${m}:${c.side}:${c.param}`] = rnd() < 0.15 ? null : view({ read: { tier, vetoed: tier === 'CAUTION', thin: tier === 'LEGACY', score: Math.round(rnd() * 100) }, rounds: Math.floor(rnd() * 7), clearShare: rnd() });
                }
            const out = fb(items, views, 'OVERLORD');
            expect(out.items.length).toBeLessThanOrEqual(Math.max(3, items.length));
            if (out.leastBad) expect(out.items.length).toBeLessThanOrEqual(3);
            for (const i of out.items) expect(items.some(o => o.market === i.market && o.contract === i.contract)).toBe(true);
            expect(out.items.length + out.blocked.length).toBe(items.length); // kept or accounted for
            // OVERLORD with no readings at all stays empty; with any reading it names something.
            const anyRead = items.some(i => views[`${i.market}:${i.contract.side}:${i.contract.param}`]);
            expect(out.items.length > 0).toBe(anyRead);
        }
    });
});

describe('normalizeSelection', () => {
    it('keeps a config saved before this existed on STANDARD', () => {
        expect(normalizeSelection(undefined)).toBe('STANDARD');
        expect(normalizeSelection('nonsense')).toBe('STANDARD');
        expect(normalizeSelection('OVERLORD')).toBe('OVERLORD');
        expect(normalizeSelection('COMBINED')).toBe('COMBINED');
    });
});

// A random-walk market with quotes, so the real engines have something to read.
const market = (n: number, seed: number) => {
    let a = seed;
    let price = 1000;
    const prices: number[] = [];
    const digits: number[] = [];
    for (let i = 0; i < n; i += 1) {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        price = Math.round((price + ((a >> 8) % 200) / 100 - 0.995) * 100) / 100;
        prices.push(price);
        digits.push(Math.round(price * 100) % 10);
    }
    return { prices, digits };
};

describe('createOverlordReader', () => {
    const fakeAssess = (vetoed = false) =>
        ((symbol: string, _s: unknown, side: string, barrier: number) =>
            read({ symbol, side, barrier, vetoed, tier: vetoed ? 'CAUTION' : 'STRONG', score: 50 } as Partial<OverlordRead>)) as never;
    const long = (n = 300) => Array.from({ length: n }, (_, i) => i % 10);
    const quotes = (n = 300) => Array.from({ length: n }, (_, i) => 100 + i);

    it('reads at most `batch` markets per call, oldest first, and builds steadiness over rounds', () => {
        const series = { A: long(), B: long(), C: long() };
        const prices = { A: quotes(), B: quotes(), C: quotes() };
        const r = createOverlordReader({ series: () => series, prices: () => prices, assess: fakeAssess(), build: () => null, batch: 2, everyMs: 1000 });
        expect(r.refresh(0)).toBe(2);
        expect(r.get('A', OVER_2, 0)?.rounds).toBe(1);
        expect(r.get('C', OVER_2, 0)).toBeNull();
        expect(r.refresh(10)).toBe(1); // C is the only one never read; A and B are not due yet
        expect(r.refresh(1000)).toBe(2);
        expect(r.refresh(2000)).toBe(2);
        expect(r.get('A', OVER_2, 2000)?.rounds).toBeGreaterThanOrEqual(MIN_ROUNDS - 1);
        expect(DEFAULT_READ_CONTRACTS.map(c => `${c.side}${c.param}`)).toEqual(['OVER2', 'UNDER7', 'OVER3', 'UNDER6']);
    });

    it('priority only breaks ties: never-read markets come before any re-read, so no market is starved', () => {
        const series = { A: long(), B: long(), C: long() };
        const prices = { A: quotes(), B: quotes(), C: quotes() };
        const r = createOverlordReader({ series: () => series, prices: () => prices, assess: fakeAssess(), build: () => null, batch: 1, everyMs: 1 });
        r.refresh(0, ['C']); // all three never read: the priority one goes first
        expect(r.get('C', OVER_2, 0)).not.toBeNull();
        expect(r.get('A', OVER_2, 0)).toBeNull();
        r.refresh(5, ['C']); // C is now the newest reading: A and B (never read) go before C is read again
        expect(r.get('C', OVER_2, 5)?.rounds).toBe(1);
        expect(r.get('A', OVER_2, 5)).not.toBeNull();
        r.refresh(10, ['C']);
        expect(r.get('B', OVER_2, 10)).not.toBeNull();
    });

    it('REGRESSION: with many busy markets and one read per call, every market still gets a fresh reading before any expires', () => {
        // 15 markets, 8 of them "in play" the whole time, one read per call every 2 s, readings valid for the default max age.
        const names = Array.from({ length: 15 }, (_, i) => `M${i}`);
        const series = Object.fromEntries(names.map(n => [n, long()]));
        const prices = Object.fromEntries(names.map(n => [n, quotes()]));
        const r = createOverlordReader({ series: () => series, prices: () => prices, assess: fakeAssess(), build: () => null, batch: 1, everyMs: 4000 });
        const busy = names.slice(0, 8);
        let t = 0;
        for (let i = 0; i < 60; i += 1) {
            r.refresh(t, busy);
            t += 2000;
        }
        for (const n of names) expect(r.get(n, OVER_2, t)).not.toBeNull(); // 2 minutes in: nothing is missing
        expect(r.status(t).markets).toBe(15);
    });

    it('spends a time budget per call (at least one market) so a slow engine cannot stall the page', () => {
        let clock = 0;
        const series = { A: long(), B: long(), C: long(), D: long() };
        const prices = { A: quotes(), B: quotes(), C: quotes(), D: quotes() };
        const slow = ((symbol: string, _s: unknown, side: string, barrier: number) => {
            clock += 120; // each contract read costs 120 ms: 4 contracts per market = 480 ms
            return read({ symbol, side, barrier, tier: 'STRONG', score: 50 } as Partial<OverlordRead>);
        }) as never;
        const r = createOverlordReader({ series: () => series, prices: () => prices, assess: slow, build: () => null, clock: () => clock, budgetMs: 250, everyMs: 1 });
        expect(r.refresh(0)).toBe(1); // one market already costs more than the budget
        const fast = createOverlordReader({ series: () => series, prices: () => prices, assess: fakeAssess(), build: () => null, clock: () => 0, budgetMs: 250, everyMs: 1 });
        expect(fast.refresh(0)).toBe(4); // free reads: everything fits, capped by batch (6)
    });

    it('keeps only the latest rounds and measures how often the contract was clear', () => {
        let veto = false;
        const series = { A: long() };
        const prices = { A: quotes() };
        const r = createOverlordReader({
            series: () => series,
            prices: () => prices,
            assess: ((...args: unknown[]) => (fakeAssess(veto) as (...a: unknown[]) => OverlordRead)(...args)) as never,
            build: () => null,
            everyMs: 1,
        });
        for (let t = 0; t < ROUND_WINDOW + 4; t += 1) {
            veto = t % 2 === 1;
            r.refresh(t * 10);
        }
        const v = r.get('A', OVER_2, 1000)!;
        expect(v.rounds).toBe(ROUND_WINDOW);
        expect(v.clearShare).toBeCloseTo(0.5, 5);
    });

    it('does not read a market whose quotes do not line up with its digits, or that is too short', () => {
        const r = createOverlordReader({
            series: () => ({ A: long(300), B: long(300), C: long(50) }),
            prices: () => ({ A: quotes(299), C: quotes(50) }),
            assess: fakeAssess(),
            build: () => null,
        });
        expect(r.refresh(0)).toBe(0);
        expect(r.get('A', OVER_2, 0)).toBeNull();
    });

    it('treats an old reading as missing, a failing engine as missing, and reset as a new start', () => {
        const ok = createOverlordReader({ series: () => ({ A: long() }), prices: () => ({ A: quotes() }), assess: fakeAssess(), build: () => null, maxAgeMs: 100 });
        ok.refresh(0);
        expect(ok.get('A', OVER_2, 50)).not.toBeNull();
        expect(ok.get('A', OVER_2, 101)).toBeNull();
        expect(ok.status(50)).toEqual({ markets: 1, newestAt: 0 });
        ok.reset();
        expect(ok.get('A', OVER_2, 50)).toBeNull();
        const bad = createOverlordReader({
            series: () => ({ A: long() }),
            prices: () => ({ A: quotes() }),
            assess: (() => {
                throw new Error('boom');
            }) as never,
            build: () => null,
        });
        expect(() => bad.refresh(0)).not.toThrow();
        expect(bad.get('A', OVER_2, 0)).toBeNull();
    });

    it('works with the real Overlord engines on a market with quotes', () => {
        const a = market(600, 3);
        const r = createOverlordReader({ series: () => ({ A: a.digits }), prices: () => ({ A: a.prices }), everyMs: 1 });
        r.refresh(0);
        r.refresh(5);
        r.refresh(10);
        for (const c of DEFAULT_READ_CONTRACTS) {
            const v = r.get('A', c, 10);
            expect(v).not.toBeNull();
            expect(v!.read.thin).toBe(false);
            expect(v!.read.layers.some(l => l.engine === 'Apex Sentinel')).toBe(true);
            expect(v!.rounds).toBe(3);
        }
    });
});
