// SIXFOLD AUTO: the autonomous runner.
//
// Press Run and Sixfold scans every market and buys one contract at a time, across all markets. Two ways of choosing it:
//   FIRST (default): every contract that passes the rules on every market is watched at once, and the first one to show its
//                    entry is bought. More markets means more chances, with exactly the same rules.
//   BEST:            the single highest-scoring contract is armed and only its entry is waited for.
// Either way it then waits for the result and goes looking again. It owns the Run Panel session the same
// way Auto Trades and Sentinel AI do: every purchase and settlement is pushed to the transactions / run-panel / summary
// stores, so the trades show in the general transactions area, and the Run Panel's own Stop button ends the session.
//
// It is a singleton service (not tied to the page), so a session keeps running while you look at other tabs.
// All I/O is injected, which keeps it unit-testable.
import { contract_stages } from '@/constants/contract-stage';
import { describeTradeFailure } from '@/utils/trade-errors';
import { type Contract, contractKey, winningDigits, winProbability } from './bot';
import { formGateOk, smartEntryDigits } from './entry';
import { type ArmId, type BrainReport, brainReport, choosePlan, fallbackPlan, findCell, type Plan, planFires } from './entry-brain';
import { expectedTickSeconds, type FeedMode, type FeedSnapshot, marketName } from './feed';
import { climateOf, IDLE_STATUS, type MeterCall, meterCall, type MeterStatus } from './meter-guide';
import {
    applyResult,
    applyWriteOff,
    DEFAULT_SETTINGS,
    DERIV_CONTRACT_TYPE,
    freshSession,
    normalizeSettings,
    primaryContracts,
    type SessionStats,
    type SixfoldSettings,
    stakeFor,
    stopReason,
    tradeContract,
} from './money';
import { type RunnerOverlay, type TradeNotice } from './overlay';
import { losingSidePressure, multiWindowGate, multiWindowHealth, pressureGate, winningSideGate, winningSidePressure } from './pressure';
import { computeRegime, regimeCell, type RegimeSummary } from './regime';
import { type Cell, eligibility, type OffersFn, type Pick, pickBest, rankedPicks, type ScanResult, scanMarkets } from './scanner';
import { mulberry32, profitMultiple } from './stats';
import type { RunnerStores, StoreWatcher } from './stores';
import { streakRead } from './streak-guard';
import { freshVh, vhAfterReal, vhAfterVirtual, type VhConfig, type VhState } from './virtual-hook';

export const MODULE_ID = 'sixfold';

const BRAIN_REFRESH_MS = 8000;
/** An armed contract tries a different entry plan this many times before its wait window ends. */
const PLAN_ROTATIONS = 3;
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
/** A rested market comes back after this long even if too few other trades happened. */
const REST_MAX_MS = 5 * 60_000;
/** Extra score asked for right after a loss, and how fast it fades while nothing qualifies. */
const PICKY_BUMP = 10;
const PICKY_FADE_MS = 15_000;
/** An armed contract is only dropped for score when it falls this far under the bar it was armed at, so it does not flap. */
const ARMED_HYSTERESIS = 4;
/** A contract found cold at the moment of purchase is left alone for this long. */
const COLD_AT_BUY_BLOCK_MS = 10_000;
/** The armed market must have printed a tick this recently, or it is not traded. */
const FRESH_TICK_MS = 5_000;
/** Give up waiting for the feed to come up after this long. */
const FEED_WAIT_MS = 25_000;
/** The watchlist is announced in the log at most this often, so a changing list does not flood it. */
const WATCH_LOG_MS = 20_000;
/** Minimum ticks a market needs before it is scanned for trading. */
export const MIN_TICKS = 300;

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Phase = 'idle' | 'connecting' | 'scanning' | 'watching' | 'armed' | 'buying' | 'settling' | 'cooling';

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
    /** The Entry Brain's plan for this trade, when the Brain is in charge of the entry. */
    plan: Plan | null;
    planTried: ArmId[];
    planAt: number;
};

export type TradeRecord = {
    contractId: number;
    symbol: string;
    name: string;
    label: string;
    recovery: boolean;
    entryDigit: number | null;
    /** Entry Brain plan this trade was bought on, and the win rate a blind entry had on that market and contract. */
    plan: ArmId | null;
    baseRate: number | null;
    /** The last digit of the settlement tick, when Deriv reported it. */
    exitDigit: number | null;
    stake: number;
    profit: number | null;
    status: 'open' | 'won' | 'lost' | 'unconfirmed';
    /** A paper trade from the Virtual Hook: settled on real ticks, no money staked, not counted in the session. */
    virtual?: boolean;
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
    /** First-to-qualify mode: every contract being watched for its entry right now, best score first. */
    watching: Armed[];
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
    /** Markets Deriv would not stream; they are left out of every scan. */
    unavailable: string[];
    /** Markets resting after a loss, with the trades left before they return. */
    resting: Array<{ symbol: string; name: string; tradesLeft: number }>;
    /** Extra score currently asked for because of the latest loss. */
    pickyBump: number;
    /** The Meter: the regime each market and contract is in, and the overall verdict. */
    regime: RegimeSummary | null;
    /** The Meter guide: the climate and the extra score bar it currently asks for. */
    meterGuide: MeterStatus;
    /** The Entry Brain's latest replay of every market, or null when it has not been needed yet. */
    brain: BrainReport | null;
    virtualHook: VirtualHookStatus;
    /** Where every contract of the latest scan stood (see ScanFunnel). Null before the first scan. */
    funnel: ScanFunnel | null;
    /** The rules engine's reading of every market, or null when this runner uses the scanner. */
    rules: {
        rows: RuleRow[];
        paper: boolean;
        paperLosses: number;
        paperNeeded: number;
        paperPending: string | null;
        paperTrades: PaperTrade[];
        paperWon: number;
        paperLost: number;
    } | null;
};

/** One market's reading by a rules engine (Vanguard's bot rules): the checks, and the first thing still missing. */
export type RuleRow = {
    symbol: string;
    /** Which contract family this reading is for: Under (the bot's rules) or Over (the same rules mirrored). */
    side: 'UNDER' | 'OVER';
    name: string;
    ready: boolean;
    score: number | null;
    checks: Array<{ key: string; label: string; ok: boolean }>;
    entry: boolean;
    waitingOn: string;
    lastDigit: number | null;
};
/** A paper trade: a signal that was recorded and resolved on the next tick instead of being bought (the bot's virtual hook). */
export type PaperTrade = {
    id: number;
    symbol: string;
    side: 'UNDER' | 'OVER';
    barrier: number;
    label: string;
    entryDigit: number | null;
    exitDigit: number | null;
    status: 'open' | 'won' | 'lost' | 'void';
    at: number;
};
export type PaperEvent = { phase: 'open' | 'settle'; trade: PaperTrade };
export type RuleOutcome = { enter: boolean; side?: 'UNDER' | 'OVER'; events: string[]; paper?: PaperEvent[] };
/**
 * An external signal source. When one is supplied, it - not the scanner - decides when a market is bought: it sees every tick of
 * every market and answers "enter now" or not. Everything after that (which contract, the stake, the buy, the result, the limits,
 * one trade at a time, stale-tick and refusal handling) is this runner's, exactly as in Sixfold.
 */
export type RulesEngine = {
    reset: () => void;
    onTick: (
        symbol: string,
        series: readonly number[],
        ctx: {
            live: boolean;
            idle: boolean;
            now: number;
            /** The barrier each side would really trade right now (its recovery barrier while a loss is open). */
            barriers: Record<'UNDER' | 'OVER', number>;
            /** Sides Deriv refused on this market, which must not be tried again for a while. */
            refused: Record<'UNDER' | 'OVER', boolean>;
        }
    ) => RuleOutcome;
    onResult: (won: boolean) => void;
    board: (symbols: readonly string[], nameOf: (symbol: string) => string) => RuleRow[];
    paperState: () => { paper: boolean; losses: number; needed: number; pending: string | null; trades: PaperTrade[]; won: number; lost: number };
};

export type VirtualHookStatus = {
    on: boolean;
    /** Opening spell of this Run: paper until the first paper win. */
    opening: boolean;
    /** The next trades are paper trades. */
    virtual: boolean;
    /** A paper trade is open right now. */
    open: boolean;
    realLosses: number;
    virtualWins: number;
    virtualDone: number;
    mode: 'STREAK' | 'FIXED';
    enterLosses: number;
    returnWins: number;
    fixedCount: number;
    paper: { trades: number; wins: number; pnl: number };
};

type VirtualOpen = { id: number; symbol: string; contract: Contract; stake: number; remaining: number; at: number };
const VIRTUAL_ID_BASE = 9_000_000_000_000;
const VIRTUAL_TIMEOUT_MS = 120_000;

