import type { Contract } from '../bot';
import type { TriggerDigit } from '../entry-brain';
import { MAX_EASE_TOTAL, MAX_RAISE, tally, toCall, type Vote } from '../fusion/consensus';
import { createEntryStudy, reconcile } from '../fusion/entry-study';
import { carryOver, FUSED_DEFAULTS } from '../fusion/fused-settings';
import type { EntryTrigger } from '../overlay';

const v = (engine: Vote['engine'], points: number): Vote => ({ engine, points, note: `${engine} ${points}` });
const trig = (digit: number, strength: EntryTrigger['strength'] = 'confirmed'): EntryTrigger => ({ digit, strength, note: `note ${digit}` });
const brainDigit = (digit: number, evidence: 'PROVEN' | 'BEST', rate = 0.75): TriggerDigit => ({
    digit,
    touches: 100,
    wins: Math.round(rate * 100),
    rate,
    windows: [],
    passed: evidence === 'PROVEN' ? 5 : 2,
    recentOk: evidence === 'PROVEN',
    score: 0.05,
    evidence,
});

describe('consensus', () => {
    it('adds the votes and counts who agrees', () => {
        const b = tally([v('pulse', -6), v('bot', -10), v('losing', 3), v('window', 0)]);
        expect([b.agree, b.disagree, b.abstain, b.net, b.bump]).toEqual([2, 1, 1, -13, -13]);
    });

    it('limits how far the votes can ease or raise the bar', () => {
        expect(tally([v('bot', -50)]).bump).toBe(-MAX_EASE_TOTAL);
        expect(tally([v('losing', 50)]).bump).toBe(MAX_RAISE);
    });

    it('does not count the idle ease as an engine agreeing', () => {
        const b = tally([v('pulse', 2), v('idle', -9)]);
        expect([b.agree, b.disagree, b.net]).toEqual([0, 1, -7]);
    });

    it('a veto is final however much the engines agree', () => {
        const b = tally([v('pulse', -6), v('bot', -10), v('digit', -5)], 'digit 8/1 rule: digit 1 is building');
        const call = toCall(b);
        expect(call).toMatchObject({ allow: false, bump: 0, note: 'digit 8/1 rule: digit 1 is building' });
    });

    it('turns agreement into an easier bar and a better rank, in the runner’s own terms', () => {
        const call = toCall(tally([v('pulse', -6), v('bot', -10)]));
        expect(call.allow).toBe(true);
        expect(call.bump).toBe(-16);
        expect(call.rank).toBeGreaterThan(0);
        expect(call.note).toContain('2 agree, 0 against');
    });
});

describe('entry study: the two studies support each other', () => {
    it('both studies on the same digit: that digit, confirmed, labelled both', () => {
        const s = reconcile(trig(4, 'weak'), [brainDigit(4, 'PROVEN'), brainDigit(7, 'PROVEN')])!;
        expect([s.source, s.trigger.digit, s.trigger.strength]).toEqual(['both', 4, 'confirmed']);
        expect(s.trigger.note).toContain('Entry Brain proves the same digit');
    });

    it('a confirmed Sentinel digit is kept, with the Brain’s own pick in the note', () => {
        const s = reconcile(trig(3, 'confirmed'), [brainDigit(8, 'PROVEN')])!;
        expect([s.source, s.trigger.digit, s.trigger.strength]).toEqual(['sentinel', 3, 'confirmed']);
        expect(s.trigger.note).toContain('Entry Brain');
    });

    it('a weak Sentinel digit gives way to a digit the Entry Brain has proven', () => {
        const s = reconcile(trig(3, 'weak'), [brainDigit(8, 'PROVEN'), brainDigit(2, 'BEST')])!;
        expect([s.source, s.trigger.digit, s.trigger.strength]).toEqual(['brain', 8, 'confirmed']);
    });

    it('a weak Sentinel digit with nothing proven by the Brain stands, still weak', () => {
        const s = reconcile(trig(3, 'weak'), [brainDigit(8, 'BEST')])!;
        expect([s.source, s.trigger.digit, s.trigger.strength]).toEqual(['sentinel', 3, 'weak']);
    });

    it('no Sentinel digit: the Brain’s digit is used, weak unless proven', () => {
        expect(reconcile(null, [brainDigit(5, 'PROVEN')])).toMatchObject({ source: 'brain', trigger: { digit: 5, strength: 'confirmed' } });
        expect(reconcile(null, [brainDigit(5, 'BEST')])).toMatchObject({ source: 'brain', trigger: { digit: 5, strength: 'weak' } });
    });

    it('no digit from either study: nothing to wait for, never a guess', () => {
        expect(reconcile(null, [])).toBeNull();
    });
});

