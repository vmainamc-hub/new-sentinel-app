// VANGUARD: the app-wide instance, wired to the real Deriv helpers. It has its own market feed (all 20 markets) and its own runner
// and module id, so it can never trade at the same time as Sixfold or Auto Trades (starting one stops the other).
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { createEngineGates } from '../edge-gates/runner-gates';
import { SixfoldFeed } from '../sixfold/feed';
import { ALL_SYMBOLS } from '../sixfold/markets';
import { primaryContracts } from '../sixfold/money';
import { SixfoldRunner } from '../sixfold/runner';
import { BotRules } from './bot-rules';
import { loadVanguardSettings, saveVanguardSettings, VANGUARD_DEFAULTS, VANGUARD_MODULE_ID } from './vanguard-settings';

export const vanguardFeed = new SixfoldFeed(undefined, undefined, ALL_SYMBOLS);

// The bot's entry rules. They read the page's settings live (paper mode, gate strictness), once the runner below exists.
export const vanguardRules = new BotRules();

/**
 * The Kalman / cross-market danger / frequency / arbiter gates from Sentinel AI, in front of Vanguard's scanner. They change which
 * signals come up for execution and nothing on screen. From the console: `vanguardEdge.set({ shadow: true })` measures without
 * acting, `vanguardEdge.set({ kalman: false })` switches one off, `vanguardEdge.print()` shows the evidence.
 */
export const vanguardGates = createEngineGates({
    moduleId: VANGUARD_MODULE_ID,
    name: 'Vanguard',
    contracts: primaryContracts,
    series: () => vanguardFeed.getLiveSeries(),
    settingsKey: 'vanguard.edge.settings.v1',
    ledgerKey: 'vanguard.edge.ledger.v1',
    handle: 'vanguardEdge',
});

export const vanguardRunner: SixfoldRunner = new SixfoldRunner({
    feed: vanguardFeed,
    rules: vanguardRules,
    moduleId: VANGUARD_MODULE_ID,
    name: 'Vanguard',
    defaults: VANGUARD_DEFAULTS,
    buy: ({ parameters, price }) => buyContractForUi({ parameters, price, source: 'Vanguard' }),
    settle: ({ contractId, fallback, onUpdate, signal }) =>
        streamContractUntilSettled({ contractId, fallback, onUpdate, signal, source: 'Vanguard' }),
    isAuthorized: () => Boolean((api_base as { is_authorized?: boolean }).is_authorized),
    currency: () => '',
    afterStop: () => {
        const base = api_base as { is_stopping?: boolean; setIsRunning?: (value: boolean) => void };
        base.is_stopping = false;
        base.setIsRunning?.(false);
    },
    now: () => Date.now(),
    loadSettings: loadVanguardSettings,
    saveSettings: saveVanguardSettings,
    overlay: vanguardGates.overlay,
});

vanguardRules.useConfig(() => {
    const s = vanguardRunner.getSnapshot().settings;
    // The bot's own paper mode is never on (the Virtual Hook is Vanguard's only paper trading), even if old saved settings say so.
    return { virtualMode: false, virtualLosses: s.virtualLosses, gateMin: s.gateMin, useUnder: s.useUnder, useOver: s.useOver };
});
vanguardFeed.onTick((symbol, digit) => {
    vanguardRunner.handleFeedTick(symbol, digit);
    vanguardGates.onTick(symbol, digit);
});
// The loop is cheap when idle (it returns early unless a session runs or the page asked for live scans).
if (typeof window !== 'undefined') window.setInterval(() => vanguardRunner.tick(), 500);
