import { fetchHistories, seriesFromHistory } from '../history';

class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: { ticks_history: string; req_id: number; count: number }[] = [];
    constructor(private answer: (req: { ticks_history: string; req_id: number }) => object | null) {
        setTimeout(() => this.onopen?.(), 0);
    }
    send(raw: string) {
        const req = JSON.parse(raw);
        this.sent.push(req);
        const reply = this.answer(req);
        if (reply) setTimeout(() => this.onmessage?.({ data: JSON.stringify({ req_id: req.req_id, ...reply }) }), 0);
    }
    close() {
        this.onclose?.();
    }
}

describe('seriesFromHistory', () => {
    it('keeps a trailing zero by using Deriv pip_size', () => {
        const s = seriesFromHistory('R_100', { history: { prices: [1234.5, 99.07] }, pip_size: 2 });
        expect(s?.digits).toEqual([0, 7]);
    });
    it('falls back to the market precision Overlord always assumed', () => {
        expect(seriesFromHistory('R_50', { history: { prices: [10.1234] } })?.digits).toEqual([4]);
    });
    it('returns null without prices', () => {
        expect(seriesFromHistory('R_10', {})).toBeNull();
        expect(seriesFromHistory('R_10', { history: { prices: [] } })).toBeNull();
    });
});

describe('fetchHistories', () => {
    it('asks for the whole history of every market over one socket and reports each as it lands', async () => {
        const sockets: FakeSocket[] = [];
        const seen: string[] = [];
        const out = await fetchHistories('wss://x', ['R_10', 'R_25'], {
            createSocket: () => {
                const s = new FakeSocket(() => ({ history: { prices: [1.001, 1.002, 1.003] }, pip_size: 3 }));
                sockets.push(s);
                return s as unknown as WebSocket;
            },
            onResult: r => seen.push(r.symbol),
        });
        expect(sockets).toHaveLength(1);
        expect(sockets[0].sent.map(r => r.count)).toEqual([5000, 5000]);
        expect(out.every(r => r.status === 'success')).toBe(true);
        expect(seen.sort()).toEqual(['R_10', 'R_25']);
    });

    it('retries only the markets that failed', async () => {
        const asked: string[][] = [];
        let round = 0;
        const out = await fetchHistories('wss://x', ['R_10', 'R_25'], {
            attempts: 2,
            createSocket: () => {
                const thisRound = round;
                const mySocket = new FakeSocket(req => {
                    if (thisRound === 0 && req.ticks_history === 'R_25') return { error: { code: 'RateLimit' } };
                    return { history: { prices: [1.001, 1.002] }, pip_size: 3 };
                });
                round += 1;
                asked.push([]);
                const orig = mySocket.send.bind(mySocket);
                mySocket.send = (raw: string) => {
                    asked[asked.length - 1].push(JSON.parse(raw).ticks_history);
                    orig(raw);
                };
                return mySocket as unknown as WebSocket;
            },
        });
        expect(asked[0].sort()).toEqual(['R_10', 'R_25']);
        expect(asked[1]).toEqual(['R_25']);
        expect(out.find(r => r.symbol === 'R_25')?.status).toBe('success');
    });

    it('reports a market that never answers as a timeout instead of hanging', async () => {
        const out = await fetchHistories('wss://x', ['R_10'], {
            attempts: 1,
            timeoutMs: 50,
            createSocket: () => new FakeSocket(() => null) as unknown as WebSocket,
        });
        expect(out[0].status).toBe('timeout');
        expect(out[0].series).toBeNull();
    });
});
