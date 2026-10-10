// SENTINEL AI — app-wide bridge (mounted once in the premium shell).
//
// 1. Hands the Run Panel / transactions / summary / dashboard stores to the runner singleton.
// 2. Keeps the Run Panel's own Stop button and the runner in sync (same hooks Auto Trades registers).
// 3. Shows the silent, on-screen "new signal" notice on ANY tab — the replacement for the Forge's beep.
import { useEffect, useRef, useState } from 'react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router-dom';
import { observer as globalObserver } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { sentinelAiRunner } from './sentinel-ai-runner-instance';
import { useSentinelAi } from './use-sentinel-ai';
import './sentinel-ai.scss';

const NOTICE_MS = 9000;

const SentinelAiBridge = observer(() => {
    const store = useStore();
    const { isAuthorized } = useApiBase();
    const navigate = useNavigate();
    const snapshot = useSentinelAi(false);
    const [notice, setNotice] = useState<{ seq: number; text: string; detail: string } | null>(null);
    const seenSeq = useRef(snapshot.alertSeq);

    // 1 + 2: store hand-off and Run Panel Stop sync.
    useEffect(() => {
        if (!store) return undefined;
        const { client, run_panel, summary_card, transactions, dashboard } = store as any;
        sentinelAiRunner.attach({ client, run_panel, summary_card, transactions, dashboard }, onChange =>
            reaction(
                () => [Boolean(run_panel.is_running), dashboard.active_trading_module as string | null] as const,
                ([running, module]) => onChange(running, module)
            )
        );
        return undefined;
    }, [store]);

    const isRunning = snapshot.status === 'RUNNING';

    useEffect(() => {
        if (!store || !isRunning) return undefined;
        const { run_panel } = store as any;
        const stop = () => sentinelAiRunner.stop('Stopped from the Run Panel');
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
        if (!isAuthorized && sentinelAiRunner.isRunning()) sentinelAiRunner.stop('Disconnected from Deriv');
    }, [isAuthorized]);

    // 3: visual notice for each new signal (only when enabled in settings).
    useEffect(() => {
        if (snapshot.alertSeq === seenSeq.current) return undefined;
        seenSeq.current = snapshot.alertSeq;
        const signal = snapshot.signal;
        if (!signal || !snapshot.settings.alertVisual) return undefined;
        setNotice({
            seq: snapshot.alertSeq,
            text: `${signal.label} on ${signal.marketName}`,
            detail: signal.entryDigit === null ? 'Waiting for an entry digit' : `Enter on digit ${signal.entryDigit}`,
        });
        const timer = window.setTimeout(() => setNotice(current => (current?.seq === snapshot.alertSeq ? null : current)), NOTICE_MS);
        return () => window.clearTimeout(timer);
    }, [snapshot.alertSeq, snapshot.signal, snapshot.settings.alertVisual]);

    const onSentinelPage = window.location.hash.replace(/^#\/?/, '').split('?')[0] === 'sentinel_ai';
    if (!notice || onSentinelPage) return null;

    return (
        <div className='sentinel-ai-notice' role='status' aria-live='polite'>
            <span className='sentinel-ai-notice__pulse' aria-hidden='true' />
            <div className='sentinel-ai-notice__text'>
                <strong>New Sentinel signal</strong>
                <span>{notice.text}</span>
                <span>{notice.detail}</span>
            </div>
            <button
                type='button'
                className='sentinel-ai-notice__open'
                onClick={() => {
                    setNotice(null);
                    navigate({ hash: '#sentinel_ai' });
                }}
            >
                Open
            </button>
            <button
                type='button'
                className='sentinel-ai-notice__close'
                aria-label='Dismiss'
                onClick={() => setNotice(null)}
            >
                ×
            </button>
        </div>
    );
});

export default SentinelAiBridge;
