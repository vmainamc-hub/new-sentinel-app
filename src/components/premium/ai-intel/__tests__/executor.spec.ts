import { AiIntelExecutor, DEFAULT_EXEC, type ExecConfig, type ExecIO, nextTrade, normalizeExec, PROPOSAL_TTL_MS } from '../executor';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const defer = <T,>(): Deferred<T> => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => (resolve = r));
    return { promise, resolve };
};
const flush = () => new Promise(r => setTimeout(r, 0));

function harness(cfg: Partial<ExecConfig> = {}, over: Partial<ExecIO> = {}) {
    let t = 1_000_000;
    const buys: Array<{ parameters: any; price: number }> = [];
    const settles: Array<Deferred<any>> = [];
    const pushed: any[] = [];
    const calls = { running: false, handlers: {} as Record<string, () => void>, module: null as string | null };
    let id = 500;
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: {
            run_id: '',
            is_contract_buying_in_progress: false,
            setIsRunning: (v: boolean) => (calls.running = v),
            setRunId() {},
            toggleDrawer() {},
            setHasOpenContract() {},
            setShowBotStopMessage() {},
            setContractStage() {},
            onBotContractEvent() {},
        },
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
        describeFailure: (e: any) => ({ kind: e?.kind ?? 'rejected', message: e?.message ?? 'x', outcomeUnknown: Boolean(e?.unknown) }),
        load: () => ({ market: 'R_10', stake: 1, mode: 'AUTO', autoAuthorised: true, stopLoss: 50, targetProfit: 0, maxStake: 100, ...cfg }),
        save() {},
        ...over,
    };
    const ex = new AiIntelExecutor(io);
    ex.attach(stores);
    return {
        ex,
        buys,
        settles,
        pushed,
        calls,
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
    it('normalises and clamps settings', () => {
        const c = normalizeExec({ duration: 99, stake: -3, direction: 'UNDER_7', recovery: { multiplier: 50 } as any });
        expect(c.duration).toBe(10);
        expect(c.stake).toBe(0);
        expect(c.direction).toBe('UNDER_7');
        expect(c.recovery.multiplier).toBe(10);
        expect(c.mode).toBe('ASSISTED'); // AUTO is never the default
        expect(DEFAULT_EXEC.autoAuthorised).toBe(false);
    });

    it('martingale stake and optional recovery barrier', () => {
        const c = normalizeExec({ stake: 1, recovery: { enabled: true, multiplier: 2, maxSteps: 4, barrierOn: true, overBarrier: 3, underBarrier: 6 } });
        expect(nextTrade(c, 0)).toMatchObject({ stake: 1, recovery: false, contract: { side: 'OVER', param: 2 } });
        expect(nextTrade(c, 2)).toMatchObject({ stake: 4, recovery: true, contract: { side: 'OVER', param: 3 } });
        const u = normalizeExec({ direction: 'UNDER_7', recovery: { ...c.recovery } });
        expect(nextTrade(u, 1)).toMatchObject({ stake: 2, contract: { side: 'UNDER', param: 6 } });
        expect(nextTrade({ ...c, recovery: { ...c.recovery, enabled: false } }, 3).stake).toBe(1);
    });
});

describe('start rules', () => {
    it('refuses without login, without a limit, and AUTO without explicit authorisation', () => {
        const a = harness({}, { isAuthorized: () => false });
        a.ex.start();
        expect(a.ex.getSnapshot().running).toBe(false);
        expect(a.ex.getSnapshot().lastError).toMatch(/log in/);
        const b = harness({ stopLoss: 0, targetProfit: 0, maxTrades: 0 });
        b.ex.start();
        expect(b.ex.getSnapshot().lastError).toMatch(/limit/);
        const c = harness({ autoAuthorised: false });
        c.ex.start();
        expect(c.ex.getSnapshot().lastError).toMatch(/authorisation/);
        expect(c.buys).toHaveLength(0);
    });
});

