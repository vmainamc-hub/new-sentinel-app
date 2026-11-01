// APEX INTEL: app-wide bridge (mounted once in the premium shell), the same job SixfoldBridge does for Sixfold.
// 1. Hands the Run Panel / transactions / summary / dashboard stores to the executor.
// 2. Keeps the Run Panel's own Stop button and the executor in sync.
// 3. Ends a running session if the Deriv session drops.
import { useEffect } from 'react';
import { reaction } from 'mobx';
import { observer as globalObserver } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { apexFeed } from './feed-source';
import { discoverVolatilityMarkets } from './discovery';
import { aiIntelExecutor } from './executor-instance';
import { useExecutor } from './use-executor';

const AiIntelBridge = () => {
    const store = useStore();
    const { isAuthorized } = useApiBase();
    const snapshot = useExecutor();

    // Once the shared feed is live, ask Deriv which Volatility indices exist and track any beyond Sixfold's ten.
    useEffect(() => {
        let started = false;
        let cancelled = false;
        const check = () => {
            if (started || !apexFeed.isLive()) return;
            started = true;
            void discoverVolatilityMarkets().then(found => {
                if (!cancelled && found.length) apexFeed.addMarkets(found);
            });
        };
        check();
        const off = apexFeed.subscribe(check);
        return () => {
            cancelled = true;
            off();
        };
    }, []);

    useEffect(() => {
        if (!store) return undefined;
        const { client, run_panel, summary_card, transactions, dashboard } = store as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        aiIntelExecutor.attach({ client, run_panel, summary_card, transactions, dashboard }, onChange =>
            reaction(
                () => [Boolean(run_panel.is_running), dashboard.active_trading_module as string | null] as const,
                ([running, module]) => onChange(running, module)
            )
        );
        return undefined;
    }, [store]);

    const isRunning = snapshot.running;
    useEffect(() => {
        if (!store || !isRunning) return undefined;
        const { run_panel } = store as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const stop = () => aiIntelExecutor.stop('Stopped from the Run Panel');
        globalObserver.register('bot.running', run_panel.onBotRunningEvent);
        globalObserver.register('contract.status', run_panel.onContractStatusEvent);
        globalObserver.register('Error', run_panel.onError);
        globalObserver.register('bot.setPurchaseInProgress', run_panel.SetpurchaseInProgress);
        globalObserver.register('bot.manual_stop', stop);
        return () => {
            globalObserver.unregister('bot.running', run_panel.onBotRunningEvent);
            globalObserver.unregister('contract.status', run_panel.onContractStatusEvent);
            globalObserver.unregister('Error', run_panel.onError);
            globalObserver.unregister('bot.setPurchaseInProgress', run_panel.SetpurchaseInProgress);
            globalObserver.unregister('bot.manual_stop', stop);
        };
    }, [isRunning, store]);

    // A dropped or switched Deriv session ends the run instead of firing trades into the void.
    useEffect(() => {
        if (!isAuthorized && aiIntelExecutor.isRunning()) aiIntelExecutor.stop('Disconnected from Deriv');
    }, [isAuthorized]);

    return null;
};

export default AiIntelBridge;
