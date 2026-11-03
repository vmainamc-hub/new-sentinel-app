// SENTINEL AI EDGE: switches and limits for the three gates. Stored apart from the engine and trading settings, so nothing that
// already reads those changes shape. There is no screen for these: they default to ON and are changed through `sentinelEdge`
// (see runner-instance.ts), which is also where the results are read.
import { DEFAULT_FREQUENCY, type FrequencyConfig } from './danger';

export type EdgeSettings = FrequencyConfig & {
    /** Kalman signal health: vetoes and re-ranks by the filtered win rate and its drift. */
    kalman: boolean;
    /** Cross-market danger: a global hold when the markets turn hostile together. */
    danger: boolean;
    /** Signal frequency: cooldown after a trade, hold-through-scans, hourly budget. */
    frequency: boolean;
    /** One pick per market, no contradictions, second source counts. */
    arbiter: boolean;
    /**
     * Shadow mode: the gates still read everything and keep their results, but change nothing the runner sees. Use it to measure
     * the same signals without the gates (see `report()`), then switch it off.
     */
    shadow: boolean;
};

export const DEFAULT_EDGE: EdgeSettings = {
    ...DEFAULT_FREQUENCY,
    kalman: true,
    danger: true,
    frequency: true,
    arbiter: true,
    shadow: false,
};

const num = (raw: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    return Math.min(hi, Math.max(lo, n));
};
const flag = (raw: unknown, fallback: boolean): boolean => (typeof raw === 'boolean' ? raw : fallback);

/** Accepts anything and returns a complete, in-range object. */
export const normalizeEdge = (raw: unknown): EdgeSettings => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const d = DEFAULT_EDGE;
    return {
        kalman: flag(s.kalman, d.kalman),
        danger: flag(s.danger, d.danger),
        frequency: flag(s.frequency, d.frequency),
        arbiter: flag(s.arbiter, d.arbiter),
        shadow: flag(s.shadow, d.shadow),
        cooldownMs: Math.round(num(s.cooldownMs, d.cooldownMs, 0, 600_000)),
        minHoldScans: Math.round(num(s.minHoldScans, d.minHoldScans, 0, 20)),
        hourlyBudget: Math.round(num(s.hourlyBudget, d.hourlyBudget, 0, 500)),
    };
};

const KEY = 'sentinelai.edge.settings.v1';

export const loadEdge = (): EdgeSettings => {
    try {
        const raw = window.localStorage.getItem(KEY);
        return normalizeEdge(raw ? JSON.parse(raw) : null);
    } catch {
        return { ...DEFAULT_EDGE };
    }
};
export const saveEdge = (s: EdgeSettings): void => {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        /* not remembered */
    }
};
