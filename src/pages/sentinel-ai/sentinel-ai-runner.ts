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
import { buildBoard, choosePick, marketDots, pickyBumpAfterLoss, type Board } from './sentinel-ai-board';
import type { EngineSample, SentinelAiEngine, VettedCandidate } from './sentinel-ai-engine-types';
import type { FusionRead, FusionSource } from './sentinel-ai-fusion';
import type { OutcomeSink } from './sentinel-ai-outcome-log';
import type { OutcomeContract, SurfacedSignalInput } from './sentinel-ai-outcomes';
import { initialStakeState, nextStakeState, requiredEntry, sessionStopReason, tradeBarrier } from './sentinel-ai-money';
import { qualityVerdict } from './sentinel-ai-quality';
import { signalKeyOf, toSentinelAiSignal } from './sentinel-ai-signal';
import {
    DEFAULT_SETTINGS,
    type ActiveSignalState,
    type EngineInfo,
    type EntrySource,
    type MomentumView,
    type Phase,
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
/** A market Deriv refuses this many times in one session is taken out of the feed until the next Run. */
const MAX_MARKET_REFUSALS = 2;
/** A waiting signal that fails the quality gate is held (never traded) and dropped only if it stays bad this long. */
const DROP_GRACE_MS = 5_000;
/** A waiting signal is paused only when it is this many points beyond the score / danger limit (or engine-blocked). */
const HOLD_TOLERANCE = 10;
/** The "momentum blocked N of the last N surfaced signals" window. */
const RECENT_SURFACED = 40;
/** Pause after a transient failure so Immediate mode cannot hammer the API. */
const RETRY_COOLDOWN_MS = 3_000;
/** A setup that was worked (traded, expired, dropped or refused) is not armed again for this long, unless it leaves the board first. */
const SPENT_MS = 20_000;
/** A market that lost rests at most this long, even when too few other trades happen to bring it back. */
const REST_MAX_MS = 5 * 60_000;
/** Rows of the scanner board sent to the page. */
const BOARD_ROWS = 12;
const PASSING_MOMENTUM = { pass: true, measurable: true, score: 0, blockers: [] as string[] };

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
    /** Insight Fusion's feed. Optional: without it the scanner runs on the Sentinel engine alone. */
    fusion?: FusionSource;
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
    /** Optional read-only signal outcome log. Failures here never reach the runner. */
    outcomes?: OutcomeSink;
};

type ActiveSignal = {
    signal: SentinelAiSignal;
    runsDone: number;
    runsTotal: number;
    expiresAt: number;
    pnl: number;
    expired: boolean;
    done: boolean;
    /** Touch-once mode: the entry digit has been touched, so trades now fire back to back without waiting for it. */
    locked: boolean;
    /** The quality gate rejects this market right now (a touch-once run is paused until it qualifies again). */
    held: boolean;
    /** Why the quality gate currently rejects this signal, and since when. */
    holdReason: string | null;
    rejectedSince: number | null;
};

