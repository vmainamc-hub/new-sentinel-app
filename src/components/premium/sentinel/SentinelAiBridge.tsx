// SIXFOLD AUTO: app-wide bridge (mounted once in the premium shell).
//
// 1. Hands the Run Panel / transactions / summary / dashboard stores to the runner singleton.
// 2. Keeps the Run Panel's own Stop button and the runner in sync (the same hooks Auto Trades registers).
// 3. Ends a running session if the Deriv session drops.
import { useEffect } from 'react';
import { reaction } from 'mobx';
import { observer as globalObserver } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { useSixfold } from '../sixfold/use-sixfold';
import { attachEngines, sentinelRunner } from './runner-instance';

const SentinelAiBridge = () => {
    const store = useStore();
    const { isAuthorized } = useApiBase();
    const snapshot = useSixfold(false, sentinelRunner);
    // Always watching: both engines keep analysing every market on every tab, so a visit never starts cold.
    useEffect(() => attachEngines(), []);

    useEffect(() => {
        if (!store) return undefined;
        const { client, run_panel, summary_card, transactions, dashboard } = store as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        sentinelRunner.attach({ client, run_panel, summary_card, transactions, dashboard }, onChange =>
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
        const stop = () => sentinelRunner.stop('Stopped from the Run Panel');
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
        if (!isAuthorized && sentinelRunner.isRunning()) sentinelRunner.stop('Disconnected from Deriv');
    }, [isAuthorized]);

    return null;
};

export default SentinelAiBridge;
