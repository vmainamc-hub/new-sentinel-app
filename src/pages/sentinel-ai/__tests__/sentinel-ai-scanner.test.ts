// The merged Sentinel AI scans round the markets like Sixfold: it arms the best setup, trades it on its entry digit, then goes looking again.
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { EngineSample, SentinelAiEngine, SignalExclusion, VettedCandidate } from '../sentinel-ai-engine-types';
import type { FusionCandidate, FusionRead, FusionSource } from '../sentinel-ai-fusion';
import { SentinelAiRunner, type RunnerIO, type RunnerStores } from '../sentinel-ai-runner';
import { DEFAULT_SETTINGS, type SentinelAiSettings } from '../sentinel-ai-types';

const vettedOf = (symbol: string, contractId: string, score: number, digit: number | null = 4): VettedCandidate => {
    const isOver = contractId.startsWith('OVER');
    const barrier = Number(contractId.replace(/\D/g, ''));
    return {
        blocked: false,
        momentum: { pass: true, measurable: true, score: 50, blockers: [] },
        opportunity: {
            symbol,
            name: `Market ${symbol}`,
            score,
            blocked: false,
            dangerComposition: { total: 20, isHardBlocked: false },
            contract: {
                id: contractId,
                label: `${isOver ? 'Over' : 'Under'} ${barrier}`,
                side: isOver ? 'OVER' : 'UNDER',
                barrier,
                confidence: 60,
            },
            entryPoint: {
                status: digit === null ? 'NO ENTRY' : 'ARMED',
                preferred: digit === null ? null : { digit, pWin: 0.8 },
                window: { label: 'last 300 ticks' },
            },
            signal: { label: 'ENTER NOW', state: 'QUALIFIED', reason: '' },
        } as unknown as RankedOpportunity,
    };
};

class FakeEngine implements SentinelAiEngine {
    vetted: VettedCandidate[] = [];
    digits: Record<string, number | null> = {};
    listeners = new Set<(symbol: string) => void>();
    status: 'live' | 'connecting' = 'live';

    retain() {
        return () => undefined;
    }

    sample(exclude?: SignalExclusion): EngineSample {
        const kept = this.vetted.filter(
            v => !exclude?.(v.opportunity.symbol, String(v.opportunity.contract.id), v.opportunity)
        );
        return {
            info: { status: this.status, online: 20, total: 20, degraded: false, failsafes: [], dangerLabel: 'CALM' },
            surfaced: kept.find(v => !v.blocked)?.opportunity ?? null,
            vetted: kept,
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

    markets() {
        return [
            { symbol: 'R_10', name: 'Volatility 10' },
            { symbol: 'R_25', name: 'Volatility 25' },
            { symbol: 'R_50', name: 'Volatility 50' },
        ];
    }

    tick(symbol: string, digit: number) {
        this.digits[symbol] = digit;
        this.listeners.forEach(listener => listener(symbol));
    }
}

class FakeFusion implements FusionSource {
    candidates: FusionCandidate[] = [];
    standDown: string[] = [];
    retained = 0;
    retain() {
        this.retained += 1;
        return () => {
            this.retained -= 1;
        };
    }
    read(): FusionRead {
        return { candidates: this.candidates, standDown: new Set(this.standDown), ready: 5, total: 13 };
    }
}

const fusionPick = (symbol: string, contract: 'DIGITOVER' | 'DIGITUNDER', barrier: number): FusionCandidate => ({
    symbol,
    market: `Market ${symbol}`,
    contract,
    barrier,
    label: `${contract === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`,
    action: 'EXECUTE',
    score: 85,
    danger: 12,
    confirmed: true,
    ripe: true,
    generatedAt: 0,
});

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
        stopActiveTradingModule: () => undefined,
    };
    return {
        run_panel,
        stores: {
            client: { currency: 'USD' },
            run_panel,
            summary_card: { onBotContractEvent: jest.fn() },
            transactions: { pushTransaction: jest.fn() },
            dashboard,
        } as unknown as RunnerStores,
    };
};

const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
};

