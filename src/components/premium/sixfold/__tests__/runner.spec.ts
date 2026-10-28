import { TradeRequestError } from '@/utils/trade-errors';
import { DEFAULT_SETTINGS, type SixfoldSettings } from '../money';
import { MIN_TICKS, type RunnerIO, SixfoldRunner } from '../runner';

// A market where Over 2 wins on every simulated trade (1 -> 7 -> 1 -> 7 ...), so the scanner finds it at once.
const planted = Array.from({ length: 600 }, (_, i) => (i % 2 === 0 ? 1 : 7));
const noise = (seed: number) => {
    let a = seed;
    return Array.from({ length: 600 }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
};

function harness(over: Partial<SixfoldSettings> = {}, io: Partial<RunnerIO> = {}) {
    let t = 1_000_000;
    const series: Record<string, number[]> = { P: planted.slice(), Q: noise(5) };
    const lastTick: Record<string, number> = { P: t, Q: t };
    const calls = { buy: [] as any[], pushed: [] as any[], connect: 0 };
    let nextId = 100;
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: {
            run_id: '',
            is_contract_buying_in_progress: false,
            running: false,
            setIsRunning(v: boolean) {
                this.running = v;
            },
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
        transactions: { pushTransaction: (d: any) => calls.pushed.push(d) },
        dashboard: {
            active_trading_module: null as string | null,
            handlers: {} as Record<string, () => void>,
            setActiveTradingModule(id: string | null) {
                this.active_trading_module = id;
            },
            registerTradingStopHandler(id: string, h: () => void) {
                this.handlers[id] = h;
            },
            unregisterTradingStopHandler(id: string) {
                delete this.handlers[id];
            },
            stopActiveTradingModule() {},
        },
    };
    let profitQueue: number[] = [];
    let watcher: ((running: boolean, mod: string | null) => void) | null = null;
    const runner = new SixfoldRunner({
        feed: {
            getLiveSeries: () => series,
            getLastTickAt: s => lastTick[s] ?? null,
            getLastDigit: s => series[s]?.at(-1) ?? null,
            isLive: () => true,
            getSnapshot: () => ({ mode: 'live', status: 'live', error: '', series, version: 1 }),
            connect: () => void calls.connect++,
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
        loadSettings: () => ({ ...DEFAULT_SETTINGS, markets: ['P', 'Q'], selectivity: 'strict', lossShield: false, pickyAfterLoss: false, ...over }),
        saveSettings: () => {},
        ...io,
    });
    runner.attach(stores, cb => {
        watcher = cb;
        return () => {
            watcher = null;
        };
    });
    return {
        runner,
        stores,
        calls,
        series,
        advance: (ms: number) => {
            t += ms;
            Object.keys(lastTick).forEach(k => (lastTick[k] = t));
        },
        stale: (s: string) => (lastTick[s] = t - 60_000),
        queueProfits: (...p: number[]) => (profitQueue = p),
        watcher: () => watcher,
    };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('SixfoldRunner', () => {
    it('refuses to start when not logged in', () => {
        const h = harness({}, { isAuthorized: () => false });
        h.runner.start();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().lastError).toMatch(/log in/i);
    });

    it('scans, arms the planted market, waits for the entry digit, buys, settles and records the trade', async () => {
        const h = harness();
        h.runner.start();
        expect(h.runner.isRunning()).toBe(true);
        let s = h.runner.getSnapshot();
        expect(s.phase).toBe('armed');
        expect(s.armed?.symbol).toBe('P');
        expect(s.armed?.label).toMatch(/^(Over 2|Under 7)$/); // only the two primary contracts are ever armed
        const [side, barrier] = s.armed!.label.split(' ');
        // A digit that would not have lost Over 2 does not trigger the buy.
        h.runner.handleFeedTick('P', 7);
        expect(h.calls.buy).toHaveLength(0);
        // Another market printing an entry digit does not trigger it either.
        h.runner.handleFeedTick('Q', 1);
        expect(h.calls.buy).toHaveLength(0);
        // The armed market printing a losing digit does.
        h.runner.handleFeedTick('P', 1);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.buy[0].parameters).toMatchObject({
            contract_type: side === 'Over' ? 'DIGITOVER' : 'DIGITUNDER',
            barrier,
            symbol: 'P',
            duration: 1,
            duration_unit: 't',
            amount: 1,
        });
        // opened + settled snapshot reach the general transactions area
        expect(h.calls.pushed.length).toBeGreaterThanOrEqual(1);
        expect(h.calls.pushed[0].shortcode).toBe(`SIXFOLD_${side === 'Over' ? 'DIGITOVER' : 'DIGITUNDER'}_P`);
        expect(h.calls.pushed[0].run_id).toMatch(/^run-/);
        s = h.runner.getSnapshot();
        expect(s.session.trades).toBe(1);
        expect(s.session.wins).toBe(1);
        expect(s.trades[0].status).toBe('won');
        expect(s.phase).toBe('cooling');
    });

    it('trades one at a time and goes looking again after the cool-down', async () => {
        const h = harness({ takeProfit: 0 });
        h.runner.start();
        h.runner.handleFeedTick('P', 1);
        h.runner.handleFeedTick('P', 1); // second entry digit while the first trade is in flight: ignored
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        h.advance(1500);
        h.runner.tick();
        expect(h.runner.getSnapshot().phase).toBe('armed');
        h.runner.handleFeedTick('P', 0);
        await flush();
        expect(h.calls.buy).toHaveLength(2);
    });

    it('stops at take profit and releases the Run Panel', async () => {
        const h = harness({ takeProfit: 0.3 });
        h.runner.start();
        expect(h.stores.run_panel.running).toBe(true);
        expect(h.stores.dashboard.active_trading_module).toBe('sixfold');
        h.runner.handleFeedTick('P', 1);
        await flush();
        const s = h.runner.getSnapshot();
        expect(s.running).toBe(false);
        expect(s.stopReason).toMatch(/Take profit/);
        expect(h.stores.run_panel.running).toBe(false);
        expect(h.stores.dashboard.active_trading_module).toBeNull();
    });

    it('doubles the stake after a loss when martingale is on, and uses the recovery barrier', async () => {
        const h = harness({ takeProfit: 0, martingale: true, multiplier: 2, recoverySizing: 'MULTIPLIER', streakBudget: 0, recovery: true, recoveryOver: 4, recoveryUnder: 5 });
        h.queueProfits(-1);
        h.runner.start();
        const side = h.runner.getSnapshot().armed!.label.split(' ')[0];
        h.runner.handleFeedTick('P', 1);
        await flush();
        h.advance(1500);
        h.runner.tick();
        h.runner.handleFeedTick('P', 0);
        await flush();
        expect(h.calls.buy[1].parameters.amount).toBe(2);
        expect(h.calls.buy[1].parameters.barrier).toBe(side === 'Over' ? '4' : '5');
    });

    it('stops after the consecutive-loss limit', async () => {
        const h = harness({ takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 2 });
        h.queueProfits(-1, -1);
        h.runner.start();
        h.runner.handleFeedTick('P', 1);
        await flush();
        h.advance(1500);
        h.runner.tick();
        h.runner.handleFeedTick('P', h.runner.getSnapshot().armed!.entryDigits[0]);
        await flush();
        expect(h.runner.getSnapshot().stopReason).toMatch(/consecutive losses/);
    });

    it('never trades a market whose last tick is stale', async () => {
        const h = harness();
        h.runner.start();
        h.stale('P');
        h.runner.handleFeedTick('P', 1);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
    });

    it('skips a contract Deriv refuses, keeps the session alive, and quarantines the market after two refusals', async () => {
        let n = 0;
        const h = harness(
            { takeProfit: 0, selectivity: 'active' },
            {
                buy: async () => {
                    n++;
                    throw new TradeRequestError('Contract not offered', { stage: 'buy', kind: 'rejected', code: 'InvalidContractProposal' });
                },
            }
        );
        h.runner.start();
        h.runner.handleFeedTick('P', 1);
        await flush();
        expect(h.runner.isRunning()).toBe(true);
        // Keep poking until P has been refused twice.
        for (let i = 0; i < 6 && !h.runner.getSnapshot().quarantined.includes('P'); i++) {
            h.advance(1500);
            h.runner.tick();
            const a = h.runner.getSnapshot().armed;
            if (a?.symbol === 'P') h.runner.handleFeedTick('P', a.entryDigits[0] ?? 1);
            await flush();
        }
        expect(n).toBeGreaterThanOrEqual(2);
        expect(h.runner.getSnapshot().quarantined).toContain('P');
    });

    it('stops (never retries) when a purchase may exist but its result is unknown', async () => {
        const h = harness(
            {},
            {
                buy: async () => {
                    throw new TradeRequestError('Purchase request timed out.', { stage: 'buy', kind: 'timeout', outcomeUnknown: true });
                },
            }
        );
        h.runner.start();
        h.runner.handleFeedTick('P', 1);
        await flush();
        const s = h.runner.getSnapshot();
        expect(s.running).toBe(false);
        expect(s.stopReason).toMatch(/Stopped/);
    });

    it('stops when the Run Panel is stopped or another module takes over', () => {
        const h = harness();
        h.runner.start();
        h.watcher()!(false, null);
        expect(h.runner.isRunning()).toBe(false);
        h.runner.start();
        h.watcher()!(true, 'auto_trades');
        expect(h.runner.isRunning()).toBe(false);
    });

    it('stops when the Run Panel Stop handler is called', () => {
        const h = harness();
        h.runner.start();
        h.stores.dashboard.handlers.sixfold();
        expect(h.runner.isRunning()).toBe(false);
    });

    it('does not trade markets without enough history', () => {
        const h = harness();
        h.series.P = planted.slice(0, MIN_TICKS - 1);
        h.runner.start();
        expect(h.runner.getSnapshot().armed).toBeNull();
        expect(h.runner.getSnapshot().readyMarkets).toBe(1);
    });

    it('ANY entry mode buys as soon as a contract is armed', async () => {
        const h = harness({ entry: 'ANY' });
        h.runner.start();
        await flush();
        expect(h.calls.buy).toHaveLength(1);
    });

    it('asks the feed to connect when it is not live and gives up after waiting', () => {
        let live = false;
        const h = harness({}, {
            feed: {
                getLiveSeries: () => ({}),
                getLastTickAt: () => null,
                getLastDigit: () => null,
                isLive: () => live,
                getSnapshot: () => ({ mode: 'live', status: 'offline', error: 'No route', series: {}, version: 1 }),
                connect: () => void (live = false),
            },
        });
        h.runner.start();
        expect(h.runner.getSnapshot().phase).toBe('connecting');
        h.advance(30_000);
        h.runner.tick();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/No route/);
    });

    it('persists edited settings and re-clamps the base stake while idle', () => {
        const h = harness();
        h.runner.updateSettings({ stake: 2.5 });
        expect(h.runner.getSnapshot().settings.stake).toBe(2.5);
        expect(h.runner.getSnapshot().session.currentStake).toBe(2.5);
    });
});

