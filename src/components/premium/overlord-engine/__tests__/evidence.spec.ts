import { describe, expect, test } from 'bun:test';
import { digitEvidence, digitLetters, EVIDENCE_MIN, EVIDENCE_WINDOW, moveEvidence, moveLetters } from '../evidence';
import { appendTick, assessRiseFall } from '../rise-fall-run';
import { type Candle, compareRiseFall, scanRiseFall } from '../rise-fall';
import { evidenceOk, type ParityRead, pickFromReads } from '../parity-engine';
import { ParityAssessment } from '../parity-assess';

const candlesFrom = (closes: number[]): Candle[] =>
    closes.map((c, i) => ({ open: c, high: c + 0.1, low: c - 0.1, close: c, time: i * 60 }));
const noisy = (seed: number) => {
    let a = seed;
    const r = () => ((a = (a * 16807) % 2147483647) / 2147483647);
    let p = 100;
    return Array.from({ length: 150 }, () => (p += (r() - 0.5) * 2));
};
/** Prices whose moves, oldest first, are the letters given (R up, F down, - flat). */
const pricesFor = (letters: string, start = 100) => {
    const out = [start];
    for (const l of letters) out.push(out[out.length - 1] + (l === 'R' ? 1 : l === 'F' ? -1 : 0));
    return out;
};

describe('evidence letters', () => {
    test('digits become E / O and moves become R / F / -', () => {
        expect(digitLetters([2, 7, 0, 9, 4])).toBe('EOEOE');
        expect(moveLetters([1, 2, 1, 1, 0])).toBe('RF-F');
    });
    test('the default is a majority: 6 of the last 10', () => {
        expect(EVIDENCE_WINDOW).toBe(10);
        expect(EVIDENCE_MIN).toBe(6);
    });
});

describe('moveEvidence (Rise / Fall)', () => {
    test('falls dominating the latest ticks passes a Fall signal, in any order', () => {
        const e = moveEvidence(pricesFor('RFFRFFRFFF'), 'FALL'); // 7 falls of 10, not consecutive
        expect(e.ok).toBe(true);
        expect(e.count).toBe(7);
        expect(e.against).toBe(3);
    });
    test('exactly 6 of 10 is enough, 5 of 10 is not', () => {
        expect(moveEvidence(pricesFor('RFFRFFRFFR'), 'FALL').ok).toBe(true);
        expect(moveEvidence(pricesFor('RFFRFRRFFR'), 'FALL').ok).toBe(false);
    });
    test('"falls must be present when you give a fall signal": a market of rises gives no Fall', () => {
        const e = moveEvidence(pricesFor('RRRRRRRFRR'), 'FALL');
        expect(e.ok).toBe(false);
        expect(e.count).toBe(1);
        expect(e.text).toContain('only 1 of the last 10 ticks were falls');
    });
    test('the same market of rises does give a Rise', () => {
        expect(moveEvidence(pricesFor('RRRRRRRFRR'), 'RISE').ok).toBe(true);
    });
    test('a tick that did not move counts for neither side', () => {
        const e = moveEvidence(pricesFor('FF--FF--FF'), 'FALL');
        expect(e.count).toBe(6);
        expect(e.against).toBe(0);
        expect(e.ok).toBe(true);
        expect(moveEvidence(pricesFor('FF----FF--'), 'FALL').ok).toBe(false);
    });
    test('only the latest ticks count', () => {
        const e = moveEvidence(pricesFor('FFFFFFFFFFRRRRRRRR'), 'FALL'); // old falls, now rising
        expect(e.ok).toBe(false);
        expect(moveEvidence(pricesFor('RRRRRRRRRRFFFFFFFF'), 'FALL').ok).toBe(true);
    });
    test('too few ticks cannot show dominance, and no ticks says so', () => {
        expect(moveEvidence(pricesFor('FFFF'), 'FALL').ok).toBe(false);
        const none = moveEvidence([], 'FALL');
        expect(none.ok).toBe(false);
        expect(none.text).toContain('no latest ticks');
    });
    test('the required count can be changed', () => {
        expect(moveEvidence(pricesFor('RFFRFFRFFR'), 'FALL', 7).ok).toBe(false);
        expect(moveEvidence(pricesFor('RFFRFFRFFR'), 'FALL', 5).ok).toBe(true);
    });
});

describe('digitEvidence (Even / Odd)', () => {
    test('evens dominating the latest digits passes an Even signal, in any order', () => {
        const e = digitEvidence([1, 3, 2, 5, 4, 6, 7, 8, 0, 2], 'EVEN'); // 6 even of 10
        expect(e.ok).toBe(true);
        expect(e.count).toBe(6);
    });
    test('"dont tell me even and there are no even digits appearing"', () => {
        const e = digitEvidence([1, 3, 5, 7, 9, 1, 3, 5, 7, 2], 'EVEN');
        expect(e.ok).toBe(false);
        expect(e.count).toBe(1);
    });
    test('5 of 10 is not a majority', () => {
        expect(digitEvidence([2, 1, 4, 3, 6, 5, 8, 7, 0, 9], 'EVEN').ok).toBe(false);
        expect(digitEvidence([2, 1, 4, 3, 6, 5, 8, 7, 0, 2], 'EVEN').ok).toBe(true);
    });
    test('odd digits dominating pass Odd but never Even', () => {
        const odds = [1, 3, 2, 5, 7, 9, 4, 1, 3, 5]; // 8 odd
        expect(digitEvidence(odds, 'ODD').ok).toBe(true);
        expect(digitEvidence(odds, 'EVEN').ok).toBe(false);
    });
});

