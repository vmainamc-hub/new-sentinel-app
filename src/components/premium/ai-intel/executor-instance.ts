// APEX INTEL: the app-wide executor, wired to the real Deriv purchase helpers and the shared live market feed.
import { contract_stages } from '@/constants/contract-stage';
import { api_base } from '@/external/bot-skeleton';
import { sixfoldFeed } from '@/components/premium/sixfold/feed';
import { describeTradeFailure } from '@/utils/trade-errors';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { AiIntelExecutor, type ExecConfig, type ExecTrade } from './executor';

const CONFIG_KEY = 'apex_intel_exec_v1';
const TRADES_KEY = 'apex_intel_trades_v1';

const read = <T,>(key: string): T | null => {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
};
const write = (key: string, value: unknown) => {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* storage may be unavailable (private mode, full) */
    }
};

export const aiIntelExecutor = new AiIntelExecutor({
    buy: ({ parameters, price }) => buyContractForUi({ parameters, price, source: 'Apex Intel' }),
    settle: ({ contractId, fallback, onUpdate, signal }) => streamContractUntilSettled({ contractId, fallback, onUpdate, signal, source: 'Apex Intel' }),
    isAuthorized: () => Boolean((api_base as { is_authorized?: boolean }).is_authorized),
    now: () => Date.now(),
    lastTickAt: symbol => sixfoldFeed.getLastTickAt(symbol),
    isFeedLive: () => sixfoldFeed.isLive(),
    connectFeed: () => sixfoldFeed.connect(),
    describeFailure: error => describeTradeFailure(error),
    afterStop: () => {
        const base = api_base as { is_stopping?: boolean; setIsRunning?: (value: boolean) => void };
        base.is_stopping = false;
        base.setIsRunning?.(false);
    },
    load: () => read<Partial<ExecConfig>>(CONFIG_KEY),
    save: config => write(CONFIG_KEY, config),
    loadTrades: () => read<ExecTrade[]>(TRADES_KEY) ?? [],
    saveTrades: trades => write(TRADES_KEY, trades),
    runningStage: contract_stages.RUNNING,
    notRunningStage: contract_stages.NOT_RUNNING,
});

sixfoldFeed.onTick((symbol, digit) => aiIntelExecutor.handleTick(symbol, digit));