const makeHarness = (patch: Partial<SentinelAiSettings> = {}) => {
    const engine = new FakeEngine();
    const fusion = new FakeFusion();
    const { stores, run_panel } = makeStores();
    let clock = 1_000_000;
    let nextId = 100;
    const profits: number[] = [];
    const buy = jest.fn(async ({ parameters }: { parameters: Record<string, any> }) => {
        nextId += 1;
        return { buy_price: Number(parameters.amount), contract_id: nextId, transaction_id: nextId + 1000 };
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
            const done = {
                ...fallback,
                contract_id: contractId,
                profit,
                status: profit < 0 ? 'lost' : 'won',
                is_sold: 1,
            };
            onUpdate(done);
            return done;
        }
    );
    const io: RunnerIO = {
        engine,
        fusion,
        buy,
        settle,
        isAuthorized: () => true,
        currency: () => 'USD',
        afterStop: jest.fn(),
        alert: jest.fn(),
        now: () => clock,
        loadSettings: () => ({ ...DEFAULT_SETTINGS, takeProfit: 0, stopLoss: 0, ...patch }),
        saveSettings: jest.fn(),
    };
    const runner = new SentinelAiRunner(io);
    runner.attach(stores);
    const stopWatching = runner.watch();
    const loop = () => (runner as unknown as { loop: () => void }).loop();
    return {
        engine,
        fusion,
        runner,
        buy,
        profits,
        run_panel,
        loop,
        advance: (ms: number) => {
            clock += ms;
        },
        show: (...vetted: VettedCandidate[]) => {
            engine.vetted = vetted;
            loop();
        },
        symbols: () => buy.mock.calls.map(call => call[0].parameters.symbol as string),
        cleanup: () => {
            stopWatching();
            runner.dispose();
        },
    };
};

type Harness = ReturnType<typeof makeHarness>;