const toLogInput = (candidate: VettedCandidate): SurfacedSignalInput => {
    const opp = candidate.opportunity;
    const contract = opp.contract;
    const isOver = contract.side === 'OVER' || String(contract.id).startsWith('OVER');
    const barrier = Number.isFinite(Number(contract.barrier))
        ? Number(contract.barrier)
        : Number(String(contract.id).match(/\d+/)?.[0] ?? NaN);
    const type: OutcomeContract = isOver ? 'OVER' : 'UNDER';
    const psychology = Number(opp.digitPsychology?.score);
    return {
        symbol: opp.symbol,
        contract: type,
        barrier: Number.isFinite(barrier) ? barrier : null,
        label: contract.label || `${isOver ? 'Over' : 'Under'} ${barrier}`,
        psychologyScore: Number.isFinite(psychology) ? psychology : null,
        momentumPass: candidate.momentum.pass,
        momentumScore: Number.isFinite(candidate.momentum.score) ? candidate.momentum.score : null,
        momentumBlocked: candidate.blocked,
    };
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
    private releaseFusion: (() => void) | null = null;
    private loopTimer: ReturnType<typeof setInterval> | null = null;

    private active: ActiveSignal | null = null;
    private pending: SentinelAiSignal | null = null;
    /** The scanner board built from the latest engine sample, and what Insight Fusion said in it. */
    private board: Board = { rows: [], signals: new Map() };
    private fusionRead: FusionRead | null = null;
    private marketList: Array<{ symbol: string; name: string }> = [];
    /** Setups already worked: key -> time they may be armed again. */
    private spent = new Map<string, number>();
    /** Loss shield: per market, the trade count / time it rests until, and its run of losses there. */
    private rest = new Map<string, { untilTrades: number; untilAt: number; streak: number }>();
    private lastResultAt = 0;
    /** The buy went through and the contract is open (the phase after buying). */
    private settling = false;
    private lastKey: string | null = null;
    private tradeInFlight = false;
    private buyErrors = 0;
    private skipStreak = 0;
    private cooldownUntil = 0;
    /** `${symbol}|${contractId}` -> time the block lapses. Cells Deriv refused this session. */
    private blocked = new Map<string, number>();
    private aborts = new Set<AbortController>();
    /** Quality-gate rejections seen in the latest engine sample: `symbol|contractId` -> reason (rank order). */
    private qualityRejected = new Map<string, string>();
    /** The engine's live figures for the signal being traded, captured during the latest sample. */
    private activeOpp: RankedOpportunity | null = null;
    /** Touch-once: the market being traded was refused by Deriv, so the next signal continues nonstop without a new touch. */
    private carryLock = false;
    /** Deriv refusals per market this session; a market refused repeatedly is quarantined. */
    private marketRefusals = new Map<string, number>();
    private quarantined = new Set<string>();
    /** Momentum result per surfaced candidate in the latest sample: `symbol|contractId` -> candidate. */
    private vettedByKey = new Map<string, VettedCandidate>();
    /** The last surfaced signal events (newest last) and whether momentum blocks each, for the "blocked N of 40" line. */
    private surfacedRing: { key: string; blocked: boolean }[] = [];
    private liveKeys = new Set<string>();

    private history: SignalRecord[] = [];
    private trades: TradeRecord[] = [];
    private lastError: string | null = null;
    /** Informational: the last signal dropped by the quality gate. Cleared when a new signal takes over. */
    private dropNotice: string | null = null;
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
        if (!this.running) {
            this.session = this.freshSession();
        } else {
            // Target profit (and the other limits) can be changed while running and apply straight away.
            const reason = sessionStopReason(this.session, this.settings);
            if (reason) {
                this.stop(reason);
                return;
            }
        }
        // The board depends on the settings (engines, momentum, loss shield): rebuild it now instead of on the next scan.
        if (this.releaseEngine) this.loop();
        else this.emit();
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
        this.dropNotice = null;
        this.stopReason = null;
        this.buyErrors = 0;
        this.skipStreak = 0;
        this.cooldownUntil = 0;
        this.blocked.clear();
        this.marketRefusals.clear();
        this.quarantined.clear();
        this.carryLock = false;
        this.spent.clear();
        this.rest.clear();
        this.lastResultAt = 0;
        this.settling = false;
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
            this.active.locked = false;
            this.active.expiresAt = this.io.now() + this.settings.signalWaitSeconds * 1000; // the wait window starts at Run
            const record = this.history.find(r => r.signal.id === this.active?.signal.id);
            if (record && record.outcome === 'WATCHED') record.outcome = 'ACTIVE';
        }
        this.emit();
        this.tryFire();
    }

    stop(reason = 'Stopped') {
        if (!this.running) return;
        this.running = false;
        this.runToken += 1;
        this.stopReason = reason;
        this.tradeInFlight = false;
        this.settling = false;
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
        this.releaseFusion = this.io.fusion?.retain() ?? null;
        this.marketList = this.io.engine.markets?.() ?? [];
        this.loopTimer = setInterval(() => this.loop(), LOOP_MS);
        this.loop();
    }

    private maybeShutdown() {
        if (this.watchers > 0 || this.running) return;
        if (this.loopTimer) clearInterval(this.loopTimer);
        this.loopTimer = null;
        this.releaseTick?.();
        this.releaseTick = null;
        this.releaseFusion?.();
        this.releaseFusion = null;
        this.releaseEngine?.();
        this.releaseEngine = null;
        if (this.emitTimer) clearTimeout(this.emitTimer);
        this.emitTimer = null;
    }

    private loop() {
        try {
            this.qualityRejected = new Map();
            this.activeOpp = null;
            const sample = this.io.engine.sample((symbol, contractId, opp) => this.excludeCell(symbol, contractId, opp), {
                requireMomentum: this.settings.requireMomentum,
            });
            this.engineInfo = sample.info;
            this.noteVetted(sample.vetted ?? []);
            this.scan(sample);
            this.ingestBoard();
            this.applyQualityToActive();
        } catch (error) {
            this.engineInfo = { ...this.engineInfo, degraded: true, failsafes: ['ENGINE ERROR'] };
            this.lastError = error instanceof Error ? error.message : 'Sentinel engine sample failed.';
        }
        this.checkExpiry();
        this.emit();
        this.tryFire();
    }

    /** Records the momentum result of what surfaced (for the page) and hands it to the read-only outcome log. */
    private noteVetted(vetted: VettedCandidate[]) {
        this.vettedByKey = new Map();
        for (const candidate of vetted) {
            this.vettedByKey.set(signalKeyOf(candidate.opportunity), candidate);
        }
        for (const [key, candidate] of this.vettedByKey) {
            if (this.liveKeys.has(key)) {
                // Still surfaced: keep the newest event of this signal current (momentum can change while it is live).
                for (let i = this.surfacedRing.length - 1; i >= 0; i -= 1) {
                    if (this.surfacedRing[i].key === key) {
                        this.surfacedRing[i].blocked = candidate.blocked;
                        break;
                    }
                }
            } else {
                this.surfacedRing.push({ key, blocked: candidate.blocked });
            }
        }
        if (this.surfacedRing.length > RECENT_SURFACED) this.surfacedRing.splice(0, this.surfacedRing.length - RECENT_SURFACED);
        this.liveKeys = new Set(this.vettedByKey.keys());
        try {
            this.io.outcomes?.observe(vetted.map(candidate => toLogInput(candidate)));
        } catch {
            // The outcome log is observation only.
        }
    }

    /** True when a market x contract cell must not be traded: Deriv refused it, the market is out, or it fails the gate. */
    private excludeCell(symbol: string, contractId: string, opp: RankedOpportunity) {
        const key = `${symbol}|${contractId}`;
        // Remember the engine's live figures for the cell being traded, whatever the gate says about it.
        if (this.active && this.active.signal.key === key) this.activeOpp = opp;
        if (this.isBlocked(key)) return true;
        if (this.settings.excludedMarkets.includes(symbol) || this.quarantined.has(symbol)) return true;
        const verdict = qualityVerdict(opp, this.settings);
        if (!verdict.ok) {
            this.qualityRejected.set(key, `${opp.contract?.label ?? contractId} on ${opp.name || symbol}: ${verdict.reason}`);
            return true;
        }
        return false;
    }

    /**
     * Keeps the signal on screen in step with the engine and guards a signal that is still waiting for its entry digit.
     *  - The figures shown are always the engine's current ones for that signal (never a stale snapshot).
     *  - A waiting signal is only paused when it falls CLEARLY out of bounds (HOLD_TOLERANCE points past a limit, or
     *    the engine blocks it) and is dropped only if that lasts DROP_GRACE_MS. Small dips around a limit are ignored.
     *  - Once a Touch-once run has touched its entry, or a trade is in flight, quality never pauses or drops it:
     *    execution is continuous and only its own stop conditions end it.
     */
    private applyQualityToActive() {
        const active = this.active;
        const opp = this.activeOpp;
        this.activeOpp = null;
        if (!active || active.done) return;
        if (opp && !this.tradeInFlight && opp.contract && String(opp.contract.id) === active.signal.contractId) {
            const live = toSentinelAiSignal(opp, active.signal.receivedAt);
            active.signal = { ...live, id: active.signal.id, receivedAt: active.signal.receivedAt };
            const record = this.history.find(r => r.signal.id === active.signal.id);
            if (record) record.signal = active.signal;
        }
        const verdict = opp ? qualityVerdict(opp, this.settings, HOLD_TOLERANCE) : { ok: true, reason: null };
        if (verdict.ok || active.locked || this.tradeInFlight) {
            // Momentum (when required) keeps a signal that is still waiting for its entry from being traded while it
            // fails. It never pauses a trade in flight or a Touch-once run that has already touched its entry.
            const momentumHold = verdict.ok && !active.locked && !this.tradeInFlight ? this.momentumHold(active) : null;
            active.held = momentumHold !== null;
            active.holdReason = momentumHold;
            active.rejectedSince = null;
            return;
        }
        // Clearly out of bounds: never trade it, and drop it if it stays that way.
        active.held = true;
        active.holdReason = verdict.reason;
        active.rejectedSince = active.rejectedSince ?? this.io.now();
        if (this.io.now() - active.rejectedSince < DROP_GRACE_MS) return;
        active.done = true;
        this.spend(active.signal.key);
        const record = this.history.find(r => r.signal.id === active.signal.id);
        if (record && record.outcome === 'ACTIVE') record.outcome = active.runsDone > 0 ? 'TRADED' : 'SKIPPED';
        this.dropNotice = `Dropped ${active.signal.label} on ${active.signal.marketName}: ${verdict.reason}`;
        if (this.pending) this.activate(this.pending);
    }

    /** Why momentum currently blocks the active signal, or null when it does not. */
    private momentumHold(active: ActiveSignal): string | null {
        if (!this.settings.requireMomentum) return null;
        const candidate = this.vettedByKey.get(active.signal.key);
        if (!candidate || !candidate.blocked) return null;
        return `momentum: ${candidate.momentum.blockers[0] ?? 'recent digit movement does not favour this contract'}`;
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

    // ── the scanner ──────────────────────────────────────────────────────────────────────────────
    /** Marks a setup as worked, so the scanner looks at the next one instead of re-arming it straight away. */
    private spend(key: string) {
        this.spent.set(key, this.io.now() + SPENT_MS);
    }

    /** Extra score asked for right after a loss. It fades, so a quiet market can never freeze the session. */
    private pickyBump(now: number): number {
        if (!this.settings.pickyAfterLoss) return 0;
        return pickyBumpAfterLoss(this.session.consecutiveLosses, now - this.lastResultAt);
    }

    /** Markets resting after a loss: symbol -> trades left. Empty when the shield is off. */
    private restingMap(now: number): Map<string, number> {
        const out = new Map<string, number>();
        if (!this.settings.lossShield) return out;
        const active = this.active;
        // A signal that is part-way through its runs keeps its market: the user asked for several runs on it.
        const working = active && !active.done && !active.expired && active.runsDone > 0 ? active.signal.symbol : null;
        this.rest.forEach((entry, symbol) => {
            if (symbol === working) return;
            if (this.session.trades < entry.untilTrades && now < entry.untilAt) {
                out.set(symbol, entry.untilTrades - this.session.trades);
            }
        });
        return out;
    }

    /** Loss shield bookkeeping after a settled trade on `symbol`: a loss rests the market, a win clears it. */
    private updateShield(symbol: string, lost: boolean) {
        if (!lost) {
            this.rest.delete(symbol);
            return;
        }
        const streak = (this.rest.get(symbol)?.streak ?? 0) + 1;
        const wait = this.settings.restTrades * (streak >= 2 ? 2 : 1);
        this.rest.set(symbol, {
            untilTrades: this.session.trades + wait,
            untilAt: this.io.now() + REST_MAX_MS,
            streak,
        });
    }

    /**
     * Builds the board from what the engines see right now: every vetted Sentinel candidate (or Insight Fusion's own picks in
     * Fusion-leads mode), ranked, each with the reason it is or is not tradable. The scanner then arms the best tradable row.
     */
    private scan(sample: EngineSample) {
        const now = this.io.now();
        try {
            this.fusionRead = this.io.fusion ? this.io.fusion.read(now) : null;
        } catch {
            this.fusionRead = null; // Fusion is a second opinion; a failing read never stops the scanner.
        }
        const vetted: readonly VettedCandidate[] =
            sample.vetted ??
            (sample.surfaced ? [{ opportunity: sample.surfaced, momentum: PASSING_MOMENTUM, blocked: false }] : []);
        this.spent.forEach((until, key) => {
            if (until <= now) this.spent.delete(key);
        });
        const active = this.active;
        const working = active && !active.done && !active.expired ? active.signal.key : null;
        this.board = buildBoard({
            vetted,
            fusion: this.fusionRead,
            settings: this.settings,
            now,
            spent: new Set(this.spent.keys()),
            resting: this.restingMap(now),
            pickyBump: this.pickyBump(now),
            activeKey: working,
            isOut: (symbol, contractId) =>
                this.isBlocked(`${symbol}|${contractId}`) ||
                this.settings.excludedMarkets.includes(symbol) ||
                this.quarantined.has(symbol),
        });
        // A setup that has left the board and comes back later is a NEW setup: it is no longer "worked".
        const onBoard = new Set(this.board.rows.map(row => row.key));
        this.spent.forEach((_until, key) => {
            if (!onBoard.has(key)) this.spent.delete(key);
        });
    }

    /**
     * Arms the board's best tradable row. One NEW signal event per newly armed cell. A signal that is only waiting for its entry
     * digit keeps its place unless a clearly better setup appears (see SWITCH_MARGIN); one already trading is never abandoned,
     * and the newer pick waits its turn.
     */
    private ingestBoard() {
        const active = this.active;
        const live = active && !active.done && !active.expired ? active : null;
        const pick = choosePick(
            this.board,
            live ? { key: live.signal.key, hold: !live.locked && !this.tradeInFlight } : null,
            this.settings.engines
        );
        const incoming = pick ? (this.board.signals.get(pick.key) ?? null) : null;
        if (!incoming) {
            this.lastKey = null;
            return;
        }
        if (incoming.key !== this.lastKey) {
            this.lastKey = incoming.key;
            this.onNewSignal(incoming);
            return;
        }
        // Same cell still armed: refresh the entry point the engine currently recommends, unless a trade is already in flight on it.
        if (active && active.signal.key === incoming.key && !active.done && !this.tradeInFlight) {
            active.signal = { ...incoming, id: active.signal.id, receivedAt: active.signal.receivedAt };
            // Not running yet: the signal stays fresh for as long as the engine keeps surfacing it, so pressing Run
            // trades it instead of waiting for a new one. It still lapses once the engine stops surfacing it.
            if (!this.running && !active.locked) active.expiresAt = this.io.now() + this.settings.signalWaitSeconds * 1000;
            const record = this.history.find(r => r.signal.id === active.signal.id);
            if (record) record.signal = active.signal;
        }
    }

    private onNewSignal(signal: SentinelAiSignal) {
        this.alertSeq += 1;
        // While Run is on, the machine trades by itself and the Run Panel shows every trade: it does not announce each setup it arms.
        if (!this.running) {
            try {
                this.io.alert(signal, this.settings);
            } catch {
                // Alerts are best effort.
            }
        }

        const current = this.active;
        if (this.running && current && !current.done && (this.tradeInFlight || current.locked)) {
            // Never abandon an in-flight trade, and never pull a touch-once run off the market it is trading.
            // The newest signal waits its turn.
            this.pending = signal;
            this.pushHistory({ signal, outcome: current.locked ? 'WATCHED' : 'ACTIVE', runsDone: 0, pnl: 0 });
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
            locked: this.carryLock && this.settings.executionMode === 'touch_once',
            held: false,
            holdReason: null,
            rejectedSince: null,
        };
        this.dropNotice = null;
        this.carryLock = false;
        const existing = this.history.find(r => r.signal.id === signal.id);
        if (!existing) this.pushHistory({ signal, outcome: this.running ? 'ACTIVE' : 'WATCHED', runsDone: 0, pnl: 0 });
        else if (existing.outcome === 'WATCHED' && this.running) existing.outcome = 'ACTIVE';
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
        // Once the entry digit has been touched (touch-once mode) the signal no longer expires.
        if (!active || active.done || active.expired || active.locked || this.tradeInFlight) return;
        if (this.io.now() < active.expiresAt) return;
        active.expired = true;
        this.spend(active.signal.key);
        const record = this.history.find(r => r.signal.id === active.signal.id);
        if (record && record.outcome === 'ACTIVE') record.outcome = active.runsDone > 0 ? 'TRADED' : 'EXPIRED';
        if (this.pending) this.activate(this.pending);
    }

    private pushHistory(record: SignalRecord) {
        this.history = [record, ...this.history].slice(0, HISTORY_LIMIT);
    }

    // ── entry trigger ────────────────────────────────────────────────────────────────────────────
    /** The digit(s) the next trade waits for. Empty when nothing is waited for (immediate mode, or already touched). */
    private requirement(): { digits: number[]; source: EntrySource | null } {
        const active = this.active;
        if (!active || this.settings.executionMode === 'immediate' || active.locked) return { digits: [], source: null };
        return requiredEntry(active.signal, this.settings);
    }

    private onTick(symbol: string) {
        const active = this.active;
        if (!active || active.signal.symbol !== symbol) {
            return;
        }
        this.scheduleEmit();
        const mode = this.settings.executionMode;
        if (mode === 'immediate' || active.locked) {
            this.tryFire();
            return;
        }
        if (!this.running || this.tradeInFlight || active.done || active.expired) return;
        if (this.io.now() >= active.expiresAt) {
            this.checkExpiry();
            return;
        }
        if (active.held) return; // The quality gate rejects this signal right now: never trade it.
        const { digits } = this.requirement();
        if (digits.length === 0) return; // No entry digit and no default digits configured: nothing is traded.
        const digit = this.io.engine.getLastDigit(symbol);
        if (digit === null || !digits.includes(digit)) return; // The first required digit to print triggers the trade.
        // Touch-once: this is the one touch. From here on trades fire back to back without waiting for a digit.
        if (mode === 'touch_once') active.locked = true;
        void this.execute(digit);
    }

    /**
     * Fires the next trade without waiting for a digit: Immediate mode, or Touch-once mode after the entry was
     * touched. Trades go one at a time (the next only starts once the last has settled). It never trades blind: it
     * holds off during a retry cool-down and while the engine reports that its market feed is stale.
     */
    private tryFire() {
        if (!this.running) return;
        const mode = this.settings.executionMode;
        const active = this.active;
        if (!active || active.done || active.expired || this.tradeInFlight) return;
        if (!(mode === 'immediate' || (mode === 'touch_once' && active.locked))) return;
        if (this.io.now() < this.cooldownUntil) return;
        if (active.held) return; // Touch-once: the market fails the quality gate; trading resumes when it qualifies.
        if (!active.locked && this.io.now() >= active.expiresAt) {
            this.checkExpiry();
            return;
        }
        if (this.engineInfo.failsafes.includes('FEED STALE')) return;
        void this.execute(active.locked ? null : active.signal.entryDigit);
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

        const contract = tradeBarrier(signal, this.session.consecutiveLosses, this.settings);
        const parameters: Loose = {
            amount: stake,
            basis: 'stake',
            contract_type: signal.contractType,
            currency,
            duration: 1,
            duration_unit: 't',
            symbol: signal.symbol,
            barrier: String(contract.barrier),
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
            try {
                this.io.outcomes?.markTraded(
                    signal.symbol,
                    signal.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER',
                    signal.barrier
                );
            } catch {
                // The outcome log is observation only.
            }
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
                label: contract.label,
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
                this.finishTrade(contractId, null, active);
                return;
            }
            this.finishTrade(contractId, profit, active);
        } catch (error) {
            this.aborts.delete(abort);
            this.tradeInFlight = false;
            this.settling = false;
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
        const refusals = (this.marketRefusals.get(signal.symbol) ?? 0) + 1;
        this.marketRefusals.set(signal.symbol, refusals);
        if (refusals >= MAX_MARKET_REFUSALS) this.quarantined.add(signal.symbol);
        this.skipStreak += 1;
        if (active.locked) this.carryLock = true; // Touch-once keeps going on the next signal, no new touch needed.
        active.done = true;
        this.spend(signal.key);
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
        this.settling = false;
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
            this.lastResultAt = this.io.now();
            this.updateShield(active.signal.symbol, profit < 0);
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

        if (active.locked) {
            // Touch-once: keep firing until a limit, the target or Stop ends the session (runs per signal is ignored).
        } else if (active.runsDone >= active.runsTotal) {
            active.done = true;
            this.spend(active.signal.key);
            if (record) record.outcome = 'TRADED';
            if (this.pending) this.activate(this.pending);
        } else {
            // More runs for this signal: give the next entry its own wait window.
            active.expiresAt = this.io.now() + this.settings.signalWaitSeconds * 1000;
        }
        this.emit();
        this.tryFire();
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

    private momentumView(): MomentumView {
        const active = this.active;
        const candidate = active ? this.vettedByKey.get(active.signal.key) : undefined;
        let topBlocked: MomentumView['topBlocked'] = null;
        for (const entry of this.vettedByKey.values()) {
            if (!entry.blocked) continue;
            topBlocked = {
                label: entry.opportunity.contract?.label ?? String(entry.opportunity.contract?.id ?? ''),
                market: entry.opportunity.name || entry.opportunity.symbol,
                reason: entry.momentum.blockers[0] ?? 'recent digit movement does not favour this contract',
            };
            break;
        }
        return {
            enabled: this.settings.requireMomentum,
            current: candidate
                ? { pass: candidate.momentum.pass, score: candidate.momentum.score, blockers: candidate.momentum.blockers }
                : null,
            recentSurfaced: this.surfacedRing.length,
            recentBlocked: this.surfacedRing.filter(entry => entry.blocked).length,
            topBlocked,
        };
    }

    /** Where the scanner is in its cycle: scanning for a setup, armed and waiting for its entry, buying, in a trade, or paused. */
    private phase(): Phase {
        if (!this.running) return 'idle';
        if (this.engineInfo.status !== 'live') return 'connecting';
        if (this.tradeInFlight) return this.settling ? 'settling' : 'buying';
        if (this.io.now() < this.cooldownUntil) return 'cooling';
        const active = this.active;
        return active && !active.done && !active.expired ? 'armed' : 'scanning';
    }

    private buildSnapshot(): SentinelAiSnapshot {
        const active = this.active;
        const now = this.io.now();
        const activeRow = active ? this.board.rows.find(row => row.key === active.signal.key) : undefined;
        const { digits: requiredDigits, source: entrySource } = this.requirement();
        let signalState: ActiveSignalState | null = null;
        if (active) {
            if (active.done) signalState = 'DONE';
            else if (active.expired) signalState = 'EXPIRED';
            else if (this.tradeInFlight) signalState = 'TRADING';
            else if (!this.running) signalState = 'WATCHING';
            else if (active.held) signalState = 'HELD';
            else if (active.locked) signalState = 'LOCKED';
            else if (this.settings.executionMode === 'immediate') signalState = 'READY';
            else signalState = requiredDigits.length === 0 ? 'NO_ENTRY_DIGIT' : 'WAITING_ENTRY';
        }
        const secondsLeft =
            active && !active.done && !active.expired && !active.locked
                ? Math.max(0, Math.ceil((active.expiresAt - this.io.now()) / 1000))
                : 0;

        const resting = Array.from(this.restingMap(now), ([symbol, tradesLeft]) => ({
            symbol,
            name: this.marketList.find(market => market.symbol === symbol)?.name ?? symbol,
            tradesLeft,
        }));

        return {
            status: this.running ? 'RUNNING' : this.watchers > 0 ? 'WATCHING' : 'IDLE',
            phase: this.phase(),
            board: this.board.rows.slice(0, BOARD_ROWS),
            markets: marketDots(this.board, this.marketList),
            fusion: {
                enabled: this.settings.engines !== 'sentinel',
                ready: this.fusionRead?.ready ?? 0,
                total: this.fusionRead?.total ?? 0,
            },
            consensus: activeRow ? activeRow.fusion : null,
            resting,
            pickyBump: this.pickyBump(now),
            engine: this.engineInfo,
            signal: active ? active.signal : null,
            signalState,
            requiredDigits,
            entrySource: active ? entrySource : null,
            locked: Boolean(active?.locked),
            recovering: this.settings.recoveryBarrierEnabled && this.session.consecutiveLosses > 0,
            filtered: {
                count: this.qualityRejected.size,
                example: this.qualityRejected.size ? (this.qualityRejected.values().next().value ?? null) : null,
            },
            quarantined: Array.from(this.quarantined),
            nextBarrier: active ? tradeBarrier(active.signal, this.session.consecutiveLosses, this.settings).barrier : null,
            nextLabel: active ? tradeBarrier(active.signal, this.session.consecutiveLosses, this.settings).label : null,
            lastDigit: active ? this.io.engine.getLastDigit(active.signal.symbol) : null,
            runsDone: active ? active.runsDone : 0,
            runsTotal: active ? active.runsTotal : this.settings.runsPerSignal,
            secondsLeft,
            session: this.session,
            history: this.history,
            trades: this.trades,
            lastError: this.lastError,
            dropNotice: this.dropNotice,
            holdReason: active?.holdReason ?? null,
            momentum: this.momentumView(),
            stopReason: this.stopReason,
            alertSeq: this.alertSeq,
            settings: this.settings,
        };
    }
}
