// SENTINEL AI — shared types and settings.
//
// The Sentinel Signal Engine (src/lib/**) is the backend and is never modified here. Everything in
// src/pages/sentinel-ai is the frontend/execution layer that READS the engine's surfaced signals.

export type MartingaleMode = 'off' | 'after_1' | 'after_2' | 'custom';

/**
 * `entry_digit` (default): a signal waits for its entry digit to print, then buys.
 * `immediate`: a signal is traded the moment it arrives; the entry digit is not waited for.
 */
export type ExecutionMode = 'entry_digit' | 'immediate';

export type SentinelAiSettings = {
    executionMode: ExecutionMode;
    /** Base stake per trade. */
    stake: number;
    martingaleMode: MartingaleMode;
    /** Used by the `custom` mode: martingale engages after this many consecutive losses. */
    martingaleCustomLosses: number;
    martingaleMultiplier: number;
    /** 0 = unlimited. After this many martingale steps the stake resets to the base stake. */
    martingaleMaxSteps: number;
    /** 0 = no cap. Hard ceiling for any single stake. */
    maxStake: number;
    /** While recovering from a loss, enter on `recoveryDigit` instead of the signal's own entry digit. */
    recoveryDigitEnabled: boolean;
    recoveryDigit: number;
    /** After a win, keep the recovery stake until the session P/L is back above zero. */
    recoverToBreakeven: boolean;
    /** How many consecutive trades are taken for each signal (each waits for the entry digit unless mode is immediate). */
    runsPerSignal: number;
    /** 0 = off. */
    takeProfit: number;
    /** 0 = off. */
    stopLoss: number;
    /** 0 = off. */
    maxTrades: number;
    /** 0 = off. */
    maxConsecutiveLosses: number;
    /** How long a signal may wait for its entry digit before it is dropped. */
    signalWaitSeconds: number;
    alertVisual: boolean;
    alertVibrate: boolean;
    alertNotify: boolean;
    alertTitle: boolean;
};

export const MIN_STAKE = 0.35;

export const DEFAULT_SETTINGS: SentinelAiSettings = {
    executionMode: 'entry_digit',
    stake: 1,
    martingaleMode: 'after_1',
    martingaleCustomLosses: 3,
    martingaleMultiplier: 2,
    martingaleMaxSteps: 0,
    maxStake: 0,
    recoveryDigitEnabled: false,
    recoveryDigit: 8,
    recoverToBreakeven: false,
    runsPerSignal: 1,
    takeProfit: 100,
    stopLoss: 100,
    maxTrades: 0,
    maxConsecutiveLosses: 0,
    signalWaitSeconds: 45,
    alertVisual: true,
    alertVibrate: true,
    alertNotify: true,
    alertTitle: true,
};

const SETTINGS_KEY = 'sentinel_ai_settings_v1';

const num = (value: unknown, fallback: number, min: number, max: number, integer = false) => {
    const parsed = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.min(max, Math.max(min, parsed));
    return integer ? Math.round(clamped) : clamped;
};

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

const MODES: MartingaleMode[] = ['off', 'after_1', 'after_2', 'custom'];
const EXECUTION_MODES: ExecutionMode[] = ['entry_digit', 'immediate'];