describe('AUTO execution', () => {
    it('buys OVER 2 only on SETUP digits 0-2, with the right Deriv parameters, one contract at a time', async () => {
        const h = harness({ duration: 3 });
        h.ex.start();
        h.tick(5);
        h.tick(9);
        expect(h.buys).toHaveLength(0);
        h.tick(1);
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.buys[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', duration: 3, duration_unit: 't', symbol: 'R_10', amount: 1, basis: 'stake', currency: 'USD' });
        h.tick(0); // a trigger digit while a contract is open: ignored
        h.tick(2);
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.ex.getSnapshot().phase).toBe('settling');
        await h.win(0);
        expect(h.ex.getSnapshot().session).toMatchObject({ trades: 1, wins: 1, pnl: 0.4 });
        expect(h.pushed.length).toBeGreaterThan(0);
        expect(h.ex.getSnapshot().trades[0]).toMatchObject({ status: 'won', label: 'Over 2', stake: 1 });
    });

    it('UNDER 7 triggers on 7-9 and buys DIGITUNDER barrier 7', async () => {
        const h = harness({ direction: 'UNDER_7' });
        h.ex.start();
        h.tick(3);
        h.tick(8);
        await flush();
        expect(h.buys[0].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '7' });
    });

    it('ignores ticks of other markets', async () => {
        const h = harness();
        h.ex.start();
        h.tick(0, 'R_100');
        await flush();
        expect(h.buys).toHaveLength(0);
    });

    it('recovery: stake doubles after a loss, resets after a win', async () => {
        const h = harness({ recovery: { enabled: true, multiplier: 2, maxSteps: 4, barrierOn: false, overBarrier: 3, underBarrier: 6 } });
        h.ex.start();
        h.tick(0);
        await flush();
        await h.lose(0);
        expect(h.ex.getSnapshot().consecutiveLosses).toBe(1);
        h.advance(1000);
        h.tick(1);
        await flush();
        expect(h.buys[1].price).toBe(2);
        expect(h.ex.getSnapshot().trades[0]).toMatchObject({ recovery: true, step: 1 });
        await h.win(1);
        h.advance(1000);
        h.tick(2);
        await flush();
        expect(h.buys[2].price).toBe(1);
    });

    it('recovery barrier moves OVER 2 to OVER 3 while recovering', async () => {
        const h = harness({ recovery: { enabled: true, multiplier: 2, maxSteps: 4, barrierOn: true, overBarrier: 3, underBarrier: 6 } });
        h.ex.start();
        h.tick(1);
        await flush();
        await h.lose(0);
        h.advance(1000);
        h.tick(3); // 3 is a losing digit for Over 3, so it triggers a SETUP entry in recovery
        await flush();
        expect(h.buys[1].parameters).toMatchObject({ barrier: '3', amount: 2 });
    });

    it('stops at the stop loss, and before a stake that could pass it', async () => {
        const h = harness({ stopLoss: 2.5, recovery: { enabled: true, multiplier: 2, maxSteps: 4, barrierOn: false, overBarrier: 3, underBarrier: 6 } });
        h.ex.start();
        h.tick(0);
        await flush();
        await h.lose(0); // pnl -1
        h.advance(1000);
        h.tick(0); // next stake 2 would risk -3 < -2.5
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/stop loss/);
    });

    it('stops above max stake and after max recovery steps', async () => {
        const h = harness({ maxStake: 1.5, stopLoss: 100 });
        h.ex.start();
        h.tick(0);
        await flush();
        await h.lose(0);
        h.advance(1000);
        h.tick(0);
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/max stake/);
    });

    it('stops at target profit and at max trades', async () => {
        const h = harness({ targetProfit: 0.4, stopLoss: 10 });
        h.ex.start();
        h.tick(0);
        await flush();
        await h.win(0);
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/Target profit/);
        const m = harness({ maxTrades: 1, targetProfit: 0, stopLoss: 10 });
        m.ex.start();
        m.tick(0);
        await flush();
        await m.win(0);
        expect(m.ex.getSnapshot().stopMessage).toMatch(/Max trades/);
    });

    it('never retries a purchase whose outcome is unknown', async () => {
        const h = harness({}, { buy: async () => Promise.reject({ message: 'timed out', unknown: true, kind: 'timeout' }) });
        h.ex.start();
        h.tick(0);
        await flush();
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.ex.getSnapshot().stopMessage).toMatch(/timed out/);
    });

    it('a refused purchase is not retried at once, and 3 refusals in a row stop the run', async () => {
        let n = 0;
        const h = harness({}, { buy: async () => (n++, Promise.reject({ message: 'rejected', kind: 'rejected' })) });
        h.ex.start();
        h.tick(0);
        await flush();
        h.tick(0); // inside the cool-down? tick advances 1000ms, cooldown is 1500
        await flush();
        expect(n).toBe(1);
        h.advance(2000);
        h.tick(0);
        await flush();
        h.advance(2000);
        h.tick(0);
        await flush();
        expect(n).toBe(3);
        expect(h.ex.getSnapshot().running).toBe(false);
    });

    it('emergency stop works mid-trade and the run panel stop handler stops it too', async () => {
        const h = harness();
        h.ex.start();
        expect(h.calls.module).toBe('ai_intel');
        h.tick(0);
        await flush();
        h.calls.handlers.ai_intel();
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.calls.running).toBe(false);
        await h.win(0); // late result after stop must not change the session
        expect(h.ex.getSnapshot().session.trades).toBe(0);
    });

    it('rejects a stale feed', async () => {
        const h = harness({}, { lastTickAt: () => 1 });
        h.ex.start();
        h.tick(0);
        await flush();
        expect(h.buys).toHaveLength(0);
    });

    it('an unconfirmed result stops the run instead of guessing', async () => {
        const h = harness();
        h.ex.start();
        h.tick(0);
        await flush();
        h.settles[0].resolve({ status: 'open' });
        await flush();
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.ex.getSnapshot().trades[0].status).toBe('unconfirmed');
    });
});

