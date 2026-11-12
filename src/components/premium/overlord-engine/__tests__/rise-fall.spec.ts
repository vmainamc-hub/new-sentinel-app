import { describe, expect, test } from 'bun:test';
import { applyOhlc, assessRiseFall } from '../rise-fall-run';
import {
    type Candle,
    connorsRsi,
    macd,
    momentum,
    readReversalVotes,
    readVotes,
    rsi,
    scanRiseFall,
    scoreSide,
    stochRsi,
    bollinger,
} from '../rise-fall';

const candlesFrom = (closes: number[]): Candle[] =>
    closes.map((c, i) => ({ open: c, high: c + 0.1, low: c - 0.1, close: c, time: i * 60 }));
const trend = (n: number, step: number, wobble = 0) =>
    Array.from({ length: n }, (_, i) => 100 + i * step + (i % 2 ? wobble : -wobble));

describe('indicators', () => {
    test('rsi is 100 on a pure rise, 0 on a pure fall, 50 when flat', () => {
        expect(rsi(trend(40, 1), 14).at(-1)).toBe(100);
        expect(rsi(trend(40, -1), 14).at(-1)).toBeCloseTo(0, 5);
        expect(rsi(trend(40, 0), 14).at(-1)).toBe(50);
    });
    test('momentum is the change over 10 bars', () => {
        expect(momentum(trend(30, 2), 10).at(-1)).toBe(20);
    });
    test('bollinger bands bracket the middle and widen with variance', () => {
        const calm = bollinger(trend(40, 0, 0.1)).at(-1)!;
        const wild = bollinger(trend(40, 0, 2)).at(-1)!;
        expect(calm.upper).toBeGreaterThan(calm.mid);
        expect(wild.upper - wild.lower).toBeGreaterThan(calm.upper - calm.lower);
    });
    test('stoch rsi and connors rsi stay within 0-100', () => {
        const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5 + (i % 7));
        for (const v of [...stochRsi(closes).k, ...connorsRsi(closes)]) {
            expect(v).toBeGreaterThanOrEqual(-1e-9);
            expect(v).toBeLessThanOrEqual(100 + 1e-9);
        }
    });
    test('macd histogram is positive in a steady rise', () => {
        expect(macd(trend(80, 1, 0.3)).hist.at(-1)!).toBeGreaterThan(-1);
    });
});

describe('votes and scan', () => {
    test('needs enough candles', () => {
        expect(readVotes(candlesFrom(trend(30, 1)))).toBeNull();
    });
    test('six votes are produced and scoring counts agree/against', () => {
        const votes = readVotes(candlesFrom(trend(150, 0.5, 0.4)))!;
        expect(votes).toHaveLength(6);
        const rise = scoreSide(votes, 'RISE');
        const fall = scoreSide(votes, 'FALL');
        expect(rise.agree + fall.agree).toBeLessThanOrEqual(6);
        expect(rise.against).toBe(fall.agree);
    });
    test('the market with the most indicators agreeing ranks first, and the side can be forced', () => {
        const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const candles: Record<string, Candle[]> = {};
        for (let m = 0; m < 8; m += 1) {
            const r = rng(m + 3);
            let p = 100;
            candles[`M${m}`] = candlesFrom(Array.from({ length: 200 }, () => (p += (r() - 0.5) * 2)));
        }
        const free = scanRiseFall({ candles });
        expect(free.evaluated).toBe(8);
        for (let i = 1; i < free.reads.length; i += 1) expect(free.reads[i - 1].agree).toBeGreaterThanOrEqual(free.reads[i].agree);
        expect(scanRiseFall({ candles, side: 'FALL' }).reads.every(r => r.side === 'FALL')).toBe(true);
    });
});