describe('SixfoldRunner trades only the primary contracts', () => {
    it('scans exactly Over 2 and Under 7 on every market by default', () => {
        const h = harness();
        h.runner.start();
        const scan = h.runner.getSnapshot().scan!;
        expect(scan.cells).toHaveLength(2 * 2); // 2 markets x 2 contracts
        expect(new Set(scan.cells.map(c => c.label))).toEqual(new Set(['Over 2', 'Under 7']));
    });

    it('never buys any other contract across a long session, even when others look healthier', async () => {
        const h = harness({ takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0, selectivity: 'active' });
        h.runner.start();
        for (let i = 0; i < 25; i++) {
            h.advance(1500);
            h.runner.tick();
            const a = h.runner.getSnapshot().armed;
            if (a) h.runner.handleFeedTick(a.symbol, a.entryDigits[0] ?? 1);
            await flush();
        }
        expect(h.calls.buy.length).toBeGreaterThan(3);
        for (const b of h.calls.buy) {
            const ok = (b.parameters.contract_type === 'DIGITOVER' && b.parameters.barrier === '2') || (b.parameters.contract_type === 'DIGITUNDER' && b.parameters.barrier === '7');
            expect(ok).toBe(true);
        }
    });

    it('after a loss it uses only the Over 3 / Under 6 recovery barriers, then returns to Over 2 / Under 7', async () => {
        const h = harness({ takeProfit: 0, recovery: true });
        h.queueProfits(-1, 0.35);
        h.runner.start();
        const side = h.runner.getSnapshot().armed!.label.split(' ')[0];
        const entry = h.runner.getSnapshot().armed!.entryDigits[0];
        h.runner.handleFeedTick(h.runner.getSnapshot().armed!.symbol, entry);
        await flush();
        h.advance(1500);
        h.runner.tick();
        const a2 = h.runner.getSnapshot().armed!;
        h.runner.handleFeedTick(a2.symbol, a2.entryDigits[0]);
        await flush();
        expect(h.calls.buy[1].parameters.barrier).toBe(h.calls.buy[1].parameters.contract_type === 'DIGITOVER' ? '3' : '6');
        h.advance(1500);
        h.runner.tick();
        const a3 = h.runner.getSnapshot().armed!;
        h.runner.handleFeedTick(a3.symbol, a3.entryDigits[0]);
        await flush();
        expect(['2', '7']).toContain(h.calls.buy[2].parameters.barrier);
        expect(side === 'Over' || side === 'Under').toBe(true);
    });

    it('switching Over off leaves only Under 7, and switching both off refuses to run', () => {
        const h = harness({ useOver: false });
        h.runner.start();
        expect(new Set(h.runner.getSnapshot().scan!.cells.map(c => c.label))).toEqual(new Set(['Under 7']));
        h.runner.stop('x');
        h.runner.updateSettings({ useUnder: false });
        h.runner.start();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().lastError).toMatch(/Over or Under/);
    });

    it('lets you move the primary barriers (for example Over 3 / Under 6) and scans only those', () => {
        const h = harness({ primaryOver: 3, primaryUnder: 6 });
        h.runner.start();
        expect(new Set(h.runner.getSnapshot().scan!.cells.map(c => c.label))).toEqual(new Set(['Over 3', 'Under 6']));
    });
});

