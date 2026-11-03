import { mulberry32 } from '../../sixfold/stats';
import type { Pick } from '../../ai-intel/picker';
import { createApexGates, pickToRow, rowsOf, scoreOfPick, tierOfPick } from '../apex-gates';

const fair = (seed: number, n = 700): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};
/** Under 7 wins on 0-6: a series winning at `p`. */
const winning = (p: number, seed: number, n = 700): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => (rnd() < p ? Math.floor(rnd() * 7) : 7 + Math.floor(rnd() * 3)));
};
const pick = (market: string, direction: 'OVER_2' | 'UNDER_7', extra: Partial<Pick> = {}): Pick => ({
    key: `${market}|${direction}`,
    market,
    direction,
    entry: 'SETUP',
    customDigits: [],
    rule: null,
    strategyId: null,
    label: direction,
    score: 0.05,
    trades: 100,
    rate: 0.75,
    significant: false,
    q: null,
    regime: 'STABLE',
    reason: 't',
    ...extra,
});
const UNDER_7 = { side: 'UNDER', param: 7 } as const;
const OVER_2 = { side: 'OVER', param: 2 } as const;

const make = (series: Record<string, number[]>, edge: Record<string, unknown> = {}, now = () => 0) => {
    const g = createApexGates({
        series: () => series,
        settingsKey: 'apex.test.settings',
        ledgerKey: 'apex.test.ledger',
        handle: 'apexTestEdge',
        now,
    });
    g.controls.set({
        kalman: false,
        danger: false,
        frequency: false,
        arbiter: false,
        cooldownMs: 0,
        minHoldScans: 0,
        hourlyBudget: 0,
        shadow: false,
        ...edge,
    });
    return g;
};

describe('Apex Intel edge gates: board rows', () => {
    it('maps picks to rows: strong when proven, steady above chance, watch otherwise', () => {
        expect(tierOfPick(pick('A', 'OVER_2', { significant: true }))).toBe('strong');
        expect(tierOfPick(pick('A', 'OVER_2', { score: 0.01 }))).toBe('steady');
        expect(tierOfPick(pick('A', 'OVER_2', { score: -0.02 }))).toBe('watch');
        expect(scoreOfPick(0)).toBe(50);
        expect(scoreOfPick(1)).toBe(100);
        expect(scoreOfPick(-1)).toBe(0);
        expect(pickToRow(pick('A', 'UNDER_7')).contract).toBe('DIGITUNDER');
    });
    it('keeps one row per market and contract, the best-ranked first', () => {
        const rows = rowsOf([
            pick('A', 'OVER_2', { score: 0.09 }),
            pick('A', 'OVER_2', { score: 0.01, entry: 'ANY' }),
            pick('A', 'UNDER_7'),
        ]);
        expect(rows).toHaveLength(2);
        expect(rows.find(r => r.barrier === 2)?.score).toBe(scoreOfPick(0.09));
    });
});

describe('Apex Intel edge gates: signals', () => {
    it('with every gate off a signal passes untouched', () => {
        const g = make({ A: fair(1) });
        g.onBoard([pick('A', 'UNDER_7')], [], 0);
        expect(g.review({ market: 'A', contract: UNDER_7, recovery: false }).allow).toBe(true);
    });

    it('Kalman stands down a signal whose win rate is not above fair', () => {
        const series = { A: winning(0.6, 3) }; // Under 7 fair is 70%: 60% is below it
        const g = make(series, { kalman: true });
        g.onBoard([pick('A', 'UNDER_7')], [], 0);
        const v = g.review({ market: 'A', contract: UNDER_7, recovery: false });
        expect(v.allow).toBe(false);
        expect(v.reason).toMatch(/^edge gates:/);
    });

    it('recovery signals skip the level rule and are not held by cooldown or budget', () => {
        const series = { A: winning(0.6, 3) };
        const g = make(series, { kalman: true, frequency: true, cooldownMs: 60_000, minHoldScans: 5, hourlyBudget: 1 });
        g.onBoard([], [], 0);
        g.onBought({ contractId: 1, market: 'A', contract: UNDER_7, recovery: false, stake: 1 });
        expect(g.review({ market: 'A', contract: { side: 'UNDER', param: 6 }, recovery: true }).allow).toBe(true);
    });

    it('cooldown holds the next main signal on the market just traded', () => {
        let t = 0;
        const g = make({ A: fair(1) }, { frequency: true, cooldownMs: 20_000 }, () => t);
        g.onBoard([pick('A', 'UNDER_7')], [], 0);
        g.onBought({ contractId: 1, market: 'A', contract: UNDER_7, recovery: false, stake: 1 });
        t = 5_000;
        const v = g.review({ market: 'A', contract: UNDER_7, recovery: false });
        expect(v.allow).toBe(false);
        t = 25_000;
        g.onBoard([pick('A', 'UNDER_7')], [], t);
        expect(g.review({ market: 'A', contract: UNDER_7, recovery: false }).allow).toBe(true);
    });

    it('arbiter abstains where Over and Under are about equally strong, and stands down the weaker', () => {
        const g = make({ A: fair(1), B: fair(2) }, { arbiter: true });
        g.onBoard(
            [
                pick('A', 'OVER_2', { score: 0.05 }),
                pick('A', 'UNDER_7', { score: 0.05 }),
                pick('B', 'OVER_2', { score: 0.08 }),
                pick('B', 'UNDER_7', { score: 0.01 }),
            ],
            [],
            0
        );
        expect(g.review({ market: 'A', contract: OVER_2, recovery: false }).allow).toBe(false);
        expect(g.review({ market: 'A', contract: UNDER_7, recovery: false }).allow).toBe(false);
        expect(g.review({ market: 'B', contract: OVER_2, recovery: false }).allow).toBe(true);
        expect(g.review({ market: 'B', contract: UNDER_7, recovery: false }).allow).toBe(false);
    });

    it('shadow mode records what the gates would stop but lets everything through', () => {
        const g = make({ A: winning(0.6, 3) }, { kalman: true, shadow: true });
        g.onBoard([pick('A', 'UNDER_7')], [], 0);
        expect(g.review({ market: 'A', contract: UNDER_7, recovery: false }).allow).toBe(true);
        expect(g.controls.report().gates.kalman.vetoed).toBeGreaterThan(0);
    });

    it('trade notices feed the evidence ledger', () => {
        const g = make({ A: fair(1) });
        g.onSettled({ contractId: 1, market: 'A', contract: UNDER_7, recovery: false, stake: 1, profit: 0.4 });
        g.onSettled({ contractId: 2, market: 'A', contract: UNDER_7, recovery: false, stake: 1, profit: null });
        expect(g.controls.report().real.live.settled).toBe(1);
        expect(g.controls.report().real.live.wins).toBe(1);
    });

    it('a failure inside the gates lets the signal through (the AI guard has already passed it)', () => {
        const g = createApexGates({
            series: () => {
                throw new Error('boom');
            },
            settingsKey: 'apex.test.settings2',
            ledgerKey: 'apex.test.ledger2',
            handle: 'apexTestEdge2',
        });
        expect(g.review({ market: 'A', contract: UNDER_7, recovery: false }).allow).toBe(true);
    });
});
