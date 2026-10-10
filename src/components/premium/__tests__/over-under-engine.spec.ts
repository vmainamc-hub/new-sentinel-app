import { lastDigit as engineLastDigit } from '@/lib/analytics';
import { computeCombinedVerdict } from '@/lib/fusion/verdict';
import { PROPOSITIONS } from '@/lib/propositions';
import {
    ACTION_RANK, ALLOWED_BARRIERS, BULK_MARKETS, LEGACY_QUALITY, OverUnderEngine, RECOMMENDATION_TTL_MS, SIGNAL_QUALITY, SignalStability, assertAllowedContract,
    buildEngineTicks, compareCandidates, contractFor, digitPercents, digitsFromPrices, engineTick, hitRate, inferDecimals,
    isAllowedContract, lastDigit, passesQuality, propositionFor, recommend, refreshLocked, validateRecommendation, watching,
    type CombinedVerdict, type Proposition, type VerdictAction,
} from '../over-under-engine';
import { propositionSpec } from '@/lib/propositions';

// Deterministic PRNG so the tests never flake.
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

const ticksWithWeights = (weights: number[], n = 1000, decimals = 2, seed = 11) => {
    const rand = rng(seed);
    const cum: number[] = [];
    weights.reduce((acc, w, i) => { cum[i] = acc + w; return acc + w; }, 0);
    const prices: number[] = [];
    for (let i = 0; i < n; i += 1) {
        const r = rand() * cum[9];
        const digit = cum.findIndex(c => r < c);
        const base = 1000 + Math.floor(rand() * 500) / 10 ** (decimals - 1);
        prices.push(Number((base + digit / 10 ** decimals).toFixed(decimals)));
    }
    return prices;
};

type Item = { proposition: Proposition; action: VerdictAction; score: number; danger?: number; independence?: number; confirmed?: boolean; ripe?: boolean };
const fakeVerdict = (market: string, items: Item[], opts: { ready?: boolean; generatedAt?: number } = {}): CombinedVerdict => ({
    market, sample: 1000, generatedAt: opts.generatedAt ?? 1_000_000, ready: opts.ready ?? true, analysis: null, digitFrequency: [],
    headline: '', best: null,
    verdicts: items.map(i => ({
        proposition: i.proposition, spec: propositionSpec(i.proposition), action: i.action, score: i.score, danger: i.danger ?? 20,
        independence: i.independence ?? 60, lifecycle: null, fusion: {} as never, reasons: [`reason for ${i.proposition}`], vetoes: [], invalidations: [],
        digitpulse: { confirmed: i.confirmed ?? false, ripe: i.ripe ?? false } as never,
    })),
});

describe('contract allowlist', () => {
    it('allows exactly Over 1/2/3 and Under 8/7/6', () => {
        for (const b of [1, 2, 3]) expect(isAllowedContract('DIGITOVER', b)).toBe(true);
        for (const b of [6, 7, 8]) expect(isAllowedContract('DIGITUNDER', b)).toBe(true);
        expect(isAllowedContract('DIGITOVER', '2')).toBe(true);
    });
    it('rejects every other barrier and every other contract type', () => {
        for (const b of [0, 4, 5, 6, 7, 8, 9, 10, -1, 2.5, NaN, null, undefined, '', 'x']) expect(isAllowedContract('DIGITOVER', b)).toBe(false);
        for (const b of [0, 1, 2, 3, 4, 5, 9, 10, 7.5, null, undefined]) expect(isAllowedContract('DIGITUNDER', b)).toBe(false);
        for (const c of ['DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', '', undefined]) expect(isAllowedContract(c, 2)).toBe(false);
    });
    it('assertAllowedContract throws a readable error for forbidden contracts', () => {
        expect(() => assertAllowedContract('DIGITOVER', 5)).toThrow();
        expect(() => assertAllowedContract('DIGITUNDER', 9)).toThrow();
        expect(() => assertAllowedContract('DIGITOVER', 0)).toThrow();
        expect(() => assertAllowedContract('DIGITDIFF', 3)).toThrow();
        expect(() => assertAllowedContract('DIGITUNDER', 7)).not.toThrow();
    });
    it('matches the engine\'s own proposition universe', () => {
        const fromAllowlist = [
            ...ALLOWED_BARRIERS.DIGITOVER.map(b => propositionFor('DIGITOVER', b)),
            ...ALLOWED_BARRIERS.DIGITUNDER.map(b => propositionFor('DIGITUNDER', b)),
        ];
        expect([...fromAllowlist].sort()).toEqual([...PROPOSITIONS].sort());
        for (const p of PROPOSITIONS) {
            const { contract, barrier } = contractFor(p);
            expect(propositionFor(contract, barrier)).toBe(p);
        }
        expect(propositionFor('DIGITOVER', 5)).toBeNull();
    });
});