describe('SixfoldRunner loss shield and result-aware rules', () => {
    // Two markets that both look healthy, so after a loss on one the other must be used.
    const twoGood = () => {
        const h = harness({ takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0, selectivity: 'active', recovery: false, lossShield: true, pickyAfterLoss: true });
        h.series.Q = planted.slice();
        return h;
    };
    const buyOnce = async (h: ReturnType<typeof harness>) => {
        h.advance(1500);
        h.runner.tick();
        const a = h.runner.getSnapshot().armed!;
        h.runner.handleFeedTick(a.symbol, a.entryDigits[0]);
        await flush();
        return a.symbol;
    };

    it('rests a market after it loses and trades the other one next', async () => {
        const h = twoGood();
        h.queueProfits(-1, 0.35);
        h.runner.start();
        const first = await buyOnce(h);
        h.advance(1600);
        h.runner.tick();
        const snap = h.runner.getSnapshot();
        expect(snap.resting.map(r => r.symbol)).toEqual([first]);
        expect(snap.queue.find(q => q.cell.symbol === first)?.reason).toMatch(/Resting/);
        const second = await buyOnce(h);
        expect(second).not.toBe(first);
    });

    it('brings the market back after the rest is over', async () => {
        const h = twoGood();
        h.queueProfits(-1, 0.35, 0.35, 0.35, 0.35);
        h.runner.updateSettings({ restTrades: 1 });
        h.runner.start();
        const first = await buyOnce(h);
        expect(h.runner.getSnapshot().resting.map(r => r.symbol)).toEqual([first]);
        await buyOnce(h); // one trade elsewhere ends the rest
        expect(h.runner.getSnapshot().resting).toEqual([]);
    });

    it('lets a rested market return after five minutes even if nothing else traded', async () => {
        const h = harness({ takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0, selectivity: 'active', recovery: false, markets: ['P'], lossShield: true });
        h.queueProfits(-1);
        h.runner.start();
        await buyOnce(h);
        expect(h.runner.getSnapshot().resting).toHaveLength(1);
        h.advance(5 * 60_000 + 1000);
        h.runner.tick();
        expect(h.runner.getSnapshot().resting).toEqual([]);
        expect(h.runner.getSnapshot().armed).not.toBeNull();
    });

    it('does nothing different when the loss shield is off', async () => {
        const h = twoGood();
        h.runner.updateSettings({ lossShield: false });
        h.queueProfits(-1);
        h.runner.start();
        await buyOnce(h);
        expect(h.runner.getSnapshot().resting).toEqual([]);
    });

    it('asks for a higher score right after a loss and lets it fade', async () => {
        const h = twoGood();
        h.queueProfits(-1);
        h.runner.start();
        expect(h.runner.getSnapshot().pickyBump).toBe(0);
        await buyOnce(h);
        expect(h.runner.getSnapshot().pickyBump).toBe(10);
        h.advance(60_000);
        expect(h.runner.getSnapshot().pickyBump).toBe(10); // snapshot is rebuilt on tick
        h.runner.tick();
        expect(h.runner.getSnapshot().pickyBump).toBe(6);
        h.advance(150_000);
        h.runner.tick();
        expect(h.runner.getSnapshot().pickyBump).toBe(0);
    });

    it('does not become picky when the setting is off, and a win clears it', async () => {
        const h = twoGood();
        h.runner.updateSettings({ pickyAfterLoss: false });
        h.queueProfits(-1);
        h.runner.start();
        await buyOnce(h);
        expect(h.runner.getSnapshot().pickyBump).toBe(0);
    });

    it('smart entry skips the digit that just lost on that market', async () => {
        const h = harness({ takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0, selectivity: 'active', recovery: false, markets: ['P'], lossShield: false });
        h.queueProfits(-1);
        h.runner.start();
        const a = h.runner.getSnapshot().armed!;
        const lostOn = a.entryDigits[0];
        h.runner.handleFeedTick(a.symbol, lostOn);
        await flush();
        h.advance(1500);
        h.runner.tick();
        expect(h.runner.getSnapshot().armed!.entryDigits).not.toContain(lostOn);
    });

    it('settings keep working for fixed and any-tick entry', () => {
        const h = harness({ entry: 'SETUP' });
        h.runner.start();
        const a = h.runner.getSnapshot().armed!;
        expect(a.entryDigits.length).toBeGreaterThan(0);
        h.runner.stop('x');
        h.runner.updateSettings({ entry: 'ANY' });
        h.runner.start();
        expect(h.runner.getSnapshot().armed?.entryDigits ?? []).toEqual([]);
    });
});

