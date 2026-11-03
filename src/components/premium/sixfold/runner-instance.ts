// SIXFOLD AUTO: the app-wide runner instance, wired to the real Deriv helpers and the app-wide market feed.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { createEngineGates } from '../edge-gates/runner-gates';
import { sixfoldFeed } from './feed';
import { loadSettings, primaryContracts, saveSettings } from './money';
import { MODULE_ID, SixfoldRunner } from './runner';

/**
 * The Kalman / cross-market danger / frequency / arbiter gates from Sentinel AI, in front of Sixfold's own scanner. They change which
 * signals come up for execution and nothing on screen. From the console: `sixfoldEdge.set({ shadow: true })` measures without
 * acting, `sixfoldEdge.set({ kalman: false })` switches one off, `sixfoldEdge.print()` shows the evidence.
 */
export const sixfoldGates = createEngineGates({
    moduleId: MODULE_ID,
    name: 'Sixfold',
    contracts: primaryContracts,
    series: () => sixfoldFeed.getLiveSeries(),
    settingsKey: 'sixfold.edge.settings.v1',
    ledgerKey: 'sixfold.edge.ledger.v1',
    handle: 'sixfoldEdge',
});

export const sixfoldRunner = new SixfoldRunner({
    feed: sixfoldFeed,
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
    loadSettings,
    saveSettings,
    overlay: sixfoldGates.overlay,
});

sixfoldFeed.onTick((symbol, digit) => {
    sixfoldRunner.handleFeedTick(symbol, digit);
    sixfoldGates.onTick(symbol, digit);
});
// The loop is cheap when idle (it returns early unless a session runs or the page asked for live scans).
if (typeof window !== 'undefined') window.setInterval(() => sixfoldRunner.tick(), 500);
