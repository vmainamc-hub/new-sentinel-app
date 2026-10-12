// SENTINEL AI — signal outcome log (runtime observer).
//
// Read-only observation. It never delays, blocks, reorders or changes signals, ranking or execution, and every public
// method swallows its own failures so a logging problem can never reach the engine or the runner.
import {
    emptyLogState,
    inferDecimals,
    logSurfaced,
    markTraded,
    parseStoredRecords,
    resolveRecord,
    toCsv,
    type LogState,
    type SignalLogRecord,
    type SurfacedSignalInput,
    type Tick,
} from './sentinel-ai-outcomes';

export const OUTCOME_LOG_KEY = 'sentinel_ai_signal_log_v1';
const SAVE_DELAY_MS = 2_000;

export type OutcomeLogIO = {
    /** Recent ticks of a market, oldest first (t in ms). */
    getTicks: (symbol: string) => Tick[];
    getPipSize: (symbol: string) => number;
    onTick: (callback: (symbol: string) => void) => () => void;
    now: () => number;
    load: () => unknown;
    save: (records: SignalLogRecord[]) => void;
};

/** What the runner reports for each surfaced signal. */
export type OutcomeSink = {
    observe: (signals: readonly SurfacedSignalInput[]) => void;
    markTraded: (symbol: string, contract: SurfacedSignalInput['contract'], barrier: number | null) => void;
};

export class SignalOutcomeLog implements OutcomeSink {
    private readonly io: OutcomeLogIO;
    private state: LogState;
    private version = 0;
    private listeners = new Set<() => void>();
    private releaseTick: (() => void) | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private decimals = new Map<string, number>();

    constructor(io: OutcomeLogIO) {
        this.io = io;
        let records: SignalLogRecord[] = [];
        try {
            records = parseStoredRecords(io.load());
        } catch {
            records = [];
        }
        this.state = emptyLogState(records);
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    /** Changes whenever the records change (useSyncExternalStore snapshot). */
    getVersion = () => this.version;

    getRecords = (): SignalLogRecord[] => this.state.records;

    toCsv = (): string => toCsv(this.state.records);

    observe = (signals: readonly SurfacedSignalInput[]) => {
        try {
            const now = this.io.now();
            this.ensureTickListener();
            const before = this.state.records;
            this.state = logSurfaced(this.state, signals, now, symbol => this.latestEpoch(symbol));
            this.sweep(now);
            if (this.state.records !== before) this.changed();
        } catch {
            // Logging must never affect the engine.
        }
    };

    markTraded = (symbol: string, contract: SurfacedSignalInput['contract'], barrier: number | null) => {
        try {
            const key = `${symbol}|${contract}|${barrier ?? ''}`;
            const next = markTraded(this.state.records, key);
            if (next !== this.state.records) {
                this.state = { ...this.state, records: next };
                this.changed();
            }
        } catch {
            // Ignore.
        }
    };

    clear = () => {
        try {
            this.state = emptyLogState([]);
            this.changed(true);
        } catch {
            // Ignore.
        }
    };

    dispose() {
        this.releaseTick?.();
        this.releaseTick = null;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.listeners.clear();
    }

    // ── internals ────────────────────────────────────────────────────────────────────────────────
    private ensureTickListener() {
        if (this.releaseTick) return;
        this.releaseTick = this.io.onTick(symbol => this.onTick(symbol));
    }

    private latestEpoch(symbol: string): number | null {
        try {
            const ticks = this.io.getTicks(symbol);
            const last = ticks.length ? ticks[ticks.length - 1] : null;
            return last && Number.isFinite(last.t) ? last.t : null;
        } catch {
            return null;
        }
    }

    private decimalsOf(symbol: string, ticks: Tick[]): number {
        const pip = this.io.getPipSize(symbol);
        const found = inferDecimals(
            ticks.map(tick => tick.price),
            pip
        );
        const known = Math.max(this.decimals.get(symbol) ?? 0, found);
        this.decimals.set(symbol, known);
        return known;
    }

    private onTick(symbol: string) {
        try {
            if (!this.state.records.some(r => r.state === 'pending' && r.symbol === symbol)) return;
            this.resolveMarket(symbol, this.io.now());
        } catch {
            // Ignore.
        }
    }

    private resolveMarket(symbol: string, now: number) {
        const ticks = this.io.getTicks(symbol);
        const decimals = this.decimalsOf(symbol, ticks);
        let changed = false;
        const records = this.state.records.map(record => {
            if (record.state !== 'pending' || record.symbol !== symbol) return record;
            const next = resolveRecord(record, ticks, decimals, now);
            if (next !== record) changed = true;
            return next;
        });
        if (changed) {
            this.state = { ...this.state, records };
            this.changed();
        }
    }

    /** Resolves what can be resolved and times out the rest, for every market with pending records. */
    private sweep(now: number) {
        const symbols = new Set<string>();
        for (const record of this.state.records) if (record.state === 'pending') symbols.add(record.symbol);
        symbols.forEach(symbol => this.resolveMarket(symbol, now));
    }

    private changed(immediate = false) {
        this.version += 1;
        this.listeners.forEach(listener => {
            try {
                listener();
            } catch {
                // A UI listener must not break logging.
            }
        });
        if (immediate) {
            if (this.saveTimer) clearTimeout(this.saveTimer);
            this.saveTimer = null;
            this.persist();
            return;
        }
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.persist();
        }, SAVE_DELAY_MS);
    }

    private persist() {
        try {
            this.io.save(this.state.records);
        } catch {
            // Storage can be full or blocked; the log then lives for this session only.
        }
    }
}

/** Browser storage helpers: one key, always wrapped. Only log records are stored (no tokens, no account ids). */
export const loadStoredRecords = (): unknown => {
    try {
        const raw = window.localStorage.getItem(OUTCOME_LOG_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
};

export const saveStoredRecords = (records: SignalLogRecord[]) => {
    try {
        window.localStorage.setItem(OUTCOME_LOG_KEY, JSON.stringify(records));
    } catch {
        // Unavailable or full.
    }
};
