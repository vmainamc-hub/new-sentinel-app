import { useEffect } from 'react';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';

// Run Panel "Stop" → every ported 360 page listens for this and stops itself if it is the one running.
export const HUB360_STOP_EVENT = 'hub360.stop';

/**
 * Registers a ported 360 page with the app's trading-module bookkeeping (the same one Sentinel AI, Sixfold, Vanguard
 * and Apex Intel use), so only one engine trades at a time and starting another engine stops this one cleanly.
 */
export const useHub360Module = (moduleId: string, isRunning: boolean) => {
    const store = useStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dashboard = (store as any)?.dashboard;

    useEffect(() => {
        if (!dashboard) return undefined;
        dashboard.registerTradingStopHandler(moduleId, () => observer.emit(`${HUB360_STOP_EVENT}.${moduleId}`));
        return () => {
            dashboard.unregisterTradingStopHandler(moduleId);
            if (dashboard.active_trading_module === moduleId) dashboard.setActiveTradingModule(null);
        };
    }, [dashboard, moduleId]);

    useEffect(() => {
        if (!dashboard) return;
        if (isRunning) {
            const other = dashboard.active_trading_module;
            if (other && other !== moduleId) dashboard.stopActiveTradingModule();
            dashboard.setActiveTradingModule(moduleId);
        } else if (dashboard.active_trading_module === moduleId) {
            dashboard.setActiveTradingModule(null);
        }
    }, [dashboard, isRunning, moduleId]);
};
