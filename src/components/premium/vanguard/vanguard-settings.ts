// VANGUARD: its own settings, stored under its own key so nothing is shared with Sixfold's saved settings.
import { DEFAULT_SETTINGS, normalizeSettings, type SixfoldSettings } from '../sixfold/money';
import { ALL_SYMBOLS } from '../sixfold/markets';

export const VANGUARD_MODULE_ID = 'vanguard';
const STORAGE_KEY = 'vanguard.settings.v1';

/**
 * Vanguard runs the "Sentinel Under 7 Psychology" bot's entry rules on every market, and buys through Sixfold's trade machinery.
 *   - Contracts: Under 7 (the bot's own, recovery Under 6) and Over 2 (the same rules mirrored, recovery Over 3).
 *   - Recovery stake: sized so one win pays back half the open loss (the bot's "martingale split 2"), with Sixfold's caps kept
 *     (a maximum number of steps and a streak budget), which the bot did not have.
 *   - Stake, take profit and stop loss are Sixfold's defaults, not the bot's placeholders (stake 3 with take profit 1 and stop loss 1
 *     would stop after one trade). Change them on the page.
 *   - Paper mode: the bot starts by paper-trading and goes real after two paper losses; a real win sends it back. It can be switched off.
 */
export const VANGUARD_DEFAULTS: SixfoldSettings = {
    ...DEFAULT_SETTINGS,
    markets: [...ALL_SYMBOLS],
    execution: 'FIRST',
    useOver: true,
    primaryOver: 2,
    recoveryOver: 3,
    useUnder: true,
    primaryUnder: 7,
    recovery: true,
    recoveryUnder: 6,
    martingale: true,
    recoverySizing: 'PAYOUT',
    recoverShare: 50,
    virtualMode: true,
    virtualLosses: 2,
    gateMin: 1,
    // The bot's own rules decide every entry, and its paper mode is virtualMode above. Sixfold's scanner-side guards and its
    // Virtual Hook / opening paper trade are therefore off here, so nothing second-guesses (or doubles) the rules.
    vhOpening: false,
    virtualHook: false,
    winStreakGate: false,
    pressureGate: false,
    multiWindowGate: false,
    winPressureGate: false,
};

export function loadVanguardSettings(): SixfoldSettings {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return normalizeSettings(raw ? JSON.parse(raw) : null, VANGUARD_DEFAULTS);
    } catch {
        return { ...VANGUARD_DEFAULTS };
    }
}

export function saveVanguardSettings(settings: SixfoldSettings) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        /* storage unavailable: settings simply are not remembered */
    }
}
