import { SixfoldFeed, SYMBOLS } from '../feed';

class FakeSocket {
    static all: FakeSocket[] = [];
    sent: string[] = [];
    closed = false;
    onopen: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    constructor(public url: string) {
        FakeSocket.all.push(this);
    }
    send(d: string) {
        this.sent.push(d);
    }
    close() {
        this.closed = true;
    }
    emit(msg: unknown) {
        this.onmessage?.({ data: JSON.stringify(msg) });
    }
}

const history = (symbol: string, prices: number[]) => ({
    msg_type: 'history',
    echo_req: { ticks_history: symbol },
    pip_size: 2,
    history: { prices },
});

describe('SixfoldFeed', () => {
    beforeEach(() => {
        FakeSocket.all = [];
    });

    it('subscribes to every market on open, then turns history and ticks into digits', () => {
        let t = 1000;
        const feed = new SixfoldFeed(url => new FakeSocket(url), () => t);
        feed.connect();
        const ws = FakeSocket.all[0];
        ws.onopen?.();
        expect(ws.sent).toHaveLength(SYMBOLS.length);
        expect(feed.isLive()).toBe(true);
        ws.emit(history('R_100', [100.11, 100.27, 100.3]));
        expect(feed.getLiveSeries().R_100).toEqual([1, 7, 0]);
        const seen: Array<[string, number]> = [];
        feed.onTick((s, d) => seen.push([s, d]));
        ws.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 100.45, pip_size: 2 } });
        expect(seen).toEqual([['R_100', 5]]);
        expect(feed.getLastDigit('R_100')).toBe(5);
        expect(feed.getLastTickAt('R_100')).toBe(1000);
    });

    it('publishes immutable snapshots for the UI', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        feed.connect();
        const ws = FakeSocket.all[0];
        ws.onopen?.();
        const before = feed.getSnapshot();
        ws.emit(history('R_10', [1.01, 1.02]));
        feed.importDigits('R_10', '1 2 3');
        const after = feed.getSnapshot();
        expect(after).not.toBe(before);
        expect(after.mode).toBe('import');
        expect(after.series.R_10).toEqual([1, 2, 3]);
    });

    it('starts empty and live-only: no demo or simulated digits before Deriv sends anything', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        const snap = feed.getSnapshot();
        expect(snap.mode).toBe('live');
        expect(snap.status).toBe('offline');
        expect(snap.series).toEqual({});
        expect(feed.getLiveSeries()).toEqual({});
        expect(feed.isLive()).toBe(false);
        expect('useDemo' in feed).toBe(false);
    });

    it('falls back to the second endpoint when the first cannot open', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        feed.connect();
        FakeSocket.all[0].onerror?.();
        expect(FakeSocket.all).toHaveLength(2);
        expect(FakeSocket.all[1].url).not.toBe(FakeSocket.all[0].url);
    });

    it('reports an error when no endpoint can be reached', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        feed.connect();
        FakeSocket.all[0].onerror?.();
        FakeSocket.all[1].onerror?.();
        expect(feed.getSnapshot().status).toBe('error');
        expect(feed.getSnapshot().error).toMatch(/Could not reach Deriv/);
    });

    it('stop closes the socket and ignores late messages', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        feed.connect();
        const ws = FakeSocket.all[0];
        ws.onopen?.();
        feed.stop();
        expect(ws.closed).toBe(true);
        expect(feed.getStatus()).toBe('offline');
    });

    it('parses pasted digits and rejects junk', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        feed.importDigits('R_10', '1 4 7 2 4');
        expect(feed.getSnapshot().mode).toBe('import');
        expect(feed.getLiveSeries().R_10).toEqual([1, 4, 7, 2, 4]);
        feed.importDigits('R_10', '1 44');
        expect(feed.getSnapshot().error).toMatch(/digits 0/);
    });
});

