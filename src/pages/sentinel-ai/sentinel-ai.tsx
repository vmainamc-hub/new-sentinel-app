// SENTINEL AI — frontend for the Sentinel Signal Engine.
//
// The engine (src/lib/**) produces signals; this page shows the live signal with its entry digit, lets the
// operator set stake / martingale / recovery / risk, and runs the session on the Run Panel like Auto Trades.
import { useEffect, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import ThemedScrollbars from '@/components/shared_ui/themed-scrollbars';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { getNotificationPermission, requestNotificationPermission } from './sentinel-ai-alerts';
import { sentinelAiRunner } from './sentinel-ai-runner-instance';
import type {
    ActiveSignalState,
    MartingaleMode,
    SentinelAiSettings,
    SentinelAiSignal,
    SignalOutcome,
} from './sentinel-ai-types';
import { MIN_STAKE } from './sentinel-ai-types';
import { useSentinelAi } from './use-sentinel-ai';
import './sentinel-ai.scss';

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const winsOnDigit = (signal: SentinelAiSignal, digit: number) =>
    signal.contractType === 'DIGITOVER' ? digit > signal.barrier : digit < signal.barrier;

const money = (value: number, signed = false) => `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}`;

const timeOf = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const OUTCOME_LABEL: Record<SignalOutcome, string> = {
    ACTIVE: 'Live',
    TRADED: 'Traded',
    EXPIRED: 'Expired',
    REPLACED: 'Replaced',
    STOPPED: 'Stopped',
    WATCHED: 'Not traded',
};

const stateText = (
    state: ActiveSignalState | null,
    required: number | null,
    recovering: boolean,
    secondsLeft: number,
    runsDone: number,
    runsTotal: number
) => {
    switch (state) {
        case 'WAITING_ENTRY':
            return `Waiting for digit ${required}${recovering ? ' (recovery digit)' : ''} · ${secondsLeft}s left`;
        case 'NO_ENTRY_DIGIT':
            return 'The engine has not validated an entry digit for this signal yet, so nothing is traded.';
        case 'TRADING':
            return 'Trade in progress';
        case 'WATCHING':
            return 'Not running. Press Run to trade this signal on its entry digit.';
        case 'EXPIRED':
            return 'Expired before the entry digit printed.';
        case 'DONE':
            return `Done: ${runsDone} of ${runsTotal} run${runsTotal === 1 ? '' : 's'} traded.`;
        default:
            return '';
    }
};

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────
const NumberField = ({
    label,
    value,
    onCommit,
    min,
    max,
    step,
    hint,
}: {
    label: string;
    value: number;
    onCommit: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    hint?: string;
}) => {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);

    const commit = () => {
        const parsed = Number(draft);
        if (draft.trim() === '' || !Number.isFinite(parsed)) {
            setDraft(String(value));
            return;
        }
        onCommit(parsed);
    };

    return (
        <label className='sentinel-ai-field'>
            <span className='sentinel-ai-field__label'>{label}</span>
            <input
                type='number'
                inputMode='decimal'
                value={draft}
                min={min}
                max={max}
                step={step}
                onChange={event => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={event => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                }}
            />
            {hint ? <span className='sentinel-ai-field__hint'>{hint}</span> : null}
        </label>
    );
};

const Toggle = ({
    label,
    checked,
    onChange,
    hint,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    hint?: string;
}) => (
    <label className='sentinel-ai-toggle'>
        <input type='checkbox' checked={checked} onChange={event => onChange(event.target.checked)} />
        <span className='sentinel-ai-toggle__track' aria-hidden='true' />
        <span className='sentinel-ai-toggle__text'>
            {label}
            {hint ? <small>{hint}</small> : null}
        </span>
    </label>
);

const MARTINGALE_OPTIONS: Array<{ value: MartingaleMode; label: string }> = [
    { value: 'off', label: 'Off' },
    { value: 'after_1', label: 'After 1 loss' },
    { value: 'after_2', label: 'After 2 losses' },
    { value: 'custom', label: 'After N losses' },
];

