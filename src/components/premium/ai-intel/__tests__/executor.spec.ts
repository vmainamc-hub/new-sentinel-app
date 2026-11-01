import { AiIntelExecutor, DEFAULT_EXEC, type ExecConfig, type ExecIO, nextStake, normalizeExec, PROPOSAL_TTL_MS } from '../executor';
import type { Pick, RecoveryPick } from '../picker';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const defer = <T,>(): Deferred<T> => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => (resolve = r));
    return { promise, resolve };
};
const flush = () => new Promise(r => setTimeout(r, 0));

const pick = (market: string, direction: 'OVER_2' | 'UNDER_7', entry: Pick['entry'] = 'SETUP', extra: Partial<Pick> = {}): Pick => ({
    key: `${market}|${direction}|${entry}`, market, direction, entry, customDigits: [], rule: null, strategyId: null, label: `${direction} · ${entry}`,
    score: 0.05, trades: 100, rate: 0.75, significant: false, q: null, regime: 'STABLE', reason: 'test', ...extra,
});
const rpick = (market: string, direction: 'OVER_3' | 'UNDER_6', entry: 'SETUP' | 'ANY' = 'SETUP'): RecoveryPick => ({
    key: `${market}|${direction}|${entry}`, market, direction, entry, label: `${direction} · ${entry}`, score: 0.02, trades: 100, rate: 0.62, regime: 'STABLE', reason: 'test',
});

const NO_VH = { enabled: false };

function harness(cfg: Partial<ExecConfig> = {}, over: Partial<ExecIO> = {}, boards: { primary?: Pick[]; recovery?: RecoveryPick[] } = {}) {
    let t = 1_000_000;
    const buys: Array<{ parameters: any; price: number }> = [];
    const settles: Array<Deferred<any>> = [];
    const pushed: any[] = [];
    const picked: any[] = [];
    const calls = { running: false, handlers: {} as Record<string, () => void>, module: null as string | null };
    const board = {
        primary: boards.primary ?? [pick('R_10', 'OVER_2'), pick('R_50', 'UNDER_7')],
        recovery: boards.recovery ?? [rpick('R_10', 'UNDER_6'), rpick('R_25', 'OVER_3')],
    };
    let id = 500;
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: { run_id: '', is_contract_buying_in_progress: false, setIsRunning: (v: boolean) => (calls.running = v), setRunId() {}, toggleDrawer() {}, setHasOpenContract() {}, setShowBotStopMessage() {}, setContractStage() {}, onBotContractEvent() {} },
        summary_card: { onBotContractEvent() {} },
        transactions: { pushTransaction: (d: any) => pushed.push(d) },
        dashboard: {
            active_trading_module: null,
            setActiveTradingModule: (m: string | null) => (calls.module = m),
            registerTradingStopHandler: (m: string, h: () => void) => (calls.handlers[m] = h),
            unregisterTradingStopHandler: (m: string) => delete calls.handlers[m],
            stopActiveTradingModule() {},
        },
    };
    const io: ExecIO = {
        buy: async a => {
            buys.push(a);
            return { buy_price: a.price, contract_id: ++id, transaction_id: id + 1000 };
        },
        settle: ({ contractId }) => {
            const d = defer<any>();
            settles.push(d);
            return d.promise.then(r => ({ contract_id: contractId, ...r }));
        },
        isAuthorized: () => true,
        now: () => t,
        lastTickAt: () => t,
        isFeedLive: () => true,
        connectFeed() {},
        pick: o => {
            picked.push(o);
            return board.primary;
        },
        pickRecovery: () => board.recovery,
        describeFailure: (e: any) => ({ kind: e?.kind ?? 'rejected', message: e?.message ?? 'x', outcomeUnknown: Boolean(e?.unknown) }),
        load: () => ({ stake: 1, mode: 'AUTO', autoAuthorised: true, stopLoss: 50, targetProfit: 0, virtualHook: NO_VH as any, ...cfg }),
        save() {},
        ...over,
    };
    const ex = new AiIntelExecutor(io);
    ex.attach(stores);
    return {
        ex, buys, settles, pushed, calls, board, picked,
        advance: (ms: number) => (t += ms),
        tick: (d: number, sym = 'R_10') => {
            t += 1000;
            ex.handleTick(sym, d);
        },
        win: async (i: number) => {
            settles[i].resolve({ is_sold: 1, status: 'won', profit: 0.4, exit_spot: '5' });
            await flush();
        },
        lose: async (i: number) => {
            settles[i].resolve({ is_sold: 1, status: 'lost', profit: -1, exit_spot: '1' });
            await flush();
        },
    };
}

