import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_EVIDENCE_RUN,
    digitEvidence,
    digitLetters,
    moveEvidence,
    moveLetters,
    trailingRun,
} from '../evidence';
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

describe('evidence letters and runs', () => {
    test('digits become E / O and moves become R / F / -', () => {
        expect(digitLetters([2, 7, 0, 9, 4])).toBe('EOEOE');
        expect(moveLetters([1, 2, 1, 1, 0])).toBe('RF-F');
    });
    test('trailingRun counts only the end', () => {
        expect(trailingRun('FFRFFF', 'F')).toBe(3);
        expect(trailingRun('FFFFR', 'F')).toBe(0);
        expect(trailingRun('', 'F')).toBe(0);
    });
    test('defaults are four moves and five digits', () => {
        expect(DEFAULT_EVIDENCE_RUN).toEqual({ RISE: 4, FALL: 4, EVEN: 5, ODD: 5 });
    });
});

describe('moveEvidence (Rise / Fall)', () => {
    test('FFFF passes a Fall signal', () => {
        const e = moveEvidence(pricesFor('RFRFFFF'), 'FALL');
        expect(e.ok).toBe(true);
        expect(e.run).toBe(4);
        expect(e.pattern.endsWith('FFFF')).toBe(true);
    });
    test('FFFR does not pass a Fall signal, and says what it was looking for', () => {
        const e = moveEvidence(pricesFor('RFFFR'), 'FALL');
        expect(e.ok).toBe(false);
        expect(e.wanted).toBe('FFFF');
        expect(e.text).toContain('need FFFF');
    });
    test('three falls are not enough, a flat tick breaks the run', () => {
        expect(moveEvidence(pricesFor('RFFF'), 'FALL').ok).toBe(false);
        expect(moveEvidence(pricesFor('FFF-F'), 'FALL').ok).toBe(false);
    });
    test('RRRR passes Rise but never Fall', () => {
        expect(moveEvidence(pricesFor('FRRRR'), 'RISE').ok).toBe(true);
        expect(moveEvidence(pricesFor('FRRRR'), 'FALL').ok).toBe(false);
    });
    test('no ticks is no evidence', () => {
        const e = moveEvidence([], 'FALL');
        expect(e.ok).toBe(false);
        expect(e.text).toContain('no latest ticks');
    });
    test('a longer required run is respected', () => {
        expect(moveEvidence(pricesFor('RFFFF'), 'FALL', 5).ok).toBe(false);
        expect(moveEvidence(pricesFor('RFFFFF'), 'FALL', 5).ok).toBe(true);
    });
});

describe('digitEvidence (Even / Odd)', () => {
    test('EEEEE passes an Even signal', () => {
        const e = digitEvidence([1, 3, 2, 4, 6, 8, 0], 'EVEN');
        expect(e.ok).toBe(true);
        expect(e.run).toBe(5);
    });
    test('an Even signal with only four even digits in a row is blocked', () => {
        expect(digitEvidence([1, 2, 4, 6, 8], 'EVEN').ok).toBe(false);
    });
    test('"dont tell me even and there are no even digits appearing"', () => {
        const e = digitEvidence([1, 3, 5, 7, 9, 1, 3], 'EVEN');
        expect(e.ok).toBe(false);
        expect(e.run).toBe(0);
        expect(e.text).toContain('need EEEEE');
    });
    test('OOOOO passes Odd but never Even', () => {
        expect(digitEvidence([2, 1, 3, 5, 7, 9], 'ODD').ok).toBe(true);
        expect(digitEvidence([2, 1, 3, 5, 7, 9], 'EVEN').ok).toBe(false);
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
    test('a Fall signal with no FFFF in the latest ticks is blocked', () => {
        const scan = scanRiseFall({
            candles,
            style: 'trend',
            side: 'FALL',
            requireEvidence: true,
            ticks: { A: pricesFor('FFFRF') },
        });
        expect(scan.best!.setup).toBe(false);
        expect(scan.best!.blockedByEvidence).toBe(true);
        expect(scan.best!.evidence!.ok).toBe(false);
    });
    test('a Fall signal with FFFF in the latest ticks is allowed', () => {
        const scan = scanRiseFall({
            candles,
            style: 'trend',
            side: 'FALL',
            requireEvidence: true,
            ticks: { A: pricesFor('RRFFFF') },
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
        const blocked = scanRiseFall({ candles: { A: stall }, style: 'reversal', requireEvidence: true, ticks: { A: pricesFor('FRRRR') } });
        const allowed = scanRiseFall({ candles: { A: stall }, style: 'reversal', requireEvidence: true, ticks: { A: pricesFor('RRFFFF') } });
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

    test('with the rule on it asks for the latest ticks and allows a Fall that shows FFFF', async () => {
        const { result, sent } = await run(true, 'RFFFFF');
        expect(sent.some(r => r.style === 'ticks' && r.subscribe === 1)).toBe(true);
        expect(result.scan.best!.setup).toBe(true);
        expect(result.scan.best!.evidence!.ok).toBe(true);
    });
    test('with the rule on, a Fall whose latest ticks do not show it is not a signal', async () => {
        const { result } = await run(true, 'FFFFRF');
        expect(result.scan.best!.setup).toBe(false);
        expect(result.scan.best!.tier).toBe('WEAK');
        expect(result.scan.best!.blockedByEvidence).toBe(true);
    });
    test('with the rule off it does not subscribe to ticks at all', async () => {
        const { result, sent } = await run(false, 'FFFFRF');
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
        evidence: digitEvidence([1, 3, 5, 7, 9, 1], 'EVEN'),
        ...over,
    });
    const showsRun = digitEvidence([1, 2, 4, 6, 8, 0], 'EVEN');

    test('a READY Even market whose latest digits show no even run is not picked', () => {
        const noRun = base({ symbol: 'n', score: 99 });
        const out = pickFromReads([noRun], 'EVEN', false, true);
        expect(out.best).toBeNull();
        expect(out.watch?.symbol).toBe('n'); // shown, with its reason, but never a signal
    });
    test('the same market is picked when the rule is off', () => {
        expect(pickFromReads([base({ symbol: 'n' })], 'EVEN', false, false).best?.symbol).toBe('n');
    });
    test('the market with EEEEE is picked over a higher-confidence one without it', () => {
        const noRun = base({ symbol: 'n', score: 99 });
        const run = base({ symbol: 'r', score: 60, evidence: showsRun });
        expect(pickFromReads([noRun, run], 'EVEN', false, true).best?.symbol).toBe('r');
    });
    test('a read with no evidence attached never passes', () => {
        expect(evidenceOk(base({ evidence: null }))).toBe(false);
    });
    test('the other parity is only suggested when it has its own run', () => {
        const odd = base({ symbol: 'o', side: 'ODD', label: 'Odd', evidence: digitEvidence([2, 4, 6, 8, 0, 1], 'ODD') });
        expect(pickFromReads([odd], 'EVEN', false, true).opposite).toBeNull();
        const oddRun = base({ symbol: 'o', side: 'ODD', label: 'Odd', evidence: digitEvidence([2, 1, 3, 5, 7, 9], 'ODD') });
        expect(pickFromReads([oddRun], 'EVEN', false, true).opposite?.symbol).toBe('o');
    });
    test('the live assessment ignores markets without the run when counting how steadily they were ready', () => {
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
