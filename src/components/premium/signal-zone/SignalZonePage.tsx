// SIGNAL ZONE: scan Sentinel AI and Insight Fusion together, pick the best market with an entry digit, and load it into a Masika bot.
// You press Run in Bot Builder yourself; nothing here ever runs a bot or buys a contract.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BULK_MARKETS } from '../over-under-engine';
import { loadSignalIntoBot } from './signal-zone-loader';
import { addEntry, entryFor, loadHistory, saveHistory, summarize, type HistoryEntry } from './signal-zone-history';
import { mergeCandidates, revalidate, type ZoneCandidate } from './signal-zone-merge';
import { signalZoneSession } from './signal-zone-session';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings, type MergeMode, type SignalZoneSettings } from './signal-zone-settings';
import { attachSources, readSources, type SourceStatus } from './signal-zone-sources';
import './signal-zone.scss';

const MODE_TEXT: Record<MergeMode, { title: string; hint: string }> = {
    both: { title: 'Both agree', hint: 'Sentinel AI and Insight Fusion must read the same market, side and barrier. Strictest, fewest signals.' },
    fusion_leads: { title: 'Fusion leads', hint: 'Insight Fusion picks the contract; Sentinel AI only supplies the entry digit for that exact contract.' },
    sentinel_only: { title: 'Sentinel AI only', hint: 'Sentinel AI picks the contract and the entry digit. Fusion agreement is shown for information.' },
};

const SOURCE_TEXT = { both: 'Both engines', fusion: 'Fusion only', sentinel: 'Sentinel only' } as const;

/** A number box that lets the user type freely ("0.", "") and commits only valid numbers. */
const NumField = ({ label, value, onCommit, hint }: {
    label: string; value: number; onCommit: (value: number) => void; hint?: string;
}) => {
    const [text, setText] = useState(String(value));
    const focused = useRef(false);
    useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
    return (
        <label className='sz-field'>
            <span>{label}</span>
            <input
                type='text' inputMode='decimal' value={text}
                onFocus={() => { focused.current = true; }}
                onBlur={() => { focused.current = false; setText(String(value)); }}
                onChange={event => {
                    setText(event.target.value);
                    const n = event.target.value.trim() === '' ? NaN : Number(event.target.value);
                    if (Number.isFinite(n)) onCommit(n);
                }}
            />
            {hint ? <small>{hint}</small> : null}
        </label>
    );
};

const Toggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) => (
    <label className='sz-toggle'>
        <input type='checkbox' checked={checked} onChange={event => onChange(event.target.checked)} />
        <span>{label}</span>
    </label>
);

const num = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? '-' : value.toFixed(digits));

