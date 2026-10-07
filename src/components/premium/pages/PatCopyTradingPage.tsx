import { useEffect, useMemo, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { CopyTradingService, type CopyFollower, type CopyLog } from '@/services/copy-trading.service';

const PatCopyTradingPage = () => {
    const { authData } = useApiBase();
    const [tokenText, setTokenText] = useState('');
    const [followers, setFollowers] = useState<CopyFollower[]>([]);
    const [logs, setLogs] = useState<CopyLog[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [running, setRunning] = useState(CopyTradingService.isRunning());
    const [error, setError] = useState('');

    useEffect(() => CopyTradingService.subscribe(log => setLogs(current => [log, ...current].slice(0, 40))), []);

    const masterAccount = authData?.loginid || localStorage.getItem('active_loginid') || 'Current Deriv account';
    const masterType = localStorage.getItem('account_type') || 'active';
    const syncedCount = followers.length;
    const realFollowers = useMemo(() => followers.filter(item => item.account_type === 'real').length, [followers]);
    const demoFollowers = syncedCount - realFollowers;

    const sync = async () => {
        setSyncing(true);
        setError('');
        try {
            const next = await CopyTradingService.syncTokens(tokenText);
            setFollowers(next);
        } catch (err) {
            setFollowers([]);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSyncing(false);
        }
    };

    const start = async () => {
        setError('');
        try {
            let targets = followers;
            if (!targets.length) {
                targets = await CopyTradingService.syncTokens(tokenText);
                setFollowers(targets);
            }
            await CopyTradingService.start(targets);
            setRunning(true);
        } catch (err) {
            setRunning(false);
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const stop = () => {
        CopyTradingService.stop();
        setRunning(false);
    };

    return <div className='prodb-live-page prodb-copy-token-page'>
        <header className='prodb-live-header'>
            <span>MASTER → FOLLOWERS</span>
            <div>
                <h1>Copy Trading</h1>
                <p>The logged-in account is the master. Paste trade-scoped follower tokens, sync them, then start or stop copying.</p>
            </div>
        </header>

        <div className='prodb-copy-master'>
            <div><small>MASTER ACCOUNT</small><strong>{masterAccount}</strong><span>{masterType}</span></div>
            <div><small>FOLLOWERS</small><strong>{syncedCount}</strong><span>{realFollowers} real · {demoFollowers} demo</span></div>
            <div className={running ? 'is-running' : ''}><small>COPY STATUS</small><strong>{running ? 'RUNNING' : 'STOPPED'}</strong><span>{running ? 'Watching confirmed master purchases' : 'No follower purchases will be sent'}</span></div>
        </div>

        <div className='prodb-live-grid prodb-live-grid--copy-token'>
            <section className='prodb-live-card'>
                <div className='prodb-live-card__title'><h2>Follower API tokens</h2><span className='prodb-live-badge'>{syncedCount} SYNCED</span></div>
                <p className='prodb-api-note'>Paste one Personal Access Token per line. Tokens are kept in memory only for this browser session and are not written to localStorage or sessionStorage.</p>
                <label className='prodb-token-field'>Follower tokens
                    <textarea
                        value={tokenText}
                        onChange={event => setTokenText(event.target.value)}
                        rows={8}
                        spellCheck={false}
                        autoComplete='off'
                        placeholder={'token_one\ntoken_two\ntoken_three'}
                    />
                </label>
                <div className='prodb-live-actions'>
                    <button onClick={sync} disabled={syncing || running}>{syncing ? 'Validating…' : 'Sync tokens'}</button>
                    {!running
                        ? <button className='is-primary' onClick={start} disabled={syncing || !tokenText.trim()}>Start copy trading</button>
                        : <button className='is-danger' onClick={stop}>Stop copy trading</button>}
                </div>
                {error && <div className='prodb-live-error'>{error}</div>}
            </section>

            <section className='prodb-live-card'>
                <div className='prodb-live-card__title'><h2>Synced follower accounts</h2><span>{followers.length}</span></div>
                <div className='prodb-copy-followers'>
                    {followers.length === 0
                        ? <div className='prodb-live-empty'>No follower token has been synced yet.</div>
                        : followers.map(item => <article key={item.id}>
                            <div><strong>{item.account_id}</strong><small>{item.token_hint}</small></div>
                            <span>{item.account_type}</span>
                            <b>{item.balance.toFixed(2)} {item.currency}</b>
                        </article>)}
                </div>
            </section>
        </div>

        <section className='prodb-live-card prodb-copy-log-card'>
            <div className='prodb-live-card__title'><h2>Copy activity</h2><button className='is-ghost' onClick={() => setLogs([])}>Clear</button></div>
            <div className='prodb-copy-logs'>
                {logs.length === 0
                    ? <div className='prodb-live-empty'>Activity will appear here after tokens are synced or copy trading starts.</div>
                    : logs.map(log => <div key={log.id} className={`is-${log.level}`}><time>{new Date(log.at).toLocaleTimeString()}</time><span>{log.message}</span></div>)}
            </div>
        </section>
    </div>;
};

export default PatCopyTradingPage;
