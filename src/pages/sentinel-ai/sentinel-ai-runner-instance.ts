// SENTINEL AI — the app-wide runner instance wired to the real engine and the real Deriv helpers.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { fireSignalAlerts } from './sentinel-ai-alerts';
import { sentinelAiEngine } from './sentinel-ai-engine';
import { SentinelAiRunner } from './sentinel-ai-runner';
import { loadSettings, saveSettings } from './sentinel-ai-types';

export const sentinelAiRunner = new SentinelAiRunner({
    engine: sentinelAiEngine,
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
});
