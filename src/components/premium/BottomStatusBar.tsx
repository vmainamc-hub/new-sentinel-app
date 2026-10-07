import { useEffect, useState } from 'react';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { PlayIcon } from './icons';

const formatUTC = (d: Date) => {
    const p = (v: number) => String(v).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
};

const BottomStatusBar = ({ botBuilderActive = false }: { botBuilderActive?: boolean }) => {
    const [now, setNow] = useState(new Date());
    const [busy, setBusy] = useState(false);
    const { connectionStatus, isAuthorized } = useApiBase();
    const { run_panel } = useStore() ?? {};
    const isRunning = Boolean(run_panel?.is_running || api_base.is_running);
    const canStop = Boolean(run_panel?.is_stop_button_visible || isRunning);
    const connected = String(connectionStatus).toLowerCase().includes('open') || isAuthorized;

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    const handleRunControl = async () => {
        if (!botBuilderActive || !run_panel || busy) return;
        setBusy(true);
        try {
            if (canStop) run_panel.onStopButtonClick();
            else await run_panel.onRunButtonClick();
        } finally {
            setBusy(false);
        }
    };

    const runLabel = busy ? 'Please wait' : canStop ? 'Stop' : botBuilderActive ? 'Run' : 'Ready';

    return <div className='prodb-bottom-bar'>
        <button className='prodb-risk' onClick={() => window.alert('Trading involves risk. Use demo trading to test strategies before risking real funds.')}>Risk Disclaimer</button>
        <div className='prodb-run-status'>
            <button className={`prodb-run ${botBuilderActive ? 'is-enabled' : ''}`} onClick={handleRunControl} disabled={!botBuilderActive || busy} title={botBuilderActive ? 'Run or stop the current Bot Builder strategy' : 'Open Bot Builder to run a bot'}><PlayIcon /> {runLabel}</button>
            <div className='prodb-execution'><small>DERIV WS</small><strong>{connected ? 'LIVE' : 'OFFLINE'}</strong><span className='prodb-switch'><i /></span></div>
            <div className='prodb-bot-state'><strong>{isRunning ? 'Bot is running' : 'Bot is not running'}</strong><span /></div>
        </div>
        <div className='prodb-bottom-meta'><i className={`prodb-online-dot ${connected ? '' : 'is-offline'}`} /><span>{formatUTC(now)}</span><button>☼</button><button>⇥</button><button>⛶</button></div>
    </div>;
};

export default BottomStatusBar;
