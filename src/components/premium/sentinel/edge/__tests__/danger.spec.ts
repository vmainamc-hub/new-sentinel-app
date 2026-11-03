import { mulberry32 } from '../../../sixfold/stats';
import { assessCrossMarketDanger, BLOCK_SCORE, DEFAULT_FREQUENCY, FrequencyGate, MIN_MARKETS } from '../danger';

const CONTRACTS = [
    { side: 'OVER', param: 2 },
    { side: 'UNDER', param: 7 },
] as const;
const SYMBOLS = Array.from({ length: 12 }, (_, i) => `M${i}`);

const fairBook = (seed: number, n = 200): Record<string, number[]> => {
    const rnd = mulberry32(seed);
    return Object.fromEntries(SYMBOLS.map(s => [s, Array.from({ length: n }, () => Math.floor(rnd() * 10))]));
};
/** Every market drawn from the same skewed distribution: digits >= 5 with probability `pHigh`. */
const skewedBook = (seed: number, pHigh: number, n = 200): Record<string, number[]> => {
    const rnd = mulberry32(seed);
    return Object.fromEntries(
        SYMBOLS.map(s => [
            s,
            Array.from({ length: n }, () => (rnd() < pHigh ? 5 + Math.floor(rnd() * 5) : Math.floor(rnd() * 5))),
        ])
    );
};

describe('assessCrossMarketDanger', () => {
    it('is calm with too few markets, saying why', () => {
        const d = assessCrossMarketDanger(fairBook(1), SYMBOLS.slice(0, MIN_MARKETS - 1), CONTRACTS);
        expect(d.level).toBe('calm');
        expect(d.block).toBe(false);
        expect(d.reasons[0]).toMatch(/markets readable/);
    });
    it('is calm when there are no contracts to judge', () => {
        expect(assessCrossMarketDanger(fairBook(1), SYMBOLS, []).block).toBe(false);
    });
    it('does not block independent fair markets: across 400 random books it never reaches the blocking score', () => {
        let blocked = 0;
        let elevated = 0;
        for (let seed = 1; seed <= 400; seed += 1) {
            const d = assessCrossMarketDanger(fairBook(seed), SYMBOLS, CONTRACTS);
            if (d.block) blocked += 1;
            if (d.level !== 'calm') elevated += 1;
        }
        expect(blocked).toBe(0);
        expect(elevated / 400).toBeLessThan(0.1);
    });
    it('blocks when every market is pushed the same way at once', () => {
        const d = assessCrossMarketDanger(skewedBook(5, 0.9), SYMBOLS, CONTRACTS);
        expect(d.components.commonFactor).toBeGreaterThan(60);
        expect(d.score).toBeGreaterThanOrEqual(BLOCK_SCORE - 20);
        expect(d.reasons.join(' ')).toMatch(/together/);
    });
    it('blocks a combined event: markets skewed together and cold on the contract Sentinel trades', () => {
        const d = assessCrossMarketDanger(skewedBook(5, 0.9), SYMBOLS, [{ side: 'UNDER', param: 7 }]);
        expect(d.block).toBe(true);
        expect(['high', 'extreme']).toContain(d.level);
    });
    it('reads a cold cascade: every market losing both contracts over the last 30 ticks', () => {
        const book = fairBook(9);
        for (const s of SYMBOLS)
            book[s] = [...book[s].slice(0, 170), ...Array.from({ length: 30 }, (_, i) => (i % 2 ? 2 : 9))];
        const d = assessCrossMarketDanger(book, SYMBOLS, CONTRACTS);
        expect(d.components.coldSpike).toBeGreaterThan(80);
    });
    it('never mutates its input', () => {
        const book = fairBook(3);
        const copy = JSON.stringify(book);
        assessCrossMarketDanger(book, SYMBOLS, CONTRACTS);
        expect(JSON.stringify(book)).toBe(copy);
    });
});

describe('FrequencyGate', () => {
    const cfg = { cooldownMs: 20_000, minHoldScans: 2, hourlyBudget: 3 };
    const fresh = { recovering: false, budget: true };

    it('makes a signal wait until it has held for the required scans, and forgets one that leaves the board', () => {
        const g = new FrequencyGate();
        g.observe(['A|x']);
        expect(g.check('A', 'A|x', 0, cfg, fresh)).toMatchObject({ allow: false });
        g.observe(['A|x']);
        expect(g.check('A', 'A|x', 0, cfg, fresh).allow).toBe(true);
        g.observe([]);
        g.observe(['A|x']);
        expect(g.held('A|x')).toBe(1);
        expect(g.check('A', 'A|x', 0, cfg, fresh).allow).toBe(false);
    });
    it('rests a market after a trade, then lets it back', () => {
        const g = new FrequencyGate();
        g.observe(['A|x']);
        g.observe(['A|x']);
        g.record('A', 1000);
        expect(g.check('A', 'A|x', 5000, cfg, fresh).reason).toMatch(/rests 16s/);
        expect(g.check('A', 'A|x', 21_001, cfg, fresh).allow).toBe(true);
        expect(g.check('B', 'B|x', 5000, { ...cfg, minHoldScans: 0 }, fresh).allow).toBe(true);
    });
    it('enforces the hourly budget over a rolling hour, except where told not to', () => {
        const g = new FrequencyGate();
        const open = { ...cfg, cooldownMs: 0, minHoldScans: 0 };
        for (const t of [0, 1000, 2000]) g.record(`S${t}`, t);
        expect(g.check('Z', 'Z|x', 3000, open, fresh).reason).toMatch(/hourly budget/);
        expect(g.check('Z', 'Z|x', 3000, open, { recovering: false, budget: false }).allow).toBe(true);
        expect(g.check('Z', 'Z|x', 3_600_000 + 2500, open, fresh).allow).toBe(true);
    });
    it('never delays a recovery trade', () => {
        const g = new FrequencyGate();
        g.record('A', 0);
        expect(g.check('A', 'A|x', 1, cfg, { recovering: true, budget: true }).allow).toBe(true);
    });
    it('treats 0 as off for every rule', () => {
        const g = new FrequencyGate();
        g.record('A', 0);
        expect(g.check('A', 'A|x', 1, { cooldownMs: 0, minHoldScans: 0, hourlyBudget: 0 }, fresh).allow).toBe(true);
        expect(DEFAULT_FREQUENCY.cooldownMs).toBeGreaterThan(0);
    });
});