describe('config and staking', () => {
    it('normalises and clamps settings, ignoring old single-market fields', () => {
        const c = normalizeExec({ duration: 99, stake: -3, recovery: { enabled: true, multiplier: 50, maxSteps: 0 }, excluded: ['R_10', 'R_10', ''], market: 'R_100' } as any);
        expect(c.duration).toBe(10);
        expect(c.stake).toBe(0);
        expect(c.recovery.multiplier).toBe(10);
        expect(c.recovery.maxSteps).toBe(1);
        expect(c.excluded).toEqual(['R_10']);
        expect((c as any).market).toBeUndefined();
        expect(DEFAULT_EXEC.virtualHook.enabled).toBe(true);
        expect(normalizeExec(null).mode).toBe('ASSISTED');
    });
    it('martingale stake after consecutive losses, base stake with recovery off', () => {
        const c = normalizeExec({ stake: 1, recovery: { enabled: true, multiplier: 2, maxSteps: 4 } });
        expect(nextStake(c, 0)).toEqual({ stake: 1, recovery: false, step: 0 });
        expect(nextStake(c, 2)).toEqual({ stake: 4, recovery: true, step: 2 });
        expect(nextStake({ ...c, recovery: { ...c.recovery, enabled: false } }, 3).stake).toBe(1);
    });
});

describe('start rules', () => {
    it('refuses without login, without a limit, and automatic mode without authorisation', () => {
        const noLogin = harness({}, { isAuthorized: () => false });
        expect(noLogin.ex.startBlocker()).toMatch(/log in/i);
        expect(harness({ stopLoss: 0, targetProfit: 0, maxTrades: 0 }).ex.startBlocker()).toMatch(/limit/i);
        expect(harness({ mode: 'AUTO', autoAuthorised: false }).ex.startBlocker()).toMatch(/authoris/i);
        expect(harness().ex.startBlocker()).toBeNull();
    });
});

describe('multi-market execution', () => {
    it('trades whichever market on the board shows its entry, with the right Deriv parameters', async () => {
        const h = harness();
        h.ex.start();
        h.tick(5, 'R_10'); // 5 wins OVER 2: no SETUP entry
        h.tick(1, 'R_100'); // not on the board
        expect(h.buys).toHaveLength(0);
        h.tick(8, 'R_50'); // 8 is a SETUP digit for UNDER 7
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.buys[0].parameters).toMatchObject({ symbol: 'R_50', contract_type: 'DIGITUNDER', barrier: '7', amount: 1, duration: 1, duration_unit: 't' });
        h.tick(1, 'R_10'); // a second market fires while the first contract is open: not bought
        await flush();
        expect(h.buys).toHaveLength(1);
        await h.win(0);
        h.advance(500);
        h.tick(1, 'R_10');
        await flush();
        expect(h.buys).toHaveLength(2);
        expect(h.buys[1].parameters).toMatchObject({ symbol: 'R_10', contract_type: 'DIGITOVER', barrier: '2' });
    });
    it('leaves excluded markets out and passes the filters to the picker', async () => {
        const h = harness({ excluded: ['R_50'], directions: 'UNDER_7', entry: 'SETUP', evidenceOnly: true, duration: 2 });
        h.ex.start();
        expect(h.picked[0]).toMatchObject({ directions: 'UNDER_7', entries: ['SETUP'], evidenceOnly: true, duration: 2 });
        h.tick(8, 'R_50');
        await flush();
        expect(h.buys).toHaveLength(0);
        expect(h.ex.getSnapshot().board.primary.map(p => p.market)).toEqual(['R_10']);
    });
    it('keeps only the best entry of each market, top few markets', () => {
        const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].flatMap(m => [pick(m, 'OVER_2'), pick(m, 'UNDER_7')]);
        const h = harness({}, {}, { primary: many });
        h.ex.start();
        const markets = h.ex.getSnapshot().board.primary.map(p => p.market);
        expect(markets).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    });
    it('waits and explains when no market qualifies', () => {
        const h = harness({}, {}, { primary: [] });
        h.ex.start();
        expect(h.ex.getSnapshot().note).toMatch(/fresh data/);
        h.tick(1);
        expect(h.buys).toHaveLength(0);
    });
    it('ANY entry buys on the first tick of a board market', async () => {
        const h = harness({}, {}, { primary: [pick('R_10', 'OVER_2', 'ANY')] });
        h.ex.start();
        h.tick(9);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
});

