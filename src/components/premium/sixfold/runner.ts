// SIXFOLD AUTO: the autonomous runner.
//
// Press Run and Sixfold scans every market, arms the best eligible contract, waits for its entry digit, buys, waits for
// the result, then goes looking again, one trade at a time, across all markets. It owns the Run Panel session the same
// way Auto Trades and Sentinel AI do: every purchase and settlement is pushed to the transactions / run-panel / summary
// stores, so the trades show in the general transactions area, and the Run Panel's own Stop button ends the session.
//
// It is a singleton service (not tied to the page), so a session keeps running while you look at other tabs.
// All I/O is injected, which keeps it unit-testable.
import { contract_stages } from '@/constants/contract-stage';
import type { RunnerStores, StoreWatcher } from '@/pages/sentinel-ai/sentinel-ai-runner';
import { describeTradeFailure } from '@/utils/trade-errors';
import { type FeedMode, type FeedSnapshot, marketName } from './feed';
import {
    applyResult,
    DERIV_CONTRACT_TYPE,
    freshSession,
    normalizeSettings,
    type SessionStats,
    type SixfoldSettings,
    stopReason,
    tradeContract,
} from './money';
import { type Cell, eligibility, pickBest, type ScanResult, scanMarkets } from './scanner';

export const MODULE_ID = 'sixfold';

const SCAN_MS = 1500;
const LOG_LIMIT = 60;
const TRADE_LIMIT = 40;
const EMIT_THROTTLE_MS = 120;
const COOLDOWN_MS = 1000;
const MAX_CONSECUTIVE_BUY_ERRORS = 3;
const BLOCK_TTL_MS = 5 * 60_000;
const EXPIRED_BLOCK_MS = 20_000;
const MAX_SKIPS_IN_A_ROW = 6;
const MAX_MARKET_REFUSALS = 2;
const RETRY_COOLDOWN_MS = 3_000;
/** The armed market must have printed a tick this recently, or it is not traded. */
const FRESH_TICK_MS = 5_000;
/** Give up waiting for the feed to come up after this long. */
const FEED_WAIT_MS = 25_000;
/** Minimum ticks a market needs before it is scanned for trading. */
export const MIN_TICKS = 300;

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Phase = 'idle' | 'connecting' | 'scanning' | 'armed' | 'buying' | 'settling' | 'cooling';

export type Armed = {
    symbol: string;
    name: string;
    label: string;
    score: number;
    edgePts: number | null;
    significant: boolean;
    entryDigits: number[];
    why: string;
    since: number;
    expiresAt: number;
    cellKey: string;
};

export type TradeRecord = {
    contractId: number;
    symbol: string;
    name: string;
    label: string;
    recovery: boolean;
    entryDigit: number | null;
    stake: number;
    profit: number | null;
    status: 'open' | 'won' | 'lost' | 'unconfirmed';
    score: number;
    at: number;
};

export type LogKind = 'info' | 'pick' | 'trade' | 'win' | 'loss' | 'warn';
export type LogLine = { id: number; at: number; kind: LogKind; text: string };

export type SixfoldSnapshot = {
    running: boolean;
    phase: Phase;
    session: SessionStats;
    settings: SixfoldSettings;
    armed: Armed | null;
    scan: ScanResult | null;
    /** Best candidates with the reason each is or is not eligible. */
    queue: Array<{ cell: Cell; ok: boolean; reason: string }>;
    trades: TradeRecord[];
    log: LogLine[];
    lastError: string | null;
    stopReason: string | null;
    feed: { mode: FeedMode; status: FeedSnapshot['status']; error: string };
    /** Markets that have enough ticks to be scanned. */
    readyMarkets: number;
    quarantined: string[];
};

