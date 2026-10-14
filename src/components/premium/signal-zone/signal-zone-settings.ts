// SIGNAL ZONE: settings, defaults, validation and persistence. Pure apart from load/save (localStorage, guarded).
import { ALLOWED_BARRIERS } from '../over-under-engine';

export type MergeMode = 'both' | 'fusion_leads' | 'sentinel_only';

export const MIN_STAKE = 0.35;
export const SETTINGS_KEY = 'signalzone.settings.v1';

export type SignalZoneSettings = {
    mergeMode: MergeMode;
    /** Base stake per trade (written to the bot's `Stake`). */
    stake: number;
    /** Written to the bot's `Martangle` (stake multiplier after a loss). 1 = flat stakes. */
    martingaleMultiplier: number;
    /** Written to the bot's `Martangle Level`: the bot stops after this many losses in a row. */
    martingaleLevel: number;
    /** Written to the bot's `Max Stake` (hard ceiling for any single stake). */
    maxStake: number;
    /** Written to the bot's `Take Profit` (the bot compares its total profit with it and stops). 0 would stop immediately, so it is required. */
    takeProfit: number;
    /** Enforced by Signal Zone itself, outside the bot. 0 = off. */
    stopLoss: number;
    /** Over signals recover on this barrier (Over 1/2/3). */
    recoveryOverBarrier: number;
    /** Under signals recover on this barrier (Under 8/7/6). */
    recoveryUnderBarrier: number;
    /** Sentinel quality gate. 0 = off. */
    minScore: number;
    /** Sentinel quality gate. 0 = off. */
    maxDanger: number;
    requireMomentum: boolean;
    skipBlocked: boolean;
    excludedMarkets: string[];
};

export const DEFAULT_SETTINGS: SignalZoneSettings = {
    mergeMode: 'both',
    stake: 1,
    martingaleMultiplier: 2,
    martingaleLevel: 4,
    maxStake: 8,
    takeProfit: 3,
    stopLoss: 10,
    recoveryOverBarrier: 3,
    recoveryUnderBarrier: 6,
    minScore: 0,
    maxDanger: 0,
    requireMomentum: true,
    skipBlocked: true,
    excludedMarkets: [],
};

const MERGE_MODES: readonly MergeMode[] = ['both', 'fusion_leads', 'sentinel_only'];

const finite = (value: unknown, fallback: number): number => {
    const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    return Number.isFinite(n) ? n : fallback;
};
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Accepts anything (parsed JSON, partial objects) and returns a complete, well-typed settings object. */
export const normalizeSettings = (raw: unknown): SignalZoneSettings => {
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const d = DEFAULT_SETTINGS;
    const mode = MERGE_MODES.includes(source.mergeMode as MergeMode) ? (source.mergeMode as MergeMode) : d.mergeMode;
    return {
        mergeMode: mode,
        stake: round2(finite(source.stake, d.stake)),
        martingaleMultiplier: round2(finite(source.martingaleMultiplier, d.martingaleMultiplier)),
        martingaleLevel: Math.round(finite(source.martingaleLevel, d.martingaleLevel)),
        maxStake: round2(finite(source.maxStake, d.maxStake)),
        takeProfit: round2(finite(source.takeProfit, d.takeProfit)),
        stopLoss: Math.max(0, round2(finite(source.stopLoss, d.stopLoss))),
        recoveryOverBarrier: Math.round(finite(source.recoveryOverBarrier, d.recoveryOverBarrier)),
        recoveryUnderBarrier: Math.round(finite(source.recoveryUnderBarrier, d.recoveryUnderBarrier)),
        minScore: Math.max(0, Math.round(finite(source.minScore, d.minScore))),
        maxDanger: Math.max(0, Math.round(finite(source.maxDanger, d.maxDanger))),
        requireMomentum: typeof source.requireMomentum === 'boolean' ? source.requireMomentum : d.requireMomentum,
        skipBlocked: typeof source.skipBlocked === 'boolean' ? source.skipBlocked : d.skipBlocked,
        excludedMarkets: Array.isArray(source.excludedMarkets)
            ? Array.from(new Set(source.excludedMarkets.map(item => String(item).trim()).filter(Boolean)))
            : [...d.excludedMarkets],
    };
};

/** Plain-words problems with the settings. An empty list means the settings can be written into a bot. */
export const validateSettings = (settings: SignalZoneSettings): string[] => {
    const problems: string[] = [];
    if (!(settings.stake >= MIN_STAKE)) problems.push(`Stake must be at least ${MIN_STAKE}.`);
    if (!(settings.martingaleMultiplier >= 1)) problems.push('Martingale multiplier must be 1 or more (1 keeps the stake flat).');
    if (!Number.isInteger(settings.martingaleLevel) || settings.martingaleLevel < 1) problems.push('Martingale level must be a whole number, 1 or more.');
    if (!(settings.maxStake >= settings.stake)) problems.push('Max stake must be at least the stake.');
    if (!(settings.takeProfit > 0)) problems.push('Take profit must be above 0.');
    if (!(settings.stopLoss >= 0)) problems.push('Stop loss cannot be negative (0 turns it off).');
    if (!ALLOWED_BARRIERS.DIGITOVER.includes(settings.recoveryOverBarrier)) problems.push('Recovery Over barrier must be 1, 2 or 3.');
    if (!ALLOWED_BARRIERS.DIGITUNDER.includes(settings.recoveryUnderBarrier)) problems.push('Recovery Under barrier must be 8, 7 or 6.');
    return problems;
};

export const loadSettings = (): SignalZoneSettings => {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return { ...DEFAULT_SETTINGS, excludedMarkets: [] };
    }
};

export const saveSettings = (settings: SignalZoneSettings): void => {
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Storage can be unavailable (private mode); settings then live for this session only.
    }
};
