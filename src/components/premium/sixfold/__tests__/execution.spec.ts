import { DEFAULT_SETTINGS, normalizeSettings, type SixfoldSettings } from '../money';
import { ALL_MARKETS, ALL_SYMBOLS, SIXFOLD_SYMBOLS } from '../markets';
import { expectedTickSeconds, marketName, MARKETS, shortName, SixfoldFeed, SYMBOLS } from '../feed';
import { VANGUARD_DEFAULTS, VANGUARD_MODULE_ID } from '../../vanguard/vanguard-settings';
import { type RunnerIO, SixfoldRunner } from '../runner';
import { pickBest, rankedPicks, scanMarkets } from '../scanner';
import { DEFAULT_BOT } from '../bot';

// Markets where Over 2 wins on every simulated trade (1 -> 7 -> 1 ...), so the scanner finds them at once. A, B and C are
// identical in quality; only the order their entry digit shows up differs.
const planted = Array.from({ length: 600 }, (_, i) => (i % 2 === 0 ? 1 : 7));
const noise = (seed: number) => {
    let a = seed;
    return Array.from({ length: 600 }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
};

function harness(over: Partial<SixfoldSettings> = {}, io: Partial<RunnerIO> & { offered?: (s: string, t: string) => boolean | null } = {}) {
    let t = 1_000_000;
    const series: Record<string, number[]> = { A: planted.slice(), B: planted.slice(), JD50: planted.slice(), N: noise(5) };
    const lastTick: Record<string, number> = { A: t, B: t, JD50: t, N: t };
    const calls = { buy: [] as any[] };
    let nextId = 100;
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: {
            run_id: '',
            setIsRunning() {},
            setRunId(id: string) {
                this.run_id = id;
            },
            setContractStage() {},
            toggleDrawer() {},
            setHasOpenContract() {},
            setShowBotStopMessage() {},
            onBotContractEvent() {},
        },
        summary_card: { onBotContractEvent() {} },
        transactions: { pushTransaction() {} },
        dashboard: {
            active_trading_module: null as string | null,
            setActiveTradingModule(id: string | null) {
                this.active_trading_module = id;
            },
            handlers: [] as string[],
            registerTradingStopHandler(id: string) {
                this.handlers.push(id);
            },
            unregisterTradingStopHandler() {},
            stopActiveTradingModule() {},
        },
    };
    const profitQueue: number[] = [];
    const runner = new SixfoldRunner({
        feed: {
            getLiveSeries: () => series,
            getLastTickAt: s => lastTick[s] ?? null,
            getLastDigit: s => series[s]?.at(-1) ?? null,
            isLive: () => true,
            getSnapshot: () => ({ mode: 'live', status: 'live', error: '', series, version: 1 }),
            connect: () => {},
            isOffered: io.offered,
            getUnavailable: () => [],
        },
        buy: async ({ parameters, price }) => {
            calls.buy.push({ parameters, price });
            return { buy_price: price, contract_id: nextId++, transaction_id: 1 };
        },
        settle: async ({ fallback }) => {
            const profit = profitQueue.length ? profitQueue.shift()! : 0.35;
            return { ...fallback, is_sold: 1, status: profit < 0 ? 'lost' : 'won', profit };
        },
        isAuthorized: () => true,
        currency: () => 'USD',
        afterStop: () => {},
        now: () => t,
        loadSettings: () => ({
            ...DEFAULT_SETTINGS,
            execution: 'FIRST',
            entry: 'SMART',
            markets: ['A', 'B', 'JD50', 'N'],
            selectivity: 'strict',
            lossShield: false,
            pickyAfterLoss: false,
            meterGuide: false,
            winStreakGate: false,
            pressureGate: false,
            multiWindowGate: false,
            winPressureGate: false,
            vhOpening: false,
            takeProfit: 0,
            stopLoss: 0,
            ...over,
        }),
        saveSettings: () => {},
        ...io,
    });
    runner.attach(stores);
    return {
        runner,
        stores,
        calls,
        series,
        profits: (...p: number[]) => profitQueue.push(...p),
        stale: (symbol: string) => (lastTick[symbol] = t - 60_000),
        advance: (ms: number) => {
            t += ms;
            Object.keys(lastTick).forEach(k => (lastTick[k] = t));
        },
    };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('Markets and tool separation', () => {
    it('Sixfold is unchanged: its own ten markets, best-score execution', () => {
        expect(SYMBOLS).toEqual(SIXFOLD_SYMBOLS);
        expect(SIXFOLD_SYMBOLS).toHaveLength(10);
        expect(MARKETS.map(m => m[0])).toEqual(SIXFOLD_SYMBOLS);
        expect(SYMBOLS.some(s => s.startsWith('JD'))).toBe(false);
        expect(DEFAULT_SETTINGS.markets).toEqual(SIXFOLD_SYMBOLS);
        expect(DEFAULT_SETTINGS.execution).toBe('BEST');
    });

    it('Vanguard covers every market, the Jump indices included, with the bot\'s contract and recovery', () => {
        expect(ALL_SYMBOLS).toHaveLength(new Set(ALL_SYMBOLS).size);
        ['JD10', 'JD25', 'JD50', 'JD75', 'JD100', '1HZ15V', '1HZ30V', '1HZ90V'].forEach(s => expect(ALL_SYMBOLS).toContain(s));
        SIXFOLD_SYMBOLS.forEach(s => expect(ALL_SYMBOLS).toContain(s));
        expect(VANGUARD_DEFAULTS.markets).toEqual(ALL_SYMBOLS);
        expect(VANGUARD_DEFAULTS.execution).toBe('FIRST');
        expect(ALL_MARKETS.map(m => m[0])).toEqual(ALL_SYMBOLS);
        // the bot's contract and recovery, with Sixfold's own caps on the recovery stake kept
        // four contracts: Under 7 (recovery Under 6) and the mirrored Over 2 (recovery Over 3)
        expect([VANGUARD_DEFAULTS.useUnder, VANGUARD_DEFAULTS.primaryUnder, VANGUARD_DEFAULTS.recoveryUnder]).toEqual([true, 7, 6]);
        expect([VANGUARD_DEFAULTS.useOver, VANGUARD_DEFAULTS.primaryOver, VANGUARD_DEFAULTS.recoveryOver]).toEqual([true, 2, 3]);
        expect(VANGUARD_DEFAULTS.recovery).toBe(true);
        expect([VANGUARD_DEFAULTS.martingale, VANGUARD_DEFAULTS.recoverySizing, VANGUARD_DEFAULTS.recoverShare]).toEqual([true, 'PAYOUT', 50]);
        expect(VANGUARD_DEFAULTS.maxSteps).toBe(DEFAULT_SETTINGS.maxSteps);
        expect(VANGUARD_DEFAULTS.streakBudget).toBe(DEFAULT_SETTINGS.streakBudget);
        expect([VANGUARD_DEFAULTS.virtualMode, VANGUARD_DEFAULTS.virtualLosses, VANGUARD_DEFAULTS.gateMin]).toEqual([false, 2, 1]);
    });

    it('names the Jump indices clearly and does not invent a documented tick rate for them', () => {
        expect(shortName('JD50')).toBe('J50');
        expect(marketName('JD50')).toBe('Jump 50');
        expect(shortName('1HZ25V')).toBe('V25·1s');
        expect(shortName('R_100')).toBe('V100');
        expect(expectedTickSeconds('1HZ10V')).toBe(1);
        expect(expectedTickSeconds('R_10')).toBe(2);
        expect(expectedTickSeconds('JD25')).toBeNull();
    });

    it('execution mode is normalised against the tool defaults', () => {
        expect(normalizeSettings({ execution: 'FIRST' }).execution).toBe('FIRST');
        expect(normalizeSettings({ execution: 'nonsense' as never }).execution).toBe('BEST');
        expect(normalizeSettings({}).execution).toBe('BEST');
        expect(normalizeSettings({ execution: 'nonsense' as never }, VANGUARD_DEFAULTS).execution).toBe('FIRST');
        expect(normalizeSettings({ markets: [] }, VANGUARD_DEFAULTS).markets).toEqual(ALL_SYMBOLS);
    });

    it('Vanguard trades under its own module id and its own shortcode, never Sixfold\'s', async () => {
        const h = harness({}, { moduleId: VANGUARD_MODULE_ID, defaults: VANGUARD_DEFAULTS });
        h.runner.start();
        expect(h.stores.dashboard.handlers).toEqual(['vanguard']);
        expect(h.stores.dashboard.active_trading_module).toBe('vanguard');
        const w = h.runner.getSnapshot().watching[0];
        h.runner.handleFeedTick(w.symbol, w.entryDigits[0]);
        await flush();
        expect(h.calls.buy[0].parameters.symbol).toBe(w.symbol);
        const sixfold = harness();
        sixfold.runner.start();
        expect(sixfold.stores.dashboard.handlers).toEqual(['sixfold']);
    });
});

describe('Scanner: ranked picks', () => {
    const scan = () =>
        scanMarkets({ A: planted, B: planted, N: noise(5) }, ['A', 'B', 'N'], { ...DEFAULT_BOT, entry: { mode: 'SETUP' } }, 1, [{ side: 'OVER', param: 2 }]);

    it('pickBest is exactly the first ranked pick', () => {
        const s = scan();
        const ranked = rankedPicks(s, 'strict', { mode: 'SETUP' });
        expect(ranked.length).toBeGreaterThan(1);
        expect(pickBest(s, 'strict', { mode: 'SETUP' })?.cell.symbol).toBe(ranked[0].cell.symbol);
        // best score first
        for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].cell.score).toBeGreaterThanOrEqual(ranked[i].cell.score);
    });

    it('a contract the market does not offer is never executable, so never picked', () => {
        const s = scanMarkets({ A: planted, B: planted }, ['A', 'B'], { ...DEFAULT_BOT, entry: { mode: 'SETUP' } }, 1, [{ side: 'OVER', param: 2 }], symbol => symbol !== 'A');
        expect(s.cells.find(c => c.symbol === 'A')?.executable).toBe(false);
        expect(rankedPicks(s, 'strict', { mode: 'SETUP' }).map(p => p.cell.symbol)).toEqual(['B']);
    });
});

