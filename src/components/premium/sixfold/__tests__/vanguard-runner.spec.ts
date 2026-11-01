import { DEFAULT_SETTINGS, type SixfoldSettings } from '../money';
import { type RulesEngine, type RunnerIO, SixfoldRunner } from '../runner';
import { BotRules } from '../../vanguard/bot-rules';
import { VANGUARD_DEFAULTS, VANGUARD_MODULE_ID } from '../../vanguard/vanguard-settings';

const noise = (seed: number, n = 600) => {
    let a = seed;
    return Array.from({ length: n }, () => ((a = (a * 1664525 + 1013904223) % 4294967296), Math.floor(a / 65536) % 10));
};
const flush = () => new Promise(r => setTimeout(r, 0));

type Script = { enter: Record<string, 'UNDER' | 'OVER' | false | undefined>; paper: any[] };

function harness(over: Partial<SixfoldSettings> = {}, io: Partial<RunnerIO> = {}, engine?: RulesEngine) {
    let t = 1_000_000;
    const series: Record<string, number[]> = { A: noise(1), B: noise(2), C: noise(3) };
    const lastTick: Record<string, number> = { A: t, B: t, C: t };
    const calls = { buy: [] as any[], ticks: [] as Array<{ symbol: string; live: boolean; idle: boolean; barriers: Record<'UNDER' | 'OVER', number>; refused: Record<'UNDER' | 'OVER', boolean> }>, results: [] as boolean[] };
    const script: Script = { enter: {}, paper: [] };
    let nextId = 100;
    const profits: number[] = [];
    const stub: RulesEngine = engine ?? {
        reset: () => {},
        onTick: (symbol, _series, ctx) => {
            calls.ticks.push({ symbol, live: ctx.live, idle: ctx.idle, barriers: ctx.barriers, refused: ctx.refused });
            const side = script.enter[symbol];
            const paper = script.paper.splice(0);
            const allowed = Boolean(side) && !(side && ctx.refused[side]); // a refused contract is not tried again, as the real engine does
            return { enter: ctx.live && ctx.idle && allowed, side: side || undefined, events: [], paper };
        },
        onResult: won => calls.results.push(won),
        board: symbols => symbols.map(symbol => ({ symbol, name: symbol, side: 'UNDER' as const, ready: true, score: 7, checks: [], entry: false, waitingOn: 'Regime score', lastDigit: 1 })),
        paperState: () => ({ paper: false, losses: 0, needed: 2, pending: null, trades: [], won: 0, lost: 0 }),
    };
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: { setIsRunning() {}, setRunId() {}, setContractStage() {}, toggleDrawer() {}, setHasOpenContract() {}, setShowBotStopMessage() {}, onBotContractEvent() {} },
        summary_card: { onBotContractEvent() {} },
        transactions: { pushed: [] as any[], pushTransaction(d: any) { this.pushed.push(d); } },
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
        h.script.enter.B = 'UNDER';
        h.runner.handleFeedTick('B', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        const p = h.calls.buy[0].parameters;
        expect([p.symbol, p.contract_type, p.barrier, p.amount, p.duration, p.duration_unit]).toEqual(['B', 'DIGITUNDER', '7', VANGUARD_DEFAULTS.stake, 1, 't']);
        expect(h.runner.getSnapshot().log.some(l => /Bot rules met on B/.test(l.text))).toBe(true);
    });

    it('does nothing before Run, but the engine still reads every tick', async () => {
        const h = harness();
        h.script.enter.A = 'UNDER';
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        expect(h.calls.ticks[0]).toMatchObject({ symbol: 'A', live: false });
    });

    it('one trade at a time across all markets, and a short cool-down before looking again', async () => {
        const h = harness();
        h.runner.start();
        h.script.enter.A = 'UNDER';
        h.script.enter.B = 'UNDER';
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
        h.script.enter.A = 'UNDER';
        h.runner.handleFeedTick('A', 3);
        await flush();
        h.advance(1500);
        expect(h.calls.results).toEqual([false]);
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.ticks.at(-1)?.barriers).toEqual({ UNDER: 6, OVER: 3 });
        const second = h.calls.buy[1].parameters;
        expect(second.barrier).toBe('6');
        expect(second.amount).toBeGreaterThan(h.calls.buy[0].parameters.amount); // sized to win back half of what is owed
        h.advance(1500);
        expect(h.calls.results).toEqual([false, true]);
    });

    it('never buys a market whose latest tick is stale', async () => {
        const h = harness();
        h.runner.start();
        h.script.enter.A = 'UNDER';
        h.stale('A');
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        expect(h.runner.getSnapshot().armed).toBeNull();
    });

    it('ignores a market that is switched off', () => {
        const h = harness();
        h.runner.start();
        h.script.enter.C = 'UNDER';
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
        h.script.enter.A = 'UNDER';
        h.script.enter.B = 'UNDER';
        h.runner.handleFeedTick('A', 3);
        await flush();
        h.advance(1500);
        h.runner.handleFeedTick('A', 3);
        h.runner.handleFeedTick('B', 3);
        await flush();
        // the refused contract on A is reported to the engine so it is not tried again; B is unaffected and still trades
        expect(h.calls.ticks.filter(x => x.symbol === 'A').at(-1)?.refused.UNDER).toBe(true);
        expect(h.calls.ticks.filter(x => x.symbol === 'B').at(-1)?.refused.UNDER).toBe(false);
        expect(h.runner.getSnapshot().session.trades).toBe(1);
        expect(h.runner.isRunning()).toBe(true);
    });

    it('stops at the limits like Sixfold: take profit ends the run', async () => {
        const h = harness({ takeProfit: 0.3 });
        h.runner.start();
        h.script.enter.A = 'UNDER';
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

describe('Vanguard: Virtual Hook on top of the bot rules', () => {
    it('after the set number of real losses a rules signal is traded on paper, not bought', async () => {
        const h = harness({ virtualHook: true, vhEnterLosses: 1, vhMode: 'FIXED', vhFixedCount: 1 });
        h.profits(-1); // the first real trade loses
        h.runner.start();
        h.script.enter.A = 'UNDER';
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        h.advance(1500);
        h.runner.handleFeedTick('A', 3);
        await flush();
        expect(h.calls.buy).toHaveLength(1); // the second signal is a paper trade: nothing bought
        expect(h.runner.getSnapshot().virtualHook.virtual).toBe(true);
    });

    it('is off by default, so the bot rules alone decide', async () => {
        const h = harness();
        expect(h.runner.getSnapshot().settings.virtualHook).toBe(false);
    });
});

describe('Vanguard: four contracts', () => {
    it('an Over signal buys Digits Over 2, and its recovery after a loss is Over 3', async () => {
        const h = harness({ useOver: true });
        h.profits(-5, 0.35);
        h.runner.start();
        h.script.enter.A = 'OVER';
        h.runner.handleFeedTick('A', 5);
        await flush();
        const first = h.calls.buy[0].parameters;
        expect([first.contract_type, first.barrier]).toEqual(['DIGITOVER', '2']);
        h.advance(1500);
        h.runner.handleFeedTick('A', 5);
        await flush();
        const second = h.calls.buy[1].parameters;
        expect([second.contract_type, second.barrier]).toEqual(['DIGITOVER', '3']);
        expect(second.amount).toBeGreaterThan(first.amount);
    });

    it('after a loss on one side, a signal on the other side is bought with its own recovery contract', async () => {
        const h = harness({ useOver: true });
        h.profits(-5);
        h.runner.start();
        h.script.enter.A = 'UNDER';
        h.runner.handleFeedTick('A', 3);
        await flush();
        h.advance(1500);
        h.script.enter.B = 'OVER';
        h.script.enter.A = undefined;
        h.runner.handleFeedTick('B', 5);
        await flush();
        const p = h.calls.buy[1].parameters;
        expect([p.symbol, p.contract_type, p.barrier]).toEqual(['B', 'DIGITOVER', '3']);
    });

    it('the Over contract is scanned and executable, so a market Deriv does not offer it on is skipped', async () => {
        const h = harness({ useOver: true });
        h.runner.start();
        const snap = h.runner.getSnapshot();
        expect(snap.scan?.cells.some(c => c.contract.side === 'OVER' && c.contract.param === 2)).toBe(true);
    });
});

describe('Vanguard: paper trades in the Transactions panel', () => {
    const trade = (status: 'open' | 'won' | 'lost') => ({ id: 1_000_000_000_000_001, symbol: 'A', side: 'OVER' as const, barrier: 2, label: 'Over 2', entryDigit: 5, exitDigit: status === 'open' ? null : 7, status, at: 1_000_000_000 });

    it('an opened paper trade is published as a virtual row, with no stake or profit', () => {
        const h = harness();
        h.runner.start();
        h.script.paper.push({ phase: 'open', trade: trade('open') });
        h.runner.handleFeedTick('A', 5);
        const row = h.stores.transactions.pushed.at(-1);
        expect(row).toMatchObject({ contract_id: 1_000_000_000_000_001, is_virtual_hook: 1, status: 'open', contract_type: 'DIGITOVER', barrier: '2', buy_price: 0, profit: 0, entry_spot: '5' });
        expect(row.virtual_result).toBeUndefined();
    });

    it('a settled paper trade is the same row marked Virtual Win or Virtual Loss', () => {
        const h = harness();
        h.runner.start();
        h.script.paper.push({ phase: 'settle', trade: trade('won') });
        h.runner.handleFeedTick('A', 7);
        h.script.paper.push({ phase: 'settle', trade: trade('lost') });
        h.runner.handleFeedTick('A', 1);
        const [won, lost] = h.stores.transactions.pushed.slice(-2);
        expect([won.virtual_result, won.is_sold, won.status]).toEqual(['win', 1, 'won']);
        expect([lost.virtual_result, lost.is_sold, lost.status]).toEqual(['loss', 1, 'lost']);
        expect([won.profit, won.buy_price]).toEqual([0, 0]);
        expect(won.exit_spot).toBe('7');
    });

    it('paper trades never touch the real session: no trades counted, nothing sent to the run panel or summary', () => {
        const h = harness();
        let runPanel = 0;
        h.stores.run_panel.onBotContractEvent = () => (runPanel += 1);
        h.stores.summary_card.onBotContractEvent = () => (runPanel += 1);
        h.runner.start();
        h.script.paper.push({ phase: 'open', trade: trade('open') });
        h.runner.handleFeedTick('A', 5);
        expect(runPanel).toBe(0);
        expect(h.runner.getSnapshot().session.trades).toBe(0);
        expect(h.calls.buy).toHaveLength(0);
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
        const rules = new BotRules(() => ({ virtualMode: false, virtualLosses: 2, gateMin: 1, useUnder: true, useOver: false }));
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