describe('Sentinel AI scanner', () => {
    let h: Harness | null = null;
    afterEach(() => {
        h?.cleanup();
        h = null;
    });

    it('goes round the markets: after a trade it arms the next best setup instead of the one it just worked', async () => {
        h = makeHarness();
        h.show(vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80));
        h.runner.start();
        expect(h.runner.getSnapshot().signal?.key).toBe('R_10|UNDER7');
        expect(h.runner.getSnapshot().phase).toBe('armed');

        h.engine.tick('R_10', 4);
        await flush();
        expect(h.symbols()).toEqual(['R_10']);

        // The first setup is still the best on the board, but it was worked: the scanner moves on by itself.
        h.loop();
        expect(h.runner.getSnapshot().signal?.key).toBe('R_25|OVER2');
        h.engine.tick('R_25', 4);
        await flush();
        expect(h.symbols()).toEqual(['R_10', 'R_25']);
        expect(h.runner.getSnapshot().session.trades).toBe(2);
    });

    it('rests the market that lost, and trades another one while it rests', async () => {
        h = makeHarness({ restTrades: 2, martingaleMode: 'off' });
        h.profits.push(-1);
        h.show(vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80));
        h.runner.start();
        h.engine.tick('R_10', 4);
        await flush();
        expect(h.runner.getSnapshot().session.losses).toBe(1);

        h.loop();
        const snap = h.runner.getSnapshot();
        expect(snap.resting).toEqual([{ symbol: 'R_10', name: 'Volatility 10', tradesLeft: 2 }]);
        expect(snap.signal?.key).toBe('R_25|OVER2');
        expect(snap.board.find(r => r.key === 'R_10|UNDER7')).toMatchObject({ eligible: false, state: 'resting' });
    });

    it('does not rest anything when the loss shield is off', async () => {
        h = makeHarness({ lossShield: false, martingaleMode: 'off' });
        h.profits.push(-1);
        h.show(vettedOf('R_10', 'UNDER7', 90));
        h.runner.start();
        h.engine.tick('R_10', 4);
        await flush();
        h.loop();
        expect(h.runner.getSnapshot().resting).toEqual([]);
    });

    it('lets a worked setup back once it has left the board and returned', async () => {
        h = makeHarness();
        h.show(vettedOf('R_10', 'UNDER7', 90));
        h.runner.start();
        h.engine.tick('R_10', 4);
        await flush();
        h.loop();
        expect(h.runner.getSnapshot().board[0]).toMatchObject({ key: 'R_10|UNDER7', state: 'spent' });

        h.show(); // the setup is gone
        h.show(vettedOf('R_10', 'UNDER7', 90)); // and comes back as a new one: armed again
        expect(h.runner.getSnapshot().signal?.key).toBe('R_10|UNDER7');
        h.loop();
        expect(h.runner.getSnapshot().board[0].state).toBe('armed');
    });

    it('moves on from a setup whose entry digit never printed', () => {
        h = makeHarness({ signalWaitSeconds: 10 });
        h.show(vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80));
        h.runner.start();
        h.advance(11_000);
        h.loop();
        h.loop();
        expect(h.runner.getSnapshot().signal?.key).toBe('R_25|OVER2');
    });

    it('prefers a signal Insight Fusion also backs, and shows that on the page', () => {
        h = makeHarness();
        h.fusion.candidates = [fusionPick('R_25', 'DIGITOVER', 2)];
        h.show(vettedOf('R_10', 'UNDER7', 82), vettedOf('R_25', 'OVER2', 78));
        h.runner.start();
        const snap = h.runner.getSnapshot();
        expect(snap.signal?.key).toBe('R_25|OVER2');
        expect(snap.consensus?.consensus).toBe('both');
        expect(snap.fusion).toEqual({ enabled: true, ready: 5, total: 13 });
    });

    it('trades only what both engines back in require mode, and waits when they disagree', () => {
        h = makeHarness({ engines: 'require' });
        h.show(vettedOf('R_10', 'UNDER7', 90));
        h.runner.start();
        expect(h.runner.getSnapshot().signal).toBeNull();
        expect(h.runner.getSnapshot().phase).toBe('scanning');

        h.fusion.candidates = [fusionPick('R_10', 'DIGITUNDER', 7)];
        h.loop();
        expect(h.runner.getSnapshot().signal?.key).toBe('R_10|UNDER7');
    });

    it('lets Insight Fusion pick the contract in fusion_leads mode and still buys on Sentinel’s entry digit', async () => {
        h = makeHarness({ engines: 'fusion_leads' });
        h.fusion.candidates = [fusionPick('R_50', 'DIGITUNDER', 8)];
        h.show(vettedOf('R_50', 'UNDER8', 75, 3), vettedOf('R_10', 'UNDER7', 95));
        h.runner.start();
        expect(h.runner.getSnapshot().signal).toMatchObject({ key: 'R_50|UNDER8', entryDigit: 3 });
        h.engine.tick('R_50', 3);
        await flush();
        expect(h.buy.mock.calls[0][0].parameters).toMatchObject({
            contract_type: 'DIGITUNDER',
            barrier: '8',
            symbol: 'R_50',
        });
    });

    it('keeps scanning on the Sentinel engine alone when Insight Fusion cannot be read', () => {
        h = makeHarness();
        h.fusion.read = () => {
            throw new Error('fusion feed down');
        };
        h.show(vettedOf('R_10', 'UNDER7', 90));
        h.runner.start();
        expect(h.runner.getSnapshot().signal?.key).toBe('R_10|UNDER7');
        expect(h.runner.getSnapshot().consensus?.consensus).toBe('off');
    });

    it('reports the phase of the cycle: scanning, armed, in trade, and connecting while the engine is not live', async () => {
        h = makeHarness();
        h.runner.start();
        expect(h.runner.getSnapshot().phase).toBe('scanning');
        h.show(vettedOf('R_10', 'UNDER7', 90));
        expect(h.runner.getSnapshot().phase).toBe('armed');
        h.engine.status = 'connecting';
        h.loop();
        expect(h.runner.getSnapshot().phase).toBe('connecting');
        h.engine.status = 'live';
        h.loop();
        h.engine.tick('R_10', 4);
        await flush();
        expect(['cooling', 'scanning', 'armed']).toContain(h.runner.getSnapshot().phase);
        h.runner.stop('done');
        expect(h.runner.getSnapshot().phase).toBe('idle');
    });

    it('lists every market on the radar with its best setup', () => {
        h = makeHarness();
        h.show(vettedOf('R_10', 'UNDER7', 90));
        const dots = h.runner.getSnapshot().markets;
        expect(dots.map(d => d.symbol)).toEqual(['R_10', 'R_25', 'R_50']);
        expect(dots[0].best?.key).toBe('R_10|UNDER7');
        expect(dots[1].best).toBeNull();
    });

    it('holds Insight Fusion’s hand through the whole session: it is started with the engine and released with it', () => {
        h = makeHarness();
        expect(h.fusion.retained).toBe(1);
        h.cleanup();
        expect(h.fusion.retained).toBe(0);
        h = null;
    });
});