/** Where every contract of the latest scan stood on the way to a trade: the answer to "why is nothing being bought?". */
export type ScanFunnel = {
    at: number;
    /** Every market x contract the scan scored. */
    cells: number;
    /** Contracts the runner can buy (not quarantined). */
    tradable: number;
    resting: number;
    /** Refused by the losing-side pressure / multi-window / winning-side guards, in total and by guard. */
    guarded: number;
    guardedPressure: number;
    guardedWindow: number;
    guardedWinning: number;
    /** Refused by the Meter guide (a loss cluster or a Meter floor). */
    meterVeto: number;
    /** Refused by the engine overlay (Sentinel AI / Fusion do not back it). */
    overlayVeto: number;
    /** Allowed by everything above but the score is under the bar it needs. */
    belowBar: number;
    /** Clear of every check above. */
    eligible: number;
    /** Of the eligible: dropped by the win-streak guard (too many losses lately), and ready to buy now (a full run of wins). */
    streakDropped: number;
    streakReady: number;
    /** The win-streak guard is switched on. */
    streakGate: boolean;
    /** Most common reasons, normalised, with how many contracts each stopped. */
    reasons: Array<{ reason: string; count: number }>;
};

export type RunnerIO = {
    feed: {
        getLiveSeries: () => Record<string, readonly number[]>;
        getLastTickAt: (symbol: string) => number | null;
        getLastDigit: (symbol: string) => number | null;
        getLastEpoch?: (symbol: string) => number | null;
        isLive: () => boolean;
        getSnapshot: () => FeedSnapshot;
        connect: () => void;
        /** Does Deriv offer this contract type on this market? null = not known yet. */
        isOffered?: (symbol: string, contractType: string) => boolean | null;
        getUnavailable?: () => string[];
    };
    /** Run Panel module id. Each tool has its own, so two tools can never trade at once. Default: 'sixfold'. */
    moduleId?: string;
    /** Display name used in messages. Default: Sixfold. */
    name?: string;
    /** The defaults this runner normalises its settings against. Default: Sixfold's. */
    defaults?: SixfoldSettings;
    /** Optional external signal source (Vanguard's bot rules). Without it the runner scans and arms as Sixfold always has. */
    rules?: RulesEngine;
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
    /** Another tool's second opinion on every step (Sentinel AI). Absent for Sixfold itself. */
    overlay?: RunnerOverlay;
};

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** How long a contract the overlay's mandatory rule held back is left alone before it can be armed again. */
const OVERLAY_HOLD_BLOCK_MS = 5000;

export class SixfoldRunner {
    private stores: RunnerStores | null = null;
    private watchStores: StoreWatcher | null = null;
    private disposeStoreWatch: (() => void) | null = null;

    private settings: SixfoldSettings;
    private running = false;
    private runToken = 0;
    private session: SessionStats;
    private armed: Armed | null = null;
    /** First-to-qualify mode: contracts being watched for their entry, keyed `symbol|contract`. */
    private watch = new Map<string, Armed>();
    private watchSig = '';
    private watchLogAt = 0;
    private scan: ScanResult | null = null;
    private brain: BrainReport | null = null;
    private brainAt = 0;
    private rng: () => number;
    private scanAt = 0;
    private queue: SixfoldSnapshot['queue'] = [];
    private funnel: ScanFunnel | null = null;
    private tradeInFlight = false;
    private settling = false;
    private cooldownUntil = 0;
    private vh: VhState = freshVh();
    /** This Run opened on paper and has not had its first paper win yet. */
    private opening = false;
    /** Markets that have printed a tick since Run. Nothing is bought on a tick that printed before Run. */
    private seenTick = new Set<string>();
    private virtualOpen: VirtualOpen | null = null;
    private virtualCount = 0;
    private paper = { trades: 0, wins: 0, pnl: 0 };
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
    /** Loss shield: per market, when it may be traded again and its current run of losses. */
    private rest = new Map<string, { untilTrades: number; untilAt: number; streak: number }>();
    /** Entry digit of the last losing trade on a market, left out the next time it is armed. */
    private lastLossEntry = new Map<string, number>();
    private lastResultAt = 0;
    private regime: RegimeSummary | null = null;
    /** Market/contract pairs currently refused by the pressure and multi-window gates. */
    private guards = new Map<string, string>();
    /** The Meter's read of the contracts that will actually be bought next (the recovery barriers after a loss). */
    private tradeRegime: RegimeSummary | null = null;
    /** Start of the wait the Meter's extra bar fades over: Run, or the last result. */
    private meterSince = 0;
    private aborts = new Set<AbortController>();
    private listeners = new Set<() => void>();
    private emitTimer: ReturnType<typeof setTimeout> | null = null;
    private retainCount = 0;
    private snap: SixfoldSnapshot;
    /** What was armed and bought for each open trade, kept for the overlay's settle notice. */
    private notices = new Map<number, TradeNotice>();

    private readonly defaults: SixfoldSettings;