// ── page ─────────────────────────────────────────────────────────────────────────────────────────
const SentinelAi = observer(() => {
    const snapshot = useSentinelAi(true);
    const { client } = useStore();
    const { isAuthorized } = useApiBase();
    const [fresh, setFresh] = useState(false);
    const [notifyPermission, setNotifyPermission] = useState(getNotificationPermission());

    const { settings, session, signal, engine } = snapshot;
    const running = snapshot.status === 'RUNNING';
    const currency = client?.currency || 'USD';
    const set = (patch: Partial<SentinelAiSettings>) => sentinelAiRunner.updateSettings(patch);

    // Brief highlight each time the engine surfaces a new signal.
    useEffect(() => {
        if (snapshot.alertSeq === 0) return undefined;
        setFresh(true);
        const timer = window.setTimeout(() => setFresh(false), 2600);
        return () => window.clearTimeout(timer);
    }, [snapshot.alertSeq]);

    const engineLabel =
        engine.status === 'live'
            ? `Engine live · ${engine.online}/${engine.total} markets`
            : engine.status === 'connecting'
              ? 'Engine connecting…'
              : engine.status === 'error'
                ? 'Engine error'
                : 'Engine starting…';

    const pnlTone = session.pnl > 0 ? 'win' : session.pnl < 0 ? 'loss' : '';
    const martingaleOn = settings.martingaleMode !== 'off';

    return (
        <div className='sentinel-ai-page'>
            <ThemedScrollbars className='sentinel-ai-page__scroll'>
                <div className='sentinel-ai-page__inner'>
                    <header className='sentinel-ai-head'>
                        <div>
                            <h1>Sentinel AI</h1>
                            <p>Signals from the Sentinel engine, traded on their entry digit.</p>
                        </div>
                        <div
                            className={classNames('sentinel-ai-chip', {
                                'is-live': engine.status === 'live' && !engine.degraded,
                                'is-warn': engine.degraded || engine.status === 'error',
                            })}
                        >
                            <span className='sentinel-ai-chip__dot' aria-hidden='true' />
                            <span>{engineLabel}</span>
                            {engine.failsafes.length > 0 ? (
                                <span className='sentinel-ai-chip__flags'>{engine.failsafes.join(', ')}</span>
                            ) : null}
                            <span className='sentinel-ai-chip__flags'>Market mood: {engine.dangerLabel.toLowerCase()}</span>
                        </div>
                    </header>

                    {snapshot.lastError ? <div className='sentinel-ai-banner is-error'>{snapshot.lastError}</div> : null}
                    {!running && snapshot.stopReason ? (
                        <div className='sentinel-ai-banner'>Session ended: {snapshot.stopReason}</div>
                    ) : null}
                    {!isAuthorized ? (
                        <div className='sentinel-ai-banner is-error'>Log in to your Deriv account to trade signals.</div>
                    ) : null}

                    <section className='sentinel-ai-runbar' aria-label='Session'>
                        <button
                            type='button'
                            className={classNames('sentinel-ai-run', { 'is-stop': running })}
                            onClick={() => (running ? sentinelAiRunner.stop('Stopped by you') : sentinelAiRunner.start())}
                            disabled={!running && !isAuthorized}
                        >
                            {running ? 'Stop' : 'Run'}
                        </button>
                        <dl className='sentinel-ai-kpis'>
                            <div>
                                <dt>Profit / loss</dt>
                                <dd className={pnlTone}>
                                    {money(session.pnl, true)} <small>{currency}</small>
                                </dd>
                            </div>
                            <div>
                                <dt>Trades</dt>
                                <dd>
                                    {session.trades}{' '}
                                    <small>
                                        {session.wins}W · {session.losses}L
                                    </small>
                                </dd>
                            </div>
                            <div>
                                <dt>Next stake</dt>
                                <dd>
                                    {money(session.currentStake)} <small>{currency}</small>
                                </dd>
                            </div>
                            <div>
                                <dt>Recovery</dt>
                                <dd>
                                    {snapshot.recovering
                                        ? `On digit ${settings.recoveryDigit}`
                                        : martingaleOn && session.martingaleStep > 0
                                          ? `Step ${session.martingaleStep}`
                                          : 'Idle'}{' '}
                                    <small>
                                        {session.consecutiveLosses > 0
                                            ? `${session.consecutiveLosses} loss${session.consecutiveLosses === 1 ? '' : 'es'} in a row`
                                            : ''}
                                    </small>
                                </dd>
                            </div>
                        </dl>
                    </section>

                    <div className='sentinel-ai-grid'>
                        <div className='sentinel-ai-col'>
                            <section className={classNames('sentinel-ai-signal', { 'is-fresh': fresh })} aria-live='polite'>
                                {signal ? (
                                    <>
                                        <div className='sentinel-ai-signal__top'>
                                            <div>
                                                <h2>{signal.label}</h2>
                                                <p>{signal.marketName}</p>
                                            </div>
                                            <div className='sentinel-ai-signal__scores'>
                                                <span>
                                                    Score <b>{signal.score}</b>
                                                </span>
                                                <span>
                                                    Confidence <b>{signal.confidence}%</b>
                                                </span>
                                                <span className='sentinel-ai-signal__status'>{signal.status}</span>
                                            </div>
                                        </div>

                                        <div className='sentinel-ai-digits' role='img' aria-label='Entry digit tracker'>
                                            {DIGITS.map(digit => (
                                                <div
                                                    key={digit}
                                                    className={classNames('sentinel-ai-digit', {
                                                        'is-win': winsOnDigit(signal, digit),
                                                        'is-required': snapshot.requiredDigit === digit,
                                                        'is-last': snapshot.lastDigit === digit,
                                                    })}
                                                >
                                                    {digit}
                                                </div>
                                            ))}
                                        </div>
                                        <p className='sentinel-ai-digits__legend'>
                                            Ringed digit is the entry. Filled digit is the last one printed. Green underline marks
                                            digits that win this contract.
                                        </p>

                                        <p className='sentinel-ai-signal__state'>
                                            {stateText(
                                                snapshot.signalState,
                                                snapshot.requiredDigit,
                                                snapshot.recovering,
                                                snapshot.secondsLeft,
                                                snapshot.runsDone,
                                                snapshot.runsTotal
                                            )}
                                        </p>

                                        <dl className='sentinel-ai-entry'>
                                            <div>
                                                <dt>Entry digit</dt>
                                                <dd>{signal.entryDigit ?? 'Not set'}</dd>
                                            </div>
                                            <div>
                                                <dt>Historical win rate on entry</dt>
                                                <dd>{signal.entryWinRate === null ? 'n/a' : `${signal.entryWinRate}%`}</dd>
                                            </div>
                                            <div>
                                                <dt>Entry status</dt>
                                                <dd>{signal.entryStatus.toLowerCase()}</dd>
                                            </div>
                                            <div>
                                                <dt>Runs</dt>
                                                <dd>
                                                    {snapshot.runsDone} / {snapshot.runsTotal}
                                                </dd>
                                            </div>
                                        </dl>
                                        {signal.reason ? <p className='sentinel-ai-signal__reason'>{signal.reason}</p> : null}
                                    </>
                                ) : (
                                    <div className='sentinel-ai-empty'>
                                        <h2>Waiting for a signal</h2>
                                        <p>
                                            The engine is scanning {engine.total || 'all'} markets. The next signal that passes its
                                            checks appears here with its entry digit.
                                        </p>
                                    </div>
                                )}
                            </section>

                            <section className='sentinel-ai-card'>
                                <h3>Signals this session</h3>
                                {snapshot.history.length === 0 ? (
                                    <p className='sentinel-ai-muted'>No signals yet.</p>
                                ) : (
                                    <ul className='sentinel-ai-list'>
                                        {snapshot.history.slice(0, 12).map(record => (
                                            <li key={record.signal.id}>
                                                <span className='sentinel-ai-list__main'>
                                                    {record.signal.label} · {record.signal.symbol}
                                                    <small>
                                                        entry {record.signal.entryDigit ?? 'none'} · {timeOf(record.signal.receivedAt)}
                                                    </small>
                                                </span>
                                                <span
                                                    className={classNames(
                                                        'sentinel-ai-pill',
                                                        `is-${record.outcome.toLowerCase()}`
                                                    )}
                                                >
                                                    {OUTCOME_LABEL[record.outcome]}
                                                    {record.runsDone > 0 ? ` · ${money(record.pnl, true)}` : ''}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>

                            <section className='sentinel-ai-card'>
                                <h3>Trades</h3>
                                {snapshot.trades.length === 0 ? (
                                    <p className='sentinel-ai-muted'>Trades appear here and on the Run Panel.</p>
                                ) : (
                                    <ul className='sentinel-ai-list'>
                                        {snapshot.trades.slice(0, 12).map(trade => (
                                            <li key={trade.contractId}>
                                                <span className='sentinel-ai-list__main'>
                                                    {trade.label} · {trade.symbol}
                                                    <small>
                                                        digit {trade.entryDigit ?? '-'} · stake {money(trade.stake)} ·{' '}
                                                        {timeOf(trade.at)}
                                                    </small>
                                                </span>
                                                <span
                                                    className={classNames('sentinel-ai-pill', {
                                                        'is-won': trade.status === 'won',
                                                        'is-lost': trade.status === 'lost',
                                                    })}
                                                >
                                                    {trade.profit === null ? 'Open' : money(trade.profit, true)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>

                        <div className='sentinel-ai-col'>
                            <fieldset className='sentinel-ai-card' disabled={running}>
                                <legend>Stake</legend>
                                <div className='sentinel-ai-row'>
                                    <NumberField
                                        label={`Stake (${currency})`}
                                        value={settings.stake}
                                        min={MIN_STAKE}
                                        step={0.01}
                                        onCommit={value => set({ stake: value })}
                                    />
                                    <NumberField
                                        label={`Max stake (${currency})`}
                                        value={settings.maxStake}
                                        min={0}
                                        step={0.01}
                                        hint='0 means no cap'
                                        onCommit={value => set({ maxStake: value })}
                                    />
                                </div>
                                <NumberField
                                    label='Runs per signal'
                                    value={settings.runsPerSignal}
                                    min={1}
                                    max={10}
                                    step={1}
                                    hint='Trades taken on one signal, each on its own entry digit'
                                    onCommit={value => set({ runsPerSignal: value })}
                                />
                            </fieldset>

                            <fieldset className='sentinel-ai-card' disabled={running}>
                                <legend>Martingale</legend>
                                <div className='sentinel-ai-segment' role='radiogroup' aria-label='Martingale mode'>
                                    {MARTINGALE_OPTIONS.map(option => (
                                        <button
                                            key={option.value}
                                            type='button'
                                            role='radio'
                                            aria-checked={settings.martingaleMode === option.value}
                                            className={classNames({ 'is-on': settings.martingaleMode === option.value })}
                                            onClick={() => set({ martingaleMode: option.value })}
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                                {martingaleOn ? (
                                    <div className='sentinel-ai-row'>
                                        {settings.martingaleMode === 'custom' ? (
                                            <NumberField
                                                label='Losses before martingale'
                                                value={settings.martingaleCustomLosses}
                                                min={1}
                                                max={10}
                                                step={1}
                                                onCommit={value => set({ martingaleCustomLosses: value })}
                                            />
                                        ) : null}
                                        <NumberField
                                            label='Multiplier'
                                            value={settings.martingaleMultiplier}
                                            min={1.01}
                                            step={0.1}
                                            onCommit={value => set({ martingaleMultiplier: value })}
                                        />
                                        <NumberField
                                            label='Max steps'
                                            value={settings.martingaleMaxSteps}
                                            min={0}
                                            max={50}
                                            step={1}
                                            hint='0 means unlimited'
                                            onCommit={value => set({ martingaleMaxSteps: value })}
                                        />
                                    </div>
                                ) : null}
                            </fieldset>

                            <fieldset className='sentinel-ai-card' disabled={running}>
                                <legend>Recovery</legend>
                                <Toggle
                                    label='Enter on a recovery digit after a loss'
                                    hint="Replaces the signal's entry digit until a win"
                                    checked={settings.recoveryDigitEnabled}
                                    onChange={checked => set({ recoveryDigitEnabled: checked })}
                                />
                                {settings.recoveryDigitEnabled ? (
                                    <NumberField
                                        label='Recovery digit'
                                        value={settings.recoveryDigit}
                                        min={0}
                                        max={9}
                                        step={1}
                                        onCommit={value => set({ recoveryDigit: value })}
                                    />
                                ) : null}
                                <Toggle
                                    label='Keep the recovery stake until the session is in profit'
                                    checked={settings.recoverToBreakeven}
                                    onChange={checked => set({ recoverToBreakeven: checked })}
                                />
                            </fieldset>

                            <fieldset className='sentinel-ai-card' disabled={running}>
                                <legend>Risk limits</legend>
                                <div className='sentinel-ai-row'>
                                    <NumberField
                                        label={`Take profit (${currency})`}
                                        value={settings.takeProfit}
                                        min={0}
                                        step={1}
                                        hint='0 means off'
                                        onCommit={value => set({ takeProfit: value })}
                                    />
                                    <NumberField
                                        label={`Stop loss (${currency})`}
                                        value={settings.stopLoss}
                                        min={0}
                                        step={1}
                                        hint='0 means off'
                                        onCommit={value => set({ stopLoss: value })}
                                    />
                                </div>
                                <div className='sentinel-ai-row'>
                                    <NumberField
                                        label='Max trades'
                                        value={settings.maxTrades}
                                        min={0}
                                        step={1}
                                        hint='0 means off'
                                        onCommit={value => set({ maxTrades: value })}
                                    />
                                    <NumberField
                                        label='Max losses in a row'
                                        value={settings.maxConsecutiveLosses}
                                        min={0}
                                        max={50}
                                        step={1}
                                        hint='0 means off'
                                        onCommit={value => set({ maxConsecutiveLosses: value })}
                                    />
                                </div>
                                <NumberField
                                    label='Signal wait (seconds)'
                                    value={settings.signalWaitSeconds}
                                    min={10}
                                    max={600}
                                    step={5}
                                    hint='How long a signal waits for its entry digit'
                                    onCommit={value => set({ signalWaitSeconds: value })}
                                />
                            </fieldset>

                            <section className='sentinel-ai-card'>
                                <h3>Signal alerts</h3>
                                <p className='sentinel-ai-muted'>No sound. Pick how you want to be told about a new signal.</p>
                                <Toggle
                                    label='On-screen notice'
                                    hint='Highlights the signal and shows a notice on any tab'
                                    checked={settings.alertVisual}
                                    onChange={checked => set({ alertVisual: checked })}
                                />
                                <Toggle
                                    label='Vibrate'
                                    hint='Phones and tablets that support it'
                                    checked={settings.alertVibrate}
                                    onChange={checked => set({ alertVibrate: checked })}
                                />
                                <Toggle
                                    label='Flash the browser tab title'
                                    hint='While the tab is in the background'
                                    checked={settings.alertTitle}
                                    onChange={checked => set({ alertTitle: checked })}
                                />
                                <Toggle
                                    label='System notification'
                                    hint='While the tab is in the background'
                                    checked={settings.alertNotify}
                                    onChange={checked => set({ alertNotify: checked })}
                                />
                                {settings.alertNotify && notifyPermission === 'default' ? (
                                    <button
                                        type='button'
                                        className='sentinel-ai-secondary'
                                        onClick={() => void requestNotificationPermission().then(setNotifyPermission)}
                                    >
                                        Allow notifications
                                    </button>
                                ) : null}
                                {settings.alertNotify && notifyPermission === 'denied' ? (
                                    <p className='sentinel-ai-muted'>
                                        Notifications are blocked for this site. Allow them in your browser settings to use this.
                                    </p>
                                ) : null}
                            </section>
                        </div>
                    </div>
                </div>
            </ThemedScrollbars>
        </div>
    );
});

export default SentinelAi;
