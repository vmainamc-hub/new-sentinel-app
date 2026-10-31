// SENTINEL AI: the app-wide runner. It is Sixfold's runner with the Pulse overlay, its own settings and Run Panel id.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { sixfoldFeed } from '../sixfold/feed';
import { SixfoldRunner } from '../sixfold/runner';
import { createSentinelOverlay } from './overlay';
import { readPulse } from './pulse';
import { type EngineSettings, loadEngine, loadTrading, saveEngine, saveTrading } from './settings';

let engine: EngineSettings = loadEngine();
export const getEngineSettings = () => engine;
export const setEngineSettings = (next: EngineSettings) => {
    engine = next;
    saveEngine(next);
};

export const sentinelOverlay = createSentinelOverlay({
    getEngine: () => engine,
    read: symbols => readPulse(sixfoldFeed.getSnapshot().series, symbols),
});

export const sentinelRunner = new SixfoldRunner({
    feed: sixfoldFeed,
    buy: ({ parameters, price }) => buyContractForUi({ parameters, price, source: 'Sentinel AI' }),
    settle: ({ contractId, fallback, onUpdate, signal }) =>
        streamContractUntilSettled({ contractId, fallback, onUpdate, signal, source: 'Sentinel AI' }),
    isAuthorized: () => Boolean((api_base as { is_authorized?: boolean }).is_authorized),
    currency: () => '',
    afterStop: () => {
        const base = api_base as { is_stopping?: boolean; setIsRunning?: (value: boolean) => void };
        base.is_stopping = false;
        base.setIsRunning?.(false);
    },
    now: () => Date.now(),
    loadSettings: loadTrading,
    saveSettings: saveTrading,
    overlay: sentinelOverlay,
});

/** Keeps the live tick feed connected while the page is open or a session runs. Returns the release function. */
export const attachEngines = (): (() => void) => {
    if (sixfoldFeed.getMode() === 'live' && sixfoldFeed.getStatus() === 'offline') sixfoldFeed.connect();
    return () => undefined;
};

sixfoldFeed.onTick((symbol, digit) => sentinelRunner.handleFeedTick(symbol, digit));
if (typeof window !== 'undefined') window.setInterval(() => sentinelRunner.tick(), 500);
