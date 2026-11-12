import { ENTRY_DIGIT_TTL_MS, entryTriggerOf, createSentinelOverlay } from '../overlay';
import { DEFAULT_ENGINE, type EngineSettings } from '../settings';
import { SCAN_MIN_TICKS } from '../../bulk-scan';

// Noise with one planted habit: right after a 5 the next digit is always 9 (a win for Over 2, Over 1, Over 3 and a loss for Under 6/7/8).
const planted = (n = 900, seed = 11) => {
    let a = seed;
    const out = Array.from({ length: n }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
    for (let i = 0; i + 1 < out.length; i += 1) if (out[i] === 5) out[i + 1] = 9;
    return out;
};
const engine: EngineSettings = { ...DEFAULT_ENGINE };
const make = (now = { t: 1_000 }) =>
    ({
        o: createSentinelOverlay({ getEngine: () => engine, read: () => ({ markets: 0, reads: [] }), now: () => now.t }),
        now,
    }) as const;

describe('entryTriggerOf (the Bulk Trader engine, per market)', () => {
    it('finds the digit after which the contract kept winning, and says it is confirmed', () => {
        const r = entryTriggerOf(planted(), 'OVER', 2, 1)!;
        expect(r.trigger.digit).toBe(5);
        expect(r.trigger.strength).toBe('confirmed');
        expect(r.trigger.note).toContain('after a 5');
    });
    it('still gives a digit when none stands out, labelled weak (a timing choice, not an edge)', () => {
        let a = 7;
        const noise = Array.from({ length: 900 }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
        const r = entryTriggerOf(noise, 'OVER', 2, 1);
        expect(r).not.toBeNull();
        expect(r!.trigger.digit).toBeGreaterThanOrEqual(0);
        expect(r!.trigger.digit).toBeLessThanOrEqual(9);
        // a digit that is no better than chance is never presented as an edge
        if (r!.trigger.strength === 'weak') expect(r!.trigger.note).toContain('timing choice');
    });
    it('is null with too little history, and for a contract it does not read', () => {
        expect(entryTriggerOf(planted(SCAN_MIN_TICKS - 1), 'OVER', 2, 1)).toBeNull();
        expect(entryTriggerOf(planted(), 'OVER', 5, 1)).toBeNull();
        expect(entryTriggerOf(planted(), 'UNDER', 2, 1)).toBeNull();
    });
    it('reads the contract being traded: the same history gives another digit for the other side', () => {
        const over = entryTriggerOf(planted(), 'OVER', 2, 1)!.trigger.digit;
        const under = entryTriggerOf(planted(), 'UNDER', 7, 1)!.trigger;
        expect(over).toBe(5);
        expect(under.digit).not.toBe(5); // after a 5 the next digit is 9, which loses Under 7
    });
});

describe('the Sentinel overlay entry trigger', () => {
    const series = planted();
    const ctx = (now: number) => ({ duration: 1, now });

    it('gives every market with enough history an entry digit', () => {
        const { o } = make();
        const t = o.entryTrigger!('A', { side: 'OVER', param: 2 }, series, ctx(1_000));
        expect(t?.digit).toBe(5);
    });
    it('keeps the same digit while it is waited for, and works it out again after a minute', () => {
        const { o } = make();
        const first = o.entryTrigger!('A', { side: 'OVER', param: 2 }, series, ctx(1_000));
        // The market has moved on: with a different history the cached digit still stands until the minute is up.
        const moved = series.map(d => (d === 5 ? 3 : d));
        expect(o.entryTrigger!('A', { side: 'OVER', param: 2 }, moved, ctx(1_000 + ENTRY_DIGIT_TTL_MS - 1))?.digit).toBe(first?.digit);
        expect(o.entryTrigger!('A', { side: 'OVER', param: 2 }, moved, ctx(1_000 + ENTRY_DIGIT_TTL_MS + 1))?.digit).not.toBe(5);
    });
    it('keeps a digit per market and per contract', () => {
        const { o } = make();
        const a = o.entryTrigger!('A', { side: 'OVER', param: 2 }, series, ctx(1_000));
        const b = o.entryTrigger!('B', { side: 'OVER', param: 2 }, series.map(d => (d === 5 ? 4 : d)), ctx(1_000));
        expect(a?.digit).toBe(5);
        expect(b?.digit).not.toBe(5);
    });
    it('is null with too little history, and tries again soon (a null is not kept for a minute)', () => {
        const { o } = make();
        expect(o.entryTrigger!('A', { side: 'OVER', param: 2 }, series.slice(0, 100), ctx(1_000))).toBeNull();
        expect(o.entryTrigger!('A', { side: 'OVER', param: 2 }, series, ctx(6_100))?.digit).toBe(5);
    });
    it('a new session works the digits out afresh', () => {
        const { o } = make();
        o.entryTrigger!('A', { side: 'OVER', param: 2 }, series, ctx(1_000));
        o.onStart!(2_000);
        const moved = series.map(d => (d === 5 ? 3 : d));
        expect(o.entryTrigger!('A', { side: 'OVER', param: 2 }, moved, ctx(2_001))?.digit).not.toBe(5);
    });
});