describe('Rise / Fall scan with the evidence rule', () => {
    const candles = { A: candlesFrom(noisy(3)) };

    test('without the rule nothing changes', () => {
        const scan = scanRiseFall({ candles, style: 'trend', side: 'FALL' });
        expect(scan.best!.setup).toBe(true);
        expect(scan.best!.evidence).toBeNull();
        expect(scan.best!.blockedByEvidence).toBe(false);
    });
    test('a Fall signal where the latest ticks are mostly rises is blocked', () => {
        const scan = scanRiseFall({
            candles,
            style: 'trend',
            side: 'FALL',
            requireEvidence: true,
            ticks: { A: pricesFor('RRFRFRRFRR') },
        });
        expect(scan.best!.setup).toBe(false);
        expect(scan.best!.blockedByEvidence).toBe(true);
        expect(scan.best!.evidence!.ok).toBe(false);
    });
    test('a Fall signal where falls dominate the latest ticks is allowed, even if they are not consecutive', () => {
        const scan = scanRiseFall({
            candles,
            style: 'trend',
            side: 'FALL',
            requireEvidence: true,
            ticks: { A: pricesFor('RRFFRFFFFF') },
        });
        expect(scan.best!.setup).toBe(true);
        expect(scan.best!.blockedByEvidence).toBe(false);
    });
    test('no ticks at all means no signal when evidence is required', () => {
        const scan = scanRiseFall({ candles, style: 'trend', side: 'FALL', requireEvidence: true });
        expect(scan.best!.setup).toBe(false);
    });
    test('a market with the evidence outranks one without it, even if the other has more indicators agreeing', () => {
        const withEvidence = { agree: 3, against: 0, score: 40, symbol: 'B', setup: true } as any;
        const without = { agree: 5, against: 0, score: 80, symbol: 'A', setup: false } as any;
        expect([without, withEvidence].sort(compareRiseFall)[0].symbol).toBe('B');
    });
    test('a reversal that the indicators like, but the ticks do not show, is blocked', () => {
        // A climb that stalls reads as a Fall reversal (see rise-fall.spec); the latest ticks are still rising.
        const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5).concat([149.5, 149.55, 149.6, 149.55, 149.5, 149.45, 149.4, 149.38, 149.37]);
        const stall = closes.map((c, i, a) => {
            const prev = i ? a[i - 1] : c;
            const big = i < 100 ? 0.5 : 0.1;
            return { open: prev, close: c, high: Math.max(prev, c) + big * 0.2, low: Math.min(prev, c) - big * 0.2, time: i * 60 };
        });
        const blocked = scanRiseFall({ candles: { A: stall }, style: 'reversal', requireEvidence: true, ticks: { A: pricesFor('FRRRRRFRRR') } });
        const allowed = scanRiseFall({ candles: { A: stall }, style: 'reversal', requireEvidence: true, ticks: { A: pricesFor('RRFFRFFFRF') } });
        expect(allowed.best!.side).toBe('FALL');
        expect(allowed.best!.agree).toBeGreaterThanOrEqual(3);
        expect(allowed.best!.setup).toBe(true);
        expect(blocked.best!.setup).toBe(false);
        expect(blocked.best!.blockedByEvidence).toBe(true);
    });
});

