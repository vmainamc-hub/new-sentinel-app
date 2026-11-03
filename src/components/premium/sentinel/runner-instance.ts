// SENTINEL AI: the app-wide runner. It is Sixfold's runner with the Pulse overlay, its own settings and Run Panel id.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { sixfoldFeed } from '../sixfold/feed';
import { SixfoldRunner } from '../sixfold/runner';
import { createEdgeInfluence, describeReport } from './edge/influence';
import { type EdgeSettings, loadEdge, normalizeEdge, saveEdge } from './edge/settings';
import { createSentinelOverlay } from './overlay';
import { readDigitsAnalysis } from './digits-source';
import { readPulse } from './pulse';
import { contractsFor, type EngineSettings, loadEngine, loadTrading, saveEngine, saveTrading } from './settings';

let engine: EngineSettings = loadEngine();
export const getEngineSettings = () => engine;
export const setEngineSettings = (next: EngineSettings) => {
    engine = next;
    saveEngine(next);
};

let edgeSettings: EdgeSettings = loadEdge();

/**
 * The Kalman / cross-market danger / frequency / arbiter gates. They sit inside the overlay, so they change which signals come up for
 * execution and nothing on screen. No screen for them: from the console, `sentinelEdge.set({ shadow: true })` measures without
 * acting, `sentinelEdge.set({ kalman: false })` switches one off, `sentinelEdge.report()` prints the evidence.
 */
export const sentinelEdgeInfluence = createEdgeInfluence({
    getSettings: () => edgeSettings,
    series: () => sixfoldFeed.getLiveSeries(),
});
export const sentinelEdge = {
    get: (): EdgeSettings => ({ ...edgeSettings }),
    set: (patch: Partial<EdgeSettings>): EdgeSettings => {
        edgeSettings = normalizeEdge({ ...edgeSettings, ...patch });
        saveEdge(edgeSettings);
        return { ...edgeSettings };
    },
    report: () => sentinelEdgeInfluence.report(),
    print: (): string => describeReport(sentinelEdgeInfluence.report()),
    reset: () => sentinelEdgeInfluence.reset(),
};
if (typeof window !== 'undefined')
    (window as unknown as { sentinelEdge?: typeof sentinelEdge }).sentinelEdge = sentinelEdge;

const readSource = (source: EngineSettings['source'], symbols: readonly string[], eng: EngineSettings) => {
    const series = sixfoldFeed.getSnapshot().series;
    return source === 'digits' ? readDigitsAnalysis(series, symbols, contractsFor(eng)) : readPulse(series, symbols);
};

export const sentinelOverlay = createSentinelOverlay({
    getEngine: () => engine,
    series: () => sixfoldFeed.getLiveSeries(),
    read: (symbols, eng) => readSource(eng.source, symbols, eng),
    readOther: (symbols, eng) => readSource(eng.source === 'digits' ? 'pulse' : 'digits', symbols, eng),
    edge: sentinelEdgeInfluence,
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

sixfoldFeed.onTick((symbol, digit) => {
    sentinelRunner.handleFeedTick(symbol, digit);
    try {
        sentinelEdgeInfluence.onTick(symbol, digit);
    } catch {
        /* the gates' record never gets in the way of a tick */
    }
});
if (typeof window !== 'undefined') window.setInterval(() => sentinelRunner.tick(), 500);
