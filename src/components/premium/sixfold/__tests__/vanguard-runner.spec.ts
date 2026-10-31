import { DEFAULT_SETTINGS, type SixfoldSettings } from '../money';
import { type RulesEngine, type RunnerIO, SixfoldRunner } from '../runner';
import { BotRules } from '../../vanguard/bot-rules';
import { VANGUARD_DEFAULTS, VANGUARD_MODULE_ID } from '../../vanguard/vanguard-settings';

const noise = (seed: number, n = 600) => {
    let a = seed;
    return Array.from({ length: n }, () => ((a = (a * 1664525 + 1013904223) % 4294967296), Math.floor(a / 65536) % 10));
};
const flush = () => new Promise(r => setTimeout(r, 0));

type Script = { enter: Record<string, boolean> };

function harness(over: Partial<SixfoldSettings> = {}, io: Partial<RunnerIO> = {}, engine?: RulesEngine) {
    let t = 1_000_000;
    const series: Record<string, number[]> = { A: noise(1), B: noise(2), C: noise(3) };
    const lastTick: Record<string, number> = { A: t, B: t, C: t };
    const calls = { buy: [] as any[], ticks: [] as Array<{ symbol: string; live: boolean; idle: boolean; prediction: number }>, results: [] as boolean[] };
    const script: Script = { enter: {} };
    let nextId = 100;
    const profits: number[] = [];
    const stub: RulesEngine = engine ?? {
        reset: () => {},
        onTick: (symbol, _series, ctx) => {
            calls.ticks.push({ symbol, live: ctx.live, idle: ctx.idle, prediction: ctx.prediction });
            return { enter: ctx.live && ctx.idle && Boolean(script.enter[symbol]), events: [] };
        },
        onResult: won => calls.results.push(won),
        board: symbols => symbols.map(symbol => ({ symbol, name: symbol, ready: true, score: 7, checks: [], entry: false, waitingOn: 'Regime score', lastDigit: 1 })),
        paperState: () => ({ paper: false, losses: 0, needed: 2, pending: null }),
    };
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: { setIsRunning() {}, setRunId() {}, setContractStage() {}, toggleDrawer() {}, setHasOpenContract() {}, setShowBotStopMessage() {}, onBotContractEvent() {} },
        summary_card: { onBotContractEvent() {} },
        transactions: { pushTransaction() {} },
        dashboard: { active_trading_module: null as string | null, setActiveTradingModule(id: string | null) { this.active_trading_module = id; }, registerTradingStopHandler() {}, unregisterTradingStopHandler() {}, stopActiveTradingModule() {} },
    };
    const runner = new SixfoldRunner({
        feed: {
            getLiveSeries: () => series,
            getLastTickAt: s => lastTick[s] ?? null,
            getLastDigit: s => series[s]?.at(-1) ?? null,
            isLive: () => true,
            getSnapshot: () => ({ mode: 'live', status: 'live', error: '', series, version: 1 }),
            connect: () => {},
        },
        moduleId: VANGUARD_MODULE_ID,
        defaults: VANGUARD_DEFAULTS,
        rules: stub,
        buy: async ({ parameters, price }) => {
            calls.buy.push({ parameters, price });
            return { buy_price: price, contract_id: nextId++, transaction_id: 1 };
        },
        settle: async ({ fallback }) => {
            const profit = profits.length ? profits.shift()! : 0.35;
            return { ...fallback, is_sold: 1, status: profit < 0 ? 'lost' : 'won', profit };
        },
        isAuthorized: () => true,
        currency: () => 'USD',
        afterStop: () => {},
        now: () => t,
        loadSettings: () => ({ ...VANGUARD_DEFAULTS, markets: ['A', 'B'], takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0, ...over }),
        saveSettings: () => {},
        ...io,
    });
    runner.attach(stores);
    return {
        runner,
        calls,
        script,
        series,
        stores,
        profits: (...p: number[]) => profits.push(...p),
        advance: (ms: number) => {
            t += ms;
            Object.keys(lastTick).forEach(k => (lastTick[k] = t));
        },
        stale: (symbol: string) => (lastTick[symbol] = t - 60_000),
    };
}