describe('entry study source', () => {
    const series = Array.from({ length: 800 }, (_, i) => (i * 7) % 10);
    const over2: Contract = { side: 'OVER', param: 2 };

    it('keeps the digit for a minute so the one being waited for does not change on every scan', () => {
        let calls = 0;
        const src = createEntryStudy({
            discover: () => ((calls += 1), { trigger: trig(calls), pick: {} as never }),
            replay: () => null,
        });
        const first = src.get('A', over2, series, 1, 1_000);
        const again = src.get('A', over2, series, 1, 30_000);
        expect(first?.trigger.digit).toBe(1);
        expect(again?.trigger.digit).toBe(1);
        expect(calls).toBe(1);
        expect(src.get('A', over2, series, 1, 62_000)?.trigger.digit).toBe(2); // after the minute it is worked out again
    });

    it('looks again soon when there was no digit (history too short), and a new session works everything out afresh', () => {
        let calls = 0;
        const src = createEntryStudy({ discover: () => (calls++, null), replay: () => null });
        expect(src.get('A', over2, series, 1, 1_000)).toBeNull();
        src.get('A', over2, series, 1, 2_000);
        expect(calls).toBe(1);
        src.get('A', over2, series, 1, 7_000);
        expect(calls).toBe(2);
        src.reset();
        src.get('A', over2, series, 1, 7_100);
        expect(calls).toBe(3);
    });

    it('one study failing leaves the other; both failing gives no digit', () => {
        const ok = createEntryStudy({
            discover: () => {
                throw new Error('boom');
            },
            replay: () => ({ triggers: [brainDigit(6, 'PROVEN')] }) as never,
        });
        expect(ok.get('A', over2, series, 1, 1)?.trigger.digit).toBe(6);
        const none = createEntryStudy({
            discover: () => {
                throw new Error('boom');
            },
            replay: () => {
                throw new Error('boom');
            },
        });
        expect(none.get('A', over2, series, 1, 1)).toBeNull();
    });

    it('the real studies find a digit on a long history and none on a short one', () => {
        const real = createEntryStudy();
        let a = 11;
        const noisy = Array.from({ length: 1200 }, () => ((a = (a * 1664525 + 1013904223) % 4294967296), Math.floor(a / 65536) % 10));
        expect(real.get('A', over2, noisy, 1, 1)).not.toBeNull();
        expect(real.get('B', over2, noisy.slice(0, 40), 1, 1)).toBeNull();
    });
});

describe('fused settings', () => {
    it('watches every market and buys the first contract to print its entry digit', () => {
        expect(FUSED_DEFAULTS.execution).toBe('FIRST');
        expect(FUSED_DEFAULTS.entry).toBe('SMART');
        expect(FUSED_DEFAULTS.markets.length).toBe(20);
    });

    it('carries only the money and contract settings over from the old Sixfold, nothing that would bring the old silence back', () => {
        const carried = carryOver({ stake: 5, stopLoss: 12, primaryUnder: 7, execution: 'BEST', entry: 'BRAIN', winStreakGate: true, markets: ['R_10'] });
        expect(carried).toEqual({ stake: 5, stopLoss: 12, primaryUnder: 7 });
        expect(carryOver(null)).toEqual({});
        expect(carryOver('nope')).toEqual({});
    });
});
