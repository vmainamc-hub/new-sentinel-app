import { useEffect, useState } from 'react';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import { PlayIcon } from './icons';
import { EXECUTION_SPEED_KEY, type ExecutionSpeed, readExecutionSpeed } from './execution-speed';

const formatUTC = (d: Date) => {
    const p = (v: number) => String(v).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
};

const BottomStatusBar = ({
    botBuilderActive = false,
    onOpenBotBuilder,
}: {
    botBuilderActive?: boolean;
    onOpenBotBuilder?: () => void;
}) => {
    const [now, setNow] = useState(new Date());
    const [busy, setBusy] = useState(false);
    const [speed, setSpeed] = useState<ExecutionSpeed>(readExecutionSpeed);
    const { connectionStatus, isAuthorized } = useApiBase();
    const { run_panel } = useStore() ?? {};
    const { is_dark_mode_on, toggleTheme } = useThemeSwitcher();
    const isRunning = Boolean(run_panel?.is_running || api_base.is_running);
    const canStop = Boolean(run_panel?.is_stop_button_visible || isRunning);
    const connected = String(connectionStatus).toLowerCase().includes('open') || isAuthorized;

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    const handleRunControl = async () => {
        // A running bot can always be stopped from here, whichever page is open.
        if (canStop) {
            run_panel?.onStopButtonClick();
            return;
        }
        // Otherwise this button is a shortcut into Bot Builder, where bots are run.
        if (!botBuilderActive) {
            onOpenBotBuilder?.();
            return;
        }
        if (!run_panel || busy) return;
        setBusy(true);
        try {
            await run_panel.onRunButtonClick();
        } finally {
            setBusy(false);
        }
    };

    const toggleSpeed = () => {
        const next: ExecutionSpeed = speed === 'fast' ? 'slow' : 'fast';
        setSpeed(next);
        try {
            window.localStorage.setItem(EXECUTION_SPEED_KEY, next);
        } catch {
            /* storage can be unavailable; the switch still reflects the choice for this session */
        }
    };

    const toggleFullscreen = () => {
        try {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen?.();
        } catch {
            /* fullscreen is optional */
        }
    };

    const runLabel = busy ? 'Please wait' : canStop ? 'Stop' : botBuilderActive ? 'Run' : 'Bot Builder';

    return <div className='prodb-bottom-bar'>
        <button className='prodb-risk' onClick={() => window.alert('Trading involves risk. Use demo trading to test strategies before risking real funds.')}>Risk Disclaimer</button>
        <div className='prodb-run-status'>
            <button className={`prodb-run ${botBuilderActive ? 'is-enabled' : ''}`} onClick={handleRunControl} disabled={busy} title={botBuilderActive ? 'Run or stop the current Bot Builder strategy' : 'Open Bot Builder to run a bot'}><PlayIcon /> {runLabel}</button>
            <div className='prodb-execution' title='Execution speed. Fast places trades immediately. Slow waits about 2 seconds before each purchase.'>
                <small>EXECUTION</small>
                <strong>{speed === 'fast' ? 'FAST' : 'SLOW'}</strong>
                <button type='button' role='switch' aria-checked={speed === 'fast'} aria-label='Execution speed, fast or slow' className={`prodb-switch ${speed === 'fast' ? 'is-on' : ''}`} onClick={toggleSpeed}><i /></button>
            </div>
            <div className='prodb-bot-state' title='Whether a Bot Builder bot is currently running'><strong>{isRunning ? 'Bot is running' : 'Bot is not running'}</strong><span /></div>
        </div>
        <div className='prodb-bottom-meta'><i className={`prodb-online-dot ${connected ? '' : 'is-offline'}`} /><span className='prodb-ws' title='Connection to the Deriv WebSocket'>WS {connected ? 'LIVE' : 'OFFLINE'}</span><span>{formatUTC(now)}</span><button type='button' onClick={toggleTheme} title={is_dark_mode_on ? 'Switch to light mode' : 'Switch to dark mode'} aria-label='Toggle theme'>☼</button><button type='button' onClick={toggleFullscreen} title='Toggle full screen' aria-label='Toggle full screen'>⛶</button></div>
    </div>;
};

export default BottomStatusBar;