describe('live candles', () => {
    test('applyOhlc replaces the forming candle and starts the next one', () => {
        const list = candlesFrom([1, 2, 3]);
        applyOhlc(list, { open_time: 120, open: 3, high: 9, low: 3, close: 8 });
        expect(list).toHaveLength(3);
        expect(list[2].close).toBe(8);
        applyOhlc(list, { open_time: 180, open: 8, high: 8, low: 8, close: 8 });
        expect(list).toHaveLength(4);
        applyOhlc(list, { open_time: 60, open: 1, high: 1, low: 1, close: 1 }); // old candle: ignored
        expect(list).toHaveLength(4);
    });

    test('assessRiseFall loads candles over the socket, re-reads them, and returns a best market', async () => {
        const sent: string[] = [];
        let sock: any;
        const create = () => {
            sock = {
                send: (s: string) => sent.push(s),
                close: () => undefined,
                onopen: null,
                onmessage: null,
                onerror: null,
            };
            setTimeout(() => {
                sock.onopen?.({});
                sent.forEach(raw => {
                    const req = JSON.parse(raw);
                    const closes = trend(120, 0.3, 0.5 + req.req_id * 0.1);
                    sock.onmessage?.({
                        data: JSON.stringify({
                            req_id: req.req_id,
                            candles: closes.map((c, i) => ({ epoch: i * 60, open: c, high: c + 0.1, low: c - 0.1, close: c })),
                        }),
                    });
                });
            }, 0);
            return sock;
        };
        const result = await assessRiseFall({
            symbols: ['A', 'B', 'C'],
            url: 'ws://x',
            assessMs: 400,
            roundMs: 100,
            createSocket: create as any,
        });
        expect(JSON.parse(sent[0]).style).toBe('candles');
        expect(JSON.parse(sent[0]).subscribe).toBe(1);
        expect(result.loaded).toBe(3);
        expect(result.rounds).toBeGreaterThanOrEqual(2);
        expect(result.scan.best).not.toBeNull();
        expect(result.scan.best!.rounds).toBe(result.rounds);
    });

    test('stops early when nothing is delivered', async () => {
        const create = () => ({ send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onerror: null });
        const t0 = Date.now();
        const result = await assessRiseFall({ symbols: ['A'], url: 'ws://x', assessMs: 900, roundMs: 100, createSocket: create as any });
        expect(result.scan.best).toBeNull();
        expect(Date.now() - t0).toBeLessThan(800);
    });
});

describe('reversal style', () => {
    // A steady climb that then slows: small candles, then a candle closing against the move.
    const climbThenStall = () => {
        const closes = [...trend(100, 0.5), ...[0.45, 0.4, 0.3, 0.2, 0.1, 0.05, -0.1, -0.05, 0.0].map((d, i) => 149.5 + d * (i + 1) * 0.1)];
        return closes.map((c, i, a) => {
            const prev = i ? a[i - 1] : c;
            const big = i < 100 ? 0.5 : 0.1;
            return { open: prev, close: c, high: Math.max(prev, c) + big * 0.2, low: Math.min(prev, c) - big * 0.2, time: i * 60 };
        });
    };
    const climbForever = () => {
        const closes = trend(120, 0.6);
        return closes.map((c, i, a) => ({ open: i ? a[i - 1] : c, close: c, high: c + 0.1, low: (i ? a[i - 1] : c) - 0.1, time: i * 60 }));
    };

    test('a stalling climb reads as a FALL reversal with several indicators agreeing', () => {
        const r = readReversalVotes(climbThenStall())!;
        expect(r.prior).toBe('RISE');
        expect(r.votes).toHaveLength(7);
        expect(scoreSide(r.votes, 'FALL').agree).toBeGreaterThanOrEqual(3);
        const scan = scanRiseFall({ candles: { A: climbThenStall() }, style: 'reversal' });
        expect(scan.best!.side).toBe('FALL');
        expect(scan.best!.setup).toBe(true);
    });
    test('a climb still gathering pace is not a reversal point', () => {
        const scan = scanRiseFall({ candles: { A: climbForever() }, style: 'reversal' });
        expect(scan.best!.setup).toBe(false);
        expect(scan.best!.agree).toBeLessThan(3);
    });
    test('a forced side that is the same as the move is never a reversal point', () => {
        const scan = scanRiseFall({ candles: { A: climbThenStall() }, style: 'reversal', side: 'RISE' });
        expect(scan.best!.setup).toBe(false);
        expect(scan.best!.agree).toBe(0);
    });
    test('a flat market has no move to reverse', () => {
        const flat = Array.from({ length: 120 }, (_, i) => ({ open: 100, close: 100 + (i % 2 ? 0.01 : -0.01), high: 100.2, low: 99.8, time: i * 60 }));
        expect(readReversalVotes(flat)!.prior).toBeNull();
        expect(scanRiseFall({ candles: { A: flat }, style: 'reversal' }).best!.setup).toBe(false);
    });
});