    constructor(private io: RunnerIO) {
        this.defaults = io.defaults ?? DEFAULT_SETTINGS;
        this.settings = normalizeSettings(io.loadSettings(), this.defaults);
        this.session = freshSession(this.settings);
        this.rng = mulberry32(Math.floor(io.now()) ^ 0x9e3779b9);
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

    private get moduleId() {
        return this.io.moduleId ?? this.io.overlay?.moduleId ?? MODULE_ID;
    }
    private get name() {
        return this.io.overlay?.name ?? this.io.name ?? 'Sixfold';
    }
    /** The contracts scanned and traded: the overlay's, or the Over / Under switched on in the settings. */
    private contractList(): Contract[] {
        return this.io.overlay ? this.io.overlay.contracts(this.settings) : primaryContracts(this.settings);
    }

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
        const before = this.settings.execution;
        this.settings = normalizeSettings({ ...this.settings, ...patch }, this.defaults);
        if (this.settings.execution !== before) {
            this.watch.clear();
            this.watchSig = '';
            if (!this.tradeInFlight) this.armed = null;
        }
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
            this.lastError = `${this.name} is still starting. Try again in a moment.`;
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
        if (this.contractList().length === 0) {
            this.lastError = this.io.overlay ? `${this.name} needs at least one contract switched on.` : 'Switch on Over or Under: Sixfold needs at least one contract to trade.';
            return this.emit();
        }
        const { run_panel, dashboard } = this.stores;
        try {
            const other = dashboard.active_trading_module;
            if (other && other !== this.moduleId) dashboard.stopActiveTradingModule();
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
        this.rest.clear();
        this.lastLossEntry.clear();
        // A Run starts from nothing: no scan, Brain read, guard or Meter state left over from before Run or from older settings.
        this.scan = null;
        this.scanAt = 0;
        this.brain = null;
        this.brainAt = 0;
        this.guards = new Map();
        this.seenTick.clear();
        // Vanguard (bot rules): with the Virtual Hook on, every Run opens on paper and goes real after its first paper win.
        this.opening = this.settings.vhOpening || (Boolean(this.io.rules) && this.settings.virtualHook);
        this.vh = this.opening ? { virtual: true, realLosses: 0, virtualWins: 0, virtualDone: 0 } : freshVh();
        this.virtualOpen = null;
        this.paper = { trades: 0, wins: 0, pnl: 0 };
        this.notices.clear();
        this.lastResultAt = 0;
        this.meterSince = this.io.now();
        this.armed = null;
        this.watch.clear();
        this.watchSig = '';
        this.session = freshSession(this.settings);
        this.runToken += 1;
        this.running = true;
        try {
            this.io.overlay?.onStart?.(this.io.now());
        } catch {
            /* an overlay failure must never stop a session from starting */
        }
        this.waitingSince = this.io.now();
        this.io.rules?.reset();
        this.addLog('info', this.io.rules ? 'Run pressed: watching every market for the bot rules.' : this.opening ? 'Run pressed: scanning every market. The first trade is a paper trade; real trading starts after its first win.' : 'Run pressed: scanning every market.');

        try {
            run_panel.setIsRunning(true);
            run_panel.setRunId(`run-${this.io.now()}`);
            run_panel.setContractStage?.(contract_stages.RUNNING);
            run_panel.toggleDrawer(true);
        } catch {
            /* optional run-panel mount failures are ignored */
        }
        dashboard.setActiveTradingModule(this.moduleId);
        dashboard.registerTradingStopHandler(this.moduleId, () => this.stop('Stopped from the Run Panel'));
        this.disposeStoreWatch?.();
        this.disposeStoreWatch =
            this.watchStores?.((runPanelRunning, activeModule) => {
                if (!this.running) return;
                if (!runPanelRunning) this.stop('Stopped from the Run Panel');
                else if (activeModule && activeModule !== this.moduleId) {
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
        this.virtualOpen = null;
        this.armed = null;
        this.watch.clear();
        this.aborts.forEach(c => c.abort());
        this.aborts.clear();
        this.disposeStoreWatch?.();
        this.disposeStoreWatch = null;
        if (this.stores) {
            const { run_panel, dashboard } = this.stores;
            dashboard.unregisterTradingStopHandler(this.moduleId);
            if (dashboard.active_trading_module === this.moduleId) dashboard.setActiveTradingModule(null);
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
            if (this.retainCount > 0) {
                this.refreshScan();
                if (this.io.rules) this.emit(); // keep the rules board live before Run is pressed
            }
            return;
        }
        if (!this.io.isAuthorized()) return this.stop('Disconnected from Deriv');
        if (this.virtualOpen && now - this.virtualOpen.at > VIRTUAL_TIMEOUT_MS) {
            const v = this.virtualOpen;
            this.virtualOpen = null;
            const t = this.trades.find(x => x.contractId === v.id);
            if (t) t.status = 'unconfirmed';
            this.tradeInFlight = false;
            this.settling = false;
            this.armed = null;
            this.addLog('warn', 'A virtual trade never settled (no ticks arrived); it was dropped.');
        }
        if (!this.io.feed.isLive()) {
            if (now - this.waitingSince > FEED_WAIT_MS) {
                return this.stop(this.io.feed.getSnapshot().error || 'The market feed did not come up.');
            }
            return this.emit();
        }
        this.waitingSince = now;
        this.refreshScan();
        if (this.io.rules) {
            // The rules engine decides on every tick (handleRules); there is nothing to arm or watch here.
            this.emit();
            return;
        }
        if (this.tradeInFlight || now < this.cooldownUntil || !this.scan) return;

        if (this.settings.execution === 'FIRST') {
            this.armed = null; // nothing is singled out ahead of time: every qualifying contract is watched
            this.refreshWatch(now);
            this.emit();
            return;
        }
        if (this.watch.size) this.watch.clear(); // switched back to best-score: no leftover watchers

        // Expire an armed contract that never saw its entry digit.
        if (this.armed && now >= this.armed.expiresAt) {
            this.addLog('info', `${this.armed.label} on ${this.armed.name} waited ${this.settings.waitSeconds}s for its entry digit; moving on.`);
            this.blocked.set(`${this.armed.symbol}|${this.armed.cellKey}`, now + EXPIRED_BLOCK_MS);
            this.armed = null;
        }
        // Keep the armed contract while it stays eligible; otherwise look again.
        if (this.armed) {
            const cell = this.scan.cells.find(c => c.symbol === this.armed!.symbol && c.key === this.armed!.cellKey);
            const call = cell ? this.meterFor(cell, now) : null;
            // Hysteresis: it was armed at the full bar, so it is only dropped once it falls clearly below it.
            const verdict = cell
                ? eligibility(cell, this.settings.selectivity, Math.max(0, this.pickyBump(now) + (call?.bump ?? 0) - ARMED_HYSTERESIS))
                : null;
            const streak = cell && this.settings.winStreakGate ? this.streakOf(cell.symbol, cell) : null;
            if (cell && streak?.abort) {
                this.addLog('info', `${this.armed.label} on ${this.armed.name} dropped: ${streak.losses} losing digits in the last 10 (limit ${streak.abortAt}).`);
                this.armed = null;
            } else if (cell && call && !call.allow) {
                this.addLog('info', `${this.armed.label} on ${this.armed.name} dropped: ${call.note}.`);
                this.armed = null;
            } else if (!cell || !verdict?.ok) {
                this.addLog('info', `${this.armed.label} on ${this.armed.name} dropped: ${verdict?.reason ?? 'no longer scanned'}.`);
                this.armed = null;
            } else {
                this.armed = {
                    ...this.armed,
                    score: cell.score,
                    edgePts: cell.edgePts,
                    significant: cell.significant,
                    entryDigits: this.entryDigitsFor(this.armed.symbol, cell, this.armed.entryDigits),
                };
                this.maybeRotatePlan(now);
            }
        }
        if (!this.armed) this.armBest(now);
        this.emit();
    }

    /** Every live tick of every market. Fires the trade when the armed market prints an entry digit. */
    handleFeedTick(symbol: string, digit: number) {
        if (this.running) this.seenTick.add(symbol);
        if (this.running && this.virtualOpen) {
            if (this.virtualOpen.symbol === symbol) this.virtualTick(digit);
            return;
        }
        if (this.io.rules) return this.handleRules(symbol, digit);
        if (this.settings.execution === 'FIRST') return this.handleFirstToQualify(symbol, digit);
        if (!this.running || this.tradeInFlight || !this.armed || this.armed.symbol !== symbol) return;
        if (this.io.now() < this.cooldownUntil) return;
        // With the streak guard on, the winning streak IS the entry: the old "wait for a losing digit" setups do not apply.
        if (!this.settings.winStreakGate && this.settings.entry !== 'ANY' && !this.brainGoverns() && !this.armed.entryDigits.includes(digit)) return;
        if (!this.streakFresh(symbol)) return;
        if (!this.recoveryFormOk(symbol)) return;
        if (!this.brainOk(symbol)) return;
        if (!this.meterFresh(symbol)) return;
        if (this.freshGuardBlocks(symbol)) return;
        void this.execute(digit);
    }

    private armBest(now: number) {
        if (!this.scan) return;
        const skipKeys = new Set<string>();
        this.blocked.forEach((until, key) => {
            if (until > now) skipKeys.add(key);
            else this.blocked.delete(key);
        });
        const skipSymbols = new Set<string>([...this.quarantined, ...this.restedSymbols(now)]);
        const guarded = this.settings.winStreakGate;
        const choose = (building: boolean) =>
            pickBest(
                this.scan!,
                this.settings.selectivity,
                { mode: this.scanMode() },
                { symbols: skipSymbols, keys: skipKeys },
                this.pickyBump(now),
                this.settings.meterGuide || this.io.overlay || guarded || this.guards.size > 0
                    ? {
                          bump: cell => this.meterFor(cell, now).bump,
                          rank: cell => this.meterFor(cell, now).rank,
                          veto: cell => {
                              if (!this.meterFor(cell, now).allow) return true;
                              if (this.guards.has(`${cell.symbol}|${cell.key}`)) return true;
                              if (!guarded) return false;
                              const read = this.streakOf(cell.symbol, cell);
                              // Never a market that is losing; first choice is one already part-way into a run of wins.
                              return read.abort || (building && read.run < Math.ceil(this.settings.winStreak / 2));
                          },
                      }
                    : undefined
            );
        const pick = guarded ? (choose(true) ?? choose(false)) : choose(false);
        if (!pick) return;
        const { cell } = pick;
        this.armed = this.buildArmed(pick, now);
        if (this.brainGoverns()) this.assignPlan(now);
        const planned = this.armed?.plan ?? null;
        const entry = planned
            ? `entry plan: ${planned.label}. ${planned.why}`
            : this.settings.entry === 'ANY'
              ? 'buying on the next tick'
              : `waiting for digit ${this.armed.entryDigits.join(' / ')}${this.settings.entry === 'SMART' ? ' (learned from this market)' : ''}`;
        const gate =
            this.settings.recoveryEntry !== 'OFF' && this.isRecovering()
                ? ` Recovery entry: also needs ${
                      this.settings.recoveryEntry === 'BRAIN'
                          ? 'the market’s proven trigger digits only (best available if none are proven).'
                          : this.settings.recoveryEntry === 'BOUNCE'
                          ? `${this.settings.recoveryForm} losing ticks in a row and then a winning one.`
                          : `${this.settings.recoveryForm} ${this.settings.recoveryEntry === 'MOMENTUM' ? 'winning' : 'losing'} ticks in a row.`
                  }`
                : '';
        this.addLog(
            'pick',
            `Armed ${cell.label} on ${marketName(cell.symbol)} (score ${cell.score}, ${fmtPts(cell.edgePts)} vs break-even${cell.significant ? ', significant' : ''}): ${entry}.${gate}`
        );
        if (this.settings.entry === 'ANY' || this.brainGoverns()) {
            const digit = this.io.feed.getLastDigit(cell.symbol);
            if (digit !== null && this.seenTick.has(cell.symbol) && this.streakFresh(cell.symbol) && this.recoveryFormOk(cell.symbol) && this.brainOk(cell.symbol) && this.meterFresh(cell.symbol) && !this.freshGuardBlocks(cell.symbol)) void this.execute(digit);
        }
    }

    /**
     * Rules-engine mode: every tick of every market goes to the engine. When it says "enter", the contract is bought the way
     * Sixfold buys anything: the same execute() with its stale-tick check, stake sizing, recovery contract, limits and refusals.
     */
    private handleRules(symbol: string, digit: number) {
        const rules = this.io.rules;
        if (!rules || !this.settings.markets.includes(symbol)) return;
        const series = this.io.feed.getLiveSeries()[symbol];
        if (!series) return;
        const now = this.io.now();
        const bases: Record<'UNDER' | 'OVER', Contract> = {
            UNDER: { side: 'UNDER', param: this.settings.primaryUnder },
            OVER: { side: 'OVER', param: this.settings.primaryOver },
        };
        const refusedOn = (side: 'UNDER' | 'OVER') => (this.blocked.get(`${symbol}|${contractKey(bases[side])}`) ?? 0) > now;
        const idle = this.running && !this.tradeInFlight && now >= this.cooldownUntil && !this.quarantined.has(symbol);
        // What would really be bought on each side decides the paper barrier too: the recovery contract while a loss is open.
        const barriers = {
            UNDER: tradeContract(bases.UNDER, this.session.consecutiveLosses, this.settings).contract.param,
            OVER: tradeContract(bases.OVER, this.session.consecutiveLosses, this.settings).contract.param,
        };
        const out = rules.onTick(symbol, series, { live: this.running, idle, now, barriers, refused: { UNDER: refusedOn('UNDER'), OVER: refusedOn('OVER') } });
        out.events.forEach(text => this.addLog('info', text));
        out.paper?.forEach(event => this.publishPaper(event));
        if (!out.enter || !out.side) {
            if (out.events.length) this.emit();
            return;
        }
        const key = contractKey(bases[out.side]);
        const cell = this.scan?.cells.find(c => c.symbol === symbol && c.key === key && c.executable);
        if (!cell) return; // Deriv does not offer it here, or it is not scanned yet: nothing is bought on a guess
        const label = cell.label;
        this.armed = {
            symbol,
            name: marketName(symbol),
            label,
            score: 100,
            edgePts: cell.edgePts,
            significant: false,
            entryDigits: [],
            why: 'The bot rules are all met',
            since: now,
            expiresAt: now + 60_000,
            cellKey: cell.key,
            plan: null,
            planTried: [],
            planAt: now,
        };
        this.addLog('pick', `Bot rules met on ${marketName(symbol)}: buying ${label}.`);
        void this.execute(digit);
        // execute() claims the trade synchronously; if it declined (stale tick) nothing stays armed.
        if (!this.tradeInFlight) this.armed = null;
    }

    /** The armed record for a picked contract (not yet armed: the caller decides where it lives). */
    private buildArmed(pick: Pick, now: number): Armed {
        const { cell } = pick;
        return {
            symbol: cell.symbol,
            name: marketName(cell.symbol),
            label: cell.label,
            score: cell.score,
            edgePts: cell.edgePts,
            significant: cell.significant,
            entryDigits: this.scanMode() === 'ANY' ? [] : this.entryDigitsFor(cell.symbol, cell, pick.entryDigits),
            why: pick.why,
            since: now,
            expiresAt: now + this.settings.waitSeconds * 1000,
            cellKey: cell.key,
            plan: null,
            planTried: [],
            planAt: now,
        };
    }

    /** Runs `fn` with `armed` temporarily standing in as the armed contract, so the per-contract helpers can be reused. */
    private withArmed(armed: Armed, fn: () => void): Armed {
        const previous = this.armed;
        this.armed = armed;
        try {
            fn();
            return this.armed ?? armed;
        } finally {
            this.armed = previous;
        }
    }

    /**
     * FIRST mode: rebuild the watchlist from the scan. A contract stays on it while it passes the same rules `pickBest` uses
     * (with the same small hysteresis the single armed contract gets), and keeps its entry plan while it does.
     */
    private refreshWatch(now: number) {
        if (!this.scan) return;
        const skipKeys = new Set<string>();
        this.blocked.forEach((until, key) => {
            if (until > now) skipKeys.add(key);
            else this.blocked.delete(key);
        });
        const skipSymbols = new Set<string>([...this.quarantined, ...this.restedSymbols(now)]);
        const meterOn = this.settings.meterGuide;
        const keyOf = (c: Cell) => `${c.symbol}|${c.key}`;
        const picks = rankedPicks(
            this.scan,
            this.settings.selectivity,
            { mode: this.scanMode() },
            { symbols: skipSymbols, keys: skipKeys },
            this.pickyBump(now),
            {
                bump: cell => (meterOn ? this.meterFor(cell, now).bump : 0) - (this.watch.has(keyOf(cell)) ? ARMED_HYSTERESIS : 0),
                rank: cell => (meterOn ? this.meterFor(cell, now).rank : 0),
                veto: cell => meterOn && !this.meterFor(cell, now).allow,
            }
        );
        const next = new Map<string, Armed>();
        for (const pick of picks) {
            const key = keyOf(pick.cell);
            const prev = this.watch.get(key);
            let armed: Armed = prev
                ? {
                      ...prev,
                      score: pick.cell.score,
                      edgePts: pick.cell.edgePts,
                      significant: pick.cell.significant,
                      entryDigits: this.scanMode() === 'ANY' ? [] : this.entryDigitsFor(prev.symbol, pick.cell, prev.entryDigits),
                  }
                : this.buildArmed(pick, now);
            if (this.brainGoverns()) {
                armed = this.withArmed(armed, () => (armed.plan ? this.maybeRotatePlan(now, true) : this.assignPlan(now)));
            }
            next.set(key, armed);
        }
        this.watch = next;
        const sig = [...next.keys()].sort().join(',');
        if (sig !== this.watchSig) {
            this.watchSig = sig;
            if (next.size > 0 && now - this.watchLogAt >= WATCH_LOG_MS) {
                this.watchLogAt = now;
                const markets = new Set([...next.values()].map(a => a.symbol)).size;
                this.addLog('pick', `Watching ${next.size} contract${next.size === 1 ? '' : 's'} on ${markets} market${markets === 1 ? '' : 's'}: the first to show its entry is bought.`);
            }
        }
    }

    /**
     * FIRST mode: a tick on `symbol` is offered to every contract watched there (best score first). The first one whose entry
     * condition holds, and that still passes the last-look checks, is bought. One trade at a time, across all markets.
     */
    private handleFirstToQualify(symbol: string, digit: number) {
        if (!this.running || this.tradeInFlight || this.io.now() < this.cooldownUntil || this.watch.size === 0) return;
        const candidates = [...this.watch.values()].filter(a => a.symbol === symbol).sort((a, b) => b.score - a.score);
        for (const candidate of candidates) {
            this.armed = candidate;
            const entryOk = this.settings.entry === 'ANY' || this.brainGoverns() || candidate.entryDigits.includes(digit);
            // The win-streak guard holds here too: never buy while the market is not on a run of winning digits.
            const streakOk = !this.settings.winStreakGate || this.streakHolds(symbol, candidate.cellKey);
            if (!entryOk || !streakOk || !this.recoveryFormOk(symbol) || !this.brainOk(symbol) || !this.meterFresh(symbol)) {
                this.armed = null; // (meterFresh already blocked and cleared a contract that went cold)
                continue;
            }
            const stillWatched = this.armed;
            void this.execute(digit);
            // execute() claims the trade synchronously; if it declined (stale tick, unknown contract) nobody is armed.
            if (!this.tradeInFlight) this.armed = null;
            else if (stillWatched) this.addLog('info', `${stillWatched.label} on ${stillWatched.name} was first to qualify.`);
            return;
        }
    }

    /** Entry digits for a market: learned from its recent ticks when SMART, otherwise the fixed setup digits. */
    private entryDigitsFor(symbol: string, cell: Cell, fixed: number[]): number[] {
        // An overlay (Sentinel AI) may hold a validated entry digit for this exact contract. It is not used while recovering,
        // because the contract bought then is the recovery barrier, which the digit was not validated for.
        const recovering = this.isRecovering();
        const forced = this.io.overlay?.entryDigits?.(cell, { recovering });
        if (forced && forced.length && !recovering && this.settings.entry !== 'ANY' && !this.brainGoverns()) return forced;
        if (this.settings.entry !== 'SMART') return fixed;
        const series = this.io.feed.getLiveSeries()[symbol] ?? [];
        const traded = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings).contract;
        const avoid = new Set<number>();
        const last = this.lastLossEntry.get(symbol);
        if (last !== undefined) avoid.add(last);
        const next = smartEntryDigits(series, traded, this.settings.duration, avoid).digits;
        return next.length === fixed.length && next.every((d, i) => d === fixed[i]) ? fixed : next;
    }

    /** How the scanner scores contracts: the Brain and "any tick" judge a contract on its own, without a setup digit. */
    private scanMode(): 'ANY' | 'SETUP' {
        return this.settings.entry === 'ANY' || this.settings.entry === 'BRAIN' ? 'ANY' : 'SETUP';
    }

    /** The contract that would actually be bought on this market right now (recovery barrier after a loss). */
    private tradedFor(symbol: string) {
        const cell = this.scan?.cells.find(c => c.symbol === symbol && c.key === this.armed?.cellKey);
        return cell ? tradeContract(cell.contract, this.session.consecutiveLosses, this.settings).contract : null;
    }

    /** Is the Entry Brain choosing this trade's entry? Always for BRAIN, and for recovery trades when recovery entry is BRAIN. */
    private brainGoverns(): boolean {
        return this.settings.entry === 'BRAIN' || (this.isRecovering() && this.settings.recoveryEntry === 'BRAIN');
    }

    /** Recovery with the Brain: the most proven plan, and the AI model must agree. */
    private brainStrict(): boolean {
        return this.isRecovering() && this.settings.recoveryEntry === 'BRAIN';
    }

    /** Pick (or re-pick) the entry plan for the armed contract. Never leaves it without one. */
    private assignPlan(now: number) {
        const armed = this.armed;
        if (!armed) return;
        const traded = this.tradedFor(armed.symbol);
        const cell = traded ? findCell(this.brain, armed.symbol, traded) : null;
        const strict = this.brainStrict();
        const plan = cell
            ? choosePlan(cell, {
                  rng: this.rng,
                  exclude: armed.planTried.length >= 10 ? [] : armed.planTried,
                  maxWaitTicks: Math.max(12, Math.round(this.settings.waitSeconds / 4)),
                  strict,
              })
            : fallbackPlan(strict);
        this.armed = { ...armed, plan, planAt: now, planTried: [...armed.planTried, plan.arm] };
    }

    /** A plan that has not fired for a third of the wait window gives way to the next best, up to PLAN_ROTATIONS times. */
    private maybeRotatePlan(now: number, quiet = false) {
        const armed = this.armed;
        if (!armed || !armed.plan || !this.brainGoverns()) return;
        if (armed.planTried.length > PLAN_ROTATIONS) return;
        if (now - armed.planAt < (this.settings.waitSeconds * 1000) / 3) return;
        const old = armed.plan;
        this.assignPlan(now);
        const next = this.armed?.plan;
        if (!quiet && next && next.arm !== old.arm) this.addLog('info', `Entry plan "${old.label}" did not fire on ${armed.name}; trying "${next.label}".`);
    }

    /**
     * The overlay's mandatory hold (Sentinel AI's special-digit rule), read on every tick for the contract that would be bought.
     * When it refuses, the arm is dropped and the best other market is armed, as with the win-streak guard.
     */
    private overlayHolds(symbol: string): boolean {
        const guard = this.io.overlay?.guard;
        if (!guard || !this.armed) return true;
        const traded = this.tradedFor(symbol);
        if (!traded) return true;
        let verdict: { ok: boolean; note: string };
        try {
            verdict = guard(symbol, traded, this.io.feed.getLiveSeries()[symbol] ?? []);
        } catch {
            return false; // a mandatory rule that cannot be read holds the trade back
        }
        if (verdict.ok) return true;
        const armed = this.armed;
        this.armed = null;
        // Rest this contract briefly so the same one is not armed straight back (the scan also vetoes it by the same rule).
        this.blocked.set(`${armed.symbol}|${armed.cellKey}`, this.io.now() + OVERLAY_HOLD_BLOCK_MS);
        this.addLog('info', `${armed.label} on ${armed.name} held back: ${verdict.note}. Looking at another market.`);
        this.armBest(this.io.now());
        this.emit();
        return false;
    }

    /** The Brain's gate: the chosen plan must fire on the latest tick (and, in recovery, the AI model must agree). */
    private brainOk(symbol: string): boolean {
        if (!this.overlayHolds(symbol)) return false;
        if (!this.brainGoverns()) return true;
        const traded = this.tradedFor(symbol);
        if (!traded) return false;
        const plan = this.armed?.plan ?? fallbackPlan(this.brainStrict());
        return planFires(plan, findCell(this.brain, symbol, traded), this.io.feed.getLiveSeries()[symbol] ?? [], traded);
    }

    private streakOf(symbol: string, cell: Cell) {
        const traded = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings).contract;
        return streakRead(this.io.feed.getLiveSeries()[symbol] ?? [], traded, this.settings.winStreak, this.settings.lossAbort);
    }

    /**
     * Win-streak guard, read afresh on every tick. Buys only inside a run of wins for the contract that would be bought (the
     * recovery barrier after a loss). A market that has printed too many losses lately is dropped so the bot can look at one
     * that is building up wins.
     */
    private streakFresh(symbol: string): boolean {
        if (!this.settings.winStreakGate || !this.armed || !this.scan) return true;
        const cell = this.scan.cells.find(c => c.symbol === symbol && c.key === this.armed!.cellKey);
        if (!cell) return true;
        const read = this.streakOf(symbol, cell);
        if (read.abort) {
            const armed = this.armed;
            this.armed = null;
            this.addLog('info', `${armed.label} on ${armed.name} dropped: ${read.losses} losing digits in the last 10 (limit ${read.abortAt}). Looking for a market building wins.`);
            this.armBest(this.io.now());
            this.emit();
            return false;
        }
        return read.ok;
    }

    /** True when the latest digits of `symbol` are a long enough run of wins for the contract that would be bought. No side effects. */
    private streakHolds(symbol: string, cellKey: string): boolean {
        const cell = this.scan?.cells.find(c => c.symbol === symbol && c.key === cellKey);
        return cell ? this.streakOf(symbol, cell).ok : false;
    }

    private isRecovering(): boolean {
        return this.session.consecutiveLosses > 0 || (this.settings.martingale && this.session.openLoss > 0);
    }

    /** Recovery entry condition: while recovering, the market's recent ticks must show the chosen run for the contract. */
    private recoveryFormOk(symbol: string): boolean {
        if (this.settings.recoveryEntry === 'OFF' || !this.isRecovering() || !this.armed || !this.scan) return true;
        const cell = this.scan.cells.find(c => c.symbol === symbol && c.key === this.armed!.cellKey);
        if (!cell) return true;
        const traded = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings).contract;
        const series = this.io.feed.getLiveSeries()[symbol] ?? [];
        return formGateOk(this.settings.recoveryEntry, this.settings.recoveryForm, series, traded);
    }

    /**
     * What the Meter says about buying this cell now. It reads the contract that WOULD be bought (the recovery barrier after
     * a loss), the market-wide climate, and how long the bot has waited since its last result.
     */
    private meterFor(cell: Cell, now: number): MeterCall {
        const meter = this.meterOnly(cell, now);
        const overlay = this.io.overlay;
        if (!overlay) return meter;
        const extra = overlay.call(cell, { recovering: this.isRecovering(), now });
        return {
            allow: meter.allow && extra.allow,
            bump: meter.bump + extra.bump,
            rank: meter.rank + extra.rank,
            note: [meter.allow ? '' : meter.note, extra.allow ? '' : extra.note, meter.allow && extra.allow ? meter.note : '', extra.allow ? extra.note : '']
                .filter(Boolean)
                .join('; '),
        };
    }

    /** The Meter's part alone (see `meterFor`). */
    private meterOnly(cell: Cell, now: number): MeterCall {
        if (!this.settings.meterGuide) return { allow: true, bump: 0, rank: 0, note: '' };
        const traded = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings).contract;
        const reading = this.tradeRegime?.cells.find(c => c.symbol === cell.symbol && c.key === contractKey(traded)) ?? null;
        return meterCall({
            climate: climateOf(this.tradeRegime),
            floor: this.meterFloor(),
            cell: reading,
            recovering: this.isRecovering(),
            waitedMs: now - this.meterSince,
            patienceMs: this.settings.meterPatience * 1000,
        });
    }