describe('Vanguard: bot rules, Sixfold execution', () => {
    it('buys Digits Under 7 on the market the rules choose, at the base stake', async () => {
        const h = harness();
        h.runner.start();
        h.script.enter.B = true;
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        const p = h.calls.buy[0].parameters;
        expect([p.symbol, p.contract_type, p.barrier, p.amount, p.duration, p.duration_unit]).toEqual(['B', 'DIGITUNDER', '7', VANGUARD_DEFAULTS.stake, 1, 't']);
        expect(h.runner.getSnapshot().log.some(l => /Bot rules met on B/.test(l.text))).toBe(true);
    });

    it('does nothing before Run, but the engine still reads every tick', async () => {
        const h = harness();
        h.script.enter.A = true;
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        expect(h.calls.ticks[0]).toMatchObject({ symbol: 'A', live: false });
    });

    it('one trade at a time across all markets, and a short cool-down before looking again', async () => {
        const h = harness();
        h.runner.start();
        h.script.enter.A = true;
        h.script.enter.B = true;
        h.runner.handleFeedTick('A', 3);
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.ticks.filter(x => x.symbol === 'B').at(-1)?.idle).toBe(false);
        h.advance(1500);
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(2);
        expect(h.calls.buy[1].parameters.symbol).toBe('B');
    });

    it('after a loss it switches to Under 6 with a recovery stake, and tells the engine each result', async () => {
        const h = harness();
        h.profits(-5, 0.35); // a loss big enough that winning back half of it needs more than the base stake
        h.runner.start();
        h.script.enter.A = true;
        h.runner.handleFeedTick('A', 3);
        await flush();
        h.advance(1500);
        expect(h.calls.results).toEqual([false]);
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.ticks.at(-1)?.prediction).toBe(6);
        const second = h.calls.buy[1].parameters;
        expect(second.barrier).toBe('6');
        expect(second.amount).toBeGreaterThan(h.calls.buy[0].parameters.amount); // sized to win back half of what is owed
        h.advance(1500);
        expect(h.calls.results).toEqual([false, true]);
    });

    it('never buys a market whose latest tick is stale', async () => {
        const h = harness();
        h.runner.start();
        h.script.enter.A = true;
        h.stale('A');
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        expect(h.runner.getSnapshot().armed).toBeNull();
    });

    it('ignores a market that is switched off', () => {
        const h = harness();
        h.runner.start();
        h.script.enter.C = true;
        h.runner.handleFeedTick('C', 3);
        expect(h.calls.ticks.some(x => x.symbol === 'C')).toBe(false);
    });

    it('a market Deriv refuses is left alone while the others keep trading', async () => {
        const { TradeRequestError } = await import('@/utils/trade-errors');
        const h = harness(
            {},
            {
                buy: async ({ parameters, price }: any) => {
                    if (parameters.symbol === 'A') throw new TradeRequestError('Trading is not offered for this contract.', { kind: 'rejected' } as never);
                    return { buy_price: price, contract_id: 900, transaction_id: 1 };
                },
            }
        );
        h.runner.start();
        h.script.enter.A = true;
        h.script.enter.B = true;
        h.runner.handleFeedTick('A', 3);
        await flush();
        h.advance(1500);
        h.runner.handleFeedTick('A', 3);
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.ticks.filter(x => x.symbol === 'A').at(-1)?.idle).toBe(false);
        expect(h.runner.getSnapshot().session.trades).toBe(1);
        expect(h.runner.isRunning()).toBe(true);
    });

    it('stops at the limits like Sixfold: take profit ends the run', async () => {
        const h = harness({ takeProfit: 0.3 });
        h.runner.start();
        h.script.enter.A = true;
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Take profit/);
    });

    it('shows the rules board and the paper state, and is Vanguard\'s own module', () => {
        const h = harness();
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.phase).toBe('watching');
        expect(s.rules?.rows.map(r => r.symbol)).toEqual(['A', 'B']);
        expect(s.rules?.paperNeeded).toBe(2);
        expect(h.stores.dashboard.active_trading_module).toBe('vanguard');
    });

    it('a Sixfold-style runner (no rules engine) is unaffected: no rules in its snapshot', () => {
        const h = harness({}, { rules: undefined, moduleId: 'sixfold', defaults: DEFAULT_SETTINGS, loadSettings: () => ({ ...DEFAULT_SETTINGS, markets: ['A', 'B'] }) } as Partial<RunnerIO>);
        expect(h.runner.getSnapshot().rules).toBeNull();
    });
});

describe('Vanguard: end to end with the real rules engine', () => {
    // The 1000-digit stream the bot was recorded on, played tick by tick on one market. The first real entry must happen on the very
    // tick the real bot would have entered (paper mode off), and nowhere earlier.
    const stream = (seed: number, n: number) => {
        let a = seed;
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
            a = (a * 1664525 + 1013904223) % 4294967296;
            out.push(Math.floor(a / 65536) % 10);
        }
        return out;
    };

    it('buys on the first tick the real bot would have bought, not before', async () => {
        const rules = new BotRules(() => ({ virtualMode: false, virtualLosses: 2, gateMin: 1 }));
        const h = harness({ virtualMode: false, markets: ['A'] }, {}, rules);
        const digits = stream(11, 3500);
        h.series.A.length = 0;
        h.series.A.push(...digits.slice(0, 1000));
        h.runner.start();
        let boughtAt = -1;
        for (let i = 1000; i < 1300 && boughtAt < 0; i++) {
            h.series.A.push(digits[i]);
            if (h.series.A.length > 2000) h.series.A.shift();
            h.advance(0);
            h.runner.handleFeedTick('A', digits[i]);
            await flush();
            if (h.calls.buy.length) boughtAt = i - 1000;
        }
        // the bot's first recorded entry on this stream
        expect(boughtAt).toBeGreaterThan(-1);
        expect(boughtAt).toBe(32);
    });
});