describe('tick feed precision', () => {
    it('infers decimals from the ticks themselves', () => {
        expect(inferDecimals(ticksWithWeights([1,1,1,1,1,1,1,1,1,1], 200, 3), 2)).toBe(3);
        expect(inferDecimals(ticksWithWeights([1,1,1,1,1,1,1,1,1,1], 200, 4), 2)).toBe(4);
        expect(inferDecimals([1.5, 2.25], 4)).toBe(4);
    });
    it('rescales quotes so the engine\'s 2-decimal lastDigit returns the TRUE digit at 1-4 decimals', () => {
        const rand = rng(3);
        for (const decimals of [1, 2, 3, 4]) {
            for (let i = 0; i < 400; i += 1) {
                const price = Number((100 + rand() * 900).toFixed(decimals));
                expect(engineLastDigit(engineTick(price, 0, decimals).price)).toBe(lastDigit(price, decimals));
            }
        }
    });
    it('the vendored engine reports the true digit distribution for 3- and 4-decimal markets', () => {
        for (const decimals of [3, 4]) {
            const prices = ticksWithWeights([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 1000, decimals, 5);
            const truth = digitPercents(digitsFromPrices(prices, decimals), 1000);
            const verdict = computeCombinedVerdict('R_50', buildEngineTicks(prices, [], decimals));
            verdict.digitFrequency.forEach((pct, digit) => expect(Math.abs(pct - truth[digit])).toBeLessThan(0.06));
        }
    });
    it('computes digit percentages and contract hit rates', () => {
        const pct = new Array(10).fill(10);
        expect(hitRate(pct, 'DIGITOVER', 2)).toBe(70);
        expect(hitRate(pct, 'DIGITUNDER', 7)).toBe(70);
        expect(digitPercents([1, 1, 2, 3], 4)).toEqual([0, 50, 25, 25, 0, 0, 0, 0, 0, 0]);
    });
});

describe('the vendored engine, run through the adapter', () => {
    it('returns exactly six verdicts for the six canonical propositions and stands down on random ticks', () => {
        const engine = new OverUnderEngine();
        const verdict = engine.analyse('R_100', buildEngineTicks(ticksWithWeights([1,1,1,1,1,1,1,1,1,1]), [], 2));
        expect(verdict.ready).toBe(true);
        expect(verdict.verdicts.map(v => v.proposition).sort()).toEqual([...PROPOSITIONS].sort());
        expect(verdict.verdicts.every(v => v.action === 'STAND_DOWN')).toBe(true);
        expect(recommend({ R_100: verdict }, 1_000_000)).toBeNull();
    });
    it('recommends an allowed contract when the engine finds a setup, and carries v3 state between scans', () => {
        const engine = new OverUnderEngine();
        const ticks = buildEngineTicks(ticksWithWeights([1,1,1,1,1,1,1,.6,.35,.35], 1000, 2, 10), [], 2);
        engine.analyse('R_100', ticks);
        const verdict = engine.analyse('R_100', ticks);
        const rec = recommend({ R_100: verdict }, verdict.generatedAt);
        expect(rec).not.toBeNull();
        expect(isAllowedContract(rec?.contract, rec?.barrier)).toBe(true);
        expect(['EXECUTE', 'PREPARE']).toContain(rec?.action);
        expect(rec?.symbol).toBe('R_100');
    });
    it('does not analyse below the minimum tick count', () => {
        const verdict = new OverUnderEngine().analyse('R_10', buildEngineTicks(ticksWithWeights([1,1,1,1,1,1,1,1,1,1], 20), [], 2));
        expect(verdict.ready).toBe(false);
        expect(verdict.verdicts.every(v => v.action === 'STAND_DOWN')).toBe(true);
    });
});

describe('cross-market comparison', () => {
    it('ranks by engine action, then score, then lower danger, then independence', () => {
        const a = { symbol: 'A', verdict: fakeVerdict('A', []), item: fakeVerdict('A', [{ proposition: 'OVER2', action: 'PREPARE', score: 70 }]).verdicts[0] };
        const b = { symbol: 'B', verdict: fakeVerdict('B', []), item: fakeVerdict('B', [{ proposition: 'UNDER7', action: 'EXECUTE', score: 62 }]).verdicts[0] };
        const c = { symbol: 'C', verdict: fakeVerdict('C', []), item: fakeVerdict('C', [{ proposition: 'OVER1', action: 'PREPARE', score: 70, danger: 10 }]).verdicts[0] };
        expect([a, b, c].sort(compareCandidates).map(x => x.symbol)).toEqual(['B', 'C', 'A']);
        expect(ACTION_RANK.EXECUTE).toBeGreaterThan(ACTION_RANK.PREPARE);
    });
    it('picks the best actionable verdict across markets and ignores OBSERVE and STAND_DOWN', () => {
        const verdicts = {
            R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'OBSERVE', score: 59 }, { proposition: 'UNDER6', action: 'STAND_DOWN', score: 90 }]),
            R_25: fakeVerdict('R_25', [{ proposition: 'UNDER7', action: 'PREPARE', score: 64 }]),
            R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'PREPARE', score: 68 }]),
        };
        const rec = recommend(verdicts, 2_000_000);
        expect(rec?.symbol).toBe('R_50');
        expect(rec?.label).toBe('Over 3');
        expect(rec?.contract).toBe('DIGITOVER');
        expect(rec?.barrier).toBe(3);
        expect(rec?.expiresAt).toBe(2_000_000 + RECOMMENDATION_TTL_MS);
    });
    it('returns no recommendation when nothing is actionable, and skips markets that are not ready', () => {
        expect(recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'OBSERVE', score: 59 }]) }, 1)).toBeNull();
        expect(recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'EXECUTE', score: 99 }], { ready: false }) }, 1)).toBeNull();
        expect(recommend({}, 1)).toBeNull();
    });
    it('keeps the current recommendation until a same-grade challenger is clearly better AND the hold time has passed', () => {
        const { stickyMargin, holdMs } = SIGNAL_QUALITY;
        const first = recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'PREPARE', score: 67 }]) }, 100)!;
        const rival = (lead: number) => ({
            R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'PREPARE', score: 67 }]),
            R_25: fakeVerdict('R_25', [{ proposition: 'UNDER7', action: 'PREPARE', score: 67 + lead }]),
        });
        const kept = recommend(rival(stickyMargin - 1), 100 + holdMs + 1, first)!;
        expect(kept.id).toBe(first.id); expect(kept.createdAt).toBe(100);
        expect(kept.refreshedAt).toBe(100 + holdMs + 1);
        expect(recommend(rival(stickyMargin), 100 + holdMs - 1, first)?.id).toBe(first.id);
        expect(recommend(rival(stickyMargin), 100 + holdMs, first)?.symbol).toBe('R_25');
        expect(recommend(rival(SIGNAL_QUALITY.holdBypassMargin), 200, first)?.symbol).toBe('R_25');
        expect(recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'STAND_DOWN', score: 40 }]) }, 400, first)).toBeNull();
    });
    it('a higher grade (EXECUTE) replaces a shown PREPARE immediately', () => {
        const first = recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'PREPARE', score: 70 }]) }, 100)!;
        const next = recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'PREPARE', score: 70 }]), R_25: fakeVerdict('R_25', [{ proposition: 'UNDER7', action: 'EXECUTE', score: 73 }]) }, 150, first);
        expect(next?.symbol).toBe('R_25'); expect(next?.action).toBe('EXECUTE');
    });
    it('the old behaviour is reproducible with LEGACY_QUALITY (margin 5, no hold, no floor)', () => {
        const first = recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'PREPARE', score: 61 }]) }, 100, null, null, LEGACY_QUALITY)!;
        expect(first.score).toBe(61);
        const next = recommend({ R_10: fakeVerdict('R_10', [{ proposition: 'OVER2', action: 'PREPARE', score: 61 }]), R_25: fakeVerdict('R_25', [{ proposition: 'UNDER7', action: 'PREPARE', score: 66 }]) }, 101, first, null, LEGACY_QUALITY);
        expect(next?.symbol).toBe('R_25');
    });
    it('offers an OBSERVE-grade hint when nothing is actionable', () => {
        const hint = watching({ R_25: fakeVerdict('R_25', [{ proposition: 'UNDER7', action: 'OBSERVE', score: 52 }, { proposition: 'OVER1', action: 'STAND_DOWN', score: 80 }]) });
        expect(hint?.label).toBe('Under 7');
        expect(watching({})).toBeNull();
    });
});