    /** The hard floor in force now: the recovery floor while recovering (never lower than the normal one). */
    private meterFloor(): number {
        const { meterFloor, meterFloorRecovery } = this.settings;
        return this.isRecovering() ? Math.max(meterFloor, meterFloorRecovery) : meterFloor;
    }

    /**
     * Last look at the moment of purchase. The scan is up to a second and a half old, so the contract about to be bought is
     * read afresh from the live ticks; if it has just fallen into a loss cluster or under the floor it is not bought.
     */
    private meterFresh(symbol: string): boolean {
        if (!this.settings.meterGuide || !this.armed) return true;
        const traded = this.tradedFor(symbol);
        if (!traded) return true;
        const reading = regimeCell(symbol, this.io.feed.getLiveSeries()[symbol] ?? [], traded);
        if (!reading) return true;
        const call = meterCall({
            climate: climateOf(this.tradeRegime),
            floor: this.meterFloor(),
            cell: reading,
            recovering: this.isRecovering(),
            waitedMs: 0,
            patienceMs: 0,
        });
        if (call.allow) return true;
        const armed = this.armed;
        this.blocked.set(`${armed.symbol}|${armed.cellKey}`, this.io.now() + COLD_AT_BUY_BLOCK_MS);
        this.armed = null;
        this.addLog('info', `${armed.label} on ${armed.name} not bought: ${call.note}.`);
        this.emit();
        return false;
    }

