// SENTINEL AI (unified): the app-wide runner. It is Sixfold's runner with the Sentinel + Fusion overlay, its own settings and Run Panel id.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { sentinelAiEngine } from '@/pages/sentinel-ai/sentinel-ai-engine';
import { bulkFeed } from '../bulk-feed';
import { sixfoldFeed } from '../sixfold/feed';
import { SixfoldRunner } from '../sixfold/runner';
import { readSources } from '../signal-zone/signal-zone-sources';
import { createSentinelOverlay } from './overlay';
import { type EngineSettings, loadEngine, loadTrading, saveEngine, saveTrading } from './settings';

let engine: EngineSettings = loadEngine();
export const getEngineSettings = () => engine;
export const setEngineSettings = (next: EngineSettings) => {
    engine = next;
    saveEngine(next);
};

export const sentinelOverlay = createSentinelOverlay({
    getEngine: () => engine,
    read: (requireMomentum, now) => readSources(requireMomentum, now),
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

/** Keeps both engines and the tick feeds alive while the page or a session needs them. Returns the release function. */
export const attachEngines = (): (() => void) => {
    bulkFeed.start();
    return sentinelAiEngine.retain();
};

sixfoldFeed.onTick((symbol, digit) => sentinelRunner.handleFeedTick(symbol, digit));
if (typeof window !== 'undefined') window.setInterval(() => sentinelRunner.tick(), 500);
