// SIGNAL ZONE: the stop loss and the live session read-out. Framework-free and unit-testable.
//
// The Masika bots have no stop-loss variable and their logic is deliberately left alone, so the stop loss is enforced here:
// the app-level bridge feeds this class the run panel's state, and when the session's loss reaches the limit the bridge stops
// the bot through the run panel's own stop action. The class lives at app level (not in the page) because the user presses Run
// in Bot Builder, when the Signal Zone page is no longer on screen.

export type SessionSnapshot = {
    /** True after Load Bot, until Disarm. While armed, every run is guarded by the stop loss. */
    armed: boolean;
    /** 0 = off. */
    stopLoss: number;
    /** What was loaded, for the status line (e.g. "Under 8 on Volatility 25, entry digit 4"). */
    label: string;
    armedAt: number | null;
    running: boolean;
    /** Profit/loss of the current (or last) run; null before any run has been seen. */
    pnl: number | null;
    /** Set when the stop loss stopped a run; cleared when the next run starts. */
    stoppedBy: string | null;
    /** Result of the last Load Bot, kept here because the page is left when the Bot Builder opens. */
    loadStatus: { ok: boolean; message: string; at: number } | null;
};

export type RunInput = { running: boolean; runId: string; total: number };

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const stopLossHit = (pnl: number, stopLoss: number): boolean => stopLoss > 0 && pnl <= -stopLoss;

const INITIAL: SessionSnapshot = {
    armed: false, stopLoss: 0, label: '', armedAt: null, running: false, pnl: null, stoppedBy: null, loadStatus: null,
};

export class SignalZoneSession {
    private snap: SessionSnapshot = { ...INITIAL };
    private readonly listeners = new Set<() => void>();
    private runId: string | null = null;
    private baseline = 0;
    private stopRequested = false;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    getSnapshot = (): SessionSnapshot => this.snap;

    private set(patch: Partial<SessionSnapshot>) {
        const next = { ...this.snap, ...patch };
        if ((Object.keys(next) as Array<keyof SessionSnapshot>).every(key => Object.is(next[key], this.snap[key]))) return;
        this.snap = next;
        this.listeners.forEach(listener => { try { listener(); } catch { /* a listener must never break the session */ } });
    }

    arm(stopLoss: number, label: string, now: number) {
        this.set({ armed: true, stopLoss: Math.max(0, stopLoss), label, armedAt: now, stoppedBy: null });
    }

    disarm() {
        this.set({ armed: false, stopLoss: 0, label: '', armedAt: null });
    }

    setLoadStatus(ok: boolean, message: string, now: number) {
        this.set({ loadStatus: { ok, message, at: now } });
    }

    /**
     * Feed the run panel's state here whenever it changes. Returns true when the bot must be stopped now (once per run).
     * The loss of a run is measured from the account total seen when that run started.
     */
    observe(input: RunInput): boolean {
        if (!input.running) {
            this.runId = null;
            this.set({ running: false });
            return false;
        }
        if (this.runId !== input.runId) {
            this.runId = input.runId;
            this.baseline = input.total;
            this.stopRequested = false;
            this.set({ running: true, pnl: 0, stoppedBy: null });
        }
        const pnl = round2(input.total - this.baseline);
        this.set({ running: true, pnl });
        if (this.snap.armed && !this.stopRequested && stopLossHit(pnl, this.snap.stopLoss)) {
            this.stopRequested = true;
            this.set({ stoppedBy: `Stop loss reached (${pnl.toFixed(2)})` });
            return true;
        }
        return false;
    }
}

export const signalZoneSession = new SignalZoneSession();