describe('recovery with Over 3 / Under 6', () => {
    it('after an Over 2 loss the next trade is Over 3 or Under 6 on the market that shows its entry, at double stake', async () => {
        const h = harness();
        h.ex.start();
        h.tick(1, 'R_10');
        await flush();
        expect(h.buys[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', amount: 1 });
        await h.lose(0);
        h.advance(500);
        h.tick(1, 'R_50'); // R_50 has no recovery entry
        h.tick(2, 'R_10'); // Under 6 needs 6-9 on R_10
        expect(h.buys).toHaveLength(1);
        h.tick(1, 'R_25'); // Over 3 SETUP digit on R_25
        await flush();
        expect(h.buys).toHaveLength(2);
        expect(h.buys[1].parameters).toMatchObject({ symbol: 'R_25', contract_type: 'DIGITOVER', barrier: '3', amount: 2 });
        await h.lose(1);
        h.advance(500);
        h.tick(7, 'R_10');
        await flush();
        expect(h.buys[2].parameters).toMatchObject({ symbol: 'R_10', contract_type: 'DIGITUNDER', barrier: '6', amount: 4 });
        await h.win(2);
        h.advance(500);
        h.tick(8, 'R_50');
        await flush();
        expect(h.buys[3].parameters).toMatchObject({ symbol: 'R_50', contract_type: 'DIGITUNDER', barrier: '7', amount: 1 });
    });
    it('an Under 7 loss recovers the same way', async () => {
        const h = harness();
        h.ex.start();
        h.tick(9, 'R_50');
        await flush();
        expect(h.buys[0].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '7' });
        await h.lose(0);
        h.advance(500);
        h.tick(0, 'R_25');
        await flush();
        expect(h.buys[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '3', amount: 2 });
    });
    it('with recovery off it keeps trading the main contracts at the base stake', async () => {
        const h = harness({ recovery: { enabled: false, multiplier: 2, maxSteps: 4 } });
        h.ex.start();
        h.tick(1, 'R_10');
        await flush();
        await h.lose(0);
        h.advance(500);
        h.tick(1, 'R_10');
        await flush();
        expect(h.buys[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', amount: 1 });
    });
});

describe('limits and safety', () => {
    it('stops at the stop loss, and before a stake that could pass it', async () => {
        const h = harness({ stopLoss: 2 });
        h.ex.start();
        h.tick(1);
        await flush();
        await h.lose(0); // -1, next stake 2 would risk -3 > 2
        h.advance(500);
        h.tick(1, 'R_25');
        expect(h.ex.isRunning()).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/stop loss/i);
    });
    it('stops after the max recovery steps', async () => {
        const h = harness({ recovery: { enabled: true, multiplier: 1, maxSteps: 1 } });
        h.ex.start();
        h.tick(1);
        await flush();
        await h.lose(0);
        h.advance(500);
        h.tick(1, 'R_25');
        await flush();
        await h.lose(1);
        h.advance(500);
        h.tick(1, 'R_25');
        expect(h.ex.isRunning()).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/recovery steps/);
    });
    it('stops at take profit and at max trades', async () => {
        const a = harness({ targetProfit: 0.4 });
        a.ex.start();
        a.tick(1);
        await flush();
        await a.win(0);
        expect(a.ex.isRunning()).toBe(false);
        expect(a.ex.getSnapshot().stopMessage).toMatch(/take profit/i);
        const b = harness({ maxTrades: 1 });
        b.ex.start();
        b.tick(1);
        await flush();
        await b.win(0);
        expect(b.ex.isRunning()).toBe(false);
    });
    it('never retries a purchase whose outcome is unknown', async () => {
        const h = harness({}, { buy: async () => { throw { unknown: true, message: 'no reply' }; } });
        h.ex.start();
        h.tick(1);
        await flush();
        expect(h.ex.isRunning()).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/no reply/);
    });
    it('three refusals in a row stop the run', async () => {
        const h = harness({}, { buy: async () => { throw { message: 'refused' }; } });
        h.ex.start();
        for (let i = 0; i < 3; i++) {
            h.tick(1);
            await flush();
            h.advance(2000);
        }
        expect(h.ex.isRunning()).toBe(false);
    });
    it('emergency stop works mid-trade and the run panel stop handler stops it too', async () => {
        const h = harness();
        h.ex.start();
        h.tick(1);
        await flush();
        h.calls.handlers.ai_intel();
        expect(h.ex.isRunning()).toBe(false);
        h.tick(1, 'R_25');
        await flush();
        expect(h.buys).toHaveLength(1);
    });
    it('rejects a stale feed and stops on an unconfirmed result', async () => {
        const stale = harness({}, { lastTickAt: () => 0 });
        stale.ex.start();
        stale.tick(1);
        await flush();
        expect(stale.buys).toHaveLength(0);
        const h = harness();
        h.ex.start();
        h.tick(1);
        await flush();
        h.settles[0].resolve({ is_sold: 0, status: 'open' });
        await flush();
        expect(h.ex.isRunning()).toBe(false);
        expect(h.ex.getSnapshot().trades[0].status).toBe('unconfirmed');
    });
});

