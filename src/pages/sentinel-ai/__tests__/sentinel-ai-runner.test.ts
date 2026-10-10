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
        const hidden = Boolean(this.surfaced && exclude?.(this.surfaced.symbol, String(this.surfaced.contract.id)));
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

    it('applies martingale after a loss and enters on the recovery digit', async () => {
        h = makeHarness({
            stake: 1,
            martingaleMode: 'after_1',
            martingaleMultiplier: 2,
            recoveryDigitEnabled: true,
            recoveryDigit: 8,
            runsPerSignal: 3,
        });
        h.profits.push(-1);
        h.surface(opportunity('UNDER7', 4));
        h.runner.start();

        h.engine.tick(SYMBOL, 4);
        await flush();
        let snap = h.runner.getSnapshot();
        expect(snap.session.losses).toBe(1);
        expect(snap.session.currentStake).toBe(2);
        expect(snap.recovering).toBe(true);
        expect(snap.requiredDigit).toBe(8);

        h.engine.tick(SYMBOL, 4); // the signal's own digit no longer triggers
        await flush();
        expect(h.buy.mock.calls.length).toBe(1);

        h.engine.tick(SYMBOL, 8);
        await flush();
        expect(h.buy.mock.calls.length).toBe(2);
        expect(h.buy.mock.calls[1][0].parameters.amount).toBe(2);

        snap = h.runner.getSnapshot();
        expect(snap.session.wins).toBe(1);
        expect(snap.session.currentStake).toBe(1);
        expect(snap.recovering).toBe(false);
        expect(snap.requiredDigit).toBe(4);
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

    it('never trades a signal that has no validated entry digit', async () => {
        h = makeHarness();
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
        expect(h.runner.getSnapshot().requiredDigit).toBeNull();
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
            h.surface(opportunity(`UNDER${i + 1}`, 4, 'JD50'));
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