    /** The climate and the extra bar an average contract faces right now, for the page. */
    private meterStatus(now: number): MeterStatus {
        if (!this.settings.meterGuide) return IDLE_STATUS;
        const climate = climateOf(this.tradeRegime);
        if (!climate) return { ...IDLE_STATUS, on: true };
        const patienceMs = this.settings.meterPatience * 1000;
        const waitedMs = now - this.meterSince;
        const recovering = this.isRecovering();
        const floor = this.meterFloor();
        const call = meterCall({ climate, cell: null, recovering, waitedMs, patienceMs });
        const full = meterCall({ climate, cell: null, recovering, waitedMs: 0, patienceMs });
        return {
            on: true,
            verdict: climate.verdict,
            meter: climate.meter,
            coldShare: climate.coldShare,
            bump: call.bump,
            floor,
            underFloor: floor > 0 && climate.meter < floor,
            recovering,
            easesInSec: full.bump > 0 ? Math.max(0, Math.ceil((patienceMs - waitedMs) / 1000)) : 0,
        };
    }

    /** Evaluate the contract that will actually be bought, including the recovery barrier after a loss. */
    private guardReason(digits: readonly number[], primary: Contract): string | null {
        return this.guardCheck(digits, primary)?.reason ?? null;
    }

    /** Which guard refuses this contract (the first that does), and why. */
    private guardCheck(digits: readonly number[], primary: Contract): { kind: 'pressure' | 'window' | 'winning'; reason: string } | null {
        const { pressureGate: pressureOn, multiWindowGate: windowsOn, pressureMax, winPressureGate: winOn, winPressureMin, strictPressure } = this.settings;
        if (!pressureOn && !windowsOn && !winOn) return null;
        const traded = tradeContract(primary, this.session.consecutiveLosses, this.settings).contract;
        if (pressureOn) {
            // Strict: normally at most one losing digit may be climbing; after a loss (recovery) none may be.
            const g = pressureGate(losingSidePressure(digits, traded), pressureMax, strictPressure, this.session.consecutiveLosses > 0 ? 0 : 1);
            if (!g.ok) return { kind: 'pressure', reason: g.reason };
        }
        if (windowsOn) {
            const g = multiWindowGate(multiWindowHealth(digits, traded));
            if (!g.ok) return { kind: 'window', reason: g.reason };
        }
        if (winOn) {
            // Strict: after a loss (recovery) the winning side must be gaining one more point than usual, not just ticking up.
            const minRise = strictPressure && this.session.consecutiveLosses > 0 ? winPressureMin + 1 : winPressureMin;
            const g = winningSideGate(winningSidePressure(digits, traded, minRise));
            if (!g.ok) return { kind: 'winning', reason: g.reason };
        }
        return null;
    }