describe('ASSISTED execution', () => {
    it('prepares a signal and buys only after confirmation; expired signals are dropped', async () => {
        const h = harness({ mode: 'ASSISTED', autoAuthorised: false });
        h.ex.start();
        h.tick(1);
        await flush();
        expect(h.buys).toHaveLength(0);
        expect(h.ex.getSnapshot().proposal).toMatchObject({ label: 'Over 2', stake: 1, triggerDigit: 1 });
        h.ex.confirmProposal();
        await flush();
        expect(h.buys).toHaveLength(1);
        await h.win(0);
        h.advance(1000);
        h.tick(0);
        expect(h.ex.getSnapshot().proposal).not.toBeNull();
        h.advance(PROPOSAL_TTL_MS + 100);
        h.ex.confirmProposal();
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.ex.getSnapshot().proposal).toBeNull();
    });
});

describe('AUTO market (the tool picks market, direction and entry)', () => {
    const pickOf = (market: string, direction: 'OVER_2' | 'UNDER_7', score = 0.05, entry: 'SETUP' | 'ANY' | 'CUSTOM' = 'SETUP', customDigits: number[] = []) => ({
        key: `${market}|${direction}|${entry}`, market, direction, entry, customDigits, strategyId: null, label: `${direction} ${entry}`, score,
        trades: 100, rate: 0.7, significant: true, q: 0.01, regime: 'STABLE' as const, reason: 'test',
    });

    it('trades the picked market and direction only, ignoring other markets', async () => {
        const ranked = [pickOf('R_50', 'UNDER_7')];
        const h = harness({ market: 'AUTO' }, { pick: () => ranked });
        h.ex.start();
        h.tick(8, 'R_10'); // not the picked market
        expect(h.buys).toHaveLength(0);
        h.tick(8, 'R_50'); // UNDER 7 SETUP trigger is 7-9
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.buys[0].parameters).toMatchObject({ symbol: 'R_50', contract_type: 'DIGITUNDER', barrier: '7' });
        expect(h.ex.getSnapshot().selected?.market).toBe('R_50');
    });

    it('waits while nothing qualifies, then trades once something does', async () => {
        let ranked: any[] = [];
        const h = harness({ market: 'AUTO' }, { pick: () => ranked });
        h.ex.start();
        h.tick(1, 'R_10');
        expect(h.buys).toHaveLength(0);
        expect(h.ex.getSnapshot().selected).toBeNull();
        expect(h.ex.getSnapshot().pickNote).toBeTruthy();
        ranked = [pickOf('R_25', 'OVER_2')];
        h.advance(2000);
        h.tick(0, 'R_25');
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.buys[0].parameters).toMatchObject({ symbol: 'R_25', contract_type: 'DIGITOVER', barrier: '2' });
    });

    it('does not switch away for a marginally better rival, but does for a clearly better one', async () => {
        let ranked = [pickOf('R_25', 'OVER_2', 0.06), pickOf('R_10', 'OVER_2', 0.05)];
        const h = harness({ market: 'AUTO' }, { pick: () => ranked });
        h.ex.start();
        h.tick(5, 'R_10');
        expect(h.ex.getSnapshot().selected?.market).toBe('R_25'); // first pick is the best
        ranked = [pickOf('R_10', 'OVER_2', 0.07), pickOf('R_25', 'OVER_2', 0.06)];
        h.advance(5000);
        h.tick(5, 'R_10');
        expect(h.ex.getSnapshot().selected?.market).toBe('R_25'); // +0.01 is under the margin
        ranked = [pickOf('R_10', 'OVER_2', 0.12), pickOf('R_25', 'OVER_2', 0.06)];
        h.advance(5000);
        h.tick(5, 'R_10');
        expect(h.ex.getSnapshot().selected?.market).toBe('R_10');
    });

    it('never switches while a contract is open, and recovery stake still doubles across picks', async () => {
        let ranked = [pickOf('R_10', 'OVER_2', 0.05)];
        const h = harness({ market: 'AUTO' }, { pick: () => ranked });
        h.ex.start();
        h.tick(0, 'R_10');
        await flush();
        expect(h.buys).toHaveLength(1);
        ranked = [pickOf('R_75', 'UNDER_7', 0.5)];
        h.advance(6000);
        h.tick(9, 'R_75'); // contract open: no switch, no second order
        expect(h.ex.getSnapshot().selected?.market).toBe('R_10');
        expect(h.buys).toHaveLength(1);
        await h.lose(0);
        h.advance(6000);
        h.tick(9, 'R_75'); // now free: switched to the better pick, stake doubled for recovery
        await flush();
        expect(h.buys).toHaveLength(2);
        expect(h.buys[1].parameters).toMatchObject({ symbol: 'R_75', amount: 2 });
    });

    it('CUSTOM picks use the strategy digits as the trigger', async () => {
        const h = harness({ market: 'AUTO' }, { pick: () => [pickOf('R_10', 'OVER_2', 0.05, 'CUSTOM', [4])] });
        h.ex.start();
        h.tick(1, 'R_10');
        expect(h.buys).toHaveLength(0);
        h.tick(4, 'R_10');
        await flush();
        expect(h.buys).toHaveLength(1);
    });

    it('refuses to start AUTO market without a picker', () => {
        const h = harness({ market: 'AUTO' });
        h.ex.start();
        expect(h.ex.getSnapshot().running).toBe(false);
        expect(h.ex.getSnapshot().lastError).toMatch(/Auto-pick/);
    });
});
