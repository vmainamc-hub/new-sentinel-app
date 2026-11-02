// The whole chain on real code: lab finds a pattern -> registry -> autopilot activates it -> picker offers it -> executor trades it.
import { mulberry32 } from '@/components/premium/sixfold/stats';
import { Autopilot, DEFAULT_AUTOPILOT } from '../autopilot';
import { AiIntelExecutor, type ExecIO } from '../executor';
import { LabRunner } from '../lab';
import { BASELINE_CANDIDATES, rankPicks } from '../picker';
import { StrategyRegistry } from '../registry';
import { compileRule } from '../rules';

const patterned = (n: number, seed: number) => {
    const r = mulberry32(seed);
    const out: number[] = [];
    while (out.length < n) {
        const d = Math.floor(r() * 10);
        out.push(d);
        if (d === 4 && out.length >= 3 && out[out.length - 2] > 2 && out[out.length - 3] > 2) out.push(9);
        else if (d === 4) out.push(Math.floor(r() * 10));
    }
    return out.slice(0, n);
};
const flush = () => new Promise(r => setTimeout(r, 0));

it('a pattern the lab validated ends up being traded by the executor', async () => {
    const series = { R_10: patterned(6000, 3) };
    let saved: any = null;
    const registry = new StrategyRegistry({ load: () => saved, save: s => (saved = s) });
    const lab: LabRunner = new LabRunner(
        () => series,
        (results, cfg) => registry.addFromLab(results, cfg, lab.getSnapshot().ticks)
    );
    const ap = new Autopilot({
        strategies: () => registry.getSnapshot(),
        forward: () => [],
        setStatus: (id, to, by, note) => registry.setStatus(id, to, by, note),
        lab,
        series: () => series,
        duration: () => 1,
        now: () => 5_000_000,
    });
    ap.configure({ promote: 'FAST', research: true });
    ap.cycle(); // starts the lab
    for (let i = 0; i < 300 && lab.getSnapshot().state === 'running'; i++) lab.step();
    expect(lab.getSnapshot().state).toBe('done');
    ap.cycle(); // validated -> approved -> active
    const active = registry.getSnapshot().filter(s => s.status === 'ACTIVE');
    expect(active.length).toBeGreaterThan(0);
    expect(active[0].history.map(h => h.by)).toContain('auto');
    expect(registry.activeCandidates().length).toBe(active.length);

    const NOW = 10_000;
    const picks = rankPicks(series, () => NOW - 500, NOW, { duration: 1, evidenceOnly: false, directions: 'BOTH', candidates: [...BASELINE_CANDIDATES, ...registry.activeCandidates()] });
    const smart = picks.find(p => p.entry === 'SMART');
    expect(smart).toBeTruthy();
    expect(active.map(s => s.id)).toContain(smart!.strategyId);

    // The executor trades that pick when its rule holds on the live ticks.
    // A real moment in the data where the strategy's own rule holds.
    const holds = compileRule(smart!.rule!, { side: 'OVER', param: 2 });
    const at = series.R_10.findIndex((_, i) => i > 5 && holds(series.R_10.slice(0, i + 1)));
    expect(at).toBeGreaterThan(5);
    const window = series.R_10.slice(0, at + 1);
    let t = 1_000_000;
    const buys: any[] = [];
    const io: ExecIO = {
        buy: async a => (buys.push(a), { buy_price: a.price, contract_id: 77, transaction_id: 78 }),
        settle: () => new Promise(() => undefined),
        isAuthorized: () => true, now: () => t, lastTickAt: () => t, isFeedLive: () => true, connectFeed() {},
        pick: () => [smart!], history: () => window,
        describeFailure: () => ({ kind: 'x', message: 'x', outcomeUnknown: false }),
        load: () => ({ mode: 'AUTO', autoAuthorised: true, stake: 1, stopLoss: 20, targetProfit: 0, ai: 'OFF', virtualHook: { enabled: false } as any }),
        save() {},
    };
    const ex = new AiIntelExecutor(io);
    const stores: any = {
        run_panel: { setIsRunning() {}, setRunId() {}, toggleDrawer() {}, setContractStage() {}, onBotContractEvent() {} },
        summary_card: { onBotContractEvent() {} }, transactions: { pushTransaction() {} },
        dashboard: { active_trading_module: null, setActiveTradingModule() {}, registerTradingStopHandler() {}, unregisterTradingStopHandler() {}, stopActiveTradingModule() {} },
    };
    ex.attach(stores);
    ex.start();
    t += 1000;
    ex.handleTick('R_10', window[window.length - 1]);
    await flush();
    expect(buys).toHaveLength(1);
    expect(buys[0].parameters).toMatchObject({ symbol: 'R_10', contract_type: 'DIGITOVER', barrier: '2' });
});

it('fair random digits produce nothing to run', () => {
    const r = mulberry32(99);
    const series = { R_10: Array.from({ length: 6000 }, () => Math.floor(r() * 10)) };
    const registry = new StrategyRegistry({ load: () => null, save: () => undefined });
    const lab: LabRunner = new LabRunner(() => series, (res, cfg) => registry.addFromLab(res, cfg, lab.getSnapshot().ticks));
    lab.start({ markets: ['R_10'], direction: 'BOTH', duration: 1, seed: 5 });
    for (let i = 0; i < 300 && lab.getSnapshot().state === 'running'; i++) lab.step();
    const ap = new Autopilot({ strategies: () => registry.getSnapshot(), forward: () => [], setStatus: (id, to, by, n) => registry.setStatus(id, to, by, n), lab, series: () => series, duration: () => 1, now: () => 1 });
    ap.configure({ ...DEFAULT_AUTOPILOT, promote: 'FAST', research: false });
    ap.cycle();
    expect(registry.activeCandidates()).toHaveLength(0);
});