describe('re-validation before execution', () => {
    const live = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'PREPARE', score: 68 }], { generatedAt: 1_000_000 }) };
    const rec = recommend(live, 1_000_000)!;

    it('accepts a fresh, still-eligible recommendation', () => {
        expect(validateRecommendation(rec, live, 1_000_500)).toEqual({ ok: true });
    });
    it('refuses when nothing is loaded', () => {
        expect(validateRecommendation(null, live, 1_000_500).ok).toBe(false);
    });
    it('refuses when the analysis has gone stale', () => {
        const result = validateRecommendation(rec, live, 1_000_000 + RECOMMENDATION_TTL_MS + 1);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toMatch(/stale/);
    });
    it('refuses when the engine now stands down on it', () => {
        const now = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'STAND_DOWN', score: 30 }], { generatedAt: 1_000_400 }) };
        const result = validateRecommendation(rec, now, 1_000_500);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toMatch(/STAND DOWN/);
    });
    it('refuses when the market has no ready analysis', () => {
        expect(validateRecommendation(rec, {}, 1_000_500).ok).toBe(false);
        expect(validateRecommendation(rec, { R_50: fakeVerdict('R_50', [], { ready: false }) }, 1_000_500).ok).toBe(false);
    });
    it('refuses a tampered recommendation with a forbidden contract', () => {
        for (const bad of [{ contract: 'DIGITOVER', barrier: 5 }, { contract: 'DIGITUNDER', barrier: 9 }, { contract: 'DIGITOVER', barrier: 0 }, { contract: 'DIGITDIFF', barrier: 3 }]) {
            const tampered = { ...rec, ...bad } as unknown as typeof rec;
            expect(validateRecommendation(tampered, live, 1_000_500).ok).toBe(false);
        }
        // consistent contract/barrier but a mismatched proposition id is also rejected
        expect(validateRecommendation({ ...rec, proposition: 'OVER1' }, live, 1_000_500).ok).toBe(false);
    });
});

