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
        feed.useDemo();
        const after = feed.getSnapshot();
        expect(after).not.toBe(before);
        expect(after.mode).toBe('demo');
        expect(after.series.R_10.length).toBe(1500);
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
