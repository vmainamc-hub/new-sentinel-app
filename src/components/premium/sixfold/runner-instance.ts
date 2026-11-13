// SIXFOLD (fused): the app-wide runner, wired to the real Deriv helpers and the app-wide all-markets feed.
//
// One tool where there used to be two (Sixfold and Vanguard). It is Sixfold's runner with the fused overlay: every engine (scanner,
// Pulse, the Vanguard bot rules, the pressure engines, the edge gates, the entry study) votes on every contract, and the trade goes out
// when the studied entry digit prints. See fusion/fused-overlay.ts. Module id 'sixfold' (the Run Panel's Stop button and the bridge
// are unchanged).
//
// From the console: `sixfoldEdge.set({ shadow: true })` measures the gates without acting, `sixfoldEdge.set({ kalman: false })`
// switches one off, `sixfoldEdge.print()` shows the evidence.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { createEngineGates } from '../edge-gates/runner-gates';
import { BotRules } from '../vanguard/bot-rules';
import { allMarketsFeed } from './all-markets-feed';
import { createFusedOverlay } from './fusion/fused-overlay';
import { FUSED_DEFAULTS, loadFusedSettings, saveFusedSettings } from './fusion/fused-settings';
import { primaryContracts } from './money';
import { MODULE_ID, SixfoldRunner } from './runner';

export const sixfoldGates = createEngineGates({
    moduleId: MODULE_ID,
    name: 'Sixfold',
    contracts: primaryContracts,
    series: () => allMarketsFeed.getLiveSeries(),
    settingsKey: 'sixfold.edge.settings.v1',
    ledgerKey: 'sixfold.edge.ledger.v1',
    handle: 'sixfoldEdge',
});

/** The Vanguard bot's regime engine. It reads every tick and votes; it does not trade on its own any more. */
export const sixfoldRules = new BotRules();

export const sixfoldFusion = createFusedOverlay({
    gates: sixfoldGates.overlay,
    series: () => allMarketsFeed.getLiveSeries(),
    rules: sixfoldRules,
    moduleId: MODULE_ID,
    name: 'Sixfold',
});

export const sixfoldRunner = new SixfoldRunner({
    feed: allMarketsFeed,
    moduleId: MODULE_ID,
    name: 'Sixfold',
    defaults: FUSED_DEFAULTS,
    buy: ({ parameters, price }) => buyContractForUi({ parameters, price, source: 'Sixfold' }),
    settle: ({ contractId, fallback, onUpdate, signal }) =>
        streamContractUntilSettled({ contractId, fallback, onUpdate, signal, source: 'Sixfold' }),
    isAuthorized: () => Boolean((api_base as { is_authorized?: boolean }).is_authorized),
    currency: () => '',
    afterStop: () => {
        const base = api_base as { is_stopping?: boolean; setIsRunning?: (value: boolean) => void };
        base.is_stopping = false;
        base.setIsRunning?.(false);
    },
    now: () => Date.now(),
    loadSettings: loadFusedSettings,
    saveSettings: saveFusedSettings,
    overlay: sixfoldFusion,
});

// The bot rules read both sides on every market, whatever is switched on for trading.
sixfoldRules.useConfig(() => ({
    virtualMode: false,
    virtualLosses: 2,
    gateMin: sixfoldRunner.getSnapshot().settings.gateMin,
    useUnder: true,
    useOver: true,
}));

allMarketsFeed.onTick((symbol, digit) => {
    sixfoldFusion.onTick(symbol, digit); // the bot rules read the tick first, so the next scan sees it
    sixfoldRunner.handleFeedTick(symbol, digit);
    sixfoldGates.onTick(symbol, digit);
});
// The loop is cheap when idle (it returns early unless a session runs or the page asked for live scans).
if (typeof window !== 'undefined') window.setInterval(() => sixfoldRunner.tick(), 500);