describe('live ticks in the Rise / Fall run', () => {
    test('appendTick keeps the latest 40 and rejects junk', () => {
        const t: number[] = [];
        for (let i = 0; i < 60; i += 1) appendTick(t, 100 + i);
        expect(t).toHaveLength(40);
        expect(t.at(-1)).toBe(159);
        expect(appendTick(t, 'abc')).toBe(false);
        expect(appendTick(t, null)).toBe(false);
        expect(appendTick(t, '')).toBe(false);
    });

    const run = async (requireEvidence: boolean, tickLetters: string) => {
        const sent: any[] = [];
        let sock: any;
        const create = () => {
            sock = { send: (s: string) => sent.push(JSON.parse(s)), close: () => undefined, onopen: null, onmessage: null, onerror: null };
            setTimeout(() => {
                sock.onopen?.({});
                for (const req of sent) {
                    if (req.style === 'candles') {
                        sock.onmessage?.({
                            data: JSON.stringify({
                                req_id: req.req_id,
                                candles: noisy(9).map((c, i) => ({ epoch: i * 60, open: c, high: c + 0.1, low: c - 0.1, close: c })),
                            }),
                        });
                    } else if (req.style === 'ticks') {
                        sock.onmessage?.({
                            data: JSON.stringify({ req_id: req.req_id, history: { prices: pricesFor(tickLetters) } }),
                        });
                    }
                }
            }, 0);
            return sock;
        };
        const result = await assessRiseFall({
            symbols: ['A'],
            url: 'ws://x',
            side: 'FALL',
            style: 'trend',
            requireEvidence,
            assessMs: 400,
            roundMs: 100,
            createSocket: create as any,
        });
        return { result, sent };
    };

    test('with the rule on it asks for the latest ticks and allows a Fall that dominates them', async () => {
        const { result, sent } = await run(true, 'RFFRFFRFFF');
        expect(sent.some(r => r.style === 'ticks' && r.subscribe === 1)).toBe(true);
        expect(result.scan.best!.setup).toBe(true);
        expect(result.scan.best!.evidence!.ok).toBe(true);
    });
    test('with the rule on, a Fall whose latest ticks do not show it is not a signal', async () => {
        const { result } = await run(true, 'RRFRRFRRRR');
        expect(result.scan.best!.setup).toBe(false);
        expect(result.scan.best!.tier).toBe('WEAK');
        expect(result.scan.best!.blockedByEvidence).toBe(true);
    });
    test('with the rule off it does not subscribe to ticks at all', async () => {
        const { result, sent } = await run(false, 'RRFRRFRRRR');
        expect(sent.some(r => r.style === 'ticks')).toBe(false);
        expect(result.scan.best!.setup).toBe(true);
    });
});

describe('Even / Odd picking with the evidence rule', () => {
    const base = (over: Partial<ParityRead>): ParityRead => ({
        symbol: 'X',
        name: 'X',
        side: 'EVEN',
        barrier: 0,
        label: 'Even',
        state: 'READY',
        ready: true,
        score: 70,
        tier: 'STRONG',
        vetoed: false,
        vetoReason: '',
        legacyPct: 50,
        thin: false,
        ticks: 2000,
        reasons: [],
        agree: 5,
        applied: 6,
        parity: null,
        oracle: null,
        evidence: digitEvidence([1, 3, 5, 7, 9, 1, 3, 5, 7, 2], 'EVEN'),
        ...over,
    });
    const showsRun = digitEvidence([1, 2, 4, 3, 6, 8, 0, 5, 2, 4], 'EVEN');

    test('a READY Even market whose latest digits are mostly odd is not picked', () => {
        const noRun = base({ symbol: 'n', score: 99 });
        const out = pickFromReads([noRun], 'EVEN', false, true);
        expect(out.best).toBeNull();
        expect(out.watch?.symbol).toBe('n'); // shown, with its reason, but never a signal
    });
    test('the same market is picked when the rule is off', () => {
        expect(pickFromReads([base({ symbol: 'n' })], 'EVEN', false, false).best?.symbol).toBe('n');
    });
    test('the market with evens dominating is picked over a higher-confidence one without it', () => {
        const noRun = base({ symbol: 'n', score: 99 });
        const run = base({ symbol: 'r', score: 60, evidence: showsRun });
        expect(pickFromReads([noRun, run], 'EVEN', false, true).best?.symbol).toBe('r');
    });
    test('a read with no evidence attached never passes', () => {
        expect(evidenceOk(base({ evidence: null }))).toBe(false);
    });
    test('the other parity is only suggested when it has its own dominance', () => {
        const odd = base({ symbol: 'o', side: 'ODD', label: 'Odd', evidence: digitEvidence([2, 4, 6, 8, 0, 1, 4, 6, 8, 2], 'ODD') });
        expect(pickFromReads([odd], 'EVEN', false, true).opposite).toBeNull();
        const oddRun = base({ symbol: 'o', side: 'ODD', label: 'Odd', evidence: digitEvidence([2, 1, 3, 5, 7, 9, 4, 1, 3, 5], 'ODD') });
        expect(pickFromReads([oddRun], 'EVEN', false, true).opposite?.symbol).toBe('o');
    });
    test('the live assessment ignores markets without the evidence when counting how steadily they were ready', () => {
        const a = new ParityAssessment('EVEN', false, true);
        const scan = (reads: ParityRead[]) => ({ reads, best: null, watch: null, opposite: null, legacyOnly: false, evaluated: reads.length });
        a.observe(scan([base({ symbol: 'n' }), base({ symbol: 'r', evidence: showsRun })]));
        a.observe(scan([base({ symbol: 'n' }), base({ symbol: 'r', evidence: showsRun })]));
        expect(a.share({ symbol: 'r', side: 'EVEN' }).clear).toBe(1);
        expect(a.share({ symbol: 'n', side: 'EVEN' }).clear).toBe(0);
        const final = a.finalize(scan([base({ symbol: 'n' }), base({ symbol: 'r', evidence: showsRun })]));
        expect(final.best?.symbol).toBe('r');
    });
});
