import { configError, DTraderRunner, type MarketView, type RunConfig, type RunnerEvent, type RunnerIO } from '../dtrader-runner';

type Listener = (symbol: string) => void;

/** A fake market + Deriv. Ticks are pushed by the test; every buy confirms, then settles on the exit tick the test chooses. */
const makeWorld = (opts: { settleProfit?: (n: number) => number; failBuys?: boolean; exitOffsetTicks?: number; silentStream?: boolean; pollReadsOpen?: boolean } = {}) => {
    const symbol = '1HZ100V';
    const view: MarketView = { digits: [], times: [], decimals: 2, lastTickAt: 0 };
    const tickListeners = new Set<Listener>();
    const contractListeners = new Set<(c: any) => void>();
    const buys: any[] = [];
    const known = new Map<number, any>();
    let nextId = 100;
    let clock = 1_000_000;
    const epochOfIndex = (i: number) => Math.round(view.times[i] / 1000);

    const pushTick = (digit: number) => {
        clock += 1000;
        const price = 1100 + digit / 100;
        void price;
        view.digits.push(digit);
        view.times.push(clock);
        view.lastTickAt = clock;
        tickListeners.forEach(l => l(symbol));
    };

    const io: RunnerIO = {
        now: () => clock,
        market: s => (s === symbol ? view : undefined),
        onTick: l => { tickListeners.add(l); return () => { tickListeners.delete(l); }; },
        buy: async (params, price) => {
            if (opts.failBuys) throw new Error('Contract purchase failed.');
            const id = nextId++;
            buys.push({ id, params, price, atTick: view.times.length });
            const n = buys.length;
            // Deriv reports one entry tick (the tick after the buy) and one exit tick, the same for every contract in the burst.
            const entryTime = Math.round((view.times[view.times.length - 1] + 1000) / 1000);
            const exitTime = entryTime + (opts.exitOffsetTicks ?? 0);
            const closed = (profit: number) => ({
                contract_id: id, status: profit > 0 ? 'won' : 'lost', is_sold: 1, profit, entry_tick_time: entryTime, exit_tick_time: exitTime,
                entry_tick_display_value: '1100.10', exit_tick_display_value: '1100.15',
            });
            known.set(id, closed((opts.settleProfit ?? (() => 0.95))(n)));
            if (!opts.silentStream) setTimeout(() => {
                const profit = (opts.settleProfit ?? (() => 0.95))(n);
                contractListeners.forEach(l => l({
                    contract_id: id, status: profit > 0 ? 'won' : 'lost', is_sold: 1, profit, entry_tick_time: entryTime, exit_tick_time: exitTime,
                    entry_tick_display_value: '1100.10', exit_tick_display_value: '1100.15',
                }));
            }, 2);
            return { contract_id: id, buy_price: price };
        },
        onContractUpdate: l => { contractListeners.add(l); return () => { contractListeners.delete(l); }; },
        isClosed: c => Boolean(c?.is_sold),
        digitAt: (_s, epoch) => { const i = view.times.findIndex(t => Math.round(t / 1000) === epoch); return i >= 0 ? view.digits[i] : null; },
        // With a silent stream, time must pass for the runner's fallback polling to start.
        sleep: ms => new Promise(resolve => setTimeout(() => { if (opts.silentStream) clock += ms; resolve(undefined); }, Math.min(ms, 5))),
        lookupContract: async id => (opts.pollReadsOpen ? { contract_id: id, status: 'open', is_sold: 0 } : known.get(Number(id))),
    };
    return { symbol, view, io, pushTick, buys, epochOfIndex, advance: (ms: number) => { clock += ms; } };
};

const baseConfig = (symbol: string, patch: Partial<RunConfig> = {}): RunConfig => ({
    symbol, family: 'overunder', side: 'second', prediction: 8, offset: 0.5, duration: 1, stake: 1, tradesPerEntry: 3, martingale: 1, takeProfit: 0, stopLoss: 0,
    mode: 'single', entry: { mode: 'instant' }, sameTickGuard: false, currency: 'USD', ...patch,
});

const collect = () => {
    const events: RunnerEvent[] = [];
    return { events, emit: (e: RunnerEvent) => events.push(e), of: <T extends RunnerEvent['type']>(type: T) => events.filter(e => e.type === type) as Array<Extract<RunnerEvent, { type: T }>> };
};

