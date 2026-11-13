import { AiIntelExecutor, DEFAULT_EXEC, type ExecConfig, type ExecIO, normalizeExec } from '../executor';
import { createEntryDigitSource, ENTRY_DIGIT_RETRY_MS } from '../entry-digit';
import { ENTRY_DIGIT_TTL_MS } from '@/components/premium/sentinel/overlay';
import type { Pick, RecoveryPick } from '../picker';

// Noise with one planted habit: right after a 5 the next digit is always 9 (a win for Over 2, a loss for Under 7).
const planted = (n = 900, seed = 11) => {
    let a = seed;
    const out = Array.from({ length: n }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
    for (let i = 0; i + 1 < out.length; i += 1) if (out[i] === 5) out[i + 1] = 9;
    return out;
};
const OVER_2 = { side: 'OVER', param: 2 } as const;

describe('createEntryDigitSource (Sentinel AI formula, kept for a minute)', () => {
    it('gives the digit after which the contract kept winning, labelled confirmed', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        const d = src.get('A', OVER_2, 1, 1_000)!;
        expect(d.digit).toBe(5);
        expect(d.strength).toBe('confirmed');
        expect(d.note).toContain('after a 5');
    });
    it('keeps the same digit for a minute, then works it out again from the newest ticks', () => {
        let series = planted();
        const src = createEntryDigitSource({ series: () => series });
        expect(src.get('A', OVER_2, 1, 1_000)?.digit).toBe(5);
        series = series.map(d => (d === 5 ? 3 : d)); // the market moved on
        expect(src.get('A', OVER_2, 1, 1_000 + ENTRY_DIGIT_TTL_MS - 1)?.digit).toBe(5);
        expect(src.get('A', OVER_2, 1, 1_000 + ENTRY_DIGIT_TTL_MS + 1)?.digit).not.toBe(5);
    });
    it('keeps a digit per market, per contract and per length', () => {
        const series: Record<string, number[]> = { A: planted(), B: planted().map(d => (d === 5 ? 4 : d)) };
        const src = createEntryDigitSource({ series: m => series[m] });
        expect(src.get('A', OVER_2, 1, 1_000)?.digit).toBe(5);
        expect(src.get('B', OVER_2, 1, 1_000)?.digit).not.toBe(5);
        expect(src.get('A', { side: 'UNDER', param: 7 }, 1, 1_000)?.digit).not.toBe(5);
    });
    it('is null with too little history and looks again soon (a missing digit is not kept for a minute)', () => {
        let series = planted().slice(0, 100);
        const src = createEntryDigitSource({ series: () => series });
        expect(src.get('A', OVER_2, 1, 1_000)).toBeNull();
        series = planted();
        expect(src.get('A', OVER_2, 1, 1_000 + 100)).toBeNull(); // still inside the retry gap
        expect(src.get('A', OVER_2, 1, 1_000 + ENTRY_DIGIT_RETRY_MS + 1)?.digit).toBe(5);
    });
    it('is null for a contract outside the six, a market with no ticks, and when the discovery throws', () => {
        const src = createEntryDigitSource({ series: () => planted() });
        expect(src.get('A', { side: 'OVER', param: 5 }, 1, 1_000)).toBeNull();
        expect(createEntryDigitSource({ series: () => undefined }).get('A', OVER_2, 1, 1_000)).toBeNull();
        const broken = createEntryDigitSource({
            series: () => planted(),
            discover: () => {
                throw new Error('x');
            },
        });
        expect(broken.get('A', OVER_2, 1, 1_000)).toBeNull();
    });
    it('reset forgets the digits', () => {
        let series = planted();
        const src = createEntryDigitSource({ series: () => series });
        expect(src.get('A', OVER_2, 1, 1_000)?.digit).toBe(5);
        series = series.map(d => (d === 5 ? 3 : d));
        src.reset();
        expect(src.get('A', OVER_2, 1, 1_001)?.digit).not.toBe(5);
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
            return { digit: 7, strength: 'confirmed', note: 'after a 7 the contract won 90% of 40 (fair 70%)' };
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
    it('shows the digit being waited for on the board, and labels a weak one', () => {
        const h = harness(
            { entryMode: 'DIGIT' },
            { entryDigit: () => ({ digit: 4, strength: 'weak', note: 'no digit stands out' }) }
        );
        h.ex.start();
        expect(h.ex.getSnapshot().entryDigits).toEqual({ R_10: { digit: 4, strength: 'weak' } });
    });
    it('a weak digit is traded like Sentinel does, and the log says it is a timing choice', async () => {
        const h = harness(
            { entryMode: 'DIGIT' },
            {
                entryDigit: () => ({
                    digit: 4,
                    strength: 'weak',
                    note: 'no digit stands out. Waiting for it is a timing choice, not an edge',
                }),
            }
        );
        h.ex.start();
        h.tick(4);
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(
            h.ex
                .getSnapshot()
                .log.map(l => l.text)
                .join('\n')
        ).toContain('weak: no digit stands out');
    });
    it('cannot start without the digit source, and says so', () => {
        const h = harness({ entryMode: 'DIGIT' }, { entryDigit: undefined });
        expect(h.ex.startBlocker()).toMatch(/entry digit is not available/i);
        expect(harness({ entryMode: 'STANDARD' }, { entryDigit: undefined }).ex.startBlocker()).toBeNull();
    });
    it('a new run resets the digits', () => {
        let resets = 0;
        const h = harness({ entryMode: 'DIGIT' }, { resetEntryDigits: () => (resets += 1) });
        h.ex.start();
        expect(resets).toBe(1);
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
});

describe('Entry digit mode with the real formula', () => {
    it('trades the planted market on its entry digit and on nothing else', async () => {
        const series = planted();
        const src = createEntryDigitSource({ series: () => series });
        const h = harness({ entryMode: 'DIGIT' }, { entryDigit: (m, c, d, now) => src.get(m, c, d, now) });
        h.ex.start();
        for (const d of [0, 1, 2, 3, 4, 6, 7, 8, 9]) h.tick(d);
        await flush();
        expect(h.buys).toHaveLength(0);
        h.tick(5); // the digit after which Over 2 kept winning on this market
        await flush();
        expect(h.buys).toHaveLength(1);
    });
});