describe('SixfoldFeed snapshots after wholesale replacement', () => {
    it('re-importing in import mode publishes the new digits, not a stale copy', () => {
        const feed = new SixfoldFeed(url => new FakeSocket(url));
        feed.importDigits('R_10', '1 2 3');
        feed.importDigits('R_10', '9 8 7 6');
        expect(feed.getSnapshot().series.R_10).toEqual([9, 8, 7, 6]);
    });
});

describe('SixfoldFeed per-market ticks and telemetry', () => {
    beforeEach(() => {
        FakeSocket.all = [];
    });
    const open = () => {
        let t = 1_000_000;
        const feed = new SixfoldFeed(url => new FakeSocket(url), () => t);
        feed.connect();
        const ws = FakeSocket.all[0];
        ws.onopen?.();
        return { feed, ws, advance: (ms: number) => (t += ms) };
    };
    const tick = (symbol: string, quote: number, epoch: number) => ({ msg_type: 'tick', tick: { symbol, quote, pip_size: 2, epoch } });

    it('measures each market at its own rate: 1s indices every second, plain indices every two', () => {
        const { feed, ws, advance } = open();
        ws.emit({ ...history('1HZ10V', [10.01]), history: { prices: [10.01], times: [1000] } });
        ws.emit({ ...history('R_10', [10.01]), history: { prices: [10.01], times: [1000] } });
        for (let s = 1; s <= 20; s++) {
            advance(1000);
            ws.emit(tick('1HZ10V', 10 + s / 100, 1000 + s));
            if (s % 2 === 0) ws.emit(tick('R_10', 10 + s / 100, 1000 + s));
        }
        const tel = Object.fromEntries(feed.getTelemetry().map(x => [x.symbol, x]));
        expect(tel['1HZ10V'].measured).toBe(1);
        expect(tel['R_10'].measured).toBe(2);
        expect(tel['1HZ10V'].expected).toBe(1);
        expect(tel['R_10'].expected).toBe(2);
        expect(tel['1HZ10V'].accepted).toBe(20);
        expect(tel['R_10'].accepted).toBe(10);
        expect(feed.getLiveSeries()['1HZ10V']).toHaveLength(21);
        expect(feed.getLiveSeries()['R_10']).toHaveLength(11);
        expect(tel['1HZ10V'].lastMinute).toBe(20);
        expect(tel['R_10'].lastMinute).toBe(10);
    });

    it('never lets a tick for one market change another, and ignores markets it does not track', () => {
        const { feed, ws } = open();
        ws.emit(history('R_10', [1.11, 1.22]));
        ws.emit(history('R_25', [2.33]));
        ws.emit(tick('R_10', 1.37, 5));
        expect(feed.getLiveSeries().R_10).toEqual([1, 2, 7]);
        expect(feed.getLiveSeries().R_25).toEqual([3]);
        ws.emit(tick('frxEURUSD', 1.5, 6));
        expect(feed.getLiveSeries().frxEURUSD).toBeUndefined();
        expect(feed.getTelemetry()[0].foreign).toBe(1);
    });

    it('drops a tick that repeats or goes backwards in Deriv time', () => {
        const { feed, ws } = open();
        ws.emit({ ...history('R_50', [5.01]), history: { prices: [5.01], times: [100] } });
        ws.emit(tick('R_50', 5.12, 102));
        ws.emit(tick('R_50', 5.12, 102)); // the same tick delivered twice
        ws.emit(tick('R_50', 5.99, 101)); // older than the last one
        ws.emit(tick('R_50', 5.23, 104));
        expect(feed.getLiveSeries().R_50).toEqual([1, 2, 3]);
        const t = feed.getTelemetry().find(x => x.symbol === 'R_50')!;
        expect(t.accepted).toBe(2);
        expect(t.dropped).toBe(2);
    });

    it('does not fire tick listeners for a dropped repeat', () => {
        const { feed, ws } = open();
        const seen: number[] = [];
        feed.onTick((_s, d) => seen.push(d));
        ws.emit(tick('R_75', 7.11, 10));
        ws.emit(tick('R_75', 7.11, 10));
        expect(seen).toEqual([1]);
    });
});