describe('SixfoldRunner: first to qualify', () => {
    it('watches every qualifying contract on every market at once, not just one', () => {
        const h = harness();
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.phase).toBe('watching');
        expect(s.armed).toBeNull();
        const symbols = new Set(s.watching.map(w => w.symbol));
        expect(symbols.has('A') && symbols.has('B') && symbols.has('JD50')).toBe(true);
        expect(symbols.has('N')).toBe(false); // random noise does not qualify: the rules are not lowered
        expect(s.watching.every(w => /^(Over 2|Under 7)$/.test(w.label))).toBe(true);
    });

    it('buys on whichever market shows its entry digit first, even when it is not the best-scoring one', async () => {
        const h = harness();
        h.runner.start();
        const before = h.runner.getSnapshot().watching.map(w => `${w.symbol}:${w.entryDigits.join('/')}`);
        expect(before.length).toBeGreaterThan(2);
        // A market that is watched but whose entry digit has not appeared does nothing...
        const first = h.runner.getSnapshot().watching.find(w => w.symbol === 'JD50')!;
        const wrong = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find(d => !first.entryDigits.includes(d))!;
        h.runner.handleFeedTick('JD50', wrong);
        expect(h.calls.buy).toHaveLength(0);
        // ...and the Jump index printing an entry digit is bought, ahead of A and B which are scored just as high.
        h.runner.handleFeedTick('JD50', first.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.buy[0].parameters.symbol).toBe('JD50');
        expect(h.runner.getSnapshot().log.some(l => /first to qualify/.test(l.text))).toBe(true);
    });

    it('a market that does not qualify never fires, whatever digit it prints', async () => {
        const h = harness();
        h.runner.start();
        for (let d = 0; d < 10; d++) h.runner.handleFeedTick('N', d);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
    });

    it('trades one at a time across all markets, then watches again after the cool-down', async () => {
        const h = harness();
        h.runner.start();
        const a = h.runner.getSnapshot().watching.find(w => w.symbol === 'A')!;
        const b = h.runner.getSnapshot().watching.find(w => w.symbol === 'B')!;
        h.runner.handleFeedTick('A', a.entryDigits[0]);
        h.runner.handleFeedTick('B', b.entryDigits[0]); // another market qualifies at the same moment: ignored
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.runner.getSnapshot().session.trades).toBe(1);
        h.advance(1500);
        h.runner.tick();
        expect(h.runner.getSnapshot().phase).toBe('watching');
        h.runner.handleFeedTick('B', h.runner.getSnapshot().watching.find(w => w.symbol === 'B')!.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(2);
        expect(h.calls.buy[1].parameters.symbol).toBe('B');
    });

    it('only ever buys the primary contracts, and the stake rules are unchanged', async () => {
        const h = harness();
        h.runner.start();
        const w = h.runner.getSnapshot().watching[0];
        h.runner.handleFeedTick(w.symbol, w.entryDigits[0]);
        await flush();
        const p = h.calls.buy[0].parameters;
        expect(['DIGITOVER', 'DIGITUNDER']).toContain(p.contract_type);
        expect(['2', '7']).toContain(p.barrier);
        expect(p.amount).toBe(1);
        expect(p.duration).toBe(1);
    });

    it('rests a market after it loses: the other markets are still watched, that one is not', async () => {
        const h = harness({ lossShield: true, restTrades: 3 });
        h.profits(-1);
        h.runner.start();
        const w = h.runner.getSnapshot().watching.find(x => x.symbol === 'A')!;
        h.runner.handleFeedTick('A', w.entryDigits[0]);
        await flush();
        h.advance(1500);
        h.runner.tick();
        const symbols = h.runner.getSnapshot().watching.map(x => x.symbol);
        expect(symbols).not.toContain('A');
        expect(symbols).toContain('B');
        expect(symbols).toContain('JD50');
        expect(h.runner.getSnapshot().resting.map(r => r.symbol)).toContain('A');
    });

    it('does not trade a market whose last tick is stale, and goes on to another one', async () => {
        const h = harness();
        h.runner.start();
        const a = h.runner.getSnapshot().watching.find(w => w.symbol === 'A')!;
        h.stale('A');
        h.runner.handleFeedTick('A', a.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        expect(h.runner.getSnapshot().armed).toBeNull();
        // a fresh market that qualifies is still bought
        const b = h.runner.getSnapshot().watching.find(w => w.symbol === 'B')!;
        h.runner.handleFeedTick('B', b.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.buy[0].parameters.symbol).toBe('B');
    });

    it('a contract Deriv says a market does not offer is never watched or bought there', () => {
        const h = harness({}, { offered: (symbol, type) => !(symbol === 'JD50' && type === 'DIGITOVER') });
        h.runner.start();
        const w = h.runner.getSnapshot().watching.filter(x => x.symbol === 'JD50');
        expect(w.every(x => x.label.startsWith('Under'))).toBe(true);
    });

    it('when offers are not known yet nothing is blocked (Deriv refusal at purchase is the safety net)', () => {
        const h = harness({}, { offered: () => null });
        h.runner.start();
        expect(h.runner.getSnapshot().watching.some(x => x.symbol === 'JD50')).toBe(true);
    });

    it('a market Deriv refuses at purchase is taken out and the next one still trades', async () => {
        const { TradeRequestError } = await import('@/utils/trade-errors');
        let n = 0;
        const h = harness(
            {},
            {
                buy: async ({ parameters, price }: any) => {
                    n += 1;
                    if (parameters.symbol === 'JD50') throw new TradeRequestError('Trading is not offered for this contract.', { kind: 'rejected' } as never);
                    return { buy_price: price, contract_id: 500 + n, transaction_id: 1 };
                },
            }
        );
        h.runner.start();
        const jd = h.runner.getSnapshot().watching.find(x => x.symbol === 'JD50')!;
        h.runner.handleFeedTick('JD50', jd.entryDigits[0]);
        await flush();
        h.advance(1500);
        h.runner.tick();
        expect(h.runner.isRunning()).toBe(true);
        expect(h.runner.getSnapshot().watching.some(x => x.symbol === 'JD50' && x.cellKey === jd.cellKey)).toBe(false);
        const a = h.runner.getSnapshot().watching.find(x => x.symbol === 'A')!;
        h.runner.handleFeedTick('A', a.entryDigits[0]);
        await flush();
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('win-streak guard: never buys while the market is not on a run of winning digits', async () => {
        // A and B alternate 1,7, so Over 2 never has more than one win in a row.
        const h = harness({ entry: 'ANY', winStreakGate: true, winStreak: 3 });
        h.runner.start();
        h.runner.handleFeedTick('A', 3);
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
    });

    it('win-streak guard: buys once the market has printed the required run of winning digits', async () => {
        const h = harness({ entry: 'ANY', winStreakGate: true, winStreak: 3 });
        h.runner.start();
        h.series.A.push(7, 3, 8); // Over 2 wins on all three
        h.runner.handleFeedTick('A', 8);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.buy[0].parameters.symbol).toBe('A');
    });

    it('any-tick entry buys on the first tick of any watched market', async () => {
        const h = harness({ entry: 'ANY' });
        h.runner.start();
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.buy[0].parameters.symbol).toBe('B');
    });

    it('Entry Brain: every watched contract has its own entry plan and none buys until its plan fires', async () => {
        const h = harness({ entry: 'BRAIN' });
        h.runner.start();
        const w = h.runner.getSnapshot().watching;
        expect(w.length).toBeGreaterThan(0);
        expect(w.every(x => x.plan !== null)).toBe(true);
    });

    it('switching to best-score mode while running drops the watchlist and arms one contract', () => {
        const h = harness();
        h.runner.start();
        expect(h.runner.getSnapshot().watching.length).toBeGreaterThan(0);
        h.runner.updateSettings({ execution: 'BEST' });
        h.advance(1500);
        h.runner.tick();
        const s = h.runner.getSnapshot();
        expect(s.watching).toHaveLength(0);
        expect(s.armed).not.toBeNull();
        expect(s.phase).toBe('armed');
    });

    it('best-score mode still arms only the single best contract', () => {
        const h = harness({ execution: 'BEST' });
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.watching).toHaveLength(0);
        expect(s.armed).not.toBeNull();
    });

    it('uses exactly the rules of best-score mode: the same contracts qualify, only more of them can fire', () => {
        const first = harness({ execution: 'FIRST' });
        const best = harness({ execution: 'BEST' });
        first.runner.start();
        best.runner.start();
        const armed = best.runner.getSnapshot().armed!;
        const watched = first.runner.getSnapshot().watching;
        // whatever best-score mode would arm is on the first-to-qualify watchlist too, and is its top entry
        expect(watched.some(w => w.symbol === armed.symbol && w.cellKey === armed.cellKey)).toBe(true);
        expect(watched[0].score).toBe(armed.score);
    });
});