    private computeGuards(series: Record<string, readonly number[]>): Map<string, string> {
        const out = new Map<string, string>();
        if (!this.scan) return out;
        for (const cell of this.scan.cells) {
            const why = this.guardReason(series[cell.symbol] ?? [], cell.contract);
            if (why) out.set(`${cell.symbol}|${cell.key}`, why);
        }
        return out;
    }

    /** Last look before buying: re-read the latest ticks so a newly hostile market is not entered. */
    private freshGuardBlocks(symbol: string): boolean {
        if (!this.armed || !this.scan) return false;
        const cell = this.scan.cells.find(c => c.symbol === symbol && c.key === this.armed!.cellKey);
        if (!cell) return false;
        const why = this.guardReason(this.io.feed.getLiveSeries()[symbol] ?? [], cell.contract);
        if (!why) return false;
        const armed = this.armed;
        this.guards.set(`${cell.symbol}|${cell.key}`, why);
        this.armed = null;
        this.addLog('info', `${armed.label} on ${armed.name} dropped: ${why}.`);
        this.emit();
        return true;
    }

    private restedSymbols(now: number): Set<string> {
        const out = new Set<string>();
        if (!this.settings.lossShield) return out;
        this.rest.forEach((r, symbol) => {
            if (this.session.trades < r.untilTrades && now < r.untilAt) out.add(symbol);
        });
        return out;
    }

    /** Extra score asked for right after a loss. It fades, so a quiet market can never freeze the session. */
    private pickyBump(now: number): number {
        if (!this.settings.pickyAfterLoss || this.session.consecutiveLosses === 0) return 0;
        return Math.max(0, PICKY_BUMP - Math.floor(Math.max(0, now - this.lastResultAt) / PICKY_FADE_MS));
    }

    private refreshScan(force = false) {
        const now = this.io.now();
        if (!force && this.scan && now - this.scanAt < SCAN_MS) return;
        const series = this.io.feed.getLiveSeries();
        const symbols = this.settings.markets.filter(s => (series[s]?.length ?? 0) >= MIN_TICKS);
        this.io.overlay?.refresh?.(now, symbols);
        // A contract only counts as executable where Deriv offers it. "Not known yet" is allowed: Deriv's own refusal at
        // purchase time (skipArmed) then takes that market out, so nothing is ever bought on a guess.
        const offers: OffersFn = (symbol, contract) => {
            const type = DERIV_CONTRACT_TYPE[contract.side];
            return type ? (this.io.feed.isOffered?.(symbol, type) ?? true) : true;
        };
        this.scan = scanMarkets(
            series,
            symbols,
            { duration: this.settings.duration, entry: { mode: this.scanMode() }, margin: this.settings.margin },
            now,
            this.contractList(),
            offers
        );
        this.scanAt = now;
        if (this.settings.entry === 'BRAIN' || this.settings.recoveryEntry === 'BRAIN' || this.retainCount > 0) {
            if (!this.brain || now - this.brainAt >= BRAIN_REFRESH_MS) {
                const contracts: Contract[] = [...this.contractList()];
                if (this.settings.recovery) {
                    if (contracts.some(c => c.side === 'OVER')) contracts.push({ side: 'OVER', param: this.settings.recoveryOver });
                    if (contracts.some(c => c.side === 'UNDER')) contracts.push({ side: 'UNDER', param: this.settings.recoveryUnder });
                }
                const uniq = [...new Map(contracts.map(c => [contractKey(c), c])).values()];
                this.brain = brainReport(series, symbols, uniq, this.settings.duration, now);
                this.brainAt = now;
            }
        }
        this.regime = computeRegime(series, symbols, this.contractList(), now);
        // After a loss the contracts bought are the recovery barriers, so the guide reads those, not the armed ones.
        const nextContracts = [
            ...new Map(
                this.contractList().map(c => {
                    const t = tradeContract(c, this.session.consecutiveLosses, this.settings).contract;
                    return [contractKey(t), t] as const;
                })
            ).values(),
        ];
        const samePrimary = nextContracts.every(c => this.contractList().some(p => contractKey(p) === contractKey(c)));
        this.tradeRegime = samePrimary ? this.regime : computeRegime(series, symbols, nextContracts, now);
        this.guards = this.computeGuards(series);
        const rested = this.restedSymbols(now);
        const bump = this.pickyBump(now);
        this.queue = this.scan.cells
            .filter(c => c.executable && !this.quarantined.has(c.symbol))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map(cell => {
                if (rested.has(cell.symbol)) return { cell, ok: false, reason: 'Resting after a loss on this market' };
                const guard = this.guards.get(`${cell.symbol}|${cell.key}`) ?? null;
                if (guard) return { cell, ok: false, reason: guard };
                const call = this.meterFor(cell, now);
                if (!call.allow) return { cell, ok: false, reason: call.note.charAt(0).toUpperCase() + call.note.slice(1) };
                const e = eligibility(cell, this.settings.selectivity, bump + call.bump);
                return { cell, ok: e.ok, reason: e.ok && call.bump > 0 ? `${e.reason}; ${call.note}` : e.reason };
            });
        this.funnel = this.buildFunnel(now, rested, bump);
        this.scheduleEmit();
    }

