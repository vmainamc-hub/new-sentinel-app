import type { Contract } from '@/components/premium/sixfold/bot';
import type { OverlordRead, OverlordTier } from '../../overlord-engine/engine';
import { AiIntelExecutor, DEFAULT_EXEC, type ExecConfig, type ExecIO, normalizeExec } from '../executor';
import { MIN_ROUNDS, type OverlordView } from '../overlord-select';
import type { Pick, RecoveryPick } from '../picker';

const flush = () => new Promise(r => setTimeout(r, 0));
const pick = (market: string, direction: 'OVER_2' | 'UNDER_7', score = 0.05): Pick => ({
    key: `${market}|${direction}|SETUP`,
    market,
    direction,
    entry: 'SETUP',
    customDigits: [],
    rule: null,
    strategyId: null,
    label: `${direction} · SETUP`,
    score,
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
const view = (tier: OverlordTier = 'STRONG', score = 60, over: Partial<OverlordRead> = {}): OverlordView => ({
    read: { tier, score, vetoed: tier === 'CAUTION', vetoReason: tier === 'CAUTION' ? 'Apex Sentinel: danger clearance failed' : '', thin: false, ...over } as OverlordRead,
    rounds: MIN_ROUNDS,
    clearShare: 1,
    at: 0,
});
const keyOf = (m: string, c: Contract) => `${m}:${c.side}:${c.param}`;

function harness(cfg: Partial<ExecConfig> = {}, over: Partial<ExecIO> = {}, primary: Pick[] = [pick('R_10', 'OVER_2')], recovery: RecoveryPick[] = [rpick('R_10', 'OVER_3')]) {
    let t = 1_000_000;
    const buys: Array<{ parameters: any; price: number }> = [];
    const settles: Array<(r: any) => void> = [];
    let id = 500;
    const calls = { refresh: [] as Array<readonly string[]>, reset: 0, onBoard: [] as Array<{ primary: string[]; recovery: string[] }>, viewsAsked: [] as string[], review: 0, special: 0 };
    const stores: any = {
        client: { currency: 'USD' },
        run_panel: { run_id: '', is_contract_buying_in_progress: false, setIsRunning() {}, setRunId() {}, toggleDrawer() {}, setHasOpenContract() {}, setShowBotStopMessage() {}, setContractStage() {}, onBotContractEvent() {} },
        summary_card: { onBotContractEvent() {} },
        transactions: { pushTransaction() {} },
        dashboard: { active_trading_module: null, setActiveTradingModule() {}, registerTradingStopHandler() {}, unregisterTradingStopHandler() {}, stopActiveTradingModule() {} },
    };
    const views: Record<string, OverlordView | null> = {};
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
        onBoard: (p, r) => calls.onBoard.push({ primary: p.map(x => `${x.market}|${x.direction}`), recovery: r.map(x => `${x.market}|${x.direction}`) }),
        review: () => {
            calls.review += 1;
            return { allow: true, reason: 'ok' };
        },
        special: () => {
            calls.special += 1;
            return { allow: true, reason: '' };
        },
        overlordView: (m, c) => {
            calls.viewsAsked.push(keyOf(m, c));
            return views[keyOf(m, c)] ?? null;
        },
        overlordRefresh: (_now, priority) => {
            calls.refresh.push(priority);
        },
        overlordReset: () => {
            calls.reset += 1;
        },
        describeFailure: (e: any) => ({ kind: 'rejected', message: e?.message ?? 'x', outcomeUnknown: false }),
        load: () => ({ stake: 1, mode: 'AUTO', autoAuthorised: true, stopLoss: 50, targetProfit: 0, virtualHook: { enabled: false } as any, ...cfg }),
        save() {},
        ...over,
    };
    const ex = new AiIntelExecutor(io);
    ex.attach(stores);
    return {
        ex,
        buys,
        settles,
        calls,
        views,
        advance: (ms: number) => (t += ms),
        tick: (d: number, sym = 'R_10') => {
            t += 1000;
            ex.handleTick(sym, d);
        },
    };
}

describe('selection config', () => {
    it('defaults to STANDARD, an old saved config stays STANDARD, and junk is STANDARD', () => {
        expect(DEFAULT_EXEC.selection).toBe('STANDARD');
        expect(normalizeExec(null).selection).toBe('STANDARD');
        expect(normalizeExec({ stake: 2 } as Partial<ExecConfig>).selection).toBe('STANDARD');
        expect(normalizeExec({ selection: 'x' } as unknown as Partial<ExecConfig>).selection).toBe('STANDARD');
        expect(normalizeExec({ selection: 'OVERLORD' }).selection).toBe('OVERLORD');
        expect(normalizeExec({ selection: 'COMBINED' }).selection).toBe('COMBINED');
    });
});

describe('STANDARD selection is Apex Intel exactly as it was', () => {
    it('never asks Overlord for anything and leaves the board as the picker made it', async () => {
        const book = [pick('R_10', 'OVER_2'), pick('R_25', 'UNDER_7')];
        const h = harness({}, {}, book);
        h.ex.start();
        const snap = h.ex.getSnapshot();
        expect(snap.board.primary.map(p => p.market)).toEqual(['R_10', 'R_25']);
        expect(snap.board.primary[0]).toBe(book[0]); // the very same pick, not a copy
        expect(snap.selection).toEqual({ mode: 'STANDARD', blocked: [], rows: {} });
        expect(h.calls.refresh).toHaveLength(0);
        expect(h.calls.viewsAsked).toHaveLength(0);
        h.tick(1);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
    it('starts without any Overlord hooks present', () => {
        const h = harness({}, { overlordView: undefined, overlordRefresh: undefined, overlordReset: undefined });
        expect(h.ex.startBlocker()).toBeNull();
    });
});

describe('OVERLORD selection', () => {
    it('cannot start where Overlord is not available', () => {
        const h = harness({ selection: 'OVERLORD' }, { overlordView: undefined });
        expect(h.ex.startBlocker()).toContain('Overlord selection is not available');
    });

    it('drops what Overlord vetoes and trades the market it lets through, with the unchanged contract parameters', async () => {
        const h = harness({ selection: 'OVERLORD' }, {}, [pick('R_10', 'OVER_2'), pick('R_25', 'OVER_2')]);
        h.views['R_10:OVER:2'] = view('CAUTION');
        h.views['R_25:OVER:2'] = view('STRONG', 70);
        h.ex.start();
        const snap = h.ex.getSnapshot();
        expect(snap.board.primary.map(p => p.market)).toEqual(['R_25']);
        expect(snap.selection.blocked[0]).toMatchObject({ market: 'R_10', reason: 'veto' });
        expect(snap.selection.blocked[0].text).toContain('danger clearance');
        expect(snap.selection.rows.R_25).toMatchObject({ tier: 'STRONG', score: 70 });
        expect(snap.board.primary[0].reason).toContain('Overlord STRONG 70');
        h.tick(1, 'R_10'); // a vetoed market: no trade even on its entry digit
        await flush();
        expect(h.buys).toHaveLength(0);
        h.tick(1, 'R_25');
        await flush();
        expect(h.buys).toHaveLength(1);
        expect(h.buys[0].parameters).toMatchObject({ symbol: 'R_25', contract_type: 'DIGITOVER', barrier: '2', amount: 1 });
    });

    it('Overlord decides the order: its preferred market comes first and the contract is chosen per market', () => {
        const h = harness({ selection: 'OVERLORD' }, {}, [pick('R_10', 'OVER_2'), pick('R_25', 'OVER_2'), pick('R_25', 'UNDER_7')]);
        h.views['R_10:OVER:2'] = view('BEST', 90);
        h.views['R_25:OVER:2'] = view('STRONG', 55);
        h.views['R_25:UNDER:7'] = view('STRONG', 80);
        h.ex.start();
        const primary = h.ex.getSnapshot().board.primary;
        expect(primary.map(p => `${p.market}|${p.direction}`)).toEqual(['R_25|UNDER_7', 'R_10|OVER_2']);
    });

    it('every existing check still runs on the chosen contract: the AI guard, the digit 1 / 8 rule', async () => {
        const guarded = harness({ selection: 'OVERLORD' }, { review: () => ({ allow: false, reason: 'guard says no' }) });
        guarded.views['R_10:OVER:2'] = view();
        guarded.ex.start();
        guarded.tick(1);
        await flush();
        expect(guarded.buys).toHaveLength(0);

        const special = harness({ selection: 'OVERLORD' }, { special: () => ({ allow: false, reason: 'digit 8 is hot' }) });
        special.views['R_10:OVER:2'] = view();
        special.ex.start();
        special.tick(1);
        await flush();
        expect(special.buys).toHaveLength(0);

        const clear = harness({ selection: 'OVERLORD' });
        clear.views['R_10:OVER:2'] = view();
        clear.ex.start();
        clear.tick(1);
        await flush();
        expect(clear.buys).toHaveLength(1);
        expect(clear.calls.review).toBeGreaterThan(0);
        expect(clear.calls.special).toBeGreaterThan(0);
    });

    it('the edge gates are still shown the picker’s whole book, not the filtered one', () => {
        const h = harness({ selection: 'OVERLORD' }, {}, [pick('R_10', 'OVER_2'), pick('R_10', 'UNDER_7'), pick('R_25', 'OVER_2')]);
        h.views['R_10:OVER:2'] = view('CAUTION');
        h.views['R_10:UNDER:7'] = view('CAUTION');
        h.views['R_25:OVER:2'] = view();
        h.ex.start();
        expect(h.ex.getSnapshot().board.primary.map(p => p.market)).toEqual(['R_25']);
        expect(h.calls.onBoard[0].primary).toEqual(['R_10|OVER_2', 'R_10|UNDER_7', 'R_25|OVER_2']);
    });

    it('a market Overlord has no reading of yet is not traded, and the page says why', async () => {
        const h = harness({ selection: 'OVERLORD' });
        h.ex.start();
        h.tick(1);
        await flush();
        expect(h.buys).toHaveLength(0);
        const snap = h.ex.getSnapshot();
        expect(snap.board.primary).toEqual([]);
        expect(snap.selection.blocked[0].reason).toBe('no-read');
        expect(snap.note).toContain('Overlord selection: nothing clear yet');
    });

    it('a reading that throws is a missing reading, not a trade', async () => {
        const h = harness(
            { selection: 'OVERLORD' },
            {
                overlordView: () => {
                    throw new Error('boom');
                },
            }
        );
        h.ex.start();
        h.tick(1);
        await flush();
        expect(h.buys).toHaveLength(0);
    });

    it('asks Overlord to read the markets in play first, and starts it afresh on every run', () => {
        const h = harness({ selection: 'OVERLORD' }, {}, [pick('R_10', 'OVER_2'), pick('R_25', 'OVER_2')]);
        h.ex.start();
        expect(h.calls.reset).toBe(1);
        expect(h.calls.refresh[0]).toEqual(['R_10', 'R_25']);
    });

    it('after a loss it reads the recovery contract (Over 3) of the markets on the recovery board', async () => {
        const h = harness({ selection: 'OVERLORD' });
        h.views['R_10:OVER:2'] = view();
        h.views['R_10:OVER:3'] = view('STRONG', 65);
        h.ex.start();
        h.tick(1);
        await flush();
        h.settles[0]({ is_sold: 1, status: 'lost', profit: -1, exit_spot: '1' });
        await flush();
        h.advance(1000);
        h.tick(1);
        await flush();
        expect(h.calls.viewsAsked).toContain('R_10:OVER:3');
        expect(h.buys).toHaveLength(2);
        expect(h.buys[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '3', amount: 2 });
    });

    it('a vetoed recovery contract waits instead of being bought', async () => {
        const h = harness({ selection: 'OVERLORD' });
        h.views['R_10:OVER:2'] = view();
        h.views['R_10:OVER:3'] = view('CAUTION');
        h.ex.start();
        h.tick(1);
        await flush();
        h.settles[0]({ is_sold: 1, status: 'lost', profit: -1, exit_spot: '1' });
        await flush();
        h.advance(1000);
        h.tick(1);
        await flush();
        expect(h.buys).toHaveLength(1);
    });
});

describe('COMBINED selection', () => {
    it('also needs the picker’s own edge: Overlord alone is not enough', async () => {
        const h = harness({ selection: 'COMBINED' }, {}, [pick('R_10', 'OVER_2', -0.01), pick('R_25', 'OVER_2', 0.04)]);
        h.views['R_10:OVER:2'] = view('STRONG', 95);
        h.views['R_25:OVER:2'] = view('BEST', 50);
        h.ex.start();
        const snap = h.ex.getSnapshot();
        expect(snap.board.primary.map(p => p.market)).toEqual(['R_25']);
        expect(snap.selection.blocked.find(b => b.market === 'R_10')?.reason).toBe('edge');
        h.tick(1, 'R_10');
        await flush();
        expect(h.buys).toHaveLength(0);
        h.tick(1, 'R_25');
        await flush();
        expect(h.buys).toHaveLength(1);
    });

    it('never trades something OVERLORD would not, and OVERLORD never something STANDARD would not', () => {
        let seed = 5;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
        const tiers: OverlordTier[] = ['STRONG', 'BEST', 'CAUTION', 'LEGACY'];
        for (let trial = 0; trial < 60; trial += 1) {
            const book: Pick[] = [];
            const views: Record<string, OverlordView | null> = {};
            for (let m = 0; m < 6; m += 1)
                for (const d of ['OVER_2', 'UNDER_7'] as const) {
                    if (rnd() < 0.8) book.push(pick(`M${m}`, d, rnd() - 0.4));
                    const tier = tiers[Math.floor(rnd() * 4)];
                    views[`M${m}:${d === 'OVER_2' ? 'OVER:2' : 'UNDER:7'}`] = rnd() < 0.1 ? null : view(tier, Math.round(rnd() * 100), { thin: tier === 'LEGACY' });
                }
            // The board shows one contract per market, so COMBINED may show a different direction of a market than OVERLORD
            // does (the best one both engines accept). What must hold: only markets and contracts the picker offered, and a
            // market COMBINED trades is a market OVERLORD would trade.
            const board = (selection: ExecConfig['selection']) => {
                const h = harness({ selection }, {}, book);
                Object.assign(h.views, views);
                h.ex.start();
                return h.ex.getSnapshot().board.primary;
            };
            const std = board('STANDARD');
            const ovl = board('OVERLORD');
            const both = board('COMBINED');
            const offered = new Set(book.map(p => p.key));
            for (const row of [...ovl, ...both]) expect(offered.has(row.key)).toBe(true);
            const stdMarkets = new Set(std.map(p => p.market));
            const ovlMarkets = new Set(ovl.map(p => p.market));
            for (const p of ovl) expect(stdMarkets.has(p.market)).toBe(true);
            for (const p of both) expect(ovlMarkets.has(p.market)).toBe(true);
        }
    });
});
