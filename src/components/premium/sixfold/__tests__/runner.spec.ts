import { TradeRequestError } from '@/utils/trade-errors';
import { DEFAULT_SETTINGS, normalizeSettings, type SixfoldSettings } from '../money';
import type { RunnerOverlay } from '../overlay';
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
        loadSettings: () => ({
            ...DEFAULT_SETTINGS,
            entry: 'SMART',
            markets: ['P', 'Q'],
            selectivity: 'strict',
            lossShield: false,
            pickyAfterLoss: false,
            meterGuide: false,
            winStreakGate: false,
            pressureGate: false,
            multiWindowGate: false,
            winPressureGate: false,
            vhOpening: false,
            ...over,
        }),
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
        const h = harness({
            takeProfit: 0,
            martingale: true,
            multiplier: 2,
            recoverySizing: 'MULTIPLIER',
            streakBudget: 0,
            recovery: true,
            recoveryOver: 4,
            recoveryUnder: 5,
        });
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
                    throw new TradeRequestError('Contract not offered', {
                        stage: 'buy',
                        kind: 'rejected',
                        code: 'InvalidContractProposal',
                    });
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
                    throw new TradeRequestError('Purchase request timed out.', {
                        stage: 'buy',
                        kind: 'timeout',
                        outcomeUnknown: true,
                    });
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
        expect(h.calls.buy).toHaveLength(0); // never on a tick that printed before Run
        const sym = h.runner.getSnapshot().armed!.symbol;
        h.series[sym].push(7);
        h.runner.handleFeedTick(sym, 7);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
    });

    it('the first run waits for a fresh tick: nothing is bought on a tick that printed before Run', async () => {
        const h = harness({ entry: 'ANY', markets: ['P'] });
        h.runner.start();
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        h.series.P.push(7);
        h.runner.handleFeedTick('P', 7);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
    });

    it('opens on paper: the first trade is virtual, a paper loss waits for a paper win, then real trades start', async () => {
        const h = harness({ entry: 'ANY', markets: ['P'], vhOpening: true, recovery: false, takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0 });
        h.runner.start();
        expect(h.runner.getSnapshot().virtualHook.opening).toBe(true);
        h.series.P.push(7);
        h.runner.handleFeedTick('P', 7); // the trigger: a virtual trade opens, nothing is bought
        await flush();
        expect(h.calls.buy).toHaveLength(0);
        expect(h.runner.getSnapshot().trades[0].virtual).toBe(true);
        h.runner.handleFeedTick('P', 1); // it settles on a losing digit (Over 2)
        expect(h.runner.getSnapshot().trades[0].status).toBe('lost');
        expect(h.runner.getSnapshot().virtualHook.virtual).toBe(true); // still waiting for a win
        h.advance(1500);
        h.runner.tick();
        h.series.P.push(7);
        h.runner.handleFeedTick('P', 7);
        await flush();
        expect(h.calls.buy).toHaveLength(0); // second paper trade
        h.runner.handleFeedTick('P', 7); // wins
        expect(h.runner.getSnapshot().trades[0].status).toBe('won');
        expect(h.runner.getSnapshot().virtualHook.virtual).toBe(false);
        expect(h.runner.getSnapshot().session.trades).toBe(0); // paper trades never touch the session
        h.advance(1500);
        h.runner.tick();
        h.series.P.push(7);
        h.runner.handleFeedTick('P', 7);
        await flush();
        expect(h.calls.buy).toHaveLength(1); // real money from here
    });

    it('with the opening switched off the first trade is real', async () => {
        const h = harness({ entry: 'ANY', markets: ['P'], vhOpening: false });
        h.runner.start();
        h.series.P.push(7);
        h.runner.handleFeedTick('P', 7);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
    });

    it('Entry Brain gives every armed trade an entry plan and never buys without it firing', async () => {
        const h = harness({ entry: 'BRAIN', markets: ['P'] });
        h.runner.start();
        const armed = h.runner.getSnapshot().armed;
        expect(armed).not.toBeNull();
        expect(armed!.plan).not.toBeNull();
        expect(armed!.plan!.label.length).toBeGreaterThan(0);
        expect(armed!.entryDigits).toEqual([]); // no fixed digit: the plan is the entry
        await flush();
        // Whatever it bought was bought on a plan, with the blind-entry win rate recorded for the ledger.
        h.runner.getSnapshot().trades.forEach(t => {
            expect(t.plan).not.toBeNull();
            expect(t.baseRate).not.toBeNull();
        });
    });

    it('Entry Brain buys on its plan and records it on the trade', async () => {
        const h = harness({ entry: 'BRAIN', markets: ['P'] });
        h.runner.start();
        const plan = h.runner.getSnapshot().armed!.plan!;
        expect(plan).toBeTruthy();
        expect(plan.why).not.toMatch(/still collecting/); // planned from a real fitted market, not the warm-up fallback
        // Feed alternating ticks: every arm that can fire on this market fires on one of them within a few ticks.
        for (let k = 0; k < 8 && h.calls.buy.length === 0; k++) {
            const next = h.series.P.at(-1) === 7 ? 1 : 7;
            h.series.P.push(next);
            h.runner.handleFeedTick('P', next);
            await flush();
        }
        if (h.calls.buy.length > 0) {
            const t = h.runner.getSnapshot().trades[0];
            expect(t.plan).toBe(plan.arm);
            expect(t.baseRate!).toBeGreaterThan(0.45); // a blind entry on 1,7,1,7... wins every other tick
            expect(t.baseRate!).toBeLessThan(0.55);
        }
        expect(h.runner.getSnapshot().brain).not.toBeNull();
    });

    it("Entry Brain enters only on the market's trigger digits and never on any other digit", async () => {
        const h = harness({ entry: 'BRAIN', markets: ['P'] });
        h.runner.start();
        const plan = h.runner.getSnapshot().armed!.plan!;
        expect(plan.digits.length).toBeGreaterThan(0);
        const other = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find(x => !plan.digits.includes(x))!;
        h.series.P.push(other);
        h.runner.handleFeedTick('P', other);
        await flush();
        expect(h.calls.buy).toHaveLength(0);
    });

    it('recovery with the Brain uses the strict plan (proven digits only)', async () => {
        const h = harness({ entry: 'SMART', recoveryEntry: 'BRAIN', markets: ['P'], martingale: true });
        h.queueProfits(-1);
        h.runner.start();
        h.runner.handleFeedTick('P', 1);
        await flush();
        h.advance(1500);
        h.runner.tick();
        const armed = h.runner.getSnapshot().armed;
        if (armed) {
            expect(armed.plan).not.toBeNull();
            expect(armed.plan!.strict).toBe(true);
        }
    });

    it('the retired Entry Lab modes in saved settings become the Brain', () => {
        const h = harness({ entry: 'LAB' as never, recoveryEntry: 'LAB' as never, markets: ['Q'] });
        const s = h.runner.getSnapshot().settings;
        expect(s.entry).toBe('BRAIN');
        expect(s.recoveryEntry).toBe('BRAIN');
    });

    it('win-streak guard does not buy while the market is not on a run of wins', async () => {
        // The planted market alternates 1,7: Over 2 never wins more than one tick in a row.
        const h = harness({ entry: 'ANY', markets: ['P'], winStreakGate: true, winStreak: 4 });
        h.runner.start();
        await flush();
        expect(h.calls.buy).toHaveLength(0);
    });

    it('win-streak guard buys once the market has run 4 wins in a row', async () => {
        const h = harness({ entry: 'ANY', markets: ['P'], winStreakGate: true, winStreak: 4 });
        h.series.P.push(7, 3, 8, 5);
        h.runner.start();
        h.series.P.push(9);
        h.runner.handleFeedTick('P', 9);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
    });

    it('virtual hook: after real losses the next trade is paper only, settles on ticks and moves no money', async () => {
        const h = harness({
            entry: 'ANY',
            markets: ['P'],
            takeProfit: 0,
            stopLoss: 0,
            maxConsecutiveLosses: 0,
            recovery: false,
            virtualHook: true,
            vhEnterLosses: 1,
            vhReturnWins: 1,
            winStreakGate: false,
        });
        h.queueProfits(-1);
        h.runner.start();
        h.series.P.push(7);
        h.runner.handleFeedTick('P', 7);
        await flush();
        expect(h.calls.buy).toHaveLength(1); // the real trade, which loses
        await flush();
        h.advance(5000);
        h.runner.tick();
        await flush();
        expect(h.calls.buy).toHaveLength(1); // now virtual: no purchase
        const snap = h.runner.getSnapshot();
        expect(snap.virtualHook.virtual).toBe(true);
        expect(snap.trades[0].virtual).toBe(true);
        expect(snap.session.trades).toBe(1);
        // a winning tick (Over 2: 7) settles it on paper
        h.runner.handleFeedTick('P', 7);
        const after = h.runner.getSnapshot();
        expect(after.trades[0].status).toBe('won');
        expect(after.virtualHook.virtual).toBe(false);
        expect(after.session.trades).toBe(1);
        expect(after.session.pnl).toBeLessThan(0);
    });

    it('asks the feed to connect when it is not live and gives up after waiting', () => {
        let live = false;
        const h = harness(
            {},
            {
                feed: {
                    getLiveSeries: () => ({}),
                    getLastTickAt: () => null,
                    getLastDigit: () => null,
                    isLive: () => live,
                    getSnapshot: () => ({ mode: 'live', status: 'offline', error: 'No route', series: {}, version: 1 }),
                    connect: () => void (live = false),
                },
            }
        );
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
            const ok =
                (b.parameters.contract_type === 'DIGITOVER' && b.parameters.barrier === '2') ||
                (b.parameters.contract_type === 'DIGITUNDER' && b.parameters.barrier === '7');
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
        expect(h.calls.buy[1].parameters.barrier).toBe(
            h.calls.buy[1].parameters.contract_type === 'DIGITOVER' ? '3' : '6'
        );
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
        const h = harness({
            takeProfit: 0,
            stopLoss: 0,
            maxConsecutiveLosses: 0,
            selectivity: 'active',
            recovery: false,
            lossShield: true,
            pickyAfterLoss: true,
        });
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
        const h = harness({
            takeProfit: 0,
            stopLoss: 0,
            maxConsecutiveLosses: 0,
            selectivity: 'active',
            recovery: false,
            markets: ['P'],
            lossShield: true,
        });
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
        const h = harness({
            takeProfit: 0,
            stopLoss: 0,
            maxConsecutiveLosses: 0,
            selectivity: 'active',
            recovery: false,
            markets: ['P'],
            lossShield: false,
        });
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

describe('SixfoldRunner recovery entry gate', () => {
    const lossThenArm = async (over: Partial<SixfoldSettings>) => {
        const h = harness({
            takeProfit: 0,
            stopLoss: 0,
            maxConsecutiveLosses: 0,
            selectivity: 'active',
            recovery: false,
            lossShield: false,
            markets: ['P'],
            ...over,
        });
        h.queueProfits(-1, 0.35);
        h.runner.start();
        const a = h.runner.getSnapshot().armed!;
        h.runner.handleFeedTick(a.symbol, a.entryDigits[0]);
        await flush();
        h.advance(1500);
        h.runner.tick();
        return h;
    };
    it('does not buy a recovery trade until the market shows the run, then buys', async () => {
        const h = await lossThenArm({ recoveryEntry: 'MOMENTUM', recoveryForm: 3 });
        const a = h.runner.getSnapshot().armed!;
        h.series.P.push(0, 1, 0); // last ticks lose Over 2
        h.runner.handleFeedTick('P', a.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        h.series.P.push(5, 6, 7); // three winning ticks
        h.runner.handleFeedTick('P', a.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(2);
    });
    it('does not gate the first trade of a session, and OFF never gates', async () => {
        const h = harness({ recoveryEntry: 'MOMENTUM', recoveryForm: 8, selectivity: 'active', markets: ['P'] });
        h.runner.start();
        h.series.P.push(0, 0, 0, 0, 0, 0, 0, 0);
        const a = h.runner.getSnapshot().armed!;
        h.runner.handleFeedTick('P', a.entryDigits[0]);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        const g = await lossThenArm({ recoveryEntry: 'OFF' });
        const b = g.runner.getSnapshot().armed!;
        g.series.P.push(0, 0, 0);
        g.runner.handleFeedTick('P', b.entryDigits[0]);
        await flush();
        expect(g.calls.buy).toHaveLength(2);
    });
});

describe('SixfoldRunner Meter gate', () => {
    it('exposes the Meter reading while scanning', () => {
        const h = harness();
        h.runner.start();
        const r = h.runner.getSnapshot().regime!;
        expect(r.total).toBe(4); // 2 markets x Over 2 / Under 7
        expect(['GO', 'WAIT', 'AVOID']).toContain(r.verdict);
    });
    it('skips a contract in a loss cluster only when the gate is on', () => {
        const mk = (gate: boolean) => {
            const h = harness({ selectivity: 'active', markets: ['P'], useUnder: false, meterGuide: gate });
            // Over 2 looks fine historically (1,7,1,7...) but the last six ticks all lose.
            h.series.P.push(0, 0, 0, 0, 0, 0);
            h.runner.start();
            return h;
        };
        const off = mk(false);
        expect(off.runner.getSnapshot().regime!.cells[0].state).toBe('COLD');
        expect(off.runner.getSnapshot().armed).not.toBeNull();
        const on = mk(true);
        expect(on.runner.getSnapshot().armed).toBeNull();
        expect(on.runner.getSnapshot().queue[0].reason).toMatch(/Meter/);
    });
});

describe('SixfoldRunner Meter guide', () => {
    // Over 2 wins on 80% of ticks here, evenly spread: a healthy, un-clustered contract.
    const healthy = Array.from({ length: 600 }, (_, i) => [1, 5, 6, 7, 8][i % 5]);
    // The same, but the last 30 ticks only won 18 times (no long losing run): below normal without being a loss cluster.
    const poorTail = () => {
        const s = healthy.slice(0, 570);
        for (let i = 0; i < 30; i++) s.push(i % 5 === 0 || i % 5 === 2 ? 1 : 6);
        return s;
    };
    const setup = (over: Partial<SixfoldSettings>, digits: number[]) => {
        const h = harness({ selectivity: 'active', markets: ['P'], useUnder: false, meterGuide: true, ...over });
        h.series.P.splice(0, h.series.P.length, ...digits);
        return h;
    };

    // Random-looking digits whose Over 2 reading scores 60 and whose last 30 ticks run weak but not clustered: the Meter asks
    // for more score than it has until it has waited.
    const mkNoise = (seed: number) => {
        let a = seed;
        return Array.from({ length: 600 }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
    };

    it('trades a contract the Meter reads well, with no extra bar', () => {
        const h = setup({}, healthy);
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.armed?.label).toBe('Over 2');
        expect(s.meterGuide).toMatchObject({ on: true, verdict: 'GO', bump: 0 });
    });

    it('raises the bar on a weak reading, then eases off while it waits instead of locking trading', () => {
        const guided = setup({ meterFloor: 0, meterFloorRecovery: 0 }, mkNoise(25));
        guided.runner.start();
        let s = guided.runner.getSnapshot();
        expect(s.armed).toBeNull();
        expect(s.queue[0].reason).toMatch(/Meter/);
        expect(s.meterGuide.bump).toBeGreaterThan(0);
        expect(s.meterGuide.easesInSec).toBeGreaterThan(0);
        // The very same contract is taken when the guide is off: the Meter, not the scanner, held it back.
        const free = setup({ meterGuide: false, meterFloor: 0, meterFloorRecovery: 0 }, mkNoise(25));
        free.runner.start();
        expect(free.runner.getSnapshot().armed).not.toBeNull();
        // Still held shortly after; then, well before the patience has run out, the bar has eased enough to take it.
        guided.advance(10_000);
        guided.runner.tick();
        expect(guided.runner.getSnapshot().armed).toBeNull();
        guided.advance(40_000);
        guided.runner.tick();
        s = guided.runner.getSnapshot();
        expect(s.armed?.label).toBe('Over 2');
        expect(s.meterGuide.bump).toBeGreaterThan(0);
        expect(s.meterGuide.bump).toBeLessThan(10);
    });

    it('does not buy a contract that fell into a loss cluster after the last scan', async () => {
        const run = async (guide: boolean) => {
            const h = setup({ meterGuide: guide }, healthy.slice());
            h.runner.start();
            const entry = h.runner.getSnapshot().armed!.entryDigits[0];
            h.series.P.push(0, 0, 0, 0, 0); // five losses in a row since the scan: the stored reading is stale
            h.runner.handleFeedTick('P', entry);
            await flush();
            return h;
        };
        const off = await run(false);
        expect(off.calls.buy).toHaveLength(1);
        const on = await run(true);
        expect(on.calls.buy).toHaveLength(0);
        expect(on.runner.getSnapshot().armed).toBeNull();
        expect(on.runner.getSnapshot().log[0].text).toMatch(/loss cluster/i);
    });

    it('reads the recovery contract it will buy, not the one that was armed', async () => {
        // Over 2 is fine here (3 > 2) but Over 3 has just lost six times running (3 is not above 3).
        const digits = [...healthy.slice(0, 594), 3, 3, 3, 3, 3, 3];
        const run = async (guide: boolean) => {
            const h = setup(
                {
                    meterGuide: guide,
                    takeProfit: 0,
                    stopLoss: 0,
                    maxConsecutiveLosses: 0,
                    recovery: true,
                    recoveryOver: 3,
                },
                digits.slice()
            );
            h.runner.start();
            const entry = h.runner.getSnapshot().armed!.entryDigits[0];
            h.queueProfits(-1);
            h.runner.handleFeedTick('P', entry); // the first trade is a normal Over 2 and loses
            await flush();
            h.advance(2_000);
            h.runner.tick();
            return h;
        };
        const off = await run(false);
        expect(off.runner.getSnapshot().session.consecutiveLosses).toBe(1);
        expect(off.runner.getSnapshot().armed).not.toBeNull();
        const on = await run(true);
        expect(on.runner.getSnapshot().session.consecutiveLosses).toBe(1);
        expect(on.runner.getSnapshot().armed).toBeNull();
        expect(on.runner.getSnapshot().queue[0].reason).toMatch(/loss cluster/i);
    });

    it('buys only while the Meter is at or above the floor, and keeps waiting under it', () => {
        // Same weak market as above: Meter 36, so under the default floor of 50 nothing is bought, however long it waits.
        const h = setup({}, poorTail());
        h.runner.start();
        let s = h.runner.getSnapshot();
        expect(s.meterGuide).toMatchObject({ floor: 50, underFloor: true });
        expect(s.armed).toBeNull();
        expect(s.queue[0].reason).toMatch(/under the 50 floor/i);
        h.advance(10 * 60_000);
        h.runner.tick();
        expect(h.runner.getSnapshot().armed).toBeNull();
        // Floors off: the same market is traded.
        const off = setup({ meterFloor: 0, meterFloorRecovery: 0 }, poorTail());
        off.runner.start();
        expect(off.runner.getSnapshot().armed?.label).toBe('Over 2');
        // A healthy market clears the floor.
        const ok = setup({}, healthy);
        ok.runner.start();
        expect(ok.runner.getSnapshot().meterGuide).toMatchObject({ underFloor: false, floor: 50 });
        expect(ok.runner.getSnapshot().armed?.label).toBe('Over 2');
    });

    it('holds the contract itself to the floor too, even when the market-wide Meter is fine', () => {
        // P is strong (64) and Q is weak (30): the Meter across both is 47, over the floor of 40, yet Q is still not bought.
        const h = setup({ meterFloor: 40, meterFloorRecovery: 40, markets: ['P', 'Q'] }, healthy.slice());
        h.series.Q.splice(0, h.series.Q.length, ...mkNoise(25));
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.meterGuide.underFloor).toBe(false);
        expect(s.armed?.symbol).toBe('P');
        const q = s.queue.find(x => x.cell.symbol === 'Q')!;
        expect(q.ok).toBe(false);
        expect(q.reason).toMatch(/contract's Meter reading 30 is under the 40 floor/i);
    });

    it('asks more for recovery: the recovery floor applies after a loss', async () => {
        const h = setup(
            {
                meterFloor: 50,
                meterFloorRecovery: 100,
                takeProfit: 0,
                stopLoss: 0,
                maxConsecutiveLosses: 0,
                recovery: true,
            },
            healthy.slice()
        );
        h.runner.start();
        expect(h.runner.getSnapshot().meterGuide.floor).toBe(50);
        const entry = h.runner.getSnapshot().armed!.entryDigits[0];
        h.queueProfits(-1);
        h.runner.handleFeedTick('P', entry);
        await flush();
        h.advance(2_000);
        h.runner.tick();
        const s = h.runner.getSnapshot();
        expect(s.session.consecutiveLosses).toBe(1);
        expect(s.meterGuide).toMatchObject({ floor: 100, recovering: true, underFloor: true });
        expect(s.armed).toBeNull();
    });

    it('does nothing at all when the guide is off', () => {
        const h = setup({ meterGuide: false }, mkNoise(25));
        h.runner.start();
        expect(h.runner.getSnapshot().meterGuide.on).toBe(false);
        expect(h.runner.getSnapshot().queue[0].reason).not.toMatch(/Meter/);
    });

    it('is on by default, and an old saved meterGate setting is ignored', () => {
        expect(DEFAULT_SETTINGS.meterGuide).toBe(true);
        expect(normalizeSettings({ meterGate: false } as never).meterGuide).toBe(true);
        expect(DEFAULT_SETTINGS).toMatchObject({ meterFloor: 50, meterFloorRecovery: 52 });
        expect(normalizeSettings({ meterFloor: 150, meterFloorRecovery: -3 })).toMatchObject({
            meterFloor: 100,
            meterFloorRecovery: 0,
        });
        expect(normalizeSettings({ meterPatience: 5 }).meterPatience).toBe(10);
        expect(normalizeSettings({ meterPatience: 9999 }).meterPatience).toBe(600);
    });
});

describe('SixfoldRunner danger gates', () => {
    const fill = (h: ReturnType<typeof harness>, digits: number[]) => {
        h.series.P.length = 0;
        h.series.P.push(...digits);
    };
    const repeat = (unit: number[], n: number) => Array.from({ length: n }, (_, i) => unit[i % unit.length]);

    it('refuses a market whose losing digits are crowding in, and says why', () => {
        const mk = (on: boolean) => {
            // planted: digit 1 (a losing digit for Over 2) prints every other tick, half the losing side's fair share again.
            const h = harness({ selectivity: 'active', markets: ['P'], useUnder: false, pressureGate: on });
            h.runner.start();
            return h;
        };
        expect(mk(false).runner.getSnapshot().armed).not.toBeNull();
        const on = mk(true);
        expect(on.runner.getSnapshot().armed).toBeNull();
        expect(on.runner.getSnapshot().queue[0].reason).toMatch(/losing/i);
    });

    it('lets a quiet market through the pressure gate', () => {
        const h = harness({ selectivity: 'active', markets: ['P'], useUnder: false, pressureGate: true });
        // Losing digit 1 shows up once in ten ticks (fair share), always followed by a winner.
        fill(h, repeat([1, 5, 6, 7, 8, 9, 5, 6, 7, 8], 600));
        h.runner.start();
        expect(h.runner.getSnapshot().armed?.symbol).toBe('P');
    });

    it('refuses a recent-only surge when the multi-window gate is on', () => {
        const mk = (on: boolean) => {
            const h = harness({ selectivity: 'active', markets: ['P'], useUnder: false, multiWindowGate: on });
            // 420 ticks that win Over 2 half the time, then 60 that win 95% of the time: a thrust in the latest window only.
            const older = Array.from({ length: 420 }, (_, i) => (i % 10 < 5 ? 5 : 1));
            const recent = Array.from({ length: 60 }, (_, i) => (i % 20 < 19 ? 5 : 1));
            fill(h, [...older, ...recent]);
            h.runner.start();
            return h;
        };
        expect(mk(false).runner.getSnapshot().queue[0].reason).not.toMatch(/thrust/i);
        const on = mk(true);
        expect(on.runner.getSnapshot().armed).toBeNull();
        expect(on.runner.getSnapshot().queue[0].reason).toMatch(/thrust/i);
    });

    it('after a loss reads the recovery contract: Over 3 also loses on a 3, so a market crowded with 3s is refused', async () => {
        const run = async (on: boolean) => {
            const h = harness({
                takeProfit: 0,
                stopLoss: 0,
                maxConsecutiveLosses: 0,
                selectivity: 'active',
                recovery: true,
                lossShield: false,
                markets: ['P'],
                useUnder: false,
                pressureGate: on,
            });
            // Digit 3 prints four ticks in ten: harmless for Over 2, but it is a losing digit for the Over 3 recovery trade.
            fill(h, repeat([1, 5, 3, 6, 3, 7, 3, 8, 3, 9], 600));
            h.queueProfits(-1, 0.35);
            h.runner.start();
            const a = h.runner.getSnapshot().armed!;
            expect(a).not.toBeNull(); // the first trade (Over 2) is fine
            h.runner.handleFeedTick(a.symbol, a.entryDigits[0]);
            await flush();
            h.advance(1500);
            h.runner.tick();
            return h;
        };
        expect((await run(false)).runner.getSnapshot().armed).not.toBeNull();
        const on = await run(true);
        expect(on.runner.getSnapshot().armed).toBeNull();
        expect(on.runner.getSnapshot().queue[0].reason).toMatch(/losing/i);
    });
});

describe('SixfoldRunner with an engine overlay', () => {
    const overlay = (over: Partial<RunnerOverlay> = {}): RunnerOverlay => ({
        moduleId: 'sentinel-ai',
        name: 'Sentinel AI',
        contracts: () => [{ side: 'OVER', param: 2 }],
        call: () => ({ allow: true, bump: 0, rank: 0, note: '' }),
        ...over,
    });

    it('trades only the overlay contracts, under its own Run Panel id and shortcode', async () => {
        const h = harness({}, { overlay: overlay() });
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.armed?.label).toBe('Over 2');
        expect(h.stores.dashboard.active_trading_module).toBe('sentinel-ai');
        h.runner.handleFeedTick('P', 1);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(h.calls.pushed[0].shortcode).toBe('SENTINEL_AI_DIGITOVER_P');
    });

    it('arms nothing while the overlay vetoes every cell, and says why', () => {
        const h = harness(
            {},
            { overlay: overlay({ call: () => ({ allow: false, bump: 0, rank: 0, note: 'neither engine backs it' }) }) }
        );
        h.runner.start();
        const s = h.runner.getSnapshot();
        expect(s.armed).toBeNull();
        expect(s.queue[0]?.reason).toMatch(/neither engine/i);
    });

    it('waits for the engine entry digit instead of its own, and reports bought and settled trades', async () => {
        const bought: number[] = [];
        const settled: Array<number | null> = [];
        const h = harness(
            {},
            {
                overlay: overlay({
                    entryDigits: () => [4],
                    onBought: n => bought.push(n.contractId),
                    onSettled: n => settled.push(n.profit),
                }),
            }
        );
        h.runner.start();
        expect(h.runner.getSnapshot().armed?.entryDigits).toEqual([4]);
        h.runner.handleFeedTick('P', 1); // the runner's own digit: ignored
        expect(h.calls.buy).toHaveLength(0);
        h.runner.handleFeedTick('P', 4);
        await flush();
        expect(h.calls.buy).toHaveLength(1);
        expect(bought).toHaveLength(1);
        expect(settled).toEqual([0.35]);
    });

    it('an overlay that throws never disturbs a live trade', async () => {
        const h = harness(
            {},
            {
                overlay: overlay({
                    onBought: () => {
                        throw new Error('boom');
                    },
                    onSettled: () => {
                        throw new Error('boom');
                    },
                }),
            }
        );
        h.runner.start();
        h.runner.handleFeedTick('P', 1);
        await flush();
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('records where every scanned contract stopped (the funnel)', () => {
        const h = harness({}, { overlay: overlay({ call: () => ({ allow: false, bump: 0, rank: 0, note: 'neither engine backs it' }) }) });
        h.runner.start();
        const f = h.runner.getSnapshot().funnel!;
        expect(f.cells).toBeGreaterThan(0);
        expect(f.overlayVeto).toBe(f.tradable);
        expect(f.eligible).toBe(0);
        expect(f.reasons[0]).toEqual({ reason: 'Engines: neither engine backs it', count: f.tradable });
    });

    it('the funnel counts an eligible contract when nothing refuses it', () => {
        const h = harness({}, { overlay: overlay() });
        h.runner.start();
        expect(h.runner.getSnapshot().funnel!.eligible).toBeGreaterThan(0);
    });
});
