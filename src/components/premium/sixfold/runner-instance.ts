// SIXFOLD AUTO: the app-wide runner instance, wired to the real Deriv helpers and the app-wide market feed.
import { api_base } from '@/external/bot-skeleton';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { sixfoldFeed } from './feed';
import { loadSettings, saveSettings } from './money';
import { SixfoldRunner } from './runner';

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
});

sixfoldFeed.onTick((symbol, digit) => sixfoldRunner.handleFeedTick(symbol, digit));
// The loop is cheap when idle (it returns early unless a session runs or the page asked for live scans).
if (typeof window !== 'undefined') window.setInterval(() => sixfoldRunner.tick(), 500);