describe('signal quality filter', () => {
    const item = (over: Partial<Item> & { action?: VerdictAction }) => fakeVerdict('X', [{ proposition: 'OVER2', action: 'PREPARE', score: 70, ...over }]).verdicts[0];
    it('filters PREPARE and leaves EXECUTE to the engine', () => {
        expect(passesQuality(item({ score: SIGNAL_QUALITY.minScore - 1 }))).toBe(false);
        expect(passesQuality(item({ score: SIGNAL_QUALITY.minScore }))).toBe(true);
        expect(passesQuality(item({ action: 'EXECUTE', score: 72 }))).toBe(true);
        expect(passesQuality(item({ action: 'OBSERVE', score: 99 }))).toBe(false);
        expect(passesQuality(item({ action: 'STAND_DOWN', score: 99 }))).toBe(false);
    });
    it('caps danger at the EXECUTE line', () => {
        expect(passesQuality(item({ danger: SIGNAL_QUALITY.maxDanger - 1 }))).toBe(true);
        expect(passesQuality(item({ danger: SIGNAL_QUALITY.maxDanger }))).toBe(false);
    });
    it('slightly tightens the engine bar', () => {
        expect(SIGNAL_QUALITY.minScore - 60).toBeLessThan(8);
        expect(SIGNAL_QUALITY.maxDanger).toBeGreaterThanOrEqual(40);
        expect(passesQuality(item({ score: 60 }), LEGACY_QUALITY)).toBe(true);
    });
    it('requires consecutive qualifying scans and resets when a scan fails', () => {
        const good = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'PREPARE', score: 70 }]) };
        const stability = new SignalStability();
        expect(recommend(good, 1, null, stability)).toBeNull();
        stability.observe('R_50', good.R_50); stability.observe('R_50', good.R_50);
        expect(stability.streak('R_50', 'OVER3')).toBe(2);
        expect(recommend(good, 2, null, stability)).toBeNull();
        stability.observe('R_50', good.R_50);
        expect(recommend(good, 3, null, stability)?.label).toBe('Over 3');
        stability.observe('R_50', fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'OBSERVE', score: 55 }]));
        expect(stability.streak('R_50', 'OVER3')).toBe(0);
        expect(recommend(good, 4, null, stability)).toBeNull();
    });
    it('an established signal needs no new streak', () => {
        const good = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'PREPARE', score: 70 }]) };
        const stability = new SignalStability(); [1, 2, 3].forEach(() => stability.observe('R_50', good.R_50));
        const shown = recommend(good, 10, null, stability)!;
        expect(recommend(good, 11, shown, new SignalStability())?.id).toBe(shown.id);
    });
});
describe('locking a signal', () => {
    const base = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'PREPARE', score: 70 }], { generatedAt: 1_000_000 }) };
    const locked = recommend(base, 1_000_000)!;
    it('refreshes engine values without swapping the signal', () => {
        const later = {
            R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'OBSERVE', score: 58, danger: 35 }], { generatedAt: 1_005_000 }),
            R_10: fakeVerdict('R_10', [{ proposition: 'UNDER7', action: 'EXECUTE', score: 90 }], { generatedAt: 1_005_000 }),
        };
        const shown = refreshLocked(locked, later, 1_005_000);
        expect(shown.id).toBe(locked.id); expect(shown.symbol).toBe('R_50'); expect(shown.label).toBe('Over 3');
        expect(shown.action).toBe('OBSERVE'); expect(shown.score).toBe(58); expect(shown.locked).toBe(true); expect(shown.expiresAt).toBe(Infinity);
    });
    it('keeps a locked signal visible if its market disappears', () => {
        const shown = refreshLocked(locked, {}, 2_000_000);
        expect(shown.id).toBe(locked.id); expect(shown.locked).toBe(true);
    });
    it('allows a locked signal to trade on OBSERVE, but not unlocked', () => {
        const observe = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'OBSERVE', score: 58 }], { generatedAt: 1_000_400 }) };
        expect(validateRecommendation(locked, observe, 1_000_500, true)).toEqual({ ok: true });
        expect(validateRecommendation(locked, observe, 1_000_500, false).ok).toBe(false);
    });
    it('still refuses STAND_DOWN, stale data, and forbidden contracts when locked', () => {
        const down = { R_50: fakeVerdict('R_50', [{ proposition: 'OVER3', action: 'STAND_DOWN', score: 20 }], { generatedAt: 1_000_400 }) };
        const refused = validateRecommendation(locked, down, 1_000_500, true);
        expect(refused.ok).toBe(false); expect(JSON.stringify(refused)).toMatch(/Unlock/);
        expect(validateRecommendation(locked, base, 1_000_000 + RECOMMENDATION_TTL_MS + 1, true).ok).toBe(false);
        expect(validateRecommendation({ ...locked, contract: 'DIGITOVER', barrier: 5 } as unknown as typeof locked, base, 1_000_500, true).ok).toBe(false);
    });
});

describe('markets', () => {
    it('covers all 13 volatility indices once', () => {
        expect(BULK_MARKETS).toHaveLength(13);
        expect(new Set(BULK_MARKETS.map(m => m.symbol)).size).toBe(13);
    });
});