describe('SixfoldRunner streak budget', () => {
    it('accepts the loss and goes back to the base stake instead of climbing past the budget', async () => {
        const h = harness({
            takeProfit: 0,
            stopLoss: 0,
            maxConsecutiveLosses: 0,
            selectivity: 'active',
            martingale: true,
            multiplier: 2,
            recoverySizing: 'MULTIPLIER',
            streakBudget: 5,
            maxSteps: 0,
            recovery: false,
            lossShield: false,
            markets: ['P'],
        });
        h.queueProfits(-1, -2, -4, 0.35);
        h.runner.start();
        for (let i = 0; i < 4; i++) {
            h.advance(1500);
            h.runner.tick();
            const a = h.runner.getSnapshot().armed!;
            h.runner.handleFeedTick(a.symbol, a.entryDigits[0]);
            await flush();
        }
        const stakes = h.calls.buy.map((b: any) => b.parameters.amount);
        expect(stakes.slice(0, 3)).toEqual([1, 2, 1]); // 1 + 4 would pass 5, so the third trade restarts at base
        expect(h.runner.getSnapshot().session.writeOffs).toBeGreaterThanOrEqual(1);
        expect(h.runner.getSnapshot().log.some(l => /Streak budget reached/.test(l.text))).toBe(true);
    });
});
