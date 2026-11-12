import { mulberry32 } from '../../sixfold/stats';
import { appendTick, assessOverlord, OverlordAssessment, STEADY_SHARE } from '../assess';
import { type MarketSeries, type OverlordRead, type OverlordScan, scanOverlord } from '../engine';
import { lastDigit } from '../legacy';

const market = (seed: number, n: number): MarketSeries => {
    const r = mulberry32(seed);
    const prices: number[] = [];
    const digits: number[] = [];
    let p = 1000;
    for (let i = 0; i < n; i += 1) {
        p += (r() - 0.5) * 2;
        const rounded = Math.round(p * 100) / 100;
        prices.push(rounded);
        digits.push(lastDigit(rounded, 2));
    }
    return { prices, digits, decimals: 2 };
};

const SYMBOLS = ['R_10', 'R_25', 'R_50'];
const data = () => Object.fromEntries(SYMBOLS.map((s, i) => [s, market(40 + i, 1500)]));

/** A socket that answers the subscribe requests with ticks, like Deriv's. */
const fakeSocket = (symbols: string[], opts: { silent?: boolean } = {}) => (_url: string) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let q = 1000;
    const ws: any = {
        onopen: null,
        onmessage: null,
        onerror: null,
        send: () => undefined,
        close: () => clearInterval(timer),
    };
    setTimeout(() => {
        ws.onopen?.({});
        if (opts.silent) return;
        timer = setInterval(() => {
            for (const symbol of symbols) {
                q += 0.37;
                ws.onmessage?.({ data: JSON.stringify({ tick: { symbol, quote: Number(q.toFixed(2)), pip_size: 2 } }) });
            }
        }, 20);
    }, 0);
    return ws;
};

describe('appendTick', () => {
    it('keeps the trailing zero by using the market precision', () => {
        const s = { prices: [] as number[], digits: [] as number[], decimals: 2 };
        expect(appendTick(s, 'R_10', 1234.5, 2)).toBe(true);
        expect(s.digits).toEqual([0]);
    });
    it('ignores a tick that is not a number', () => {
        const s = { prices: [] as number[], digits: [] as number[] };
        expect(appendTick(s, 'R_10', 'x')).toBe(false);
        expect(s.prices).toHaveLength(0);
    });
    it('never holds more than 5000 ticks', () => {
        const s = { prices: Array(5000).fill(1), digits: Array(5000).fill(1), decimals: 2 };
        appendTick(s, 'R_10', 2.34, 2);
        expect(s.prices).toHaveLength(5000);
        expect(s.digits[4999]).toBe(4);
    });
});

describe('OverlordAssessment', () => {
    const scanOf = (): OverlordScan => scanOverlord({ series: data(), symbols: SYMBOLS, side: 'UNDER', barrier: 7, fluctuationTop: 0 });

    it('leaves a single-round scan unchanged', () => {
        const a = new OverlordAssessment();
        const s = scanOf();
        a.observe(s);
        expect(a.finalize(s)).toBe(s);
    });

    it('downgrades a STRONG contract that was not clear in enough rounds, and records how steady each one was', () => {
        const a = new OverlordAssessment();
        const base = scanOf();
        const top = base.reads.find(r => !r.thin)!;
        const forged = (vetoed: boolean): OverlordScan => ({
            ...base,
            reads: base.reads.map(r => (r === top ? ({ ...r, vetoed, tier: vetoed ? 'CAUTION' : 'STRONG' } as OverlordRead) : r)),
        });
        // clear in 1 of 4 rounds = 25%, below STEADY_SHARE
        a.observe(forged(false));
        a.observe(forged(true));
        a.observe(forged(true));
        a.observe(forged(true));
        const out = a.finalize(forged(false));
        const read = out.reads.find(r => r.symbol === top.symbol && r.side === top.side && r.barrier === top.barrier)!;
        expect(read.steady?.rounds).toBe(4);
        expect(read.steady?.clearShare).toBeCloseTo(0.25, 5);
        expect(0.25).toBeLessThan(STEADY_SHARE);
        expect(read.tier).toBe('BEST');
    });
});

describe('assessOverlord', () => {
    it('watches live ticks for the whole window, scans several times, and only then answers', async () => {
        const t0 = Date.now();
        const rounds: number[] = [];
        const out = await assessOverlord({
            series: data(),
            symbols: SYMBOLS,
            side: 'UNDER',
            barrier: 7,
            url: 'ws://test',
            assessMs: 700,
            roundMs: 200,
            createSocket: fakeSocket(SYMBOLS),
            onProgress: p => rounds.push(p.rounds),
        });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(690);
        expect(out.liveTicks).toBe(true);
        expect(out.ticks).toBeGreaterThan(10);
        expect(out.rounds).toBeGreaterThanOrEqual(2);
        expect(out.scan.best).not.toBeNull();
        expect(out.scan.best?.steady?.rounds).toBe(out.rounds);
        expect(Math.max(...rounds)).toBe(out.rounds);
    });

    it('does not wait out the whole window when no live tick arrives', async () => {
        const t0 = Date.now();
        const out = await assessOverlord({
            series: data(),
            symbols: SYMBOLS,
            side: 'UNDER',
            barrier: 7,
            url: 'ws://test',
            assessMs: 3000,
            roundMs: 200,
            createSocket: fakeSocket(SYMBOLS, { silent: true }),
        });
        expect(out.liveTicks).toBe(false);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(out.scan.best).not.toBeNull(); // still answers from the history
    });

    it('stops at once when cancelled and returns no market', async () => {
        let stop = false;
        setTimeout(() => (stop = true), 150);
        const out = await assessOverlord({
            series: data(),
            symbols: SYMBOLS,
            side: 'UNDER',
            barrier: 7,
            url: 'ws://test',
            assessMs: 5000,
            roundMs: 200,
            createSocket: fakeSocket(SYMBOLS),
            cancelled: () => stop,
        });
        expect(out.cancelled).toBe(true);
        expect(out.scan.best).toBeNull();
    });
});
