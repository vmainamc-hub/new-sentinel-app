// SENTINEL AI — signal runner (execution layer).
//
// Mirrors how Auto Trades runs: Run starts a session on the Run Panel ("main deck"), every purchase and
// settlement is pushed to the same transactions / run-panel / summary stores, and Stop (or the Run Panel's
// own Stop button) ends it. The difference is the trigger: instead of its own digit-streak scan, it takes
// the Sentinel engine's surfaced signal, waits for the signal's ENTRY DIGIT to print on that market, then buys.
//
// It is a singleton service (not tied to a mounted page), so a session keeps running while you look at
// other tabs. All I/O is injected, which keeps it unit-testable.
import { contract_stages } from '@/constants/contract-stage';
import { describeTradeFailure } from '@/utils/trade-errors';
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { SentinelAiEngine } from './sentinel-ai-engine-types';
import { initialStakeState, nextStakeState, requiredEntryDigit, sessionStopReason } from './sentinel-ai-money';
import { toSentinelAiSignal } from './sentinel-ai-signal';
import {
    DEFAULT_SETTINGS,
    type ActiveSignalState,
    type EngineInfo,
    type SentinelAiSettings,
    type SentinelAiSignal,
    type SentinelAiSnapshot,
    type SessionStats,
    type SignalOutcome,
    type SignalRecord,
    type TradeRecord,
    normalizeSettings,
} from './sentinel-ai-types';

export const MODULE_ID = 'sentinel_ai';

const HISTORY_LIMIT = 25;
const TRADE_LIMIT = 40;
const LOOP_MS = 1000;
const EMIT_THROTTLE_MS = 120;
const MAX_CONSECUTIVE_BUY_ERRORS = 3;
/** A contract Deriv refused stays out of the feed for this long (market hours / offerings change, so not forever). */
const BLOCK_TTL_MS = 5 * 60_000;
/** Stop (instead of looping silently) when Deriv refuses this many signals in a row without a single purchase. */
const MAX_SKIPS_IN_A_ROW = 6;
/** Pause after a transient failure so Immediate mode cannot hammer the API. */
const RETRY_COOLDOWN_MS = 3_000;

type Loose = Record<string, any>;

export interface RunPanelLike {
    run_id?: string;
    is_contract_buying_in_progress: boolean;
    setIsRunning: (value: boolean) => void;
    setRunId: (id: string) => void;
    setContractStage?: (stage: number) => void;
    toggleDrawer: (open: boolean) => void;
    setHasOpenContract?: (value: boolean) => void;
    setShowBotStopMessage?: (value: boolean) => void;
    onBotContractEvent: (data: Loose) => void;
}

export interface RunnerStores {
    /** Account currency source (same one Auto Trades reads). Falls back to USD when unavailable. */
    client?: { currency?: string };
    run_panel: RunPanelLike;
    summary_card: { onBotContractEvent: (data: Loose) => void };
    transactions: { pushTransaction: (data: Loose) => void };
    dashboard: {
        active_trading_module: string | null;
        setActiveTradingModule: (id: string | null) => void;
        registerTradingStopHandler: (id: string, handler: () => void) => void;
        unregisterTradingStopHandler: (id: string) => void;
        stopActiveTradingModule: () => void;
    };
}

export type StoreWatcher = (onChange: (runPanelRunning: boolean, activeModule: string | null) => void) => () => void;

export type RunnerIO = {
    engine: SentinelAiEngine;
    buy: (args: { parameters: Loose; price: number }) => Promise<{
        buy_price: number;
        contract_id: number;
        transaction_id: number;
    }>;
    settle: (args: {
        contractId: number;
        fallback: Loose;
        onUpdate: (contract: Loose) => void;
        signal: AbortSignal;
    }) => Promise<Loose>;
    isAuthorized: () => boolean;
    currency: () => string;
    /** Clears bot-skeleton running flags after a stop (same cleanup Auto Trades performs). */
    afterStop: () => void;
    /** Non-audio alerts for a new signal. */
    alert: (signal: SentinelAiSignal, settings: SentinelAiSettings) => void;
    now: () => number;
    loadSettings: () => SentinelAiSettings;
    saveSettings: (settings: SentinelAiSettings) => void;
};