export type RunnerIO = {
    feed: {
        getLiveSeries: () => Record<string, readonly number[]>;
        getLastTickAt: (symbol: string) => number | null;
        getLastDigit: (symbol: string) => number | null;
        isLive: () => boolean;
        getSnapshot: () => FeedSnapshot;
        connect: () => void;
    };
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
    afterStop: () => void;
    now: () => number;
    loadSettings: () => SixfoldSettings;
    saveSettings: (settings: SixfoldSettings) => void;
};

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export class SixfoldRunner {
    private stores: RunnerStores | null = null;
    private watchStores: StoreWatcher | null = null;
    private disposeStoreWatch: (() => void) | null = null;

    private settings: SixfoldSettings;
    private running = false;
    private runToken = 0;
    private session: SessionStats;
    private armed: Armed | null = null;
    private scan: ScanResult | null = null;
    private scanAt = 0;
    private queue: SixfoldSnapshot['queue'] = [];
    private tradeInFlight = false;
    private settling = false;
    private cooldownUntil = 0;
    private buyErrors = 0;
    private skipStreak = 0;
    private waitingSince = 0;
    private lastError: string | null = null;
    private stopMessage: string | null = null;
    private trades: TradeRecord[] = [];
    private log: LogLine[] = [];
    private logSeq = 0;
    private blocked = new Map<string, number>();
    private refusals = new Map<string, number>();
    private quarantined = new Set<string>();
    private aborts = new Set<AbortController>();
    private listeners = new Set<() => void>();
    private emitTimer: ReturnType<typeof setTimeout> | null = null;
    private retainCount = 0;
    private snap: SixfoldSnapshot;

    constructor(private io: RunnerIO) {
        this.settings = normalizeSettings(io.loadSettings());
        this.session = freshSession(this.settings);
        this.snap = this.build();
    }

    // ---- wiring ----
    attach(stores: RunnerStores, watchStores?: StoreWatcher) {
        this.stores = stores;
        this.watchStores = watchStores ?? null;
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    getSnapshot = () => this.snap;
    isRunning = () => this.running;

    /** The page asks for live scans while it is open, even when no session is running. Returns the release function. */
    retainScan = () => {
        this.retainCount += 1;
        this.refreshScan(true);
        this.emit();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.retainCount = Math.max(0, this.retainCount - 1);
        };
    };

    updateSettings(patch: Partial<SixfoldSettings>) {
        this.settings = normalizeSettings({ ...this.settings, ...patch });
        this.io.saveSettings(this.settings);
        if (!this.running) this.session = freshSession(this.settings);
        else if (this.session.consecutiveLosses === 0) {
            this.session = { ...this.session, currentStake: freshSession(this.settings).currentStake };
        }
        this.refreshScan(true);
        this.emit();
    }

    // ---- lifecycle ----
    start() {
        if (this.running) return;
        if (!this.stores) {
            this.lastError = 'Sixfold is still starting. Try again in a moment.';
            return this.emit();
        }
        if (!this.io.isAuthorized()) {
            this.lastError = 'Please log in to your Deriv account before trading.';
            return this.emit();
        }
        if (this.settings.markets.length === 0) {
            this.lastError = 'Pick at least one market to scan.';
            return this.emit();
        }
        const { run_panel, dashboard } = this.stores;
        try {
            const other = dashboard.active_trading_module;
            if (other && other !== MODULE_ID) dashboard.stopActiveTradingModule();
        } catch {
            /* a failing foreign stop handler must not block Run */
        }

        this.lastError = null;
        this.stopMessage = null;
        this.buyErrors = 0;
        this.skipStreak = 0;
        this.cooldownUntil = 0;
        this.blocked.clear();
        this.refusals.clear();
        this.quarantined.clear();
        this.armed = null;
        this.session = freshSession(this.settings);
        this.runToken += 1;
        this.running = true;
        this.waitingSince = this.io.now();
        this.addLog('info', 'Run pressed: scanning every market.');

        try {
            run_panel.setIsRunning(true);
            run_panel.setRunId(`run-${this.io.now()}`);
            run_panel.setContractStage?.(contract_stages.RUNNING);
            run_panel.toggleDrawer(true);
        } catch {
            /* optional run-panel mount failures are ignored */
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

        if (!this.io.feed.isLive()) {
            this.addLog('info', 'Connecting to the live market feed.');
            this.io.feed.connect();
        }
        this.emit();
        this.tick();
    }

    stop(reason = 'Stopped') {
        if (!this.running) return;
        this.running = false;
        this.runToken += 1;
        this.stopMessage = reason;
        this.tradeInFlight = false;
        this.settling = false;
        this.armed = null;
        this.aborts.forEach(c => c.abort());
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
                /* optional run-panel cleanup failures are ignored */
            }
        }
        try {
            this.io.afterStop();
        } catch {
            /* optional bot-skeleton cleanup failures are ignored */
        }
        this.addLog('warn', reason);
        this.emit();
    }

    // ---- the loop ----
    /** Called about twice a second by the app (and directly by tests). */
    tick() {
        const now = this.io.now();
        if (!this.running) {
            if (this.retainCount > 0) this.refreshScan();
            return;
        }
        if (!this.io.isAuthorized()) return this.stop('Disconnected from Deriv');
        if (!this.io.feed.isLive()) {
            if (now - this.waitingSince > FEED_WAIT_MS) {
                return this.stop(this.io.feed.getSnapshot().error || 'The market feed did not come up.');
            }
            return this.emit();
        }
        this.waitingSince = now;
        this.refreshScan();
        if (this.tradeInFlight || now < this.cooldownUntil || !this.scan) return;

        // Expire an armed contract that never saw its entry digit.
        if (this.armed && now >= this.armed.expiresAt) {
            this.addLog('info', `${this.armed.label} on ${this.armed.name} waited ${this.settings.waitSeconds}s for its entry digit; moving on.`);
            this.blocked.set(`${this.armed.symbol}|${this.armed.cellKey}`, now + EXPIRED_BLOCK_MS);
            this.armed = null;
        }
        // Keep the armed contract while it stays eligible; otherwise look again.
        if (this.armed) {
            const cell = this.scan.cells.find(c => c.symbol === this.armed!.symbol && c.key === this.armed!.cellKey);
            const verdict = cell ? eligibility(cell, this.settings.selectivity) : null;
            if (!cell || !verdict?.ok) {
                this.addLog('info', `${this.armed.label} on ${this.armed.name} dropped: ${verdict?.reason ?? 'no longer scanned'}.`);
                this.armed = null;
            } else {
                this.armed = { ...this.armed, score: cell.score, edgePts: cell.edgePts, significant: cell.significant };
            }
        }
        if (!this.armed) this.armBest(now);
        this.emit();
    }

    /** Every live tick of every market. Fires the trade when the armed market prints an entry digit. */
    handleFeedTick(symbol: string, digit: number) {
        if (!this.running || this.tradeInFlight || !this.armed || this.armed.symbol !== symbol) return;
        if (this.io.now() < this.cooldownUntil) return;
        if (this.settings.entry === 'SETUP' && !this.armed.entryDigits.includes(digit)) return;
        void this.execute(digit);
    }

    private armBest(now: number) {
        if (!this.scan) return;
        const skipKeys = new Set<string>();
        this.blocked.forEach((until, key) => {
            if (until > now) skipKeys.add(key);
            else this.blocked.delete(key);
        });
        const pick = pickBest(this.scan, this.settings.selectivity, { mode: this.settings.entry }, {
            symbols: this.quarantined,
            keys: skipKeys,
        });
        if (!pick) return;
        const { cell } = pick;
        this.armed = {
            symbol: cell.symbol,
            name: marketName(cell.symbol),
            label: cell.label,
            score: cell.score,
            edgePts: cell.edgePts,
            significant: cell.significant,
            entryDigits: pick.entryDigits,
            why: pick.why,
            since: now,
            expiresAt: now + this.settings.waitSeconds * 1000,
            cellKey: cell.key,
        };
        const entry =
            this.settings.entry === 'ANY' ? 'buying on the next tick' : `waiting for digit ${pick.entryDigits.join(' / ')}`;
        this.addLog(
            'pick',
            `Armed ${cell.label} on ${marketName(cell.symbol)} (score ${cell.score}, ${fmtPts(cell.edgePts)} vs break-even${cell.significant ? ', significant' : ''}): ${entry}.`
        );
        if (this.settings.entry === 'ANY') {
            const digit = this.io.feed.getLastDigit(cell.symbol);
            if (digit !== null) void this.execute(digit);
        }
    }

    private refreshScan(force = false) {
        const now = this.io.now();
        if (!force && this.scan && now - this.scanAt < SCAN_MS) return;
        const series = this.io.feed.getLiveSeries();
        const symbols = this.settings.markets.filter(s => (series[s]?.length ?? 0) >= MIN_TICKS);
        this.scan = scanMarkets(
            series,
            symbols,
            { duration: this.settings.duration, entry: { mode: this.settings.entry }, margin: this.settings.margin },
            now
        );
        this.scanAt = now;
        this.queue = this.scan.cells
            .filter(c => c.executable && !this.quarantined.has(c.symbol))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map(cell => ({ cell, ...eligibility(cell, this.settings.selectivity) }));
        this.scheduleEmit();
    }

    // ---- trade ----
    private pushContract(data: Loose) {
        if (!this.stores) return;
        try {
            const { transactions, run_panel, summary_card } = this.stores;
            transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
            run_panel.onBotContractEvent(data);
            summary_card.onBotContractEvent(data);
        } catch {
            /* observer emit failures are ignored */
        }
    }

    private async execute(entryDigit: number | null) {
        const armed = this.armed;
        if (!armed || this.tradeInFlight || !this.scan) return;
        const lastTick = this.io.feed.getLastTickAt(armed.symbol);
        if (lastTick === null || this.io.now() - lastTick > FRESH_TICK_MS) return; // never trade on a stale market
        const cell = this.scan.cells.find(c => c.symbol === armed.symbol && c.key === armed.cellKey);
        if (!cell) return;

        const token = this.runToken;
        const stake = this.session.currentStake;
        const bought = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings);
        const contractType = DERIV_CONTRACT_TYPE[bought.contract.side];
        if (!contractType) return;
        const currency = this.stores?.client?.currency || this.io.currency() || 'USD';
        const startedAt = Math.floor(this.io.now() / 1000);
        const hasBarrier = bought.contract.side === 'OVER' || bought.contract.side === 'UNDER';

        this.tradeInFlight = true;
        this.settling = false;
        this.emit();

        const parameters: Loose = {
            amount: stake,
            basis: 'stake',
            contract_type: contractType,
            currency,
            duration: this.settings.duration,
            duration_unit: 't',
            symbol: armed.symbol,
            ...(hasBarrier ? { barrier: String(bought.contract.param) } : {}),
        };
        const baseContract: Loose = {
            display_name: armed.symbol,
            underlying_symbol: armed.symbol,
            shortcode: `SIXFOLD_${contractType}_${armed.symbol}`,
            contract_type: contractType,
            currency,
            date_start: startedAt,
            verification_id: `${armed.symbol}_${startedAt}_${Math.random().toString(36).slice(2, 11)}`,
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
            const record: TradeRecord = {
                contractId,
                symbol: armed.symbol,
                name: armed.name,
                label: bought.label,
                recovery: bought.recovery,
                entryDigit,
                stake,
                profit: null,
                status: 'open',
                score: armed.score,
                at: this.io.now(),
            };
            this.trades = [record, ...this.trades].slice(0, TRADE_LIMIT);
            this.addLog(
                'trade',
                `Bought ${bought.label}${bought.recovery ? ' (recovery)' : ''} on ${armed.name}, stake ${stake.toFixed(2)}${entryDigit === null ? '' : `, entry digit ${entryDigit}`}.`
            );
            if (token !== this.runToken) {
                this.tradeInFlight = false;
                return; // stopped while buying: the purchase is on the deck, but the run is over
            }
            this.settling = true;
            this.emit();
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
                return this.finishTrade(contractId, null);
            }
            this.finishTrade(contractId, profit);
        } catch (error) {
            this.aborts.delete(abort);
            this.tradeInFlight = false;
            this.settling = false;
            if (token !== this.runToken) return;
            if (contractId) {
                this.lastError = 'Lost track of the open contract; its result was not recorded. Check your Deriv statement.';
                return this.finishTrade(contractId, null);
            }
            const failure = describeTradeFailure(error);
            this.lastError = failure.message;
            // A purchase was sent and never answered: it may exist. Never retry; stop and say so.
            if (failure.outcomeUnknown || failure.kind === 'fatal') return this.stop(`Stopped: ${failure.message}`);
            // Deriv explicitly refused this contract: nothing was bought. Take it out for a while, keep going.
            if (failure.kind === 'rejected') return this.skipArmed(armed, failure.message);
            this.buyErrors += 1;
            this.cooldownUntil = this.io.now() + RETRY_COOLDOWN_MS;
            if (this.buyErrors >= MAX_CONSECUTIVE_BUY_ERRORS) {
                return this.stop(`Stopped after ${this.buyErrors} failed attempts: ${failure.message}`);
            }
            this.addLog('warn', failure.message);
            this.emit();
        }
    }

    private skipArmed(armed: Armed, message: string) {
        this.blocked.set(`${armed.symbol}|${armed.cellKey}`, this.io.now() + BLOCK_TTL_MS);
        const n = (this.refusals.get(armed.symbol) ?? 0) + 1;
        this.refusals.set(armed.symbol, n);
        if (n >= MAX_MARKET_REFUSALS) {
            this.quarantined.add(armed.symbol);
            this.addLog('warn', `${armed.name} taken out for this session: Deriv refused it ${n} times.`);
        }
        this.skipStreak += 1;
        this.armed = null;
        this.addLog('warn', `Skipped ${armed.label} on ${armed.name}: ${message}`);
        if (this.skipStreak >= MAX_SKIPS_IN_A_ROW) {
            return this.stop(`Stopped: Deriv refused ${this.skipStreak} contracts in a row. Last: ${message}`);
        }
        this.emit();
    }

    /** `profit === null` means the result could not be confirmed: counted as a trade, never as a win or loss. */
    private finishTrade(contractId: number, profit: number | null) {
        this.tradeInFlight = false;
        this.settling = false;
        this.armed = null;
        this.cooldownUntil = this.io.now() + COOLDOWN_MS;
        const trade = this.trades.find(t => t.contractId === contractId);
        if (profit === null) {
            this.session = { ...this.session, trades: this.session.trades + 1 };
            if (trade) trade.status = 'unconfirmed';
        } else {
            this.session = applyResult(this.session, profit, this.settings);
            if (trade) {
                trade.profit = profit;
                trade.status = profit < 0 ? 'lost' : 'won';
            }
            this.addLog(
                profit < 0 ? 'loss' : 'win',
                `${trade?.label ?? 'Contract'} on ${trade?.name ?? ''} ${profit < 0 ? 'lost' : 'won'} ${fmtMoney(profit)}. Session ${fmtMoney(this.session.pnl)}.`
            );
        }
        const reason = stopReason(this.session, this.settings);
        if (reason) return this.stop(reason);
        this.emit();
    }

    // ---- snapshot ----
    private addLog(kind: LogKind, text: string) {
        this.log = [{ id: ++this.logSeq, at: this.io.now(), kind, text }, ...this.log].slice(0, LOG_LIMIT);
    }

    private phase(): Phase {
        if (!this.running) return 'idle';
        if (!this.io.feed.isLive()) return 'connecting';
        if (this.tradeInFlight) return this.settling ? 'settling' : 'buying';
        if (this.io.now() < this.cooldownUntil) return 'cooling';
        return this.armed ? 'armed' : 'scanning';
    }

    private build(): SixfoldSnapshot {
        const series = this.io.feed.getLiveSeries();
        const f = this.io.feed.getSnapshot();
        return {
            running: this.running,
            phase: this.phase(),
            session: this.session,
            settings: this.settings,
            armed: this.armed,
            scan: this.scan,
            queue: this.queue,
            trades: this.trades,
            log: this.log,
            lastError: this.lastError,
            stopReason: this.stopMessage,
            feed: { mode: f.mode, status: f.status, error: f.error },
            readyMarkets: this.settings.markets.filter(s => (series[s]?.length ?? 0) >= MIN_TICKS).length,
            quarantined: [...this.quarantined],
        };
    }

    private emit() {
        if (this.emitTimer) {
            clearTimeout(this.emitTimer);
            this.emitTimer = null;
        }
        this.snap = this.build();
        this.listeners.forEach(l => l());
    }

    private scheduleEmit() {
        if (this.emitTimer) return;
        this.emitTimer = setTimeout(() => {
            this.emitTimer = null;
            this.emit();
        }, EMIT_THROTTLE_MS);
    }
}

const fmtPts = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)} pts`);
const fmtMoney = (x: number) => `${x >= 0 ? '+' : ''}${round2(x).toFixed(2)}`;