const SignalZonePage = ({ openBotBuilder }: { openBotBuilder: () => void }) => {
    const [settings, setSettings] = useState<SignalZoneSettings>(() => loadSettings());
    const [scan, setScan] = useState<{ at: number; candidates: ZoneCandidate[] } | null>(null);
    const [selectedId, setSelectedId] = useState('');
    const [status, setStatus] = useState<SourceStatus | null>(null);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
    const session = useSyncExternalStore(signalZoneSession.subscribe, signalZoneSession.getSnapshot);

    useEffect(() => attachSources(), []);
    useEffect(() => { saveSettings(settings); }, [settings]);
    useEffect(() => {
        const refresh = () => setStatus(readSources(settings.requireMomentum, Date.now()).status);
        refresh();
        const timer = window.setInterval(refresh, 2000);
        return () => window.clearInterval(timer);
    }, [settings.requireMomentum]);
    // The log is written by the app-level bridge when a run ends; re-read it whenever the session changes.
    useEffect(() => { setHistory(loadHistory()); }, [session.running, session.stoppedBy]);

    const update = useCallback(<K extends keyof SignalZoneSettings>(key: K, value: SignalZoneSettings[K]) => {
        setSettings(current => ({ ...current, [key]: value }));
    }, []);

    const problems = useMemo(() => validateSettings(settings), [settings]);
    const selected = scan?.candidates.find(item => item.id === selectedId) ?? null;

    const runScan = () => {
        setError('');
        const now = Date.now();
        const read = readSources(settings.requireMomentum, now);
        setStatus(read.status);
        const candidates = mergeCandidates(read.sentinel, read.fusion, settings, now);
        setScan({ at: now, candidates });
        const best = candidates.find(item => item.loadable) ?? null;
        setSelectedId(best ? best.id : candidates[0]?.id ?? '');
        if (!read.status.warm) setMessage('The engines are still warming up. Give them a moment and scan again.');
        else if (best) setMessage(`Best signal: ${best.label} on ${best.market}, entry digit ${best.entryDigit}.`);
        else setMessage('No market qualifies right now. The nearest candidates are listed below, with the reason each cannot be loaded.');
    };

    const loadBot = async () => {
        if (loading) return;
        setError('');
        if (problems.length) { setError(problems[0]); return; }
        const now = Date.now();
        const read = readSources(settings.requireMomentum, now);
        const fresh = mergeCandidates(read.sentinel, read.fusion, settings, now);
        const check = revalidate(selected, fresh, now);
        if (!check.ok) { setError(check.reason); return; }
        setLoading(true);
        try {
            const outcome = await loadSignalIntoBot(check.candidate, settings, openBotBuilder);
            const next = addEntry(loadHistory(), entryFor(check.candidate, settings.mergeMode, now));
            saveHistory(next);
            setHistory(next);
            setMessage(`Loaded ${outcome.botName}: ${outcome.summary}. Press Run in Bot Builder.`);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    };

    const toggleMarket = (symbol: string) => update(
        'excludedMarkets',
        settings.excludedMarkets.includes(symbol) ? settings.excludedMarkets.filter(item => item !== symbol) : [...settings.excludedMarkets, symbol],
    );

    const groups = useMemo(() => summarize(history), [history]);
    const canLoad = Boolean(selected?.loadable) && !problems.length && !loading;

    return (
        <div className='sz'>
            <header className='sz__head'>
                <div>
                    <h1>Signal Zone</h1>
                    <p>Scan Sentinel AI and Insight Fusion together, then load the best market into a Masika bot. You press Run.</p>
                </div>
                <div className='sz__engines' aria-label='Engine status'>
                    <span className={status && status.sentinelOnline > 0 ? 'is-on' : ''}>Sentinel AI {status ? `${status.sentinelOnline}/${status.sentinelTotal}` : '...'}</span>
                    <span className={status && status.fusionReady > 0 ? 'is-on' : ''}>Insight Fusion {status ? `${status.fusionReady}/${status.fusionTotal}` : '...'}</span>
                </div>
            </header>

            <div className='sz__grid'>
                <section className='sz__panel' aria-label='Settings'>
                    <h2>Settings</h2>
                    <fieldset className='sz-modes'>
                        <legend>Signal source</legend>
                        {(Object.keys(MODE_TEXT) as MergeMode[]).map(mode => (
                            <label key={mode} className={settings.mergeMode === mode ? 'is-active' : ''}>
                                <input type='radio' name='sz-mode' checked={settings.mergeMode === mode} onChange={() => update('mergeMode', mode)} />
                                <span>{MODE_TEXT[mode].title}</span>
                                <small>{MODE_TEXT[mode].hint}</small>
                            </label>
                        ))}
                    </fieldset>
                    <div className='sz-fields'>
                        <NumField label='Stake' value={settings.stake} onCommit={v => update('stake', v)} />
                        <NumField label='Martingale multiplier' value={settings.martingaleMultiplier} onCommit={v => update('martingaleMultiplier', v)} hint='1 keeps the stake flat' />
                        <NumField label='Martingale level' value={settings.martingaleLevel} onCommit={v => update('martingaleLevel', v)} hint='Bot stops after this many losses in a row' />
                        <NumField label='Max stake' value={settings.maxStake} onCommit={v => update('maxStake', v)} />
                        <NumField label='Take profit' value={settings.takeProfit} onCommit={v => update('takeProfit', v)} hint='The bot stops at this session profit' />
                        <NumField label='Stop loss' value={settings.stopLoss} onCommit={v => update('stopLoss', v)} hint='Enforced by Signal Zone; 0 = off' />
                        <NumField label='Recovery Over barrier' value={settings.recoveryOverBarrier} onCommit={v => update('recoveryOverBarrier', v)} hint='1, 2 or 3' />
                        <NumField label='Recovery Under barrier' value={settings.recoveryUnderBarrier} onCommit={v => update('recoveryUnderBarrier', v)} hint='8, 7 or 6' />
                        <NumField label='Min Sentinel score' value={settings.minScore} onCommit={v => update('minScore', v)} hint='0 = off' />
                        <NumField label='Max Sentinel danger' value={settings.maxDanger} onCommit={v => update('maxDanger', v)} hint='0 = off' />
                    </div>
                    <div className='sz-toggles'>
                        <Toggle label='Require momentum' checked={settings.requireMomentum} onChange={v => update('requireMomentum', v)} />
                        <Toggle label='Skip blocked signals' checked={settings.skipBlocked} onChange={v => update('skipBlocked', v)} />
                    </div>
                    <div className='sz-markets'>
                        <span>Exclude markets</span>
                        <div>
                            {BULK_MARKETS.map(market => (
                                <button
                                    key={market.symbol} type='button' className={settings.excludedMarkets.includes(market.symbol) ? 'is-off' : ''}
                                    onClick={() => toggleMarket(market.symbol)} aria-pressed={settings.excludedMarkets.includes(market.symbol)}
                                >{market.name}</button>
                            ))}
                        </div>
                    </div>
                    {problems.length ? <ul className='sz-problems'>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul> : null}
                    <button type='button' className='sz-link' onClick={() => setSettings({ ...DEFAULT_SETTINGS, excludedMarkets: [] })}>Reset to defaults</button>
                </section>

                <section className='sz__panel' aria-label='Scanner'>
                    <h2>Scanner</h2>
                    <div className='sz-actions'>
                        <button type='button' className='sz-btn sz-btn--scan' onClick={runScan}>Scan</button>
                        <button type='button' className='sz-btn sz-btn--load' onClick={loadBot} disabled={!canLoad}>{loading ? 'Loading...' : 'Load Bot'}</button>
                    </div>
                    {scan ? <p className='sz-stamp'>Last scan {new Date(scan.at).toLocaleTimeString()}</p> : <p className='sz-stamp'>Press Scan to read both engines.</p>}
                    {message ? <p className='sz-message'>{message}</p> : null}
                    {error ? <p className='sz-error' role='alert'>{error}</p> : null}

                    {selected ? (
                        <article className={`sz-result ${selected.loadable ? 'is-ready' : 'is-blocked'}`}>
                            <div className='sz-result__top'>
                                <strong>{selected.label}</strong>
                                <span>{selected.market}</span>
                                <em className={`sz-badge sz-badge--${selected.source}`}>{SOURCE_TEXT[selected.source]}</em>
                            </div>
                            <dl>
                                <div><dt>Entry digit</dt><dd className='sz-digit'>{selected.entryDigit ?? '-'}</dd></div>
                                <div><dt>Entry status</dt><dd>{selected.entryStatus.toLowerCase()}</dd></div>
                                <div><dt>Window</dt><dd>{selected.entryWindow || '-'}</dd></div>
                                <div><dt>Entry estimate</dt><dd>{selected.entryWinRate === null ? '-' : `${selected.entryWinRate}%`}</dd></div>
                                <div><dt>Sentinel</dt><dd>{selected.sentinel ? `score ${num(selected.sentinel.score)} / danger ${num(selected.sentinel.danger)}` : 'no signal'}</dd></div>
                                <div><dt>Fusion</dt><dd>{selected.fusion ? `${selected.fusion.action.toLowerCase().replace('_', ' ')} / score ${num(selected.fusion.score)} / danger ${num(selected.fusion.danger)}` : 'no signal'}</dd></div>
                            </dl>
                            {selected.reason ? <p className='sz-why'>{selected.reason}</p> : null}
                        </article>
                    ) : null}

                    {scan && scan.candidates.length > 1 ? (
                        <details className='sz-list'>
                            <summary>All candidates ({scan.candidates.length})</summary>
                            <ul>
                                {scan.candidates.map(item => (
                                    <li key={item.id}>
                                        <button type='button' className={item.id === selectedId ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}>
                                            <span>{item.label} / {item.market}</span>
                                            <span>{SOURCE_TEXT[item.source]}</span>
                                            <span>{item.loadable ? `digit ${item.entryDigit}` : 'not loadable'}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ) : null}

                    <div className={`sz-session ${session.stoppedBy ? 'is-stopped' : ''}`}>
                        <h3>After loading</h3>
                        {session.loadStatus ? <p className={session.loadStatus.ok ? 'sz-message' : 'sz-error'}>{session.loadStatus.message}</p> : <p className='sz-stamp'>Nothing loaded yet.</p>}
                        {session.armed ? (
                            <p>
                                Stop loss {session.stopLoss > 0 ? `armed at ${session.stopLoss}` : 'is off'} for every run until you disarm.
                                {session.running && session.pnl !== null ? ` Running now: ${session.pnl >= 0 ? '+' : ''}${session.pnl.toFixed(2)}.` : ''}
                                {' '}<button type='button' className='sz-link' onClick={() => signalZoneSession.disarm()}>Disarm</button>
                            </p>
                        ) : null}
                        {session.stoppedBy ? <p className='sz-error'>Bot stopped: {session.stoppedBy}.</p> : null}
                    </div>

                    <p className='sz-note'>An entry digit changes when the bot buys, not the odds of the contract. Engine percentages are estimates, not promises. Try it on a virtual account with a small stake first.</p>
                </section>
            </div>

            <section className='sz__panel' aria-label='Signal history'>
                <h2>Signal history</h2>
                {groups.length ? (
                    <table className='sz-table'>
                        <thead><tr><th>Mode</th><th>Source</th><th>Loaded</th><th>Finished</th><th>Profitable</th><th>Net</th></tr></thead>
                        <tbody>
                            {groups.map(group => (
                                <tr key={group.key}>
                                    <td>{MODE_TEXT[group.mode].title}</td><td>{SOURCE_TEXT[group.source]}</td><td>{group.loads}</td><td>{group.finished}</td>
                                    <td>{group.wins}</td><td className={group.net >= 0 ? 'is-win' : 'is-loss'}>{group.net.toFixed(2)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : <p className='sz-stamp'>Loaded signals and how their runs ended will be counted here, so you can compare the modes with your own results.</p>}
            </section>
        </div>
    );
};

export default SignalZonePage;
