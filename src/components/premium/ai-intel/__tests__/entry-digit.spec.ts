import { AiIntelExecutor, DEFAULT_EXEC, type ExecConfig, type ExecIO, normalizeExec } from '../executor';
import { createEntryDigitSource, type EntryDigit } from '../entry-digit';
import { LAB_DEFAULTS } from '../entry-lab';
import type { Pick, RecoveryPick } from '../picker';

// Noise with one planted habit: right after a 5 the next digit is always 9 (a win for Over 2, a loss for Under 7).
const planted = (n = 900, seed = 11) => {
    let a = seed;
    const out = Array.from({ length: n }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
    for (let i = 0; i + 1 < out.length; i += 1) if (out[i] === 5) out[i + 1] = 9;
    return out;
};
const OVER_2 = { side: 'OVER', param: 2 } as const;
const UNDER_7 = { side: 'UNDER', param: 7 } as const;

describe('createEntryDigitSource (the Entry Digit Lab behind a facade)', () => {
    it('gives the digit after which the contract kept winning, confirmed and tradable', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        const d = src.get('A', OVER_2, 1)!;
        expect(d).toMatchObject({ digit: 5, strength: 'confirmed', tradable: true });
        expect(d.note).toContain('after a 5');
    });
    it('has no minute of memory: it follows every tick that is fed to it', () => {
        const series = planted();
        const src = createEntryDigitSource({ series: () => series });
        expect(src.get('A', OVER_2, 1)).toMatchObject({ digit: 5, tradable: true });
        // The market turns: after a 5 the next digit is now 0, a loss for Over 2.
        let gone = -1;
        for (let i = 1; i <= 300 && gone < 0; i += 1) {
            const d = series[series.length - 1] === 5 ? 0 : [1, 2, 3, 4, 6, 7, 8, 9, 5][i % 9];
            series.push(d);
            src.observe('A', d);
            const now = src.get('A', OVER_2, 1);
            if (!(now && now.digit === 5 && now.tradable)) gone = i;
        }
        expect(gone).toBeGreaterThan(0);
        expect(gone).toBeLessThan(250);
    });
    it('keeps a digit per market, per contract and per length', () => {
        const series: Record<string, number[]> = { A: planted(), B: planted().map(d => (d === 5 ? 4 : d)) };
        const src = createEntryDigitSource({ series: m => series[m] });
        expect(src.get('A', OVER_2, 1)?.digit).toBe(5);
        const b = src.get('B', OVER_2, 1);
        expect(b && b.digit === 5 && b.tradable).toBeFalsy();
        const u = src.get('A', UNDER_7, 1);
        expect(u && u.digit === 5 && u.tradable).toBeFalsy();
    });
    it('is null with too little history, and starts answering once there is enough', () => {
        let series = planted().slice(0, 100);
        const src = createEntryDigitSource({ series: () => series });
        expect(src.get('A', OVER_2, 1)).toBeNull();
        series = planted();
        expect(src.get('A', OVER_2, 1)?.digit).toBe(5); // no retry gap to wait out
    });
    it('is null for a contract outside the six, a market with no ticks, and when the series throws', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        expect(src.get('A', { side: 'OVER', param: 5 }, 1)).toBeNull();
        expect(createEntryDigitSource({ series: () => undefined }).get('A', OVER_2, 1)).toBeNull();
        const broken = createEntryDigitSource({
            series: () => {
                throw new Error('x');
            },
        });
        expect(broken.get('A', OVER_2, 1)).toBeNull();
        expect(() => broken.observe('A', 3)).not.toThrow();
        expect(broken.view('A', OVER_2, 1)).toBeNull();
    });
    it('picks the market up again when a reconnect replaces its history', () => {
        let series = planted();
        const src = createEntryDigitSource({ series: () => series });
        expect(src.get('A', OVER_2, 1)?.digit).toBe(5);
        series = planted(900, 99).map(d => (d === 5 ? 3 : d)); // a different history altogether, with no 5s
        const d = src.get('A', OVER_2, 1);
        expect(d && d.digit === 5 && d.tradable).toBeFalsy();
    });
    it('a digit that loses twice on this contract is benched and the log line says so', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        expect(src.get('A', OVER_2, 1)?.digit).toBe(5);
        expect(src.record('A', OVER_2, 1, 5, false)).toBeNull();
        expect(src.record('A', OVER_2, 1, 5, false)).toContain('benched');
        const d = src.get('A', OVER_2, 1);
        expect(d && d.digit === 5 && d.tradable).toBeFalsy();
        expect(src.view('A', OVER_2, 1)!.rows[5].state).toBe('benched');
    });
    it('the lab keeps its numbers for the page', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        src.get('A', OVER_2, 1); // the digit in use is set when it is asked for
        const v = src.view('A', OVER_2, 1)!;
        expect(v.rows).toHaveLength(10);
        expect(v.market).toBe('A');
        expect(v.current).toBe(5);
    });
    it('reset forgets everything it learned', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        src.get('A', OVER_2, 1);
        src.record('A', OVER_2, 1, 5, false);
        src.record('A', OVER_2, 1, 5, false);
        src.reset();
        expect(src.get('A', OVER_2, 1)).toMatchObject({ digit: 5, tradable: true });
    });
    it('accepts settings, and the defaults are what the page describes', () => {
        expect(LAB_DEFAULTS.minTicks).toBeGreaterThan(0);
        const strict = createEntryDigitSource({ series: () => planted(), params: { zLead: 99, zConfirm: 99 } });
        expect(strict.get('A', OVER_2, 1)?.tradable).toBe(false);
    });
});

describe('config', () => {
    it('defaults to STANDARD, and an old saved config without the field stays STANDARD', () => {
        expect(DEFAULT_EXEC.entryMode).toBe('STANDARD');
        expect(normalizeExec(null).entryMode).toBe('STANDARD');
        expect(normalizeExec({ stake: 2 } as Partial<ExecConfig>).entryMode).toBe('STANDARD');
        expect(normalizeExec({ entryMode: 'nonsense' } as unknown as Partial<ExecConfig>).entryMode).toBe('STANDARD');
        expect(normalizeExec({ entryMode: 'DIGIT' }).entryMode).toBe('DIGIT');
    });
});

// A small harness in the style of executor.spec.ts.
const flush = () => new Promise(r => setTimeout(r, 0));
const pick = (market: string, direction: 'OVER_2' | 'UNDER_7', entry: Pick['entry'] = 'SETUP'): Pick => ({
    key: `${market}|${direction}|${entry}`,
    market,
    direction,
    entry,
    customDigits: [],
    rule: null,
    strategyId: null,
    label: `${direction} · ${entry}`,
    score: 0.05,
    trades: 100,
    rate: 0.75,
    significant: false,
    q: null,
    regime: 'STABLE',
    reason: 'test',
});
const rpick = (market: string, direction: 'OVER_3' | 'UNDER_6'): RecoveryPick => ({
    key: `${market}|${direction}|SETUP`,
    market,
    direction,
    entry: 'SETUP',
    label: direction,
    score: 0.02,
    trades: 100,
    rate: 0.62,
    regime: 'STABLE',
    reason: 'test',
});

function harness(
    cfg: Partial<ExecConfig> = {},
    over: Partial<ExecIO> = {},
    primary: Pick[] = [pick('R_10', 'OVER_2', 'SETUP')],
    recovery: RecoveryPick[] = [rpick('R_10', 'OVER_3')]
) {
    let t = 1_000_000;
    const buys: Array<{ parameters: any; price: number }> = [];
    const settles: Array<(r: any) => void> = [];
    let id = 500;
    const asked: Array<{ market: string; label: string; duration: number }> = [];
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: {
            run_id: '',
            is_contract_buying_in_progress: false,
            setIsRunning() {},
            setRunId() {},
            toggleDrawer() {},
            setHasOpenContract() {},
            setShowBotStopMessage() {},
            setContractStage() {},
            onBotContractEvent() {},
        },
        summary_card: { onBotContractEvent() {} },
        transactions: { pushTransaction() {} },
        dashboard: {
            active_trading_module: null,
            setActiveTradingModule() {},
            registerTradingStopHandler() {},
            unregisterTradingStopHandler() {},
            stopActiveTradingModule() {},
        },
    };
    const io: ExecIO = {
        buy: async a => {
            buys.push(a);
            return { buy_price: a.price, contract_id: ++id, transaction_id: id + 1000 };
        },
        settle: ({ contractId }) => new Promise(res => settles.push(r => res({ contract_id: contractId, ...r }))),
        isAuthorized: () => true,
        now: () => t,
        lastTickAt: () => t,
        isFeedLive: () => true,
        connectFeed() {},
        pick: () => primary,
        pickRecovery: () => recovery,
        entryDigit: (market, contract, duration) => {
            asked.push({ market, label: `${contract.side} ${contract.param}`, duration });
            return {
                digit: 7,
                strength: 'confirmed',
                tradable: true,
                note: 'after a 7 the contract won 90% of 40 (fair 70%)',
            };
        },
        describeFailure: (e: any) => ({ kind: 'rejected', message: e?.message ?? 'x', outcomeUnknown: false }),
        load: () => ({
            stake: 1,
            mode: 'AUTO',
            autoAuthorised: true,
            stopLoss: 50,
            targetProfit: 0,
            virtualHook: { enabled: false } as any,
            ...cfg,
        }),
        save() {},
        ...over,
    };
    const ex = new AiIntelExecutor(io);
    ex.attach(stores);
    return {
        ex,
        buys,
        asked,
        settles,
        advance: (ms: number) => (t += ms),
        tick: (d: number, sym = 'R_10') => {
            t += 1000;
            ex.handleTick(sym, d);
        },
    };
}

describe('Entry digit mode in the executor', () => {
    it('STANDARD is untouched: the entry type arms the trade and the digit source is never asked', async () => {
        const h = harness({ entryMode: 'STANDARD' });
        h.ex.start();
        h.tick(5); // a winning digit for Over 2: no SETUP entry
        await flush();
        expect(h.buys).toHaveLength(0);
        h.tick(1); // a losing digit: the SETUP entry
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.asked).toHaveLength(0);
        expect(h.ex.getSnapshot().entryDigits).toEqual({});
        expect(h.ex.getSnapshot().entryLab).toBeNull();
    });
    it("DIGIT buys only when the market's entry digit prints, whatever the entry type would say", async () => {
        const h = harness({ entryMode: 'DIGIT' });
        h.ex.start();
        h.tick(1); // the SETUP entry would fire here, but the entry digit is 7
        await flush();
        expect(h.buys).toHaveLength(0);
        h.tick(7);
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.buys[0].parameters).toMatchObject({
            symbol: 'R_10',
            contract_type: 'DIGITOVER',
            barrier: '2',
            duration: 1,
        });
        const log = h.ex
            .getSnapshot()
            .log.map(l => l.text)
            .join('\n');
        expect(log).toContain('entry digit 7 (confirmed: after a 7');
    });
    it('DIGIT replaces an ANY entry too: no more buying on every tick', async () => {
        const h = harness({ entryMode: 'DIGIT' }, {}, [pick('R_10', 'OVER_2', 'ANY')]);
        h.ex.start();
        h.tick(3);
        h.tick(4);
        await flush();
        expect(h.buys).toHaveLength(0);
        h.tick(7);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
    it('asks for the contract being traded and the run length, and the recovery contract after a loss', async () => {
        const h = harness({ entryMode: 'DIGIT', duration: 3 });
        h.ex.start();
        h.tick(7);
        await flush();
        expect(h.asked.some(a => a.label === 'OVER 2' && a.duration === 3 && a.market === 'R_10')).toBe(true);
        h.settles[0]({ is_sold: 1, status: 'lost', profit: -1, exit_spot: '1' });
        await flush();
        h.advance(1000);
        h.tick(7);
        await flush();
        expect(h.asked.some(a => a.label === 'OVER 3')).toBe(true);
        expect(h.buys).toHaveLength(2);
        expect(h.buys[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '3', amount: 2 });
    });
    it('follows the digit as it changes: it is asked again on every tick, nothing is kept', async () => {
        let current = 4;
        const h = harness(
            { entryMode: 'DIGIT' },
            { entryDigit: () => ({ digit: current, strength: 'leading', tradable: true, note: 'n' }) }
        );
        h.ex.start();
        h.tick(7); // the digit now is 4
        await flush();
        expect(h.buys).toHaveLength(0);
        current = 7; // the lab moved on
        h.tick(7);
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.ex.getSnapshot().entryDigits).toEqual({ R_10: { digit: 7, strength: 'leading', tradable: true } });
    });
    it('a digit that does not hold up is never traded, even when it prints', async () => {
        const h = harness(
            { entryMode: 'DIGIT' },
            {
                entryDigit: () => ({
                    digit: 4,
                    strength: 'weak',
                    tradable: false,
                    note: 'Standing aside: nothing holds up',
                }),
            }
        );
        h.ex.start();
        for (const d of [4, 4, 4, 1, 4]) h.tick(d);
        await flush();
        expect(h.buys).toHaveLength(0);
        expect(h.ex.getSnapshot().entryDigits).toEqual({ R_10: { digit: 4, strength: 'weak', tradable: false } });
    });
    it('no digit yet (short history) means no trade on that market', async () => {
        const h = harness({ entryMode: 'DIGIT' }, { entryDigit: () => null });
        h.ex.start();
        for (const d of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) h.tick(d);
        await flush();
        expect(h.buys).toHaveLength(0);
        expect(h.ex.getSnapshot().entryDigits).toEqual({ R_10: null });
    });
    it('a digit lookup that throws means no trade, not a guess', async () => {
        const h = harness(
            { entryMode: 'DIGIT' },
            {
                entryDigit: () => {
                    throw new Error('boom');
                },
            }
        );
        h.ex.start();
        h.tick(7);
        await flush();
        expect(h.buys).toHaveLength(0);
    });
    it('cannot start without the digit source, and says so', () => {
        const h = harness({ entryMode: 'DIGIT' }, { entryDigit: undefined });
        expect(h.ex.startBlocker()).toMatch(/entry digit is not available/i);
        expect(harness({ entryMode: 'STANDARD' }, { entryDigit: undefined }).ex.startBlocker()).toBeNull();
    });
    it('ASSISTED prepares the digit trade for confirmation instead of buying', async () => {
        const h = harness({ entryMode: 'DIGIT', mode: 'ASSISTED', autoAuthorised: false });
        h.ex.start();
        h.tick(2);
        expect(h.ex.getSnapshot().proposal).toBeNull();
        h.tick(7);
        const p = h.ex.getSnapshot().proposal!;
        expect(p).toMatchObject({ market: 'R_10', triggerDigit: 7 });
        expect(p.digitNote).toContain('confirmed');
        expect(h.buys).toHaveLength(0);
    });
    it('puts the lab on the snapshot for the page', () => {
        const view = {
            market: 'R_10',
            label: 'Over 2',
            fair: 0.7,
            ticks: 900,
            rows: [],
            current: 7,
            heldTicks: 12,
            switches: 3,
        };
        const h = harness({ entryMode: 'DIGIT' }, { entryView: () => view as any });
        h.ex.start();
        expect(h.ex.getSnapshot().entryLab).toEqual(view);
    });
});

describe('Entry digit mode: results go back to the lab', () => {
    const results = () => {
        const seen: any[] = [];
        return {
            seen,
            io: {
                entryResult: (r: any) => {
                    seen.push(r);
                    return seen.length === 1 ? 'Entry digit 7 benched on R_10 for 90 ticks: test' : null;
                },
            } as Partial<ExecIO>,
        };
    };
    it('a real trade that settles tells the lab which digit it was entered on, and a benching is logged', async () => {
        const r = results();
        const h = harness({ entryMode: 'DIGIT' }, r.io);
        h.ex.start();
        h.tick(7);
        await flush();
        h.settles[0]({ is_sold: 1, status: 'lost', profit: -1, exit_spot: '1' });
        await flush();
        expect(r.seen).toHaveLength(1);
        expect(r.seen[0]).toMatchObject({
            market: 'R_10',
            contract: { side: 'OVER', param: 2 },
            duration: 1,
            digit: 7,
            won: false,
        });
        expect(
            h.ex
                .getSnapshot()
                .log.map(l => l.text)
                .join('\n')
        ).toContain('Entry digit 7 benched on R_10');
    });
    it('a win is reported as a win', async () => {
        const r = results();
        const h = harness({ entryMode: 'DIGIT' }, r.io);
        h.ex.start();
        h.tick(7);
        await flush();
        h.settles[0]({ is_sold: 1, status: 'won', profit: 0.4, exit_spot: '9' });
        await flush();
        expect(r.seen[0]).toMatchObject({ digit: 7, won: true });
    });
    it('a paper trade teaches it the same way', async () => {
        const r = results();
        const h = harness(
            {
                entryMode: 'DIGIT',
                virtualHook: {
                    enabled: true,
                    opening: true,
                    mode: 'STREAK',
                    enterLosses: 2,
                    returnWins: 2,
                    fixedCount: 3,
                } as any,
            },
            r.io
        );
        h.ex.start();
        h.tick(7); // opens on paper
        h.tick(1); // settles a tick later: a loss for Over 2
        await flush();
        expect(h.buys).toHaveLength(0);
        expect(r.seen.length).toBeGreaterThan(0);
        expect(r.seen[0]).toMatchObject({ market: 'R_10', digit: 7, won: false });
    });
    it('STANDARD reports nothing', async () => {
        const r = results();
        const h = harness({ entryMode: 'STANDARD' }, r.io);
        h.ex.start();
        h.tick(1);
        await flush();
        h.settles[0]({ is_sold: 1, status: 'lost', profit: -1, exit_spot: '1' });
        await flush();
        expect(r.seen).toHaveLength(0);
    });
});

describe('Entry digit mode with the real lab', () => {
    // Each tick goes to the feed copy, the lab and the executor, in the order the app does it.
    const rig = () => {
        const series = planted();
        const src = createEntryDigitSource({ series: () => series });
        const h = harness(
            { entryMode: 'DIGIT' },
            {
                entryDigit: (m, c, d) => src.get(m, c, d),
                entryResult: r => src.record(r.market, r.contract, r.duration, r.digit, r.won),
            }
        );
        const feed = (d: number) => {
            series.push(d);
            src.observe('R_10', d);
            h.tick(d);
        };
        return { src, h, feed, series };
    };
    it('trades the planted market on its entry digit and on nothing else', async () => {
        const { h, feed } = rig();
        h.ex.start();
        for (const d of [0, 1, 2, 3, 4, 6, 7, 8, 9]) feed(d);
        await flush();
        expect(h.buys).toHaveLength(0);
        feed(5); // the digit after which Over 2 kept winning on this market
        await flush();
        expect(h.buys).toHaveLength(1);
    });
    it('stops trading on that digit once the market stops rewarding it', async () => {
        const { src, h, feed, series } = rig();
        h.ex.start();
        let boughtOnFive = 0;
        // The habit flips: after a 5 the next digit is now a loser (0 for Over 2).
        for (let i = 0; i < 400; i += 1) {
            const last = series[series.length - 1];
            const d = last === 5 ? 0 : [1, 2, 3, 4, 6, 7, 8, 9, 5][i % 9];
            const before = h.buys.length;
            feed(d);
            await flush();
            if (d === 5 && h.buys.length > before) boughtOnFive += 1;
            if (h.buys.length > before)
                h.settles[h.buys.length - 1]({
                    is_sold: 1,
                    status: d === 5 ? 'won' : 'lost',
                    profit: -1,
                    exit_spot: '0',
                });
            await flush();
        }
        const now = src.get('R_10', OVER_2, 1);
        expect(now && now.digit === 5 && now.tradable).toBeFalsy();
        expect(boughtOnFive).toBeLessThan(25); // it did not keep going on the old digit for the rest of the run
    });
});
