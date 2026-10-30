// SENTINEL AI — the app-wide runner instance wired to the real engine and the real Deriv helpers.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { fireSignalAlerts } from './sentinel-ai-alerts';
import { derivBus } from '@/sentinel-engine/lib/deriv/tick-bus';
import { sentinelAiEngine } from './sentinel-ai-engine';
import { bulkFusionSource } from './sentinel-ai-fusion';
import { loadStoredRecords, saveStoredRecords, SignalOutcomeLog } from './sentinel-ai-outcome-log';
import { SentinelAiRunner } from './sentinel-ai-runner';
import { loadSettings, saveSettings } from './sentinel-ai-types';

/** Read-only paper-outcome log of every surfaced signal. It never trades and never feeds back into the engine. */
export const sentinelAiOutcomeLog = new SignalOutcomeLog({
    getTicks: symbol => derivBus.getTicks(symbol),
    getPipSize: symbol => derivBus.getPipSize(symbol),
    onTick: callback => derivBus.onTick(symbol => callback(symbol)),
    now: () => Date.now(),
    load: loadStoredRecords,
    save: saveStoredRecords,
});

export const sentinelAiRunner = new SentinelAiRunner({
    engine: sentinelAiEngine,
    fusion: bulkFusionSource,
    buy: ({ parameters, price }) => buyContractForUi({ parameters, price, source: 'SentinelAI' }),
    settle: ({ contractId, fallback, onUpdate, signal }) =>
        streamContractUntilSettled({ contractId, fallback, onUpdate, signal, source: 'SentinelAI' }),
    isAuthorized: () => Boolean((api_base as { is_authorized?: boolean }).is_authorized),
    currency: () => '',
    afterStop: () => {
        const base = api_base as { is_stopping?: boolean; setIsRunning?: (value: boolean) => void };
        base.is_stopping = false;
        base.setIsRunning?.(false);
    },
    alert: fireSignalAlerts,
    now: () => Date.now(),
    loadSettings,
    saveSettings,
    outcomes: sentinelAiOutcomeLog,
});