    /** Walks EVERY scanned contract through the same checks the pick uses and counts where each one stops. */
    private buildFunnel(now: number, rested: Set<string>, bump: number): ScanFunnel | null {
        const scan = this.scan;
        if (!scan) return null;
        const f: ScanFunnel = {
            at: scan.at,
            cells: scan.cells.length,
            tradable: 0,
            resting: 0,
            guarded: 0,
            guardedPressure: 0,
            guardedWindow: 0,
            guardedWinning: 0,
            meterVeto: 0,
            overlayVeto: 0,
            belowBar: 0,
            eligible: 0,
            streakDropped: 0,
            streakReady: 0,
            streakGate: this.settings.winStreakGate,
            reasons: [],
        };
        const tally = new Map<string, number>();
        const note = (reason: string) => {
            const key = reason.replace(/[0-9]+(\.[0-9]+)?/g, '#').replace(/\s+/g, ' ').trim();
            tally.set(key, (tally.get(key) ?? 0) + 1);
        };
        for (const cell of scan.cells) {
            if (!cell.executable || this.quarantined.has(cell.symbol)) continue;
            f.tradable += 1;
            if (rested.has(cell.symbol)) {
                f.resting += 1;
                note('Resting after a loss on this market');
                continue;
            }
            const check = this.guardCheck(this.io.feed.getLiveSeries()[cell.symbol] ?? [], cell.contract);
            if (check) {
                f.guarded += 1;
                if (check.kind === 'pressure') f.guardedPressure += 1;
                else if (check.kind === 'window') f.guardedWindow += 1;
                else f.guardedWinning += 1;
                note(check.reason);
                continue;
            }
            const meter = this.meterOnly(cell, now);
            if (!meter.allow) {
                f.meterVeto += 1;
                note(`Meter: ${meter.note}`);
                continue;
            }
            const extra = this.io.overlay?.call(cell, { recovering: this.isRecovering(), now });
            if (extra && !extra.allow) {
                f.overlayVeto += 1;
                note(`Engines: ${extra.note}`);
                continue;
            }
            const e = eligibility(cell, this.settings.selectivity, bump + meter.bump + (extra?.bump ?? 0));
            if (e.ok) {
                f.eligible += 1;
                if (this.settings.winStreakGate) {
                    const read = this.streakOf(cell.symbol, cell);
                    if (read.abort) {
                        f.streakDropped += 1;
                        note('Win-streak guard: too many losses in the last 10 ticks');
                    } else if (read.ok) f.streakReady += 1;
                }
            } else {
                f.belowBar += 1;
                note(e.reason);
            }
        }
        f.reasons = [...tally.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([reason, count]) => ({ reason, count }));
        return f;
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

    /**
     * Shows a paper trade in the general Transactions panel the way the bot's virtual hook does: a row marked virtual that settles to
     * "Virtual Win" or "Virtual Loss", with no stake or profit, and never counted in the real totals. The Run Panel and the summary card
     * are deliberately left alone, so a paper trade cannot touch a real session's numbers.
     */
    private publishPaper({ phase, trade }: PaperEvent) {
        if (!this.stores) return;
        const settled = phase === 'settle';
        const won = trade.status === 'won';
        const currency = this.io.currency() || this.stores.client?.currency || 'USD';
        const type = DERIV_CONTRACT_TYPE[trade.side];
        const data: Loose = {
            contract_id: trade.id,
            display_name: trade.symbol,
            underlying_symbol: trade.symbol,
            shortcode: `${this.moduleId.toUpperCase()}_PAPER_${type}_${trade.symbol}`,
            contract_type: type,
            currency,
            date_start: Math.floor(trade.at / 1000),
            is_virtual_hook: 1,
            is_sold: settled ? 1 : 0,
            is_expired: settled ? 1 : 0,
            status: settled ? (won ? 'won' : 'lost') : 'open',
            virtual_result: settled ? (won ? 'win' : 'loss') : undefined,
            buy_price: 0,
            sell_price: 0,
            payout: 0,
            bid_price: 0,
            profit: 0,
            barrier: String(trade.barrier),
            entry_spot: trade.entryDigit === null ? undefined : String(trade.entryDigit),
            exit_spot: settled && trade.exitDigit !== null ? String(trade.exitDigit) : undefined,
            exit_tick_time: settled ? Math.floor(this.io.now() / 1000) : undefined,
            transaction_ids: settled ? { buy: trade.id, sell: trade.id } : { buy: trade.id },
        };
        try {
            this.stores.transactions.pushTransaction({ ...data, run_id: this.stores.run_panel.run_id });
        } catch {
            /* a display failure must never affect trading */
        }
    }

    private async execute(entryDigit: number | null) {
        const armed = this.armed;
        if (!armed || this.tradeInFlight || !this.scan) return;
        const lastTick = this.io.feed.getLastTickAt(armed.symbol);
        if (lastTick === null || this.io.now() - lastTick > FRESH_TICK_MS) return; // never trade on a stale market
        const cell = this.scan.cells.find(c => c.symbol === armed.symbol && c.key === armed.cellKey);
        if (!cell) return;

        if (this.paperNow()) return this.executeVirtual(armed, cell, entryDigit);
        const triggerEpoch = this.io.feed.getLastEpoch?.(armed.symbol) ?? null;
        const tickAgeMs = this.io.now() - lastTick;
        const token = this.runToken;
        const bought = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings);
        const sized = stakeFor(this.session, bought.contract, this.settings);
        const stake = sized.stake;
        if (sized.writeOff) {
            this.addLog(
                'warn',
                `Streak budget reached (${this.session.openLoss.toFixed(2)} owed): accepting the loss and restarting at stake ${stake.toFixed(2)}.`
            );
            this.session = applyWriteOff(this.session, this.settings);
        }
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
            shortcode: `${this.name.replace(/\W+/g, '_').toUpperCase()}_${contractType}_${armed.symbol}`,
            contract_type: contractType,
            currency,
            date_start: startedAt,
            verification_id: `${armed.symbol}_${startedAt}_${Math.random().toString(36).slice(2, 11)}`,
        };

