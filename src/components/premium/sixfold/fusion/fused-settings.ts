// SIXFOLD (fused): its settings. The fused tool is Sixfold's runner, so these are Sixfold's own settings with the defaults that make it
// the one tool Sixfold and Vanguard became:
//   - every market (Sixfold's ten, the other Volatility indices and the Jump indices) is watched at once, and the first contract to
//     show its entry is bought (execution 'FIRST', the way Vanguard worked);
//   - the entry is a STUDIED digit (entry 'SMART' with the overlay's entry trigger): the digit is worked out from the market's own
//     history and the trade goes out on the first new tick that shows it (the way Sentinel AI and Apex Intel do it);
//   - the pressure / window / winning-side checks are no longer hard gates: they vote in the consensus (see consensus.ts). The runner
//     keeps its own protections at the entry digit (red run, loss abort), the loss shield, the Meter and every money limit.
// Stored under its own key. A first run copies the money settings (stake, take profit, stop loss, contracts, recovery) the person had
// in the old Sixfold, and nothing else, so an old Best-score / Brain setup does not come back.
import { DEFAULT_SETTINGS, normalizeSettings, type SixfoldSettings } from '../money';
import { ALL_SYMBOLS } from '../markets';

export const FUSED_STORAGE_KEY = 'sixfold.fused.settings.v1';
const LEGACY_KEY = 'sixfold.auto.settings.v1';

export const FUSED_DEFAULTS: SixfoldSettings = {
    ...DEFAULT_SETTINGS,
    markets: [...ALL_SYMBOLS],
    execution: 'FIRST',
    entry: 'SMART',
    recoveryEntry: 'OFF',
    selectivity: 'balanced',
    // The votes replace these hard gates. (The entry digit's own protections in the runner stay on regardless.)
    winStreakGate: false,
    pressureGate: false,
    multiWindowGate: false,
    winPressureGate: false,
    // No opening paper trade: the first signal is a real one, as on Vanguard. The Virtual Hook stays available.
    vhOpening: false,
    virtualHook: false,
    virtualMode: false,
    virtualLosses: 2,
    gateMin: 1,
    // The Meter stays, with a floor low enough that it only turns away a market that is clearly cold.
    meterGuide: true,
    meterFloor: 40,
    meterFloorRecovery: 45,
};

/** The money and contract settings carried over from the old Sixfold. */
export const CARRIED_KEYS: ReadonlyArray<keyof SixfoldSettings> = [
    'useOver', 'primaryOver', 'useUnder', 'primaryUnder', 'stake', 'takeProfit', 'stopLoss', 'maxTrades', 'maxConsecutiveLosses',
    'martingale', 'multiplier', 'recoverySizing', 'recoverShare', 'streakBudget', 'maxSteps', 'maxStake',
    'recovery', 'recoveryOver', 'recoveryUnder', 'duration',
];

export function carryOver(legacy: unknown): Partial<SixfoldSettings> {
    if (!legacy || typeof legacy !== 'object') return {};
    const src = legacy as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of CARRIED_KEYS) if (src[k] !== undefined) out[k] = src[k];
    return out as Partial<SixfoldSettings>;
}

export function loadFusedSettings(): SixfoldSettings {
    try {
        const raw = window.localStorage.getItem(FUSED_STORAGE_KEY);
        if (raw) return normalizeSettings(JSON.parse(raw), FUSED_DEFAULTS);
        const legacy = window.localStorage.getItem(LEGACY_KEY);
        return normalizeSettings({ ...FUSED_DEFAULTS, ...carryOver(legacy ? JSON.parse(legacy) : null) }, FUSED_DEFAULTS);
    } catch {
        return { ...FUSED_DEFAULTS };
    }
}

export function saveFusedSettings(settings: SixfoldSettings) {
    try {
        window.localStorage.setItem(FUSED_STORAGE_KEY, JSON.stringify(settings));
    } catch {
        /* storage unavailable: settings simply are not remembered */
    }
}