const seed = (w: ReturnType<typeof makeWorld>, digits: number[]) => digits.forEach(d => w.pushTick(d));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('DTraderRunner', () => {
    it('counts the trades the same-tick guard held back as not sent, and buys only what it sent', async () => {
        const w = makeWorld();
        seed(w, [4, 5, 6, 7, 8, 9, 1, 2, 3, 4]);   // 1 s ticks
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        await runner.run(baseConfig(w.symbol, { tradesPerEntry: 10, sameTickGuard: true }));
        expect(w.buys.length).toBeLessThan(10);
        expect(runner.totals.contracts).toBe(w.buys.length);
        expect(runner.totals).toMatchObject({ requested: 10, notSent: 10 - w.buys.length });
        expect(runner.totals.won + runner.totals.lost).toBe(w.buys.length);   // every bought contract settled, nothing else
    });
    it('settles every trade by asking Deriv directly when the settlement stream stays silent', async () => {
        const w = makeWorld({ silentStream: true });
        seed(w, [4, 5, 6, 7]);
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        await runner.run(baseConfig(w.symbol, { tradesPerEntry: 6 }));
        expect(runner.totals).toMatchObject({ contracts: 6, won: 6, lost: 0 });
        expect(c.of('trade').filter(e => e.row.state === 'open').length).toBe(6);   // the rows that opened...
        expect(new Set(c.of('trade').filter(e => e.row.state === 'won').map(e => e.row.id)).size).toBe(6); // ...all closed
        expect(c.of('journal').some(j => /Confirming with Deriv directly/.test(j.text))).toBe(true);
    });
    it('says what Deriv returned when a contract still does not look finished', async () => {
        const w = makeWorld({ silentStream: true, pollReadsOpen: true });
        seed(w, [4, 5, 6, 7]);
        const c = collect();
        await new DTraderRunner(w.io, c.emit).run(baseConfig(w.symbol, { tradesPerEntry: 2 }));
        expect(c.of('journal').some(j => /still reads status "open"/.test(j.text))).toBe(true);
    });
    it('Ends Between sends both barriers with every trade of the bulk, and refuses a missing offset', async () => {
        const w = makeWorld();
        seed(w, [4, 5, 6, 7]);
        const runner = new DTraderRunner(w.io, collect().emit);
        await runner.run(baseConfig(w.symbol, { family: 'range', side: 'first', tradesPerEntry: 5, duration: 5 }));
        expect(w.buys).toHaveLength(5);
        expect(w.buys.every(b => b.params.contract_type === 'EXPIRYRANGE' && b.params.barrier === '+0.5' && b.params.barrier2 === '-0.5')).toBe(true);
        const bad = collect();
        await new DTraderRunner(makeWorld().io, bad.emit).run(baseConfig('1HZ100V', { family: 'highlow', offset: 0 }));
        expect(bad.of('journal').some(j => /barrier offset/i.test(j.text))).toBe(true);
    });
    it('instant entry sends the whole bulk at once and reports that every trade shared one entry and one exit tick', async () => {
        const w = makeWorld();
        seed(w, [4, 5, 6, 7]);
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        await runner.run(baseConfig(w.symbol, { tradesPerEntry: 20 }));
        expect(w.buys).toHaveLength(20);
        expect(new Set(w.buys.map(b => b.atTick)).size).toBe(1);
        expect(w.buys.every(b => b.params.contract_type === 'DIGITUNDER' && b.params.barrier === '8' && b.params.duration === 1)).toBe(true);
        const sync = c.of('sync').at(-1)!;
        expect(sync.ok).toBe(true);
        expect(sync.text).toMatch(/All 20 trades entered and exited on the same tick/);
        expect(runner.totals).toMatchObject({ contracts: 20, won: 20, lost: 0, stake: 20 });
    });

    it('a sequence entry buys nothing until the digits have printed in order, then fires on that tick', async () => {
        const w = makeWorld();
        seed(w, [9, 9]);
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        const entry = { mode: 'pattern' as const, pattern: { kind: 'sequence' as const, digits: [1, 2, 5], fireAfter: 2 } };
        const done = runner.run(baseConfig(w.symbol, { entry, tradesPerEntry: 20 }));
        await tick();
        w.pushTick(1);
        await tick();
        expect(w.buys).toHaveLength(0);
        w.pushTick(2);                         // 1 then 2 have printed: fire after the 2nd step
        await done;
        expect(w.buys).toHaveLength(20);
        expect(new Set(w.buys.map(b => b.atTick)).size).toBe(1);
        expect(w.buys[0].atTick).toBe(4);      // sent right after the 4th tick printed (9, 9, 1, then the 2)
        expect(c.of('sync').at(-1)!.ok).toBe(true);
    });

    it('a pattern that never completes never buys', async () => {
        const w = makeWorld();
        seed(w, [9]);
        const runner = new DTraderRunner(w.io, () => undefined);
        const done = runner.run(baseConfig(w.symbol, { entry: { mode: 'pattern', pattern: { kind: 'sequence', digits: [1, 2, 5], fireAfter: 3 } } }));
        for (const d of [1, 2, 3, 5, 2, 1]) { w.pushTick(d); await tick(); }
        expect(w.buys).toHaveLength(0);
        runner.stop();
        await done;
        expect(w.buys).toHaveLength(0);
    });

    it('flags it when Deriv reports the trades on different exit ticks', async () => {
        const w = makeWorld();
        seed(w, [1, 2, 3, 4]);
        // Settle the 3rd contract one tick later than the others.
        const c = collect();
        const io: RunnerIO = { ...w.io, onContractUpdate: l => w.io.onContractUpdate(u => l(u.contract_id === 102 ? { ...u, exit_tick_time: u.exit_tick_time + 1 } : u)) };
        const runner = new DTraderRunner(io, c.emit);
        await runner.run(baseConfig(w.symbol, { tradesPerEntry: 3 }));
        const sync = c.of('sync').at(-1)!;
        expect(sync.ok).toBe(false);
        expect(sync.text).toMatch(/exit tick\(s\)|results differ/);
    });

    it('does not buy when a newer tick already printed than the one that triggered the entry', async () => {
        const w = makeWorld();
        seed(w, [1, 2, 3]);
        const c = collect();
        let calls = 0;
        const io: RunnerIO = {
            ...w.io,
            market: s => {
                const view = w.io.market(s);
                calls += 1;
                // 1st call = waitForEntry (instant). 2nd call = inside the burst: pretend a new tick has just printed.
                if (calls === 2 && view) return { ...view, times: [...view.times, view.times[view.times.length - 1] + 1000] };
                return view;
            },
        };
        const runner = new DTraderRunner(io, c.emit);
        const done = runner.run(baseConfig(w.symbol));
        await tick();
        expect(w.buys).toHaveLength(0);
        expect(c.of('journal').some(j => /Nothing was bought/.test(j.text))).toBe(true);
        runner.stop();
        w.pushTick(5);
        await done;
    });

    it('repeats, multiplies the stake after a losing entry and resets it after a win', async () => {
        const w = makeWorld({ settleProfit: n => (n <= 2 ? -1 : 0.95) });
        seed(w, [1, 2, 3, 4]);
        const runner = new DTraderRunner(w.io, () => undefined);
        // entry 1: 2 trades lose (stake 1) -> entry 2 at stake 2 (trades 3,4 win) -> back to base for entry 3
        const done = runner.run(baseConfig(w.symbol, { mode: 'repeat', tradesPerEntry: 2, martingale: 2, takeProfit: 0 }));
        for (let i = 0; i < 60 && w.buys.length < 6; i += 1) { await tick(); w.pushTick(i % 10); await new Promise(r => setTimeout(r, 8)); }
        runner.stop();
        await done;
        expect(w.buys.slice(0, 2).map(b => b.params.amount)).toEqual([1, 1]);
        expect(w.buys.slice(2, 4).map(b => b.params.amount)).toEqual([2, 2]);
        expect(w.buys[4].params.amount).toBe(1);
    });

    it('stops on take profit', async () => {
        const w = makeWorld({ settleProfit: () => 1 });
        seed(w, [1, 2, 3, 4]);
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        const done = runner.run(baseConfig(w.symbol, { mode: 'repeat', tradesPerEntry: 5, takeProfit: 5 }));
        await done;
        expect(w.buys).toHaveLength(5);
        expect(c.of('journal').some(j => /Take profit reached/.test(j.text))).toBe(true);
    });

    it('a two-sided entry sends both contracts, the same number of each', async () => {
        const w = makeWorld();
        seed(w, [1, 2, 3, 4]);
        const runner = new DTraderRunner(w.io, () => undefined);
        await runner.run(baseConfig(w.symbol, { side: 'both', prediction: 4, tradesPerEntry: 4 }));
        const over = w.buys.filter(b => b.params.contract_type === 'DIGITOVER');
        const under = w.buys.filter(b => b.params.contract_type === 'DIGITUNDER');
        expect(over).toHaveLength(4);
        expect(under).toHaveLength(4);
    });

    it('stops the run when every purchase is refused', async () => {
        const w = makeWorld({ failBuys: true });
        seed(w, [1, 2, 3, 4]);
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        await runner.run(baseConfig(w.symbol, { mode: 'repeat', tradesPerEntry: 3 }));
        expect(w.buys).toHaveLength(0);
        expect(runner.totals.failed).toBe(3);
        expect(c.of('journal').some(j => j.level === 'error')).toBe(true);
    });

    it('refuses to start with an invalid setup', async () => {
        const w = makeWorld();
        const c = collect();
        const runner = new DTraderRunner(w.io, c.emit);
        await runner.run(baseConfig(w.symbol, { side: 'first', prediction: 9 }));
        expect(w.buys).toHaveLength(0);
        expect(configError(baseConfig(w.symbol, { duration: 0 }))).toMatch(/Ticks/);
        expect(c.of('journal')[0].text).toMatch(/Over needs/);
    });

    it('refuses a second run while one is active', async () => {
        const w = makeWorld();
        seed(w, [1, 2, 3, 4]);
        const runner = new DTraderRunner(w.io, () => undefined);
        const first = runner.run(baseConfig(w.symbol, { entry: { mode: 'digit', op: '=', digit: 9 } }));
        await tick();
        expect(runner.busy).toBe(true);
        await runner.run(baseConfig(w.symbol));
        expect(w.buys).toHaveLength(0);
        runner.stop();
        await first;
        expect(runner.busy).toBe(false);
    });
});