type ActiveSignal = {
    signal: SentinelAiSignal;
    runsDone: number;
    runsTotal: number;
    expiresAt: number;
    pnl: number;
    expired: boolean;
    done: boolean;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

const EMPTY_ENGINE: EngineInfo = {
    status: 'idle',
    online: 0,
    total: 0,
    degraded: false,
    failsafes: [],
    dangerLabel: 'CALM',
};

export class SentinelAiRunner {
    private readonly io: RunnerIO;
    private stores: RunnerStores | null = null;
    private watchStores: StoreWatcher | null = null;
    private disposeStoreWatch: (() => void) | null = null;

    private settings: SentinelAiSettings;
    private session: SessionStats;
    private engineInfo: EngineInfo = EMPTY_ENGINE;

    private listeners = new Set<() => void>();
    private snapshot: SentinelAiSnapshot;
    private emitTimer: ReturnType<typeof setTimeout> | null = null;

    private watchers = 0;
    private running = false;
    private runToken = 0;
    private releaseEngine: (() => void) | null = null;
    private releaseTick: (() => void) | null = null;
    private loopTimer: ReturnType<typeof setInterval> | null = null;

    private active: ActiveSignal | null = null;
    private pending: SentinelAiSignal | null = null;
    private lastKey: string | null = null;
    private tradeInFlight = false;
    private buyErrors = 0;
    private skipStreak = 0;
    private cooldownUntil = 0;
    /** `${symbol}|${contractId}` -> time the block lapses. Cells Deriv refused this session. */
    private blocked = new Map<string, number>();
    private aborts = new Set<AbortController>();

    private history: SignalRecord[] = [];
    private trades: TradeRecord[] = [];
    private lastError: string | null = null;
    private stopReason: string | null = null;
    private alertSeq = 0;

    constructor(io: RunnerIO) {
        this.io = io;
        this.settings = normalizeSettings(io.loadSettings(), DEFAULT_SETTINGS);
        this.session = this.freshSession();
        this.snapshot = this.buildSnapshot();
    }

    // ── subscription (useSyncExternalStore-compatible) ───────────────────────────────────────────
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getSnapshot = () => this.snapshot;

    // ── wiring ───────────────────────────────────────────────────────────────────────────────────
    attach(stores: RunnerStores, watchStores?: StoreWatcher) {
        this.stores = stores;
        this.watchStores = watchStores ?? null;
    }

    /** Keeps the engine analysing and the signal feed live (e.g. while the Sentinel AI page is open). */
    watch = () => {
        this.watchers += 1;
        this.ensureEngine();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.watchers = Math.max(0, this.watchers - 1);
            this.maybeShutdown();
        };
    };

    isRunning() {
        return this.running;
    }

    updateSettings(patch: Partial<SentinelAiSettings>) {
        this.settings = normalizeSettings({ ...this.settings, ...patch }, this.settings);
        this.io.saveSettings(this.settings);
        if (!this.running) this.session = this.freshSession();
        this.emit();
    }

    // ── run lifecycle (mirrors Auto Trades' handleRun / stopTrading) ─────────────────────────────
    start() {
        if (this.running) return;
        if (!this.stores) {
            this.lastError = 'Sentinel AI is still starting. Try again in a moment.';
            this.emit();
            return;
        }
        if (!this.io.isAuthorized()) {
            this.lastError = 'Please log in to your Deriv account before trading.';
            this.emit();
            return;
        }

        const { run_panel, dashboard } = this.stores;

        // Only one trading module may own the Run Panel at a time.
        try {
            const other = dashboard.active_trading_module;
            if (other && other !== MODULE_ID) dashboard.stopActiveTradingModule();
        } catch {
            // Ignore a failing foreign stop handler.
        }

        this.lastError = null;
        this.stopReason = null;
        this.buyErrors = 0;
        this.skipStreak = 0;
        this.cooldownUntil = 0;
        this.blocked.clear();
        this.session = this.freshSession();
        this.runToken += 1;
        this.running = true;

        try {
            run_panel.setIsRunning(true);
            run_panel.setRunId(`run-${this.io.now()}`);
            run_panel.setContractStage?.(contract_stages.RUNNING);
            run_panel.toggleDrawer(true);
        } catch {
            // Ignore optional run-panel mount failures.
        }
        dashboard.setActiveTradingModule(MODULE_ID);
        dashboard.registerTradingStopHandler(MODULE_ID, () => this.stop('Stopped from the Run Panel'));

        this.disposeStoreWatch?.();
        this.disposeStoreWatch =
            this.watchStores?.((runPanelRunning, activeModule) => {
                if (!this.running) return;
                if (!runPanelRunning) this.stop('Stopped from the Run Panel');
                else if (activeModule && activeModule !== MODULE_ID) {
                    this.stop('Another trading module took over the Run Panel');
                }
            }) ?? null;

        this.ensureEngine();

        // A signal that is already live and still inside its wait window is traded straight away.
        if (this.active && !this.active.done && !this.active.expired) {
            this.active.runsTotal = this.settings.runsPerSignal;
            this.active.runsDone = 0;
            this.active.pnl = 0;
            const record = this.history.find(r => r.signal.id === this.active?.signal.id);
            if (record && record.outcome === 'WATCHED') record.outcome = 'ACTIVE';
        }
        this.emit();
        this.tryImmediate();
    }

    stop(reason = 'Stopped') {
        if (!this.running) return;
        this.running = false;
        this.runToken += 1;
        this.stopReason = reason;
        this.tradeInFlight = false;
        this.aborts.forEach(controller => controller.abort());
        this.aborts.clear();
        this.disposeStoreWatch?.();
        this.disposeStoreWatch = null;

        if (this.stores) {
            const { run_panel, dashboard } = this.stores;
            dashboard.unregisterTradingStopHandler(MODULE_ID);
            if (dashboard.active_trading_module === MODULE_ID) dashboard.setActiveTradingModule(null);
            try {
                run_panel.is_contract_buying_in_progress = false;
                run_panel.setIsRunning(false);
                run_panel.setHasOpenContract?.(false);
                run_panel.setContractStage?.(contract_stages.NOT_RUNNING);
                run_panel.setShowBotStopMessage?.(false);
            } catch {
                // Ignore optional run-panel cleanup failures.
            }
        }
        try {
            this.io.afterStop();
        } catch {
            // Ignore optional bot-skeleton cleanup failures.
        }

        // Close out the signal that was being worked so the history reads correctly.
        if (this.active) {
            const record = this.history.find(r => r.signal.id === this.active?.signal.id);
            if (record && record.outcome === 'ACTIVE') record.outcome = record.runsDone > 0 ? 'TRADED' : 'STOPPED';
        }
        this.maybeShutdown();
        this.emit();
    }

    /** Test / teardown helper. */
    dispose() {
        this.stop('Disposed');
        this.watchers = 0;
        this.maybeShutdown();
        this.listeners.clear();
    }

    // ── engine feed ──────────────────────────────────────────────────────────────────────────────
    private ensureEngine() {
        if (this.releaseEngine) return;
        this.releaseEngine = this.io.engine.retain();
        this.releaseTick = this.io.engine.onTick(symbol => this.onTick(symbol));
        this.loopTimer = setInterval(() => this.loop(), LOOP_MS);
        this.loop();
    }

    private maybeShutdown() {
        if (this.watchers > 0 || this.running) return;
        if (this.loopTimer) clearInterval(this.loopTimer);
        this.loopTimer = null;
        this.releaseTick?.();
        this.releaseTick = null;
        this.releaseEngine?.();
        this.releaseEngine = null;
        if (this.emitTimer) clearTimeout(this.emitTimer);
        this.emitTimer = null;
    }

    private loop() {
        try {
            const sample = this.io.engine.sample((symbol, contractId) => this.isBlocked(`${symbol}|${contractId}`));
            this.engineInfo = sample.info;
            this.ingest(sample.surfaced);
        } catch (error) {
            this.engineInfo = { ...this.engineInfo, degraded: true, failsafes: ['ENGINE ERROR'] };
            this.lastError = error instanceof Error ? error.message : 'Sentinel engine sample failed.';
        }
        this.checkExpiry();
        this.emit();
        this.tryImmediate();
    }

    private isBlocked(key: string) {
        const until = this.blocked.get(key);
        if (until === undefined) return false;
        if (this.io.now() >= until) {
            this.blocked.delete(key);
            return false;
        }
        return true;
    }

    /** One NEW signal event per newly surfaced market × contract cell (same rule the Forge used). */
    private ingest(surfaced: RankedOpportunity | null) {
        if (!surfaced) {
            this.lastKey = null;
            return;
        }
        const incoming = toSentinelAiSignal(surfaced, this.io.now());
        if (incoming.key !== this.lastKey) {
            this.lastKey = incoming.key;
            this.onNewSignal(incoming);
            return;
        }
        // Same cell still surfaced: refresh the entry point the engine currently recommends, unless a
        // trade is already in flight on it.
        const active = this.active;
        if (active && active.signal.key === incoming.key && !active.done && !this.tradeInFlight) {
            active.signal = { ...incoming, id: active.signal.id, receivedAt: active.signal.receivedAt };
            const record = this.history.find(r => r.signal.id === active.signal.id);
            if (record) record.signal = active.signal;
        }
    }

    private onNewSignal(signal: SentinelAiSignal) {
        this.alertSeq += 1;
        try {
            this.io.alert(signal, this.settings);
        } catch {
            // Alerts are best effort.
        }

        if (this.running && this.tradeInFlight && this.active && !this.active.done) {
            // Never abandon an in-flight trade. The newest signal waits its turn.
            this.pending = signal;
            this.pushHistory({ signal, outcome: 'ACTIVE', runsDone: 0, pnl: 0 });
            return;
        }
        this.activate(signal);
    }

    private activate(signal: SentinelAiSignal) {
        this.closeActive('REPLACED');
        this.pending = null;
        this.active = {
            signal,
            runsDone: 0,
            runsTotal: this.settings.runsPerSignal,
            expiresAt: this.io.now() + this.settings.signalWaitSeconds * 1000,
            pnl: 0,
            expired: false,
            done: false,
        };
        const existing = this.history.find(r => r.signal.id === signal.id);
        if (!existing) this.pushHistory({ signal, outcome: this.running ? 'ACTIVE' : 'WATCHED', runsDone: 0, pnl: 0 });
    }

    /** Marks the current signal's final outcome when something else takes its place. */
    private closeActive(fallbackOutcome: SignalOutcome) {
        const active = this.active;
        if (!active) return;
        const record = this.history.find(r => r.signal.id === active.signal.id);
        if (record && record.outcome === 'ACTIVE') {
            record.outcome = active.runsDone > 0 ? 'TRADED' : fallbackOutcome;
        }
        if (record && record.outcome === 'WATCHED') record.outcome = 'WATCHED';
    }

    private checkExpiry() {
        const active = this.active;
        if (!active || active.done || active.expired || this.tradeInFlight) return;
        if (this.io.now() < active.expiresAt) return;
        active.expired = true;
        const record = this.history.find(r => r.signal.id === active.signal.id);
        if (record && record.outcome === 'ACTIVE') record.outcome = active.runsDone > 0 ? 'TRADED' : 'EXPIRED';
        if (this.pending) this.activate(this.pending);
    }

    private pushHistory(record: SignalRecord) {
        this.history = [record, ...this.history].slice(0, HISTORY_LIMIT);
    }

    // ── entry trigger ────────────────────────────────────────────────────────────────────────────
    private requiredDigit(): number | null {
        if (!this.active || this.settings.executionMode === 'immediate') return null;
        return requiredEntryDigit(this.active.signal.entryDigit, this.session.consecutiveLosses, this.settings);
    }

    private onTick(symbol: string) {
        const active = this.active;
        if (!active || active.signal.symbol !== symbol) {
            return;
        }
        this.scheduleEmit();
        if (this.settings.executionMode === 'immediate') {
            this.tryImmediate();
            return;
        }
        if (!this.running || this.tradeInFlight || active.done || active.expired) return;
        if (this.io.now() >= active.expiresAt) {
            this.checkExpiry();
            return;
        }
        const required = this.requiredDigit();
        if (required === null) return; // The engine has not validated an entry digit — never invented.
        const digit = this.io.engine.getLastDigit(symbol);
        if (digit === null || digit !== required) return;
        void this.execute(required);
    }

    /**
     * Immediate mode: trade the live signal right away instead of waiting for its entry digit. Still never trades
     * blind: it holds off while a trade is in flight, during a retry cool-down, or while the engine reports that its
     * market feed is stale.
     */
    private tryImmediate() {
        if (!this.running || this.settings.executionMode !== 'immediate') return;
        const active = this.active;
        if (!active || active.done || active.expired || this.tradeInFlight) return;
        if (this.io.now() < this.cooldownUntil) return;
        if (this.io.now() >= active.expiresAt) {
            this.checkExpiry();
            return;
        }
        if (this.engineInfo.failsafes.includes('FEED STALE')) return;
        void this.execute(active.signal.entryDigit);
    }

    // ── trade ────────────────────────────────────────────────────────────────────────────────────
    private pushContract(data: Loose) {
        if (!this.stores) return;
        try {
            const { transactions, run_panel, summary_card } = this.stores;
            transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
            run_panel.onBotContractEvent(data);
            summary_card.onBotContractEvent(data);
        } catch {
            // Ignore observer emit failures.
        }
    }

    private async execute(entryDigit: number | null) {
        const active = this.active;
        if (!active) return;
        const token = this.runToken;
        const signal = active.signal;
        const stake = this.session.currentStake;
        const currency = this.stores?.client?.currency || this.io.currency() || 'USD';
        const startedAt = Math.floor(this.io.now() / 1000);
        const verificationId = `${signal.symbol}_${startedAt}_${Math.random().toString(36).slice(2, 11)}`;

        this.tradeInFlight = true;
        this.emit();

        const parameters: Loose = {
            amount: stake,
            basis: 'stake',
            contract_type: signal.contractType,
            currency,
            duration: 1,
            duration_unit: 't',
            symbol: signal.symbol,
            barrier: String(signal.barrier),
        };

        const baseContract: Loose = {
            display_name: signal.symbol,
            underlying_symbol: signal.symbol,
            shortcode: `SENTINEL_${signal.contractType}_${signal.symbol}`,
            contract_type: signal.contractType,
            currency,
            date_start: startedAt,
            verification_id: verificationId,
        };

        let contractId = 0;
        const abort = new AbortController();
        try {
            const buy = await this.io.buy({ parameters, price: stake });
            contractId = buy.contract_id;
            this.buyErrors = 0;
            this.skipStreak = 0;
            const opened: Loose = {
                ...baseContract,
                buy_price: buy.buy_price,
                contract_id: buy.contract_id,
                transaction_ids: { buy: buy.transaction_id },
            };
            this.pushContract(opened);
            this.recordTrade({
                contractId,
                signalId: signal.id,
                symbol: signal.symbol,
                label: signal.label,
                entryDigit,
                stake,
                profit: null,
                status: 'open',
                at: this.io.now(),
            });

            if (token !== this.runToken) {
                this.tradeInFlight = false;
                return; // Stopped while buying: the purchase is on the deck, but the run is over.
            }

            this.aborts.add(abort);
            const settled = await this.io.settle({
                contractId,
                fallback: opened,
                onUpdate: snapshot => {
                    if (token === this.runToken) this.pushContract(snapshot);
                },
                signal: abort.signal,
            });
            this.aborts.delete(abort);
            if (token !== this.runToken) {
                this.tradeInFlight = false;
                return;
            }

            const isFinal =
                Boolean(settled.is_sold) || ['won', 'lost', 'sold'].includes(String(settled.status ?? '').toLowerCase());
            const profit = Number(settled.profit);
            if (!isFinal || !Number.isFinite(profit)) {
                this.lastError = 'Contract result was not confirmed in time; stake settings were left unchanged.';
                this.finishTrade(contractId, null, active);
                return;
            }
            this.finishTrade(contractId, profit, active);
        } catch (error) {
            this.aborts.delete(abort);
            this.tradeInFlight = false;
            if (token !== this.runToken) return;
            // The purchase went through but something after it failed: never count that as a failed buy.
            if (contractId) {
                this.lastError = 'Lost track of the open contract; its result was not recorded. Check your Deriv statement.';
                this.finishTrade(contractId, null, active);
                return;
            }
            const failure = describeTradeFailure(error);
            this.lastError = failure.message;

            // A purchase was sent and never answered: it may exist. Never retry; stop and tell the user.
            if (failure.outcomeUnknown || failure.kind === 'fatal') {
                this.stop(`Stopped: ${failure.message}`);
                return;
            }
            // Deriv explicitly refused this contract (nothing was bought): drop the signal, keep the session alive.
            if (failure.kind === 'rejected') {
                this.skipSignal(active, failure.message);
                return;
            }
            this.buyErrors += 1;
            this.cooldownUntil = this.io.now() + RETRY_COOLDOWN_MS;
            if (this.buyErrors >= MAX_CONSECUTIVE_BUY_ERRORS) {
                this.stop(`Stopped after ${this.buyErrors} failed attempts: ${failure.message}`);
                return;
            }
            this.emit();
        }
    }

    /** Deriv refused this exact contract. Block it for a while so the next-best signal can surface. */
    private skipSignal(active: ActiveSignal, message: string) {
        const { signal } = active;
        this.blocked.set(signal.key, this.io.now() + BLOCK_TTL_MS);
        this.skipStreak += 1;
        active.done = true;
        const record = this.history.find(r => r.signal.id === signal.id);
        if (record) record.outcome = 'SKIPPED';
        this.lastError = `Skipped ${signal.label} on ${signal.marketName}: ${message}`;
        if (this.skipStreak >= MAX_SKIPS_IN_A_ROW) {
            this.stop(`Stopped: Deriv refused ${this.skipStreak} signals in a row. Last: ${message}`);
            return;
        }
        if (this.pending) this.activate(this.pending);
        this.emit();
    }

    private recordTrade(trade: TradeRecord) {
        this.trades = [trade, ...this.trades].slice(0, TRADE_LIMIT);
    }

    /** `profit === null` means the result could not be confirmed: counted as a trade, never as a win/loss. */
    private finishTrade(contractId: number, profit: number | null, active: ActiveSignal) {
        this.tradeInFlight = false;
        const trade = this.trades.find(t => t.contractId === contractId);

        this.session = { ...this.session, trades: this.session.trades + 1 };
        if (profit !== null) {
            const pnl = round2(this.session.pnl + profit);
            const next = nextStakeState(this.session, profit, pnl, this.settings);
            this.session = {
                ...this.session,
                pnl,
                wins: this.session.wins + (profit < 0 ? 0 : 1),
                losses: this.session.losses + (profit < 0 ? 1 : 0),
                currentStake: next.currentStake,
                consecutiveLosses: next.consecutiveLosses,
                martingaleStep: next.martingaleStep,
            };
            active.pnl = round2(active.pnl + profit);
            if (trade) {
                trade.profit = profit;
                trade.status = profit < 0 ? 'lost' : 'won';
            }
        }
        active.runsDone += 1;
        const record = this.history.find(r => r.signal.id === active.signal.id);
        if (record) {
            record.runsDone = active.runsDone;
            record.pnl = active.pnl;
        }

        const reason = sessionStopReason(this.session, this.settings);
        if (reason) {
            if (record && record.outcome === 'ACTIVE') record.outcome = 'TRADED';
            this.stop(reason);
            return;
        }

        if (active.runsDone >= active.runsTotal) {
            active.done = true;
            if (record) record.outcome = 'TRADED';
            if (this.pending) this.activate(this.pending);
        } else {
            // More runs for this signal: give the next entry its own wait window.
            active.expiresAt = this.io.now() + this.settings.signalWaitSeconds * 1000;
        }
        this.emit();
        this.tryImmediate();
    }

    // ── snapshot ─────────────────────────────────────────────────────────────────────────────────
    private freshSession(): SessionStats {
        const stake = initialStakeState(this.settings);
        return { pnl: 0, trades: 0, wins: 0, losses: 0, ...stake };
    }

    private scheduleEmit() {
        if (this.emitTimer) return;
        this.emitTimer = setTimeout(() => {
            this.emitTimer = null;
            this.emit();
        }, EMIT_THROTTLE_MS);
    }

    private emit() {
        this.snapshot = this.buildSnapshot();
        this.listeners.forEach(listener => listener());
    }

    private buildSnapshot(): SentinelAiSnapshot {
        const active = this.active;
        const required = this.requiredDigit();
        let signalState: ActiveSignalState | null = null;
        if (active) {
            if (active.done) signalState = 'DONE';
            else if (active.expired) signalState = 'EXPIRED';
            else if (this.tradeInFlight) signalState = 'TRADING';
            else if (!this.running) signalState = 'WATCHING';
            else if (this.settings.executionMode === 'immediate') signalState = 'READY';
            else signalState = required === null ? 'NO_ENTRY_DIGIT' : 'WAITING_ENTRY';
        }
        const secondsLeft =
            active && !active.done && !active.expired
                ? Math.max(0, Math.ceil((active.expiresAt - this.io.now()) / 1000))
                : 0;

        return {
            status: this.running ? 'RUNNING' : this.watchers > 0 ? 'WATCHING' : 'IDLE',
            engine: this.engineInfo,
            signal: active ? active.signal : null,
            signalState,
            requiredDigit: required,
            recovering: this.settings.recoveryDigitEnabled && this.session.consecutiveLosses > 0,
            lastDigit: active ? this.io.engine.getLastDigit(active.signal.symbol) : null,
            runsDone: active ? active.runsDone : 0,
            runsTotal: active ? active.runsTotal : this.settings.runsPerSignal,
            secondsLeft,
            session: this.session,
            history: this.history,
            trades: this.trades,
            lastError: this.lastError,
            stopReason: this.stopReason,
            alertSeq: this.alertSeq,
            settings: this.settings,
        };
    }
}