describe('SixfoldFeed: the all-markets feed Vanguard uses', () => {
    class FakeSocket {
        static all: FakeSocket[] = [];
        sent: any[] = [];
        onopen: ((ev?: unknown) => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        onerror: ((ev?: unknown) => void) | null = null;
        onclose: ((ev?: unknown) => void) | null = null;
        constructor(public url: string) {
            FakeSocket.all.push(this);
        }
        send(d: string) {
            this.sent.push(JSON.parse(d));
        }
        close() {}
        emit(msg: unknown) {
            this.onmessage?.({ data: JSON.stringify(msg) });
        }
    }
    const open = () => {
        FakeSocket.all = [];
        const feed = new SixfoldFeed(url => new FakeSocket(url), undefined, ALL_SYMBOLS);
        feed.connect();
        const ws = FakeSocket.all[0];
        ws.onopen?.();
        return { feed, ws };
    };
    const history = (symbol: string, prices: number[]) => ({ msg_type: 'history', echo_req: { ticks_history: symbol }, pip_size: 2, history: { prices } });

    it('subscribes to the Jump indices along with the Volatility indices', () => {
        const { ws } = open();
        const subscribed = ws.sent.filter(m => m.ticks_history).map(m => m.ticks_history);
        ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'].forEach(s => expect(subscribed).toContain(s));
        expect(subscribed).toHaveLength(ALL_SYMBOLS.length);
    });

    it('turns Jump index ticks into digits like any other market, each into its own market only', () => {
        const { feed, ws } = open();
        ws.emit(history('JD50', [100.11, 100.27]));
        expect(feed.getLiveSeries().JD50).toEqual([1, 7]);
        ws.emit({ msg_type: 'tick', tick: { symbol: 'JD50', quote: 100.45, pip_size: 2, epoch: 5 } });
        expect(feed.getLiveSeries().JD50).toEqual([1, 7, 5]);
        expect(feed.getLiveSeries().JD25 ?? []).toEqual([]);
    });

    it('asks Deriv which contracts a market offers, once, after its ticks start', () => {
        const { feed, ws } = open();
        ws.emit(history('JD25', [100.11, 100.27]));
        ws.emit(history('JD25', [100.11, 100.27, 100.5]));
        const asks = ws.sent.filter(m => m.contracts_for);
        expect(asks.map(a => a.contracts_for)).toEqual(['JD25']);
        expect(feed.isOffered('JD25', 'DIGITOVER')).toBeNull(); // unknown until Deriv answers
        ws.emit({ msg_type: 'contracts_for', echo_req: { contracts_for: 'JD25' }, contracts_for: { available: [{ contract_type: 'DIGITMATCH' }, { contract_type: 'DIGITDIFF' }] } });
        expect(feed.isOffered('JD25', 'DIGITMATCH')).toBe(true);
        expect(feed.isOffered('JD25', 'DIGITOVER')).toBe(false);
    });

    it('one market Deriv will not stream is left out and does not look like the whole feed failing', () => {
        const { feed, ws } = open();
        ws.emit({ msg_type: 'history', echo_req: { ticks_history: 'JD10' }, error: { code: 'InvalidSymbol', message: 'Symbol JD10 invalid' } });
        expect(feed.getUnavailable()).toEqual(['JD10']);
        expect(feed.getSnapshot().error).toBe('');
        expect(feed.isLive()).toBe(true);
        // and a later good history brings it back
        ws.emit(history('JD10', [100.11, 100.27]));
        expect(feed.getUnavailable()).toEqual([]);
    });

    it('a failed offers lookup leaves that market unknown, never blocked', () => {
        const { feed, ws } = open();
        ws.emit(history('JD75', [100.11]));
        ws.emit({ echo_req: { contracts_for: 'JD75' }, error: { message: 'nope' } });
        expect(feed.isOffered('JD75', 'DIGITOVER')).toBeNull();
        expect(feed.getSnapshot().error).toBe('');
    });
});

describe('SixfoldFeed: Sixfold keeps its ten markets', () => {
    it('a default feed subscribes to Sixfold\'s ten markets only and ignores a Jump tick', () => {
        const sent: any[] = [];
        let ws: any;
        const feed = new SixfoldFeed(() => {
            ws = { send: (d: string) => sent.push(JSON.parse(d)), close() {}, onopen: null, onmessage: null, onerror: null, onclose: null };
            return ws;
        });
        feed.connect();
        ws.onopen?.();
        expect(sent.filter(m => m.ticks_history).map(m => m.ticks_history)).toEqual(SIXFOLD_SYMBOLS);
        ws.onmessage?.({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'JD50', quote: 100.45, pip_size: 2, epoch: 5 } }) });
        expect(feed.getLiveSeries().JD50).toBeUndefined();
    });
});
