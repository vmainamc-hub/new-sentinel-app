// The DTrader's run loop. One entry decision -> one burst of trades -> every trade settles on the same tick -> next entry.
//
// All outside dependencies (ticks, buying, contract updates, clock) come in through RunnerIO, so the whole loop, including the
// same-tick checks, is unit-tested without a network. The page wires RunnerIO to the app's Deriv socket and tick feed.

import { entrySlip, slipText, tickMoved } from '../auto-trader';
import { exitDigitFrom, type Fill,settlementText, syncReport } from '../bulk-run';
import { DEFAULT_BUY_MS, learnPace, tickIntervalMs } from '../burst-pace';
import { type Duration } from './dtrader-catalog';
import {
    describeEntry, entryError, type EntryRule, exposureError, FAMILIES, type Family, type Leg, legsFor, matchEntry, MAX_TRADES_PER_ENTRY, nextStake, offsetError, planBurst, predictionError, round2,
type SideChoice,
    stopReason, } from './dtrader-engine';
import { type Preflight, type PreflightInput } from './dtrader-preflight';
import { type Decision, defaultStrategyId, getStrategy, resolveParams, sigmaOffset, type StrategyParams } from './dtrader-strategies';

export type RunMode = 'single' | 'repeat';
export type RunnerState = 'idle' | 'waiting' | 'placing' | 'settling' | 'stopping';

export type RunConfig = {
    symbol: string;
    family: Family;
    side: SideChoice;
    prediction: number;
    /** Barrier distance from the entry spot (Higher/Lower, Ends Between/Outside). */
    offset: number;
    duration: number;
    stake: number;
    /** Trades per leg in one entry (the bulk size). */
    tradesPerEntry: number;
    martingale: number;
    takeProfit: number;
    stopLoss: number;
    mode: RunMode;
    entry: EntryRule;
    /** The Auto side's strategy (id from dtrader-strategies) and its settings. Defaults to the family's standard one. */
    strategy?: { id: string; params?: StrategyParams };
    /** Trim a burst so it all lands before the next tick. */
    sameTickGuard: boolean;
    currency: string;
};

export type TradeRow = {
    id: number;
    batch: number;
    time: string;
    label: string;
    stake: number;
    entrySpot: string;
    exitSpot: string;
    exitDigit: number | null;
    profit: number;
    state: 'open' | 'won' | 'lost' | 'failed';
    note?: string;
};

/** requested = trades asked for, contracts = trades actually bought, notSent = trades never sent (the same-tick guard trimmed them; no money used). */
export type Totals = { stake: number; payout: number; contracts: number; won: number; lost: number; failed: number; pnl: number; requested: number; notSent: number };
export const emptyTotals = (): Totals => ({ stake: 0, payout: 0, contracts: 0, won: 0, lost: 0, failed: 0, pnl: 0, requested: 0, notSent: 0 });

export type RunnerEvent =
    | { type: 'state'; state: RunnerState; note: string }
    | { type: 'journal'; text: string; level: 'info' | 'warn' | 'error' | 'success' }
    | { type: 'trade'; row: TradeRow }
    | { type: 'totals'; totals: Totals }
    | { type: 'sync'; text: string; ok: boolean | null };

export type MarketView = { digits: number[]; times: number[]; decimals: number; lastTickAt: number; prices?: number[] };

export type BuyParams = {
    amount: number; basis: 'stake'; contract_type: string; currency: string; underlying_symbol: string;
    duration: number; duration_unit: Duration['unit']; barrier?: string; barrier2?: string;
};

export interface RunnerIO {
    now(): number;
    market(symbol: string): MarketView | undefined;
    /** Called for every new tick of any market. Returns the unsubscribe function. */
    onTick(listener: (symbol: string) => void): () => void;
    buy(params: BuyParams, maxPrice: number): Promise<{ contract_id: number | string; buy_price?: number }>;
    onContractUpdate(listener: (contract: any) => void): () => void;
    isClosed(contract: any): boolean;
    digitAt(symbol: string, epochSeconds: number): number | null;
    sleep(ms: number): Promise<void>;
    /** Ask Deriv for a contract again (used when a closing update carried no exit tick). */
    lookupContract?(contractId: number): Promise<any>;
    /** Checks the contract against Deriv's rules and quotes before anything is bought (Higher/Lower, Ends Between/Outside). */
    preflight?(input: PreflightInput): Promise<Preflight>;
}

const SETTLE_WAIT_MS = 90_000;
/** If a contract has not reported a result by itself, ask Deriv about it directly at this pace. */
const POLL_AFTER_MS = 2500;
const POLL_BATCH = 25;
const DIAGNOSE_AFTER_MS = 8000;
const EXIT_LOOKUP_DELAYS_MS = [400, 1200, 2500, 4500];
const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const numOrNull = (value: unknown) => { const n = Number(value); return value !== undefined && value !== null && value !== '' && Number.isFinite(n) ? n : null; };
const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const errorText = (error: unknown) => (error instanceof Error ? error.message : (error as { message?: string })?.message || String(error));

export const configError = (cfg: RunConfig): string | null => {
    if (!cfg.symbol) return 'Pick a market first.';
    const entry = entryError(cfg.entry);
    if (entry) return entry;
    const prediction = cfg.side === 'auto' ? predictionError(cfg.family, 'both', cfg.prediction) : predictionError(cfg.family, cfg.side, cfg.prediction);
    if (prediction) return prediction;
    const offset = offsetError(cfg.family, cfg.offset);
    if (offset) return offset;
    if (!Number.isInteger(cfg.duration) || cfg.duration < 1 || cfg.duration > 10) return 'Ticks must be a whole number from 1 to 10.';
    if (!(cfg.stake > 0)) return 'Enter a stake.';
    if (!Number.isInteger(cfg.tradesPerEntry) || cfg.tradesPerEntry < 1 || cfg.tradesPerEntry > MAX_TRADES_PER_ENTRY) return `Trades per entry must be from 1 to ${MAX_TRADES_PER_ENTRY}.`;
    return null;
};

export class DTraderRunner {
    private running = false;
    private stopped = false;
    private cancelWait: (() => void) | null = null;
    private buyMs = DEFAULT_BUY_MS;
    /** What the preflight settled on for this run: the duration Deriv offers and the smallest barrier distance it accepts. */
    private resolved: { duration: Duration; offsetFloor: number } | null = null;
    private rowSeq = 0;
    private batchSeq = 0;
    totals: Totals = emptyTotals();

    constructor(private readonly io: RunnerIO, private readonly emit: (event: RunnerEvent) => void) {}

    get busy() { return this.running; }

    resetTotals() {
        this.totals = emptyTotals();
        this.emit({ type: 'totals', totals: { ...this.totals } });
    }

    /** No further purchases. Contracts already bought keep being monitored until they settle. */
    stop() {
        if (!this.running) return;
        this.stopped = true;
        this.cancelWait?.();
    }

    private state(state: RunnerState, note: string) { this.emit({ type: 'state', state, note }); }
    private log(textValue: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') { this.emit({ type: 'journal', text: textValue, level }); }
    private clock() { return new Date(this.io.now()).toLocaleTimeString(); }

    async run(cfg: RunConfig): Promise<void> {
        if (this.running) return;
        const bad = configError(cfg);
        if (bad) { this.log(bad, 'error'); this.state('idle', bad); return; }
        this.running = true;
        this.stopped = false;
        let stake = cfg.stake;
        let sessionPnl = 0;
        let waitNextTick = false;
        this.resolved = null;
        this.log(`Run started on ${cfg.symbol}. ${describeEntry(cfg.entry)}.`);
        try {
            if (!(await this.checkContract(cfg, stake))) return;
            while (!this.stopped) {
                const auto = cfg.side === 'auto';
                this.state('waiting', auto ? `Waiting for the ${this.strategyFor(cfg).title} signal…` : cfg.entry.mode === 'instant' ? 'Placing the next entry…' : `Waiting for the entry: ${describeEntry(cfg.entry)}.`);
                const entry = await this.waitForEntry(cfg, waitNextTick);
                waitNextTick = false;
                if (entry === null || this.stopped) break;
                if (auto && entry.decision.reason) this.log(entry.decision.reason);

                const outcome = await this.burst(cfg, stake, entry.at, entry.decision);
                if (outcome.kind === 'missed') { waitNextTick = true; continue; }
                if (outcome.kind === 'failed') break;
                sessionPnl = round2(sessionPnl + outcome.profit);
                stake = nextStake(cfg.stake, stake, outcome.profit, cfg.martingale);

                const reason = stopReason(sessionPnl, cfg.takeProfit, cfg.stopLoss);
                if (reason) { this.log(reason, 'warn'); break; }
                if (cfg.mode === 'single') break;
                if (stake !== cfg.stake) this.log(`Next stake ${stake.toFixed(2)} ${cfg.currency}.`);
            }
        } catch (error) {
            this.log(`Run stopped by an error: ${errorText(error)}`, 'error');
        } finally {
            this.running = false;
            this.cancelWait = null;
            this.state('idle', this.stopped ? 'Stopped.' : 'Run finished.');
            this.log(this.stopped ? 'Stopped. No more trades will be placed.' : 'Run finished.');
        }
    }

    private strategyFor(cfg: RunConfig) {
        const wanted = getStrategy(cfg.strategy?.id ?? '');
        return wanted && wanted.families.includes(cfg.family) ? wanted : getStrategy(defaultStrategyId(cfg.family))!;
    }

    /** The side (and digit / barrier distance) for the entry that just completed, or null when the strategy says wait. */
    private decide(cfg: RunConfig, view: MarketView): Decision | null {
        if (cfg.side !== 'auto') return { side: cfg.side === 'first' ? 0 : cfg.side === 'second' ? 1 : 'both', reason: '' };
        const strategy = this.strategyFor(cfg);
        return strategy.decide({
            family: cfg.family, digits: view.digits, prices: view.prices ?? [], prediction: cfg.prediction, offset: cfg.offset, ticks: cfg.duration,
            decimals: view.decimals, params: resolveParams(strategy, cfg.strategy?.id === strategy.id ? cfg.strategy.params : {}),
        });
    }

    /** Resolves with the epoch (ms) of the tick that completed the entry and what to trade, or null when stopped. */
    private waitForEntry(cfg: RunConfig, forceNextTick: boolean): Promise<{ at: number; decision: Decision } | null> {
        const attempt = (): { at: number; decision: Decision } | null => {
            const view = this.io.market(cfg.symbol);
            if (!view || !view.times.length || !matchEntry(view.digits, cfg.entry)) return null;
            const decision = this.decide(cfg, view);
            return decision ? { at: view.times[view.times.length - 1], decision } : null;
        };
        if (cfg.entry.mode === 'instant' && !forceNextTick) {
            const hit = attempt();
            if (hit) return Promise.resolve(hit);
        }
        return new Promise<{ at: number; decision: Decision } | null>(resolve => {
            let off: (() => void) | null = null;
            const done = (value: { at: number; decision: Decision } | null) => { off?.(); this.cancelWait = null; resolve(value); };
            this.cancelWait = () => done(null);
            off = this.io.onTick(symbol => {
                if (symbol !== cfg.symbol || this.stopped) return;
                const hit = attempt();
                if (hit) done(hit);
            });
            if (this.stopped) done(null);
        });
    }

    /**
     * Before the first trade of a run: for the contracts that carry a price barrier, ask Deriv what it offers on this market and
     * quote the setup. Refuses to start (nothing bought) when Deriv would not take it, and says why.
     */
    private async checkContract(cfg: RunConfig, stake: number): Promise<boolean> {
        if (!FAMILIES[cfg.family].needsOffset || !this.io.preflight) return true;
        const view = this.io.market(cfg.symbol);
        if (!view) { this.log('No live ticks for this market yet.', 'error'); return false; }
        const interval = tickIntervalMs(view.times);
        const checked = await this.io.preflight({
            symbol: cfg.symbol, family: cfg.family, side: cfg.side, prediction: cfg.prediction, offset: cfg.offset, ticks: cfg.duration, stake,
            currency: cfg.currency, decimals: view.decimals, tickSeconds: interval ? interval / 1000 : 1,
            volatilityOffset: view.prices?.length ? sigmaOffset(view.prices, cfg.duration, 1, view.decimals) : undefined,
        });
        if (!checked.ok) { this.log(checked.error, 'error'); this.log('Nothing was bought.'); return false; }
        checked.notes.forEach(note => this.log(note, 'warn'));
        this.resolved = { duration: checked.duration, offsetFloor: checked.offset };
        return true;
    }

    private async burst(cfg: RunConfig, stake: number, decidedAt: number, decision: Decision): Promise<{ kind: 'done'; profit: number } | { kind: 'missed' } | { kind: 'failed' }> {
        const view = this.io.market(cfg.symbol);
        if (!view) { this.log('No live ticks for this market yet.', 'error'); return { kind: 'failed' }; }
        const side = decision.side === 'both' ? 'both' : decision.side === 0 ? 'first' : 'second';
        const prediction = decision.prediction ?? cfg.prediction;
        // The barrier distance is never smaller than the one Deriv was found to accept at the start of the run.
        const offset = Math.max(this.resolved?.offsetFloor ?? 0, decision.offset ?? cfg.offset);
        const invalid = predictionError(cfg.family, side, prediction);
        if (invalid) { this.log(`${invalid} Skipping this entry.`, 'warn'); return { kind: 'missed' }; }
        const legs: Leg[] = legsFor(cfg.family, side, prediction, offset, view.decimals);
        const duration = this.resolved?.duration ?? { value: cfg.duration, unit: 't' as const };
        const interval = tickIntervalMs(view.times);
        const plan = planBurst({
            legs: legs.length, perLeg: cfg.tradesPerEntry, intervalMs: interval,
            elapsedMs: view.lastTickAt ? Math.max(0, this.io.now() - view.lastTickAt) : 0, perBuyMs: this.buyMs, guard: cfg.sameTickGuard,
        });
        const tooBig = exposureError(stake, plan.total);
        if (tooBig) { this.log(tooBig, 'error'); return { kind: 'failed' }; }
        // A newer tick printed since the entry was confirmed: this buy would enter a tick late, on a digit nobody checked.
        if (tickMoved(view.times, decidedAt)) {
            this.log('A new tick printed before the buy was sent. Nothing was bought. Checking the entry again.', 'warn');
            return { kind: 'missed' };
        }

        const batch = (this.batchSeq += 1);
        // Trades the guard trimmed are never sent to Deriv, so they cost nothing and can never settle later.
        this.totals = { ...this.totals, requested: this.totals.requested + plan.requestedTotal, notSent: this.totals.notSent + (plan.requestedTotal - plan.total) };
        this.emit({ type: 'totals', totals: { ...this.totals } });
        const owned = new Map<number, { rowId: number; leg: Leg }>();
        const settled = new Set<number>();
        const fills = new Map<number, Fill>();
        const lookups: Array<Promise<void>> = [];
        const rows = new Map<number, TradeRow>();
        let batchProfit = 0;

        const finishContract = (id: number, update: any) => {
            const owner = owned.get(id);
            if (!owner || settled.has(id)) return;
            settled.add(id);
            const profit = update.profit !== undefined && update.profit !== null && update.profit !== '' ? num(update.profit) : num(update.sold_for) - stake;
            const decimals = view.decimals;
            const exitDigit = exitDigitFrom(update, decimals, epoch => this.io.digitAt(cfg.symbol, epoch));
            fills.set(id, {
                contractId: id,
                entryTime: numOrNull(update.entry_tick_time ?? update.entry_spot_time),
                exitTime: numOrNull(update.exit_tick_time ?? update.exit_spot_time ?? update.sell_spot_time),
                exitDigit,
            });
            batchProfit = round2(batchProfit + profit);
            this.totals = {
                ...this.totals,
                payout: round2(this.totals.payout + Math.max(0, stake + profit)),
                pnl: round2(this.totals.pnl + profit),
                won: this.totals.won + (profit > 0 ? 1 : 0),
                lost: this.totals.lost + (profit > 0 ? 0 : 1),
            };
            const row: TradeRow = {
                ...(rows.get(id) as TradeRow),
                entrySpot: text(update.entry_tick_display_value ?? update.entry_spot_display_value ?? update.entry_tick ?? update.entry_spot),
                exitSpot: text(update.exit_tick_display_value ?? update.exit_spot_display_value ?? update.sell_spot_display_value ?? update.exit_tick ?? update.sell_spot),
                exitDigit, profit, state: profit > 0 ? 'won' : 'lost',
            };
            rows.set(id, row);
            this.emit({ type: 'trade', row });
            this.emit({ type: 'totals', totals: { ...this.totals } });
            if (exitDigit === null) lookups.push(this.resolveExitDigit(cfg, id, rows, fills, view.decimals));
        };

        const off = this.io.onContractUpdate(update => {
            const id = Math.trunc(Number(update?.contract_id));
            if (owned.has(id) && !settled.has(id) && this.io.isClosed(update)) finishContract(id, update);
        });

        try {
            this.state('placing', `Placing ${plan.total} trade${plan.total === 1 ? '' : 's'} together…`);
            if (plan.note) this.log(plan.note, 'warn');
            this.log(`Entry met on tick ${new Date(decidedAt).toLocaleTimeString()}. Sending ${plan.total} × ${legs.map(l => l.label).join(' + ')} at ${stake.toFixed(2)} ${cfg.currency} each.`);

            const arrivals: number[] = [];
            const sends: Array<Promise<{ ok: true } | { ok: false; leg: Leg; error: unknown }>> = [];
            for (const leg of legs) {
                for (let i = 0; i < plan.perLeg; i += 1) {
                    const params: BuyParams = {
                        amount: stake, basis: 'stake', contract_type: leg.contract, currency: cfg.currency, underlying_symbol: cfg.symbol,
                        duration: duration.value, duration_unit: duration.unit, ...(leg.barrier !== undefined ? { barrier: leg.barrier } : {}),
                        ...(leg.barrier2 !== undefined ? { barrier2: leg.barrier2 } : {}),
                    };
                    sends.push(this.io.buy(params, stake).then(bought => {
                        arrivals.push(this.io.now());
                        const id = Math.trunc(Number(bought.contract_id));
                        const rowId = (this.rowSeq += 1);
                        owned.set(id, { rowId, leg });
                        this.totals = { ...this.totals, stake: round2(this.totals.stake + stake), contracts: this.totals.contracts + 1 };
                        const row: TradeRow = { id: rowId, batch, time: this.clock(), label: leg.label, stake, entrySpot: '', exitSpot: '', exitDigit: null, profit: 0, state: 'open' };
                        rows.set(id, row);
                        this.emit({ type: 'trade', row });
                        this.emit({ type: 'totals', totals: { ...this.totals } });
                        return { ok: true as const };
                    }, error => ({ ok: false as const, leg, error })));
                }
            }
            const results = await Promise.all(sends);
            this.buyMs = learnPace(this.buyMs, arrivals);

            const failures = results.filter((r): r is { ok: false; leg: Leg; error: unknown } => !r.ok);
            failures.forEach(failure => {
                this.totals = { ...this.totals, failed: this.totals.failed + 1 };
                this.emit({
                    type: 'trade',
                    row: { id: (this.rowSeq += 1), batch, time: this.clock(), label: failure.leg.label, stake, entrySpot: '', exitSpot: '', exitDigit: null, profit: 0, state: 'failed', note: errorText(failure.error) },
                });
            });
            if (failures.length) {
                this.emit({ type: 'totals', totals: { ...this.totals } });
                this.log(`${failures.length} of ${plan.total} purchases failed: ${errorText(failures[0].error)}`, 'error');
            }
            if (owned.size === 0) return { kind: 'failed' };

            this.state('settling', `Placed ${owned.size}/${plan.total}. Waiting for them to settle…`);
            const startedAt = this.io.now();
            const deadline = startedAt + SETTLE_WAIT_MS;
            let lastPoll = startedAt;
            let announced = false;
            const reported = new Set<number>();
            while (settled.size < owned.size && this.io.now() < deadline) {
                await this.io.sleep(250);
                // Safety net: the live settlement stream normally reports each result. If any contract is still silent, ask Deriv
                // about it directly, and say plainly what Deriv returned if it still does not look finished.
                if (!this.io.lookupContract || this.io.now() - lastPoll < POLL_AFTER_MS) continue;
                lastPoll = this.io.now();
                const pending = [...owned.keys()].filter(id => !settled.has(id)).slice(0, POLL_BATCH);
                if (!pending.length) continue;
                if (!announced) {
                    announced = true;
                    this.log(`${pending.length} bought contract(s) are waiting for their result. Confirming with Deriv directly…`);
                }
                await Promise.all(pending.map(async id => {
                    try {
                        const update = await this.io.lookupContract!(id);
                        if (!update) return;
                        if (this.io.isClosed(update)) finishContract(id, { ...update, contract_id: id });
                        else if (!reported.has(id) && this.io.now() - startedAt >= DIAGNOSE_AFTER_MS) {
                            reported.add(id);
                            this.log(`Contract ${id} still reads status "${text(update.status)}" (is_sold ${text(update.is_sold)}, is_expired ${text(update.is_expired)}, exit tick ${text(update.exit_tick_time ?? update.exit_spot_time) || 'none'}).`, 'warn');
                        }
                    } catch (error) {
                        if (!reported.has(id)) { reported.add(id); this.log(`Could not read contract ${id} from Deriv: ${errorText(error)}`, 'warn'); }
                    }
                }));
            }
            await Promise.allSettled(lookups);

            const list = [...fills.values()];
            const report = syncReport(list);
            const times = view.times;
            const note = [settlementText(list), slipText(list.map(fill => entrySlip(times, decidedAt, fill.entryTime)))].filter(Boolean).join(' ');
            this.emit({ type: 'sync', text: note, ok: list.length ? report.synced : null });
            const open = owned.size - settled.size;
            if (open > 0) this.log(`${open} contract(s) are still open. They stay on your Deriv account; check the statement.`, 'warn');
            else this.log(`Batch ${batch}: ${owned.size} settled · P/L ${batchProfit.toFixed(2)} ${cfg.currency}. ${note}`, report.synced ? 'success' : 'warn');
            return { kind: 'done', profit: batchProfit };
        } finally {
            off();
        }
    }

    /** The closing update did not carry the exit tick yet: ask Deriv again and re-read the tick history until it shows. */
    private async resolveExitDigit(cfg: RunConfig, id: number, rows: Map<number, TradeRow>, fills: Map<number, Fill>, decimals: number) {
        for (const delay of EXIT_LOOKUP_DELAYS_MS) {
            await this.io.sleep(delay);
            let digit: number | null = null;
            try {
                const update = await this.io.lookupContract?.(id);
                if (update) digit = exitDigitFrom(update, decimals, epoch => this.io.digitAt(cfg.symbol, epoch));
                const fill = fills.get(id);
                if (digit === null && fill?.exitTime) digit = this.io.digitAt(cfg.symbol, fill.exitTime);
                if (digit !== null && update) {
                    const row = rows.get(id);
                    if (row) {
                        const next = { ...row, exitDigit: digit, exitSpot: row.exitSpot || text(update.exit_tick_display_value ?? update.exit_spot_display_value ?? '') };
                        rows.set(id, next);
                        this.emit({ type: 'trade', row: next });
                    }
                    if (fill) fills.set(id, { ...fill, exitDigit: digit, exitTime: fill.exitTime ?? numOrNull(update.exit_tick_time ?? update.exit_spot_time) });
                    return;
                }
            } catch { /* try the next delay */ }
        }
    }
}
