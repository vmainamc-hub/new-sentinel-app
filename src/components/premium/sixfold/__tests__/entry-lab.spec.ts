import { chanceOfLossRun, compareEntryRules, compareRecoveryGates, twoProportionP, walkForward } from '../entry-lab';
import { mulberry32 } from '../stats';

const over3 = { side: 'OVER' as const, param: 3 };

const randomDigits = (n: number, seed: number) => {
    const rand = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(rand() * 10));
};

describe('walkForward', () => {
    it('trades one contract at a time and never reuses the exit tick as an entry', () => {
        const trades = walkForward(randomDigits(3000, 1), over3, 'ANY', { duration: 2, warmup: 10 });
        for (let i = 1; i < trades.length; i++) {
            expect(trades[i].entryIndex).toBeGreaterThan(trades[i - 1].entryIndex + 2);
        }
    });

    it('marks a trade as recovering only when the trade before it lost', () => {
        const trades = walkForward(randomDigits(5000, 2), over3, 'ANY', { warmup: 10 });
        expect(trades[0].recovering).toBe(false);
        for (let i = 1; i < trades.length; i++) expect(trades[i].recovering).toBe(!trades[i - 1].won);
    });

    it('only sees ticks up to the arming tick: changing the future never changes a decision already made', () => {
        const base = randomDigits(4000, 3);
        const changed = base.slice();
        for (let i = 3000; i < changed.length; i++) changed[i] = (changed[i] + 5) % 10;
        const a = walkForward(base, over3, 'SMART', { warmup: 600 });
        const b = walkForward(changed, over3, 'SMART', { warmup: 600 });
        const early = (ts: typeof a) => ts.filter(t => t.entryIndex < 2990).map(t => [t.entryIndex, t.entryDigit]);
        expect(early(a)).toEqual(early(b));
    });
});

describe('compareEntryRules on random digits', () => {
    it('finds no difference from buying immediately', () => {
        const out = compareEntryRules(randomDigits(40000, 12345), over3);
        for (const r of out) expect(['NO_DIFFERENCE', 'LEANS_BETTER', 'WORSE']).toContain(r.verdict);
        // A fair stream never lets Over 3 beat its payout break-even by any rule.
        for (const r of out) expect(r.verdict).not.toBe('BETTER');
    });

    it('says TOO_FEW when the history is short', () => {
        const out = compareEntryRules(randomDigits(540, 4), over3);
        for (const r of out) expect(r.verdict).toBe('TOO_FEW');
    });
});

describe('compareEntryRules when the market really has a bias', () => {
    it('lets SMART separate from chance once a digit reliably precedes a win', () => {
        const rand = mulberry32(99);
        const biased: number[] = [];
        for (let i = 0; i < 60000; i++) {
            const prev = biased[i - 1];
            biased.push(prev === 4 && rand() < 0.8 ? 4 + Math.floor(rand() * 6) : Math.floor(rand() * 10));
        }
        const smart = compareEntryRules(biased, over3).find(r => r.rule === 'SMART');
        expect(smart?.verdict).toBe('BETTER');
        expect(smart?.stats.rate ?? 0).toBeGreaterThan(smart?.control.rate ?? 1);
    });
});

describe('compareRecoveryGates', () => {
    it('reports every gate and compares only recovery trades', () => {
        const out = compareRecoveryGates(randomDigits(40000, 7), over3, 3);
        expect(out.map(r => r.rule)).toEqual(['GATE:MOMENTUM', 'GATE:REVERSION', 'GATE:BOUNCE']);
        for (const r of out) expect(r.verdict).not.toBe('BETTER');
    });
});

describe('helpers', () => {
    it('twoProportionP is near 0.5 for equal rates and small for a clear gap', () => {
        expect(twoProportionP(60, 100, 60, 100)).toBeCloseTo(0.5, 1);
        expect(twoProportionP(800, 1000, 600, 1000) ?? 1).toBeLessThan(0.001);
    });

    it('chanceOfLossRun grows with the number of trades', () => {
        const short = chanceOfLossRun(64, 6, 0.4);
        const long = chanceOfLossRun(500, 6, 0.4);
        expect(short).toBeGreaterThan(0.05);
        expect(short).toBeLessThan(0.3);
        expect(long).toBeGreaterThan(short);
        expect(chanceOfLossRun(3, 6, 0.4)).toBe(0);
    });
});