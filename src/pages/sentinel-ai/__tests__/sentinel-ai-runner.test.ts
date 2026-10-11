import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import { TradeRequestError } from '@/utils/trade-errors';
import type { EngineSample, SentinelAiEngine, SignalExclusion } from '../sentinel-ai-engine-types';
import { MODULE_ID, SentinelAiRunner, type RunnerIO, type RunnerStores } from '../sentinel-ai-runner';
import { DEFAULT_SETTINGS, type SentinelAiSettings } from '../sentinel-ai-types';

const SYMBOL = 'R_100';

const opportunity = (contractId = 'UNDER7', digit: number | null = 4, symbol = SYMBOL): RankedOpportunity => {
    const isOver = contractId.startsWith('OVER');
    const barrier = Number(contractId.replace(/\D/g, ''));
    return {
        symbol,
        name: 'Volatility 100 Index',
        score: 72,
        blocked: false,
        dangerComposition: { total: 20, isHardBlocked: false },
        contract: {
            id: contractId,
            label: `${isOver ? 'Over' : 'Under'} ${barrier}`,
            side: isOver ? 'OVER' : 'UNDER',
            barrier,
            confidence: 64,
        },
        entryPoint: {
            status: digit === null ? 'NO ENTRY' : 'READY',
            preferred: digit === null ? null : { digit, pWin: 0.8 },
            window: { label: 'last 300 ticks' },
        },
        signal: { label: 'ENTER NOW', state: 'QUALIFIED', reason: '' },
    } as unknown as RankedOpportunity;
};

class FakeEngine implements SentinelAiEngine {
    surfaced: RankedOpportunity | null = null;
    digits: Record<string, number | null> = {};
    listeners = new Set<(symbol: string) => void>();
    retained = 0;
    failsafes: string[] = [];

    retain() {
        this.retained += 1;
        return () => {
            this.retained -= 1;
        };
    }

    sample(exclude?: SignalExclusion): EngineSample {
        const hidden = Boolean(this.surfaced && exclude?.(this.surfaced.symbol, String(this.surfaced.contract.id), this.surfaced));
        return {
            info: {
                status: 'live',
                online: 20,
                total: 20,
                degraded: this.failsafes.length > 0,
                failsafes: this.failsafes,
                dangerLabel: 'CALM',
            },
            surfaced: hidden ? null : this.surfaced,
        };
    }

    onTick(callback: (symbol: string) => void) {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }

    getLastDigit(symbol: string) {
        return this.digits[symbol] ?? null;
    }

    tick(symbol: string, digit: number) {
        this.digits[symbol] = digit;
        this.listeners.forEach(listener => listener(symbol));
    }
}

const makeStores = () => {
    const handlers: Record<string, () => void> = {};
    const run_panel = {
        run_id: '',
        is_running: false,
        is_contract_buying_in_progress: false,
        setIsRunning: jest.fn((value: boolean) => {
            run_panel.is_running = value;
        }),
        setRunId: jest.fn((id: string) => {
            run_panel.run_id = id;
        }),
        setContractStage: jest.fn(),
        toggleDrawer: jest.fn(),
        setHasOpenContract: jest.fn(),
        setShowBotStopMessage: jest.fn(),
        onBotContractEvent: jest.fn(),
    };
    const summary_card = { onBotContractEvent: jest.fn() };
    const transactions = { pushTransaction: jest.fn() };
    const dashboard = {
        active_trading_module: null as string | null,
        setActiveTradingModule: (id: string | null) => {
            dashboard.active_trading_module = id;
        },
        registerTradingStopHandler: (id: string, handler: () => void) => {
            handlers[id] = handler;
        },
        unregisterTradingStopHandler: (id: string) => {
            delete handlers[id];
        },
        stopActiveTradingModule: () => {
            if (dashboard.active_trading_module) handlers[dashboard.active_trading_module]?.();
        },
    };
    const stores = { client: { currency: 'USD' }, run_panel, summary_card, transactions, dashboard };
    return { stores: stores as unknown as RunnerStores, run_panel, summary_card, transactions, dashboard, handlers };
};

const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
};

type Harness = ReturnType<typeof makeHarness>;

const makeHarness = (settingsPatch: Partial<SentinelAiSettings> = {}, authorized = true) => {
    const engine = new FakeEngine();
    const fake = makeStores();
    let clock = 1_000_000;
    let nextContractId = 100;
    const profits: number[] = [];
    const gate: { hold: Promise<void> | null } = { hold: null };

    const buy = jest.fn(async ({ parameters }: { parameters: Record<string, any> }) => {
        if (gate.hold) await gate.hold;
        nextContractId += 1;
        return { buy_price: Number(parameters.amount), contract_id: nextContractId, transaction_id: nextContractId + 1000 };
    });
    const settle = jest.fn(
        async ({
            contractId,
            fallback,
            onUpdate,
        }: {
            contractId: number;
            fallback: Record<string, any>;
            onUpdate: (c: Record<string, any>) => void;
        }) => {
            const profit = profits.length ? (profits.shift() as number) : 0.95;
            const done = { ...fallback, contract_id: contractId, profit, status: profit < 0 ? 'lost' : 'won', is_sold: 1 };
            onUpdate(done);
            return done;
        }
    );
    const alert = jest.fn();

    const io: RunnerIO = {
        engine,
        buy,
        settle,
        isAuthorized: () => authorized,
        currency: () => 'USD',
        afterStop: jest.fn(),
        alert,
        now: () => clock,
        loadSettings: () => ({ ...DEFAULT_SETTINGS, takeProfit: 0, stopLoss: 0, ...settingsPatch }),
        saveSettings: jest.fn(),
    };

    const runner = new SentinelAiRunner(io);
    runner.attach(fake.stores);
    const stopWatching = runner.watch();

    const loop = () => (runner as unknown as { loop: () => void }).loop();
    return {
        engine,
        runner,
        buy,
        settle,
        alert,
        profits,
        gate,
        loop,
        advance: (ms: number) => {
            clock += ms;
        },
        surface: (opp: RankedOpportunity | null) => {
            engine.surfaced = opp;
            loop();
        },
        cleanup: () => {
            stopWatching();
            runner.dispose();
        },
        ...fake,
    };
};

describe('SentinelAiRunner', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    it('refuses to start when the account is not logged in', () => {
        h = makeHarness({}, false);
        h.runner.start();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().lastError).toMatch(/log in/i);
        expect(h.run_panel.setIsRunning).not.toHaveBeenCalled();
    });

    it('starts on the Run Panel the way Auto Trades does', () => {
        h = makeHarness();
        h.runner.start();
        expect(h.runner.isRunning()).toBe(true);
        expect(h.run_panel.setIsRunning.mock.calls[0][0]).toBe(true);
        expect(h.run_panel.toggleDrawer.mock.calls[0][0]).toBe(true);
        expect(h.dashboard.active_trading_module).toBe(MODULE_ID);
        expect(typeof h.handlers[MODULE_ID]).toBe('function');
        expect(h.run_panel.run_id).toMatch(/^run-/);
    });

    it('waits for the entry digit, then buys once and reports to the Run Panel', async () => {
        h = makeHarness();
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();

        h.engine.tick(SYMBOL, 2);
        h.engine.tick(SYMBOL, 9);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        expect(h.runner.getSnapshot().signalState).toBe('WAITING_ENTRY');

        h.engine.tick(SYMBOL, 4);
        await flush();

        expect(h.buy.mock.calls.length).toBe(1);
        const sent = h.buy.mock.calls[0][0].parameters;
        expect(sent.contract_type).toBe('DIGITUNDER');
        expect(sent.barrier).toBe('7');
        expect(sent.amount).toBe(1);
        expect(sent.symbol).toBe(SYMBOL);
        expect(sent.duration).toBe(1);
        expect(sent.duration_unit).toBe('t');
        expect(sent.currency).toBe('USD');

        expect(h.transactions.pushTransaction.mock.calls.length).toBeGreaterThan(0);
        expect(h.run_panel.onBotContractEvent.mock.calls.length).toBeGreaterThan(0);
        expect(h.summary_card.onBotContractEvent.mock.calls.length).toBeGreaterThan(0);
        expect(h.transactions.pushTransaction.mock.calls[0][0].run_id).toBe(h.run_panel.run_id);

        const snap = h.runner.getSnapshot();
        expect(snap.session.trades).toBe(1);
        expect(snap.session.wins).toBe(1);
        expect(snap.session.pnl).toBeCloseTo(0.95, 2);
        expect(snap.trades[0].status).toBe('won');
        expect(snap.history[0].outcome).toBe('TRADED');
    });

    it('does not fire a second trade while one is in flight', async () => {
        h = makeHarness({ runsPerSignal: 3 });
        let release: () => void = () => undefined;
        h.gate.hold = new Promise<void>(resolve => {
            release = resolve;
        });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();

        h.engine.tick(SYMBOL, 4);
        h.engine.tick(SYMBOL, 4);
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);

        h.gate.hold = null;
        release();
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('applies martingale after a loss and trades the recovery barrier on the same entry digit', async () => {
        h = makeHarness({
            stake: 1,
            martingaleMode: 'after_1',
            martingaleMultiplier: 2,
            recoveryBarrierEnabled: true,
            recoveryUnderBarrier: 6,
            runsPerSignal: 3,
        });
        h.profits.push(-1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();

        h.engine.tick(SYMBOL, 4);
        await flush();
        const snap = h.runner.getSnapshot();
        expect(snap.session.currentStake).toBe(2);
        expect(snap.recovering).toBe(true);
        expect(snap.nextLabel).toBe('Under 6');
        expect(snap.requiredDigits).toEqual([4]); // the entry digit is unchanged

        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(2);
        expect(h.buy.mock.calls[1][0].parameters.amount).toBe(2);
        expect(h.buy.mock.calls[1][0].parameters.barrier).toBe('6');
    });

    it('stops at take profit and releases the Run Panel', async () => {
        h = makeHarness({ takeProfit: 0.5 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();

        const snap = h.runner.getSnapshot();
        expect(h.runner.isRunning()).toBe(false);
        expect(snap.status).toBe('WATCHING');
        expect(snap.stopReason).toMatch(/Take profit/);
        expect(h.run_panel.setIsRunning.mock.calls[h.run_panel.setIsRunning.mock.calls.length - 1][0]).toBe(false);
        expect(h.dashboard.active_trading_module).toBeNull();
        expect(h.handlers[MODULE_ID]).toBeUndefined();
        expect(snap.history[0].outcome).toBe('TRADED');
    });

    it('stops at stop loss', async () => {
        h = makeHarness({ stopLoss: 1, martingaleMode: 'off', runsPerSignal: 3 });
        h.profits.push(-1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Stop loss/);
    });

    it('never trades a signal that has no entry digit when no default digits are set', async () => {
        h = makeHarness({ defaultOverDigits: [], defaultUnderDigits: [] });
        h.surface(opportunity('UNDER7', null));
        h.runner.start();
        for (let digit = 0; digit <= 9; digit += 1) h.engine.tick(SYMBOL, digit);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        expect(h.runner.getSnapshot().signalState).toBe('NO_ENTRY_DIGIT');
    });

    it('takes the configured number of runs per signal, each on its own entry digit', async () => {
        h = makeHarness({ runsPerSignal: 2, martingaleMode: 'off' });
        h.surface(opportunity('OVER2', 5));
        h.runner.start();

        h.engine.tick(SYMBOL, 5);
        await flush();
        h.engine.tick(SYMBOL, 5);
        await flush();
        h.engine.tick(SYMBOL, 5);
        await flush();

        expect(h.buy.mock.calls.length).toBe(2);
        expect(h.buy.mock.calls[0][0].parameters.contract_type).toBe('DIGITOVER');
        expect(h.buy.mock.calls[0][0].parameters.barrier).toBe('2');
        const snap = h.runner.getSnapshot();
        expect(snap.signalState).toBe('DONE');
        expect(snap.runsDone).toBe(2);
    });

    it('drops a signal whose entry digit never prints in time', async () => {
        h = makeHarness({ signalWaitSeconds: 10 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.advance(11_000);
        h.loop();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        const snap = h.runner.getSnapshot();
        expect(snap.signalState).toBe('EXPIRED');
        expect(snap.history[0].outcome).toBe('EXPIRED');
    });

    it('lets a newer signal wait for the in-flight trade instead of cancelling it', async () => {
        h = makeHarness({ runsPerSignal: 1 });
        let release: () => void = () => undefined;
        h.gate.hold = new Promise<void>(resolve => {
            release = resolve;
        });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();

        h.surface(opportunity('OVER2', 6)); // a different cell is surfaced mid-trade
        expect(h.runner.getSnapshot().signal?.contractId).toBe('UNDER7');

        h.gate.hold = null;
        release();
        await flush();
        expect(h.runner.getSnapshot().signal?.contractId).toBe('OVER2');
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('stops when the Run Panel stop handler is invoked', () => {
        h = makeHarness();
        h.runner.start();
        h.dashboard.stopActiveTradingModule();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Run Panel/);
    });

    it('stops when the Run Panel itself reports it is no longer running', () => {
        const watchers: Array<(running: boolean, module: string | null) => void> = [];
        h = makeHarness();
        h.runner.attach(h.stores, onChange => {
            watchers.push(onChange);
            return () => undefined;
        });
        h.runner.start();
        watchers[0](false, MODULE_ID);
        expect(h.runner.isRunning()).toBe(false);
    });

    it('alerts once per new signal event, not on every refresh', () => {
        h = makeHarness();
        h.surface(opportunity('UNDER7', 4));
        h.loop();
        h.loop();
        expect(h.alert.mock.calls.length).toBe(1);
        h.surface(null);
        h.surface(opportunity('UNDER7', 4)); // same cell re-qualifying after a gap is a new event
        expect(h.alert.mock.calls.length).toBe(2);
        expect(h.runner.getSnapshot().alertSeq).toBe(2);
    });

    it('stops on a fatal purchase error instead of retrying', async () => {
        h = makeHarness();
        h.buy.mockImplementation(async () => {
            throw new Error('Your account has insufficient balance.');
        });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/insufficient balance/i);
    });

    it('tolerates a transient purchase error and keeps waiting for the entry digit', async () => {
        h = makeHarness();
        let first = true;
        h.buy.mockImplementation(async ({ parameters }: { parameters: Record<string, any> }) => {
            if (first) {
                first = false;
                throw new Error('Market is closed for this contract.');
            }
            return { buy_price: Number(parameters.amount), contract_id: 500, transaction_id: 1500 };
        });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.runner.isRunning()).toBe(true);
        expect(h.runner.getSnapshot().lastError).toMatch(/closed/i);
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('releases the engine when nothing is watching and nothing is running', () => {
        const local = makeHarness();
        expect(local.engine.retained).toBe(1);
        local.cleanup();
        expect(local.engine.retained).toBe(0);
    });
});

describe('SentinelAiRunner: Immediate mode', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    it('trades a live signal right away, without waiting for the entry digit', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();

        expect(h.buy.mock.calls.length).toBe(1); // no tick was ever printed
        expect(h.buy.mock.calls[0][0].parameters.contract_type).toBe('DIGITUNDER');
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('trades even when the engine has no validated entry digit', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.surface(opportunity('UNDER7', null));
        h.runner.start();
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
    });

    it('trades a signal that arrives after Run was pressed', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.runner.start();
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);

        h.surface(opportunity('OVER2', 5));
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
        expect(h.buy.mock.calls[0][0].parameters.contract_type).toBe('DIGITOVER');
    });

    it('takes every run of a signal back to back, one at a time', async () => {
        h = makeHarness({ executionMode: 'immediate', runsPerSignal: 3 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();
        await flush();
        await flush();
        expect(h.buy.mock.calls.length).toBe(3);
        expect(h.runner.getSnapshot().runsDone).toBe(3);
    });

    it('requires no entry digit', () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.surface(opportunity('UNDER7', 4));
        expect(h.runner.getSnapshot().requiredDigits).toEqual([]);
    });

    it('does not trade blind while the engine reports a stale feed', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.engine.failsafes = ['FEED STALE'];
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);

        h.engine.failsafes = [];
        h.loop();
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
    });

    it('leaves the default entry-digit behaviour untouched', async () => {
        h = makeHarness();
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        expect(h.runner.getSnapshot().signalState).toBe('WAITING_ENTRY');
    });
});

describe('SentinelAiRunner: failed purchases', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    const rejected = () =>
        new TradeRequestError('Unknown contract proposal (InvalidContractProposal)', {
            stage: 'proposal',
            kind: 'rejected',
            code: 'InvalidContractProposal',
        });

    it('skips a contract Deriv refuses and keeps the session running', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.buy.mockRejectedValueOnce(rejected());
        h.surface(opportunity('UNDER8', 4, 'JD50'));
        h.runner.start();
        await flush();

        expect(h.runner.isRunning()).toBe(true);
        const snap = h.runner.getSnapshot();
        expect(snap.history[0].outcome).toBe('SKIPPED');
        expect(snap.lastError).toMatch(/Skipped Under 8/);
        expect(h.buy.mock.calls.length).toBe(1);

        // The refused cell is hidden from the feed; the next signal trades normally.
        h.loop();
        h.surface(opportunity('UNDER7', 4, SYMBOL));
        await flush();
        expect(h.runner.isRunning()).toBe(true);
        expect(h.buy.mock.calls.length).toBe(2);
        expect(h.runner.getSnapshot().session.trades).toBe(1);
    });

    it('does not re-offer a refused cell until its block lapses', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.buy.mockRejectedValueOnce(rejected());
        h.surface(opportunity('UNDER8', 4, 'JD50'));
        h.runner.start();
        await flush();
        h.loop();
        h.loop();
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);

        h.advance(6 * 60_000);
        h.surface(opportunity('UNDER8', 4, 'JD50'));
        await flush();
        expect(h.buy.mock.calls.length).toBe(2);
    });

    it('stops with a clear reason if Deriv keeps refusing every signal', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.buy.mockImplementation(async () => {
            throw rejected();
        });
        h.runner.start();
        for (let i = 0; i < 8 && h.runner.isRunning(); i += 1) {
            h.surface(opportunity(`UNDER${i + 1}`, 4, `MKT${i}`));
            await flush();
        }
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/refused 6 signals in a row/);
    });

    it('never retries a purchase whose outcome is unknown', async () => {
        h = makeHarness({ executionMode: 'immediate', runsPerSignal: 3 });
        h.buy.mockRejectedValueOnce(
            new TradeRequestError('Purchase request timed out. The result is unknown.', {
                stage: 'buy',
                kind: 'timeout',
                outcomeUnknown: true,
            })
        );
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();
        h.loop();
        await flush();

        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/unknown/i);
        expect(h.buy.mock.calls.length).toBe(1);
    });

    it('stops on an account error', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.buy.mockRejectedValueOnce(new Error('Your account has insufficient balance.'));
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/insufficient balance/i);
    });

    it('retries a transient failure after a cool-down, then gives up after 3', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.buy.mockImplementation(async () => {
            throw new Error('Network hiccup');
        });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);

        h.loop(); // still inside the cool-down: no hammering
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);

        for (let i = 0; i < 2; i += 1) {
            h.advance(3_100);
            h.loop();
            await flush();
        }
        expect(h.buy.mock.calls.length).toBe(3);
        expect(h.runner.isRunning()).toBe(false);
    });
});

describe('SentinelAiRunner: default entry digits', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    it('an Under signal without an entry digit trades on 5 or 7, whichever prints first', async () => {
        h = makeHarness({ martingaleMode: 'off' });
        h.surface(opportunity('UNDER7', null));
        h.runner.start();

        const snap = h.runner.getSnapshot();
        expect(snap.requiredDigits).toEqual([5, 7]);
        expect(snap.entrySource).toBe('default');
        expect(snap.signalState).toBe('WAITING_ENTRY');

        h.engine.tick(SYMBOL, 3);
        h.engine.tick(SYMBOL, 9);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);

        h.engine.tick(SYMBOL, 7);
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
        expect(h.buy.mock.calls[0][0].parameters.contract_type).toBe('DIGITUNDER');
        expect(h.runner.getSnapshot().trades[0].entryDigit).toBe(7);
    });

    it('an Over signal without an entry digit trades on 2 or 4, whichever prints first', async () => {
        h = makeHarness({ martingaleMode: 'off' });
        h.surface(opportunity('OVER3', null));
        h.runner.start();
        expect(h.runner.getSnapshot().requiredDigits).toEqual([2, 4]);

        h.engine.tick(SYMBOL, 5);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);

        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
        expect(h.buy.mock.calls[0][0].parameters.contract_type).toBe('DIGITOVER');
        expect(h.runner.getSnapshot().trades[0].entryDigit).toBe(4);
    });

    it('the first of the two default digits to print wins (2 before 4, 5 before 7)', async () => {
        h = makeHarness({ martingaleMode: 'off', runsPerSignal: 1 });
        h.surface(opportunity('OVER3', null));
        h.runner.start();
        h.engine.tick(SYMBOL, 2);
        h.engine.tick(SYMBOL, 4); // already in flight: must not fire a second trade
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
        expect(h.runner.getSnapshot().trades[0].entryDigit).toBe(2);
    });

    it("never overrides the engine's own entry digit", async () => {
        h = makeHarness({ martingaleMode: 'off' });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        expect(h.runner.getSnapshot().requiredDigits).toEqual([4]);
        expect(h.runner.getSnapshot().entrySource).toBe('engine');

        h.engine.tick(SYMBOL, 5); // a default digit, but the engine gave its own entry
        h.engine.tick(SYMBOL, 7);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);

        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
    });

    it('uses custom default digits', async () => {
        h = makeHarness({ martingaleMode: 'off', defaultUnderDigits: [1, 9] });
        h.surface(opportunity('UNDER7', null));
        h.runner.start();
        expect(h.runner.getSnapshot().requiredDigits).toEqual([1, 9]);
        h.engine.tick(SYMBOL, 5);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        h.engine.tick(SYMBOL, 9);
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
    });
});

describe('SentinelAiRunner: recovery barrier per side', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    const recoveryHarness = (patch: Partial<SentinelAiSettings> = {}) =>
        makeHarness({
            martingaleMode: 'off',
            runsPerSignal: 3,
            recoveryBarrierEnabled: true,
            recoveryOverBarrier: 3,
            recoveryUnderBarrier: 6,
            ...patch,
        });
    const barriers = (hh: Harness) => hh.buy.mock.calls.map(call => String(call[0].parameters.barrier));

    it('Under 7 loses -> Under 6; a win -> back to Under 7', async () => {
        h = recoveryHarness();
        h.profits.push(-1, 1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        for (let i = 0; i < 3; i += 1) {
            h.engine.tick(SYMBOL, 4);
            await flush();
        }
        expect(barriers(h)).toEqual(['7', '6', '7']);
        expect(h.buy.mock.calls.map(call => call[0].parameters.contract_type)).toEqual([
            'DIGITUNDER',
            'DIGITUNDER',
            'DIGITUNDER',
        ]);
        expect(h.runner.getSnapshot().trades.map(t => t.label).reverse()).toEqual(['Under 7', 'Under 6', 'Under 7']);
    });

    it('an Over signal recovers on Over 3 (never on the Under barrier)', async () => {
        h = recoveryHarness();
        h.profits.push(-1);
        h.surface(opportunity('OVER2', 5));
        h.runner.start();
        h.engine.tick(SYMBOL, 5);
        await flush();
        h.engine.tick(SYMBOL, 5);
        await flush();
        expect(barriers(h)).toEqual(['2', '3']);
        expect(h.buy.mock.calls[1][0].parameters.contract_type).toBe('DIGITOVER');
    });

    it('still waits for the normal entry digit during recovery', async () => {
        h = recoveryHarness();
        h.profits.push(-1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        h.engine.tick(SYMBOL, 6); // the recovery barrier is not an entry digit
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
    });

    it('stays on the recovery barrier through consecutive losses', async () => {
        h = recoveryHarness({ runsPerSignal: 5 });
        h.profits.push(-1, -1, -1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        for (let i = 0; i < 4; i += 1) {
            h.engine.tick(SYMBOL, 4);
            await flush();
        }
        expect(barriers(h)).toEqual(['7', '6', '6', '6']);
    });

    it('works for a signal without an engine entry digit (default digits)', async () => {
        h = recoveryHarness();
        h.profits.push(-1);
        h.surface(opportunity('OVER2', null));
        h.runner.start();
        h.engine.tick(SYMBOL, 2);
        await flush();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(barriers(h)).toEqual(['2', '3']);
    });

    it('does nothing when recovery is off', async () => {
        h = recoveryHarness({ recoveryBarrierEnabled: false });
        h.profits.push(-1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(barriers(h)).toEqual(['7', '7']);
    });

    it('martingale still raises the stake while recovering', async () => {
        h = recoveryHarness({ martingaleMode: 'after_1', martingaleMultiplier: 2 });
        h.profits.push(-1);
        h.surface(opportunity('OVER2', 5));
        h.runner.start();
        h.engine.tick(SYMBOL, 5);
        await flush();
        h.engine.tick(SYMBOL, 5);
        await flush();
        expect(h.buy.mock.calls[1][0].parameters.amount).toBe(2);
    });
});

describe('SentinelAiRunner: Touch-once mode', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    // The fake buy/settle resolve instantly, so a nonstop run is always ended by a limit in these tests.
    const touchHarness = (patch: Partial<SentinelAiSettings> = {}) =>
        makeHarness({ executionMode: 'touch_once', martingaleMode: 'off', ...patch });

    it('waits for the entry digit once, then fires back to back without waiting for it again', async () => {
        h = touchHarness({ maxTrades: 5 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();

        h.engine.tick(SYMBOL, 9); // not the entry digit
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        expect(h.runner.getSnapshot().signalState).toBe('WAITING_ENTRY');
        expect(h.runner.getSnapshot().locked).toBe(false);

        h.engine.tick(SYMBOL, 4); // the one and only touch
        await flush(); // no further ticks are sent
        expect(h.buy.mock.calls.length).toBe(5);
        expect(h.runner.getSnapshot().session.trades).toBe(5);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Max trades/);
    });

    it('uses the default digits for the single touch when the signal has no entry digit', async () => {
        h = touchHarness({ maxTrades: 3 });
        h.surface(opportunity('OVER2', null));
        h.runner.start();
        h.engine.tick(SYMBOL, 6);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        h.engine.tick(SYMBOL, 2);
        await flush();
        expect(h.buy.mock.calls.length).toBe(3);
        expect(h.buy.mock.calls[0][0].parameters.contract_type).toBe('DIGITOVER');
    });

    it('trades the same market and contract on every shot', async () => {
        h = touchHarness({ maxTrades: 4 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        const sent = h.buy.mock.calls.map(call => `${call[0].parameters.symbol}|${call[0].parameters.contract_type}|${call[0].parameters.barrier}`);
        expect(new Set(sent)).toEqual(new Set([`${SYMBOL}|DIGITUNDER|7`]));
    });

    it('stops at the target profit and releases the Run Panel', async () => {
        h = touchHarness({ takeProfit: 2 }); // each win is +0.95, so the third trade crosses it
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(3);
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Take profit/);
        expect(h.dashboard.active_trading_module).toBeNull();
    });

    it('stops at the stop loss', async () => {
        h = touchHarness({ stopLoss: 2 });
        h.profits.push(-1, -1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(2);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Stop loss/);
    });

    it('after a loss it keeps firing nonstop on the recovery barrier, then returns to the signal barrier after a win', async () => {
        h = touchHarness({
            maxTrades: 4,
            martingaleMode: 'after_1',
            martingaleMultiplier: 2,
            recoveryBarrierEnabled: true,
            recoveryUnderBarrier: 6,
        });
        h.profits.push(-1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4); // the only touch
        await flush();
        expect(h.buy.mock.calls.map(call => String(call[0].parameters.barrier))).toEqual(['7', '6', '7', '7']);
        expect(h.buy.mock.calls.map(call => call[0].parameters.amount)).toEqual([1, 2, 1, 1]);
    });

    it('ignores runs per signal and does not stop after the first trade', async () => {
        h = touchHarness({ maxTrades: 4, runsPerSignal: 1 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(4);
    });

    it('never expires after the entry was touched, and does not drop the market for a newer signal', async () => {
        h = touchHarness({ signalWaitSeconds: 10, maxTrades: 4 });
        let calls = 0;
        h.buy.mockImplementation(async ({ parameters }: { parameters: Record<string, any> }) => {
            calls += 1;
            if (calls === 2) throw new Error('Temporary network blip.'); // transient: cool-down, then carry on
            return { buy_price: Number(parameters.amount), contract_id: 700 + calls, transaction_id: 1700 + calls };
        });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(calls).toBe(2); // first trade settled, second hit the blip and is cooling down
        expect(h.runner.getSnapshot().locked).toBe(true);

        h.advance(60_000); // far beyond the 10 second signal wait
        h.surface(opportunity('OVER2', 6)); // a different signal arrives mid-run
        const snap = h.runner.getSnapshot();
        expect(snap.signal?.contractId).toBe('UNDER7'); // still on the touched market
        expect(snap.signalState).not.toBe('EXPIRED');
        expect(snap.history.find(r => r.signal.contractId === 'OVER2')?.outcome).toBe('WATCHED');

        await flush(); // cool-down over: it carries on without a new touch
        expect(calls).toBeGreaterThan(2);
        expect(h.runner.getSnapshot().session.trades).toBe(4);
        expect(h.runner.getSnapshot().history.find(r => r.signal.contractId === 'UNDER7')?.outcome).toBe('TRADED');
    });

    it('Stop ends a nonstop run immediately', async () => {
        h = touchHarness({ maxTrades: 3 });
        let release: () => void = () => undefined;
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.gate.hold = new Promise<void>(resolve => {
            release = resolve;
        });
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);

        h.runner.stop('Stopped by you');
        h.gate.hold = null;
        release();
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);
        expect(h.runner.isRunning()).toBe(false);
    });

    it('reports the touch state in the snapshot', async () => {
        h = touchHarness({ maxTrades: 2 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        expect(h.runner.getSnapshot().locked).toBe(false);
        h.engine.tick(SYMBOL, 4);
        await flush();
        const snap = h.runner.getSnapshot();
        expect(snap.requiredDigits).toEqual([]); // nothing is waited for any more
    });
});

describe('SentinelAiRunner: target profit can change while running', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    it('lowering the target below the current profit ends the session straight away', async () => {
        h = makeHarness({ martingaleMode: 'off', runsPerSignal: 3 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.runner.isRunning()).toBe(true); // +0.95 and no target set (the harness turns it off)

        h.runner.updateSettings({ takeProfit: 0.5 });
        expect(h.runner.isRunning()).toBe(false);
        expect(h.runner.getSnapshot().stopReason).toMatch(/Take profit/);
    });

    it('raising the target keeps the session running', async () => {
        h = makeHarness({ martingaleMode: 'off', runsPerSignal: 3, takeProfit: 0.5 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        h.runner.updateSettings({ takeProfit: 50 });
        expect(h.runner.isRunning()).toBe(true);
        expect(h.runner.getSnapshot().settings.takeProfit).toBe(50);
    });
});

describe('SentinelAiRunner: score, danger and market filters', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    const rejected = () =>
        new TradeRequestError('Unknown contract proposal (InvalidContractProposal)', {
            stage: 'proposal',
            kind: 'rejected',
            code: 'InvalidContractProposal',
        });
    const weak = (patch: Record<string, unknown>, contractId = 'UNDER7', symbol = SYMBOL) =>
        ({ ...opportunity(contractId, 4, symbol), ...patch }) as unknown as RankedOpportunity;

    it('never trades a score-0 (engine-blocked) signal', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        h.surface(weak({ score: 0, blocked: true }));
        h.runner.start();
        await flush();
        expect(h.runner.getSnapshot().signal).toBeNull();
        expect(h.buy.mock.calls.length).toBe(0);
        expect(h.runner.getSnapshot().filtered.count).toBe(1);
        expect(h.runner.getSnapshot().filtered.example).toMatch(/blocked by the engine/);
    });

    it('rejects a score below the minimum and accepts it once the minimum is lowered', async () => {
        h = makeHarness({ executionMode: 'immediate', minScore: 70 });
        h.surface(weak({ score: 55 }));
        h.runner.start();
        expect(h.runner.getSnapshot().signal).toBeNull();
        expect(h.runner.getSnapshot().filtered.example).toMatch(/score 55 is below 70/);
        h.runner.updateSettings({ minScore: 50 });
        h.loop();
        expect(h.runner.getSnapshot().signal?.score).toBe(55);
    });

    it('rejects a danger above the maximum', async () => {
        h = makeHarness({ executionMode: 'immediate', maxDanger: 45 });
        h.surface(weak({ dangerComposition: { total: 60, isHardBlocked: false } }));
        h.runner.start();
        expect(h.runner.getSnapshot().signal).toBeNull();
        expect(h.runner.getSnapshot().filtered.example).toMatch(/danger 60 is above 45/);
    });

    it('0 switches the score and danger limits off', () => {
        h = makeHarness({ executionMode: 'immediate', minScore: 0, maxDanger: 0, skipBlocked: false });
        h.surface(weak({ score: 5, blocked: true, dangerComposition: { total: 99, isHardBlocked: true } }));
        h.runner.start();
        expect(h.runner.getSnapshot().signal).not.toBeNull();
    });

    it('a signal that turns bad while it waits for its entry digit is dropped, not traded', async () => {
        h = makeHarness({});
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        expect(h.runner.getSnapshot().signal?.contractId).toBe('UNDER7');
        h.surface(weak({ score: 10 })); // same cell, now failing the gate
        h.advance(1000);
        h.engine.tick(SYMBOL, 4);
        await flush();
        expect(h.buy.mock.calls.length).toBe(0);
        expect(h.runner.getSnapshot().history[0].outcome).toBe('SKIPPED');
        expect(h.runner.getSnapshot().lastError).toMatch(/Dropped/);
    });

    it('JD100 is excluded by default and other markets are not', async () => {
        h = makeHarness({ executionMode: 'immediate' });
        expect(h.runner.getSnapshot().settings.excludedMarkets).toEqual(['JD100']);
        h.surface(opportunity('UNDER7', 4, 'JD100'));
        h.runner.start();
        expect(h.runner.getSnapshot().signal).toBeNull();
        expect(h.buy.mock.calls.length).toBe(0);
        h.surface(opportunity('UNDER7', 4, 'JD50'));
        h.advance(1000);
        expect(h.runner.getSnapshot().signal?.symbol).toBe('JD50');
    });

    it('the excluded list can be changed', () => {
        h = makeHarness({ executionMode: 'immediate', excludedMarkets: [] });
        h.surface(opportunity('UNDER7', 4, 'JD100'));
        h.runner.start();
        expect(h.runner.getSnapshot().signal?.symbol).toBe('JD100');
    });

    it('a market Deriv refuses twice is quarantined for the rest of the session', async () => {
        h = makeHarness({ executionMode: 'immediate', excludedMarkets: [] });
        h.buy.mockImplementation(async () => {
            throw rejected();
        });
        h.runner.start();
        h.surface(opportunity('UNDER7', 4, 'JD75'));
        await flush();
        h.surface(opportunity('UNDER6', 4, 'JD75'));
        h.advance(1000);
        await flush();
        expect(h.runner.getSnapshot().quarantined).toEqual(['JD75']);
        const sent = h.buy.mock.calls.length;
        h.surface(opportunity('UNDER5', 4, 'JD75')); // a third cell on the same market never reaches Deriv
        h.advance(1000);
        await flush();
        expect(h.buy.mock.calls.length).toBe(sent);
        expect(h.runner.getSnapshot().history.some(r => r.signal.contractId === 'UNDER5')).toBe(false);
    });

    it('a touch-once run pauses while the market fails the gate and resumes when it qualifies', async () => {
        h = makeHarness({ executionMode: 'touch_once', martingaleMode: 'off', maxTrades: 3 });
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();
        let calls = 0;
        h.buy.mockImplementation(async ({ parameters }: { parameters: Record<string, any> }) => {
            calls += 1;
            if (calls === 1) h.surface(weak({ dangerComposition: { total: 90, isHardBlocked: false } }));
            return { buy_price: Number(parameters.amount), contract_id: 900 + calls, transaction_id: 1900 + calls };
        });
        h.engine.tick(SYMBOL, 4);
        await flush();
        h.advance(1000); // the sample now rejects the market
        await flush();
        expect(h.runner.getSnapshot().signalState).toBe('HELD');
        const heldAt = h.buy.mock.calls.length;
        h.advance(1000);
        await flush();
        expect(h.buy.mock.calls.length).toBe(heldAt);

        h.surface(opportunity('UNDER7', 4)); // qualifies again
        h.advance(1000);
        await flush();
        expect(h.buy.mock.calls.length).toBe(3);
    });
});