/** Validates and clamps a (possibly partial / hand-edited / stale) settings object. */
export const normalizeSettings = (raw: unknown, base: SentinelAiSettings = DEFAULT_SETTINGS): SentinelAiSettings => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        executionMode: EXECUTION_MODES.includes(r.executionMode as ExecutionMode)
            ? (r.executionMode as ExecutionMode)
            : base.executionMode,
        stake: num(r.stake, base.stake, MIN_STAKE, 100000),
        martingaleMode: MODES.includes(r.martingaleMode as MartingaleMode)
            ? (r.martingaleMode as MartingaleMode)
            : base.martingaleMode,
        martingaleCustomLosses: num(r.martingaleCustomLosses, base.martingaleCustomLosses, 1, 10, true),
        martingaleMultiplier: num(r.martingaleMultiplier, base.martingaleMultiplier, 1.01, 100),
        martingaleMaxSteps: num(r.martingaleMaxSteps, base.martingaleMaxSteps, 0, 50, true),
        maxStake: num(r.maxStake, base.maxStake, 0, 1000000),
        recoveryDigitEnabled: bool(r.recoveryDigitEnabled, base.recoveryDigitEnabled),
        recoveryDigit: num(r.recoveryDigit, base.recoveryDigit, 0, 9, true),
        recoverToBreakeven: bool(r.recoverToBreakeven, base.recoverToBreakeven),
        runsPerSignal: num(r.runsPerSignal, base.runsPerSignal, 1, 10, true),
        takeProfit: num(r.takeProfit, base.takeProfit, 0, 1000000),
        stopLoss: num(r.stopLoss, base.stopLoss, 0, 1000000),
        maxTrades: num(r.maxTrades, base.maxTrades, 0, 100000, true),
        maxConsecutiveLosses: num(r.maxConsecutiveLosses, base.maxConsecutiveLosses, 0, 50, true),
        signalWaitSeconds: num(r.signalWaitSeconds, base.signalWaitSeconds, 10, 600, true),
        alertVisual: bool(r.alertVisual, base.alertVisual),
        alertVibrate: bool(r.alertVibrate, base.alertVibrate),
        alertNotify: bool(r.alertNotify, base.alertNotify),
        alertTitle: bool(r.alertTitle, base.alertTitle),
    };
};

export const loadSettings = (): SentinelAiSettings => {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
};

export const saveSettings = (settings: SentinelAiSettings) => {
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Storage can be unavailable (private mode); settings then live for this session only.
    }
};

/** A signal as consumed by the Sentinel AI frontend. Always carries its entry point. */
export type SentinelAiSignal = {
    /** Unique event id: `${symbol}|${contractId}@${receivedAt}`. */
    id: string;
    /** `${symbol}|${contractId}` — stable while the engine keeps surfacing the same cell. */
    key: string;
    symbol: string;
    marketName: string;
    contractId: string;
    contractType: 'DIGITOVER' | 'DIGITUNDER';
    barrier: number;
    /** e.g. "Under 7". */
    label: string;
    /** The observed last digit on which to enter. Null until the engine validates one — never invented. */
    entryDigit: number | null;
    entryStatus: string;
    entryWindow: string;
    /** Historical win rate (%) when this entry digit is showing, if the engine measured it. */
    entryWinRate: number | null;
    score: number;
    confidence: number;
    /** Sentinel's own classification label, shown for information. */
    status: string;
    reason: string;
    receivedAt: number;
};

export type SignalOutcome = 'ACTIVE' | 'TRADED' | 'EXPIRED' | 'REPLACED' | 'STOPPED' | 'WATCHED' | 'SKIPPED';

export type SignalRecord = {
    signal: SentinelAiSignal;
    outcome: SignalOutcome;
    runsDone: number;
    pnl: number;
};

export type TradeRecord = {
    contractId: number;
    signalId: string;
    symbol: string;
    label: string;
    entryDigit: number | null;
    stake: number;
    profit: number | null;
    status: 'open' | 'won' | 'lost';
    at: number;
};

export type SessionStats = {
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
    consecutiveLosses: number;
    currentStake: number;
    martingaleStep: number;
};

export type EngineInfo = {
    status: 'idle' | 'connecting' | 'live' | 'error';
    online: number;
    total: number;
    degraded: boolean;
    failsafes: string[];
    dangerLabel: string;
};

export type RunnerStatus = 'IDLE' | 'WATCHING' | 'RUNNING';

export type ActiveSignalState =
    | 'READY'
    | 'WAITING_ENTRY'
    | 'NO_ENTRY_DIGIT'
    | 'TRADING'
    | 'WATCHING'
    | 'EXPIRED'
    | 'DONE';

export type SentinelAiSnapshot = {
    status: RunnerStatus;
    engine: EngineInfo;
    signal: SentinelAiSignal | null;
    signalState: ActiveSignalState | null;
    /** Digit that must print for the next trade (signal entry digit, or recovery digit when recovering). */
    requiredDigit: number | null;
    recovering: boolean;
    lastDigit: number | null;
    runsDone: number;
    runsTotal: number;
    secondsLeft: number;
    session: SessionStats;
    history: SignalRecord[];
    trades: TradeRecord[];
    lastError: string | null;
    stopReason: string | null;
    /** Increments for every new signal event so the UI can flash/animate. */
    alertSeq: number;
    settings: SentinelAiSettings;
};