        let contractId = 0;
        const abort = new AbortController();
        try {
            const sentAt = this.io.now();
            const buy = await this.io.buy({ parameters, price: stake });
            const buyMs = this.io.now() - sentAt;
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
                plan: this.brainGoverns() ? (armed.plan?.arm ?? null) : null,
                baseRate: this.brainGoverns() ? (findCell(this.brain, armed.symbol, bought.contract)?.immediateRate ?? null) : null,
                exitDigit: null,
                stake,
                profit: null,
                status: 'open',
                score: armed.score,
                at: this.io.now(),
            };
            this.trades = [record, ...this.trades].slice(0, TRADE_LIMIT);
            const notice: TradeNotice = {
                contractId, symbol: armed.symbol, armed: cell.contract, bought: bought.contract, recovery: bought.recovery, stake, entryDigit,
            };
            this.notices.set(contractId, notice);
            try {
                this.io.overlay?.onBought?.(notice);
            } catch {
                /* an overlay failure must never disturb a live trade */
            }
            this.addLog(
                'trade',
                `Bought ${bought.label}${bought.recovery ? ' (recovery)' : ''} on ${armed.name}, stake ${stake.toFixed(2)}${entryDigit === null ? '' : `, entry digit ${entryDigit}`}${this.brainGoverns() && armed.plan ? `, plan: ${armed.plan.label}` : ''}. Sent ${Math.max(0, Math.round(tickAgeMs))} ms after the trigger tick, confirmed in ${Math.max(0, Math.round(buyMs))} ms.`
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
            this.reportStart(armed, settled, triggerEpoch);
            const isFinal =
                Boolean(settled.is_sold) || ['won', 'lost', 'sold'].includes(String(settled.status ?? '').toLowerCase());
            const profit = Number(settled.profit);
            if (!isFinal || !Number.isFinite(profit)) {
                this.lastError = 'Contract result was not confirmed in time; stake settings were left unchanged.';
                return this.finishTrade(contractId, null);
            }
            this.finishTrade(contractId, profit, lastDigitOf(settled.exit_tick_display_value ?? settled.exit_spot_display_value ?? settled.exit_spot ?? settled.sell_spot_display_value ?? settled.sell_spot ?? settled.exit_tick));
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

    /** Is the next trade a paper trade? The opening spell of a Run, or the Virtual Hook after real losses. */
    private paperNow(): boolean {
        return this.vh.virtual && (this.opening || this.settings.virtualHook);
    }

    private vhConfig(): VhConfig {
        const s = this.settings;
        return { enterLosses: s.vhEnterLosses, returnWins: s.vhReturnWins, mode: s.vhMode, fixedCount: s.vhFixedCount };
    }

    private vhReturnText(): string {
        const s = this.settings;
        return s.vhMode === 'FIXED' ? `${s.vhFixedCount} paper trades are done` : `${s.vhReturnWins} paper win${s.vhReturnWins > 1 ? 's' : ''} in a row`;
    }

    private pushVirtual(data: Loose) {
        try {
            this.stores?.transactions.pushTransaction({ ...data, is_virtual_hook: 1, run_id: this.stores.run_panel.run_id });
        } catch {
            /* optional transactions-panel failures are ignored */
        }
    }

    /** A paper trade: the same pick and entry as a real one, no purchase. It settles on the market's real ticks. */
    private executeVirtual(armed: Armed, cell: Cell, entryDigit: number | null) {
        const bought = tradeContract(cell.contract, this.session.consecutiveLosses, this.settings);
        const stake = stakeFor(this.session, bought.contract, this.settings).stake;
        const contractType = DERIV_CONTRACT_TYPE[bought.contract.side];
        if (!contractType) return;
        const id = VIRTUAL_ID_BASE + ++this.virtualCount;
        const startedAt = Math.floor(this.io.now() / 1000);
        this.virtualOpen = { id, symbol: armed.symbol, contract: bought.contract, stake, remaining: Math.max(1, this.settings.duration), at: this.io.now() };
        this.tradeInFlight = true;
        this.settling = true;
        const record: TradeRecord = {
            contractId: id,
            symbol: armed.symbol,
            name: armed.name,
            label: bought.label,
            recovery: bought.recovery,
            entryDigit,
            plan: null,
            baseRate: null,
            exitDigit: null,
            stake,
            profit: null,
            status: 'open',
            virtual: true,
            score: armed.score,
            at: this.io.now(),
        };
        this.trades = [record, ...this.trades].slice(0, TRADE_LIMIT);
        this.pushVirtual({
            display_name: armed.symbol,
            underlying_symbol: armed.symbol,
            shortcode: `SIXFOLD_VIRTUAL_${contractType}_${armed.symbol}`,
            contract_type: contractType,
            contract_id: id,
            currency: this.stores?.client?.currency || this.io.currency() || 'USD',
            date_start: startedAt,
            buy_price: stake,
            barrier: String(bought.contract.param),
            status: 'open',
            is_sold: 0,
            profit: 0,
            transaction_ids: { buy: id },
        });
        this.addLog('trade', `Virtual ${bought.label}${bought.recovery ? ' (recovery)' : ''} on ${armed.name}: paper trade, no money staked.`);
        this.emit();
    }

    private virtualTick(digit: number) {
        const v = this.virtualOpen;
        if (!v) return;
        v.remaining -= 1;
        if (v.remaining > 0) return;
        this.virtualOpen = null;
        const won = winningDigits(v.contract).includes(digit);
        const profit = won ? Math.round(v.stake * profitMultiple(winProbability(v.contract), this.settings.margin) * 100) / 100 : -v.stake;
        const trade = this.trades.find(t => t.contractId === v.id);
        if (trade) {
            trade.profit = profit;
            trade.exitDigit = digit;
            trade.status = won ? 'won' : 'lost';
        }
        this.paper = { trades: this.paper.trades + 1, wins: this.paper.wins + (won ? 1 : 0), pnl: Math.round((this.paper.pnl + profit) * 100) / 100 };
        this.pushVirtual({
            display_name: v.symbol,
            underlying_symbol: v.symbol,
            contract_type: DERIV_CONTRACT_TYPE[v.contract.side],
            contract_id: v.id,
            buy_price: v.stake,
            sell_price: won ? v.stake + profit : 0,
            barrier: String(v.contract.param),
            status: won ? 'won' : 'lost',
            is_sold: 1,
            is_expired: 1,
            profit,
            exit_spot: String(digit),
            exit_digit: digit,
            virtual_result: won ? 'win' : 'loss',
            transaction_ids: { buy: v.id, sell: v.id },
        });
        this.addLog(won ? 'win' : 'loss', `Virtual ${trade?.label ?? 'contract'} on ${trade?.name ?? ''} ${won ? 'won' : 'lost'} on paper (digit ${digit}). No money moved.`);
        if (this.opening) {
            // Opening spell: a loss means wait for a win on paper, a win means real trading starts now.
            if (won) {
                this.opening = false;
                this.vh = freshVh();
                this.addLog('info', 'Opening paper trade won. Real trading starts now.');
            } else {
                this.vh = { ...this.vh, virtualDone: this.vh.virtualDone + 1 };
                this.addLog('info', 'Opening paper trade lost. Staying on paper until one wins.');
            }
        } else {
            const step = vhAfterVirtual(this.vh, won, this.vhConfig());
            this.vh = step.state;
            if (step.event === 'returned') this.addLog('info', 'Virtual Hook: the paper trades did it. Back to real money.');
        }
        this.tradeInFlight = false;
        this.settling = false;
        this.armed = null;
        this.cooldownUntil = this.io.now() + COOLDOWN_MS;
        this.emit();
    }

    /**
     * Checks where the contract really began. A contract bought on a tick starts on the next tick Deriv prints; "ticks late"
     * is how many extra ticks passed between the trigger tick and that start (0 = bought on the very next tick).
     */
    private reportStart(armed: Armed, settled: Loose, triggerEpoch: number | null) {
        const start = Number(settled.entry_tick_time ?? settled.entry_spot_time ?? settled.date_start);
        if (triggerEpoch === null || !Number.isFinite(start) || start <= 0) return;
        const secs = expectedTickSeconds(armed.symbol);
        if (secs === null) return;
        const late = Math.max(0, Math.round((start - triggerEpoch) / secs) - 1);
        if (late > 0) {
            this.addLog('warn', `${armed.label} on ${armed.name} started ${late} tick${late > 1 ? 's' : ''} after the trigger tick (${start - triggerEpoch}s later): the purchase was slower than the market's tick.`);
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

    /** Loss shield bookkeeping after a settled trade on `symbol`. */
    private updateShield(symbol: string, name: string, entryDigit: number | null, lost: boolean) {
        if (!lost) {
            this.rest.delete(symbol);
            this.lastLossEntry.delete(symbol);
            return;
        }
        if (entryDigit !== null) this.lastLossEntry.set(symbol, entryDigit);
        const streak = (this.rest.get(symbol)?.streak ?? 0) + 1;
        const wait = this.settings.restTrades * (streak >= 2 ? 2 : 1);
        this.rest.set(symbol, { untilTrades: this.session.trades + wait, untilAt: this.io.now() + REST_MAX_MS, streak });
        if (this.settings.lossShield) {
            this.addLog(
                'warn',
                `Resting ${name} for the next ${wait} trades${streak >= 2 ? ` (${streak} losses in a row there)` : ''}.`
            );
        }
    }

    /** `profit === null` means the result could not be confirmed: counted as a trade, never as a win or loss. */
    private finishTrade(contractId: number, profit: number | null, exitDigit: number | null = null) {
        this.tradeInFlight = false;
        this.settling = false;
        this.armed = null;
        this.watch.clear(); // re-read after the result: the loss shield, the bump and the Meter may have changed what is allowed
        this.watchSig = '';
        this.cooldownUntil = this.io.now() + COOLDOWN_MS;
        const trade = this.trades.find(t => t.contractId === contractId);
        const notice = this.notices.get(contractId);
        this.notices.delete(contractId);
        if (notice) {
            try {
                this.io.overlay?.onSettled?.({ ...notice, profit });
            } catch {
                /* an overlay failure must never disturb a live session */
            }
        }
        if (profit === null) {
            this.session = { ...this.session, trades: this.session.trades + 1 };
            if (trade) trade.status = 'unconfirmed';
        } else {
            this.session = applyResult(this.session, profit, this.settings);
            this.io.rules?.onResult(profit >= 0);
            this.lastResultAt = this.io.now();
            this.meterSince = this.lastResultAt;
            this.scanAt = 0; // the next scan reads the contracts that will be bought after this result
            if (this.settings.virtualHook) {
                const step = vhAfterReal(this.vh, profit >= 0, this.vhConfig());
                this.vh = step.state;
                if (step.event === 'entered') {
                    this.addLog('info', `Virtual Hook: ${this.vh.realLosses} real loss${this.vh.realLosses > 1 ? 'es' : ''} in a row. Trading on paper (no money) until ${this.vhReturnText()}.`);
                }
            }
            if (trade) this.updateShield(trade.symbol, trade.name, trade.entryDigit, profit < 0);
            if (trade) {
                trade.profit = profit;
                trade.exitDigit = exitDigit;
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
        if (this.armed) return 'armed';
        if (this.io.rules) return 'watching';
        return this.watch.size > 0 ? 'watching' : 'scanning';
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
            watching: [...this.watch.values()].sort((a, b) => b.score - a.score),
            scan: this.scan,
            queue: this.queue,
            trades: this.trades,
            log: this.log,
            lastError: this.lastError,
            stopReason: this.stopMessage,
            feed: { mode: f.mode, status: f.status, error: f.error },
            readyMarkets: this.settings.markets.filter(s => (series[s]?.length ?? 0) >= MIN_TICKS).length,
            quarantined: [...this.quarantined],
            unavailable: this.io.feed.getUnavailable?.() ?? [],
            resting: [...this.restedSymbols(this.io.now())].map(symbol => ({
                symbol,
                name: marketName(symbol),
                tradesLeft: Math.max(0, (this.rest.get(symbol)?.untilTrades ?? 0) - this.session.trades),
            })),
            pickyBump: this.pickyBump(this.io.now()),
            regime: this.regime,
            meterGuide: this.meterStatus(this.io.now()),
            brain: this.brain,
            funnel: this.funnel,
            virtualHook: {
                on: this.settings.virtualHook || this.opening,
                opening: this.opening,
                virtual: this.paperNow(),
                open: this.virtualOpen !== null,
                realLosses: this.vh.realLosses,
                virtualWins: this.vh.virtualWins,
                virtualDone: this.vh.virtualDone,
                mode: this.settings.vhMode,
                enterLosses: this.settings.vhEnterLosses,
                returnWins: this.settings.vhReturnWins,
                fixedCount: this.settings.vhFixedCount,
                paper: this.paper,
            },
            rules: this.io.rules
                ? (() => {
                      const p = this.io.rules.paperState();
                      return {
                          rows: this.io.rules.board(this.settings.markets, marketName),
                          paper: p.paper,
                          paperLosses: p.losses,
                          paperNeeded: p.needed,
                          paperPending: p.pending,
                          paperTrades: p.trades,
                          paperWon: p.won,
                          paperLost: p.lost,
                      };
                  })()
                : null,
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

/** Last digit of Deriv's displayed settlement quote, e.g. "4943.82" -> 2. */
const lastDigitOf = (value: unknown): number | null => {
    const m = /(\d)\s*$/.exec(String(value ?? ''));
    return m ? Number(m[1]) : null;
};
const fmtPts = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)} pts`);
const fmtMoney = (x: number) => `${x >= 0 ? '+' : ''}${round2(x).toFixed(2)}`;
