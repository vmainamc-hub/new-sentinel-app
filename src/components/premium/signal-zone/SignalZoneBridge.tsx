// SIGNAL ZONE: app-level bridge. Mounted once in the premium shell (like the Sentinel AI bridge) so the stop loss keeps working while the
// user is in Bot Builder pressing Run. It only reads the run panel and calls the run panel's own stop action.
import { useEffect } from 'react';
import { reaction } from 'mobx';
import { useStore } from '@/hooks/useStore';
import { finishLatest, loadHistory, saveHistory } from './signal-zone-history';
import { signalZoneSession } from './signal-zone-session';

const SignalZoneBridge = () => {
    const store = useStore();

    useEffect(() => {
        const runPanel = store?.run_panel;
        const transactions = store?.transactions;
        if (!runPanel || !transactions) return undefined;

        let wasRunning = false;
        return reaction(
            () => ({
                running: Boolean(runPanel.is_running),
                runId: String((runPanel as { run_id?: string }).run_id ?? ''),
                total: Number(transactions.statistics?.total_profit) || 0,
            }),
            input => {
                const stop = signalZoneSession.observe(input);
                if (wasRunning && !input.running) {
                    // The run ended: close the newest open history entry with the run's result.
                    const snapshot = signalZoneSession.getSnapshot();
                    if (snapshot.armed && snapshot.pnl !== null) saveHistory(finishLatest(loadHistory(), snapshot.pnl, snapshot.stoppedBy));
                }
                wasRunning = input.running;
                if (stop) {
                    try {
                        runPanel.onStopBotClick();
                    } catch (error) {
                        console.error('[signal-zone] could not stop the bot at the stop loss:', error);
                    }
                }
            },
            { fireImmediately: true, equals: (a, b) => a.running === b.running && a.runId === b.runId && a.total === b.total }
        );
    }, [store]);

    return null;
};

export default SignalZoneBridge;