describe('confirm-each-trade mode', () => {
    it('prepares a signal on the right market and buys only after confirmation; expired signals are dropped', async () => {
        const h = harness({ mode: 'ASSISTED', autoAuthorised: false });
        h.ex.start();
        h.tick(8, 'R_50');
        expect(h.buys).toHaveLength(0);
        expect(h.ex.getSnapshot().proposal).toMatchObject({ market: 'R_50', label: 'Under 7' });
        h.ex.confirmProposal();
        await flush();
        expect(h.buys[0].parameters).toMatchObject({ symbol: 'R_50', contract_type: 'DIGITUNDER' });
        await h.win(0);
        h.advance(500);
        h.tick(1, 'R_10');
        expect(h.ex.getSnapshot().proposal).not.toBeNull();
        h.advance(PROPOSAL_TTL_MS + 100);
        h.ex.confirmProposal();
        expect(h.buys).toHaveLength(1);
    });
});

describe('SMART strategy picks', () => {
    const smart = pick('R_10', 'OVER_2', 'SMART', { rule: { digits: [4], prev: { kind: 'ALL_WIN', k: 2 } }, strategyId: 's@v1' });
    it('buys only when the digit AND the rule on the recent ticks both hold', async () => {
        let hist: number[] = [];
        const h = harness({}, { history: () => hist }, { primary: [smart] });
        h.ex.start();
        hist = [1, 6, 4];
        h.tick(4);
        expect(h.buys).toHaveLength(0);
        hist = [5, 6, 3];
        h.tick(3);
        expect(h.buys).toHaveLength(0);
        hist = [5, 6, 4];
        h.tick(4);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
    it('does not trade a SMART pick when no history is available', () => {
        const h = harness({}, {}, { primary: [smart] });
        h.ex.start();
        h.tick(4);
        expect(h.buys).toHaveLength(0);
    });
});

describe('virtual hook (paper trades)', () => {
    const VH = { enabled: true, opening: false, mode: 'STREAK' as const, enterLosses: 2, returnWins: 2, fixedCount: 3 };
    it('goes to paper after the configured real losses, settles paper trades on real ticks, and returns after paper wins', async () => {
        const h = harness({ virtualHook: VH, recovery: { enabled: true, multiplier: 1, maxSteps: 9 } }, {}, { primary: [pick('R_10', 'OVER_2', 'ANY')], recovery: [rpick('R_10', 'OVER_3', 'ANY')] });
        h.ex.start();
        h.tick(9);
        await flush();
        await h.lose(0);
        h.advance(500);
        h.tick(9);
        await flush();
        await h.lose(1); // second real loss: paper
        expect(h.ex.getSnapshot().vh.virtual).toBe(true);
        expect(h.ex.getSnapshot().session.trades).toBe(2);
        h.advance(500);
        h.tick(9); // paper trade opens, nothing bought
        expect(h.buys).toHaveLength(2);
        expect(h.ex.getSnapshot().vh.open).toBe(true);
        h.tick(9, 'R_50'); // other markets do not settle it
        expect(h.ex.getSnapshot().paper.trades).toBe(0);
        h.tick(9); // settles on the next tick of its market: Over 3 wins on 9
        expect(h.ex.getSnapshot().paper).toMatchObject({ trades: 1, wins: 1 });
        expect(h.pushed.some(p => p.is_virtual_hook === 1 && p.virtual_result === 'win')).toBe(true);
        h.advance(500);
        h.tick(9);
        h.tick(9);
        expect(h.ex.getSnapshot().vh.virtual).toBe(false); // two paper wins in a row: back to real
        expect(h.ex.getSnapshot().session.trades).toBe(2); // paper never counted
        h.advance(500);
        h.tick(9);
        await flush();
        expect(h.buys).toHaveLength(3);
    });
    it('opens the run on paper until the first paper win', async () => {
        const h = harness({ virtualHook: { ...VH, opening: true } }, {}, { primary: [pick('R_10', 'OVER_2', 'ANY')] });
        h.ex.start();
        h.tick(9); // paper opens
        expect(h.buys).toHaveLength(0);
        h.tick(1); // settles, Over 2 loses on 1
        expect(h.ex.getSnapshot().vh.virtual).toBe(true);
        h.advance(500);
        h.tick(9);
        h.tick(9); // paper win
        expect(h.ex.getSnapshot().vh.virtual).toBe(false);
        h.advance(500);
        h.tick(9);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
    it('paper stakes never touch the session, and the hook is inert when switched off', async () => {
        const h = harness({ virtualHook: { ...VH, enabled: false, opening: true } }, {}, { primary: [pick('R_10', 'OVER_2', 'ANY')] });
        h.ex.start();
        h.tick(9);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
});
