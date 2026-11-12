import { resetParityMemory } from '../parity/engine';
import {
    appendLiveTick,
    assessParity,
    PARITY_STEADY_SHARE,
    ParityAssessment,
} from '../parity-assess';
import { type ParityRead, type ParityScan, type ParitySeries, pickFromReads, scanParity } from '../parity-engine';

const rng = (seed: number) => {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const market = (seed: number, n: number, pEven = 0.5): ParitySeries => {
    const r = rng(seed);
    const digits: number[] = [];
    for (let i = 0; i < n; i += 1) {
        const pick = Math.floor(r() * 5);
        digits.push(r() < pEven ? pick * 2 : pick * 2 + 1);
    }
    return { prices: digits, digits, decimals: 2 };
};

const SYMBOLS = ['R_10', 'R_25', 'R_50'];
const data = () => Object.fromEntries(SYMBOLS.map((s, i) => [s, market(40 + i, 1500, 0.5 + i * 0.05)]));

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

beforeEach(() => {
    resetParityMemory();
    const next = rng(77);
    jest.spyOn(Math, 'random').mockImplementation(next);
});
afterEach(() => {
    jest.restoreAllMocks();
});

describe('appendLiveTick', () => {
    it('keeps the trailing zero by using the market precision', () => {
        const s = { prices: [] as number[], digits: [] as number[], decimals: 2 };
        expect(appendLiveTick(s, 'R_10', 1234.5, 2)).toBe(true);
        expect(s.digits).toEqual([0]);
    });
    it('ignores a tick that is not a number', () => {
        const s = { prices: [] as number[], digits: [] as number[] };
        expect(appendLiveTick(s, 'R_10', 'x')).toBe(false);
        expect(s.prices).toHaveLength(0);
    });
    it('never holds more than 5000 ticks', () => {
        const s = { prices: Array(5000).fill(1), digits: Array(5000).fill(1), decimals: 2 };
        appendLiveTick(s, 'R_10', 2.34, 2);
        expect(s.prices).toHaveLength(5000);
        expect(s.digits[4999]).toBe(4);
    });
});

describe('ParityAssessment', () => {
    /** A scan in which the first market is READY for EVEN (or not), the rest as Parity left them. */
    const forged = (base: ParityScan, ready: boolean): ParityScan => {
        const reads: ParityRead[] = base.reads.map((r, i) =>
            i === 0
                ? ({
                      ...r,
                      side: 'EVEN',
                      label: 'Even',
                      ready,
                      state: ready ? 'READY' : 'BUILDING',
                      tier: ready ? 'STRONG' : 'CAUTION',
                  } as ParityRead)
                : ({ ...r, ready: false, state: 'MONITORING', tier: 'CAUTION' } as ParityRead)
        );
        return { reads, ...pickFromReads(reads, 'EVEN') };
    };
    const baseScan = () => scanParity({ series: data(), symbols: SYMBOLS, side: 'EVEN' });

    it('leaves a single-round scan unchanged', () => {
        const a = new ParityAssessment('EVEN');
        const s = baseScan();
        a.observe(s);
        expect(a.finalize(s)).toBe(s);
    });

    it('keeps STRONG for a market READY in enough rounds and records how steady it was', () => {
        const a = new ParityAssessment('EVEN');
        const base = baseScan();
        for (let i = 0; i < 4; i += 1) a.observe(forged(base, true));
        const out = a.finalize(forged(base, true));
        const top = out.reads[0];
        expect(top.ready).toBe(true);
        expect(top.tier).toBe('STRONG');
        expect(top.steady).toEqual({ rounds: 4, clearShare: 1, topShare: 1 });
        expect(out.best?.symbol).toBe(top.symbol);
    });

    it('downgrades a READY market that was READY in too few rounds to BEST, without changing its verdict or score', () => {
        const a = new ParityAssessment('EVEN');
        const base = baseScan();
        // READY in 1 of 4 rounds = 25%, below PARITY_STEADY_SHARE
        a.observe(forged(base, true));
        a.observe(forged(base, false));
        a.observe(forged(base, false));
        a.observe(forged(base, false));
        const final = forged(base, true);
        const out = a.finalize(final);
        const top = out.reads.find(r => r.symbol === final.reads[0].symbol)!;
        expect(top.tier).toBe('BEST');
        expect(top.steady?.clearShare).toBe(0.25);
        expect(0.25).toBeLessThan(PARITY_STEADY_SHARE);
        expect(top.ready).toBe(true);
        expect(top.score).toBe(final.reads[0].score);
        expect(top.state).toBe('READY');
    });

    it('leaves markets that are not READY exactly as Parity gave them', () => {
        const a = new ParityAssessment('EVEN');
        const base = baseScan();
        for (let i = 0; i < 3; i += 1) a.observe(forged(base, true));
        const final = forged(base, true);
        const out = a.finalize(final);
        for (const r of out.reads.filter(x => !x.ready)) {
            const before = final.reads.find(x => x.symbol === r.symbol)!;
            expect(r).toBe(before);
        }
    });

    it('does not count rounds from a scan that only had the original condition', () => {
        const a = new ParityAssessment('EVEN');
        const thin = scanParity({ series: { R_10: market(5, 100) }, symbols: ['R_10'], side: 'EVEN' });
        a.observe(thin);
        expect(a.rounds).toBe(0);
    });
});

describe('assessParity', () => {
    it('watches live ticks, re-runs Parity each round, and answers from a final scan on the grown series', async () => {
        const series = data();
        const before = series.R_10.digits.length;
        const out = await assessParity({
            series,
            symbols: SYMBOLS,
            side: 'EVEN',
            url: 'wss://example.test',
            assessMs: 400,
            roundMs: 100,
            createSocket: fakeSocket(SYMBOLS),
        });
        expect(out.liveTicks).toBe(true);
        expect(out.ticks).toBeGreaterThan(0);
        expect(out.rounds).toBeGreaterThan(0);
        expect(out.cancelled).toBe(false);
        expect(out.scan.legacyOnly).toBe(false);
        expect(out.scan.evaluated).toBe(SYMBOLS.length);
        // the history handed in is left alone
        expect(series.R_10.digits).toHaveLength(before);
        // the answer is only ever a READY market of the chosen parity
        if (out.scan.best) {
            expect(out.scan.best.ready).toBe(true);
            expect(out.scan.best.side).toBe('EVEN');
        }
    });

    it('reports progress while it watches', async () => {
        const seen: number[] = [];
        await assessParity({
            series: data(),
            symbols: SYMBOLS,
            side: null,
            url: 'wss://example.test',
            assessMs: 300,
            roundMs: 100,
            createSocket: fakeSocket(SYMBOLS),
            onProgress: p => seen.push(p.elapsedMs),
        });
        expect(seen.length).toBeGreaterThan(2);
        expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(seen[0]);
    });

    it('answers from the history alone when no live tick arrives', async () => {
        const out = await assessParity({
            series: data(),
            symbols: SYMBOLS,
            side: 'ODD',
            url: 'wss://example.test',
            assessMs: 300,
            // longer than a third of the window: with no live tick the watch ends before the first round
            roundMs: 200,
            createSocket: fakeSocket(SYMBOLS, { silent: true }),
        });
        expect(out.liveTicks).toBe(false);
        expect(out.rounds).toBe(0);
        expect(out.scan.evaluated).toBe(SYMBOLS.length);
    });

    it('stops at once when cancelled and returns no market', async () => {
        const out = await assessParity({
            series: data(),
            symbols: SYMBOLS,
            side: 'EVEN',
            url: 'wss://example.test',
            assessMs: 5000,
            roundMs: 100,
            createSocket: fakeSocket(SYMBOLS),
            cancelled: () => true,
        });
        expect(out.cancelled).toBe(true);
        expect(out.scan.best).toBeNull();
        expect(out.scan.reads).toHaveLength(0);
    });
});
