// SIXFOLD: the simple front face.
// Run / Stop, one status line, the session numbers, the few settings that matter and the latest trades. The scanner, Meter,
// Entry Brain and every gate still run in the runner; they are just no longer drawn here. The full page (SixfoldPage.tsx)
// stays in the repo because Vanguard shares its small controls.
import { useEffect, useState } from 'react';
import '../sentinel/sentinel-simple.scss';
import { marketName, MARKETS, shortName, sixfoldFeed } from './feed';
import { type EntryRule, DEFAULT_SETTINGS, type Selectivity } from './money';
import type { Phase } from './runner';
import { sixfoldRunner } from './runner-instance';
import SignalConditions from './SignalConditions';
import { Num, Seg, Stat, Switch } from './SixfoldPage';
import { useFeed } from './use-feed';
import { useSixfold } from './use-sixfold';

const PHASE_LABEL: Record<Phase, string> = {
    idle: 'Ready',
    connecting: 'Connecting to the market',
    scanning: 'Scanning the markets',
    watching: 'Watching the markets',
    armed: 'Armed',
    buying: 'Placing the trade',
    settling: 'In a trade',
    cooling: 'Looking for the next trade',
};

const money = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

const SixfoldSimplePage = () => {
    const sx = useSixfold(true, sixfoldRunner);
    const feed = useFeed();
    const s = sx.settings;
    const set = sixfoldRunner.updateSettings.bind(sixfoldRunner);
    const [more, setMore] = useState(false);

    // Always start on the live Deriv feed.
    useEffect(() => {
        if (sixfoldFeed.getMode() === 'live' && sixfoldFeed.getStatus() === 'offline') sixfoldFeed.connect();
    }, []);

    const toggleMarket = (symbol: string) =>
        set({ markets: s.markets.includes(symbol) ? s.markets.filter(m => m !== symbol) : [...s.markets, symbol] });

    // One line: what it is doing now. When it is looking but not trading, the best candidate and what holds it back.
    const status = sx.armed
        ? `${sx.armed.label} · ${shortName(sx.armed.symbol)} · waiting for entry`
        : sx.running
          ? PHASE_LABEL[sx.phase]
          : (sx.stopReason ?? `${sx.readyMarkets} of ${s.markets.length} markets ready`);
    const top = sx.queue[0];
    const reason =
        sx.running && !sx.armed && sx.phase !== 'connecting' && top && !top.ok
            ? `Best: ${shortName(top.cell.symbol)} · ${top.cell.label}. ${top.reason}`
            : null;
    const feedTone = feed.mode === 'live' ? feed.status : 'warn';

    return (
        <div className='sixfold sf sn'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    SIXFOLD<small>AUTO</small>
                </b>
                <span className={`sf-feed ${feedTone}`}>
                    {feed.mode === 'import' ? 'IMPORTED' : feed.status.toUpperCase()}
                </span>
            </header>

            <main className='sn-wrap'>
                <section className='sn-card sn-main'>
                    <div className='sn-pl'>
                        <small>Session P/L</small>
                        <b className={sx.session.pnl > 0 ? 'pos' : sx.session.pnl < 0 ? 'neg' : ''}>
                            {money(sx.session.pnl)}
                        </b>
                    </div>
                    {sx.running ? (
                        <button className='sf-run stop' onClick={() => sixfoldRunner.stop('Stopped by you')}>
                            Stop
                        </button>
                    ) : (
                        <button className='sf-run' onClick={() => sixfoldRunner.start()}>
                            Run
                        </button>
                    )}
                    <div className='sn-status' role='status'>
                        {status}
                    </div>
                    {reason && <div className='sn-reason'>{reason}</div>}
                    {feed.mode === 'live' && feed.status === 'offline' && !sx.running && (
                        <button className='sf-btn primary' onClick={feed.connect}>
                            Connect live
                        </button>
                    )}
                    {(sx.lastError || feed.error) && <div className='sf-msg bad'>{sx.lastError || feed.error}</div>}
                    <div className='sf-stats'>
                        <Stat label='Trades' value={sx.session.trades} />
                        <Stat label='Won / lost' value={`${sx.session.wins} / ${sx.session.losses}`} />
                        <Stat label='Next stake' value={sx.session.currentStake.toFixed(2)} />
                    </div>
                </section>

                <section className='sn-card'>
                    <div className='sn-label'>Contracts</div>
                    <div className='sf-grid2'>
                        <div>
                            <Switch on={s.useOver} onChange={v => set({ useOver: v })} title='Over' sub='' />
                            <Num label='Barrier' value={s.primaryOver} onCommit={n => set({ primaryOver: n })} />
                        </div>
                        <div>
                            <Switch on={s.useUnder} onChange={v => set({ useUnder: v })} title='Under' sub='' />
                            <Num label='Barrier' value={s.primaryUnder} onCommit={n => set({ primaryUnder: n })} />
                        </div>
                    </div>

                    <div className='sf-grid3 sn-nums'>
                        <Num label='Stake' value={s.stake} onCommit={n => set({ stake: n })} />
                        <Num label='Take profit' value={s.takeProfit} onCommit={n => set({ takeProfit: n })} hint='0 = off' />
                        <Num label='Stop loss' value={s.stopLoss} onCommit={n => set({ stopLoss: n })} hint='0 = off' />
                    </div>

                    <Switch on={s.martingale} onChange={v => set({ martingale: v })} title='Martingale' sub='' />
                    {s.martingale && (
                        <div className='sf-grid2 sn-nums'>
                            <Num label='Max steps' value={s.maxSteps} onCommit={n => set({ maxSteps: n })} hint='0 = no limit' />
                            <Num label='Max stake' value={s.maxStake} onCommit={n => set({ maxStake: n })} hint='0 = no cap' />
                        </div>
                    )}

                    <div className='sn-label'>Selectivity</div>
                    <Seg<Selectivity>
                        label='Selectivity'
                        value={s.selectivity}
                        onChange={v => set({ selectivity: v })}
                        options={[
                            ['strict', 'Strict'],
                            ['balanced', 'Balanced'],
                            ['active', 'Active'],
                        ]}
                    />
                </section>

                <section className='sn-card'>
                    <div className='sn-label'>Latest trades</div>
                    {sx.trades.length === 0 ? (
                        <p className='sn-empty'>No trades yet.</p>
                    ) : (
                        <ul className='sf-trades'>
                            {sx.trades.slice(0, 8).map(t => (
                                <li key={t.contractId} className={t.status}>
                                    <b>{shortName(t.symbol)}</b>
                                    <span>
                                        {t.label}
                                        {t.recovery ? ' ↺' : ''}
                                        {t.virtual ? ' · paper' : ''}
                                    </span>
                                    <span className='dg'>
                                        <i>{t.entryDigit ?? '·'}</i>→
                                        <i className={t.status === 'won' ? 'w' : t.status === 'lost' ? 'l' : ''}>
                                            {t.exitDigit ?? '·'}
                                        </i>
                                    </span>
                                    <span>{t.stake.toFixed(2)}</span>
                                    <em>{t.profit === null ? (t.status === 'open' ? 'open' : '?') : money(t.profit)}</em>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className='sn-card'>
                    <button type='button' className='sn-more' aria-expanded={more} onClick={() => setMore(v => !v)}>
                        More settings <span aria-hidden='true'>{more ? '−' : '+'}</span>
                    </button>
                    {more && (
                        <div className='sn-morebody'>
                            <div className='sn-label'>Entry</div>
                            <Seg<EntryRule>
                                label='Entry'
                                value={s.entry}
                                onChange={v => set({ entry: v })}
                                options={[
                                    ['BRAIN', 'Entry Brain'],
                                    ['SMART', 'Adaptive'],
                                    ['SETUP', 'Fixed digit'],
                                    ['ANY', 'Any tick'],
                                ]}
                            />
                            <Switch on={s.recovery} onChange={v => set({ recovery: v })} title='Recovery barrier' sub='' />
                            {s.recovery && (
                                <div className='sf-grid2 sn-nums'>
                                    <Num label='Over' value={s.recoveryOver} onCommit={n => set({ recoveryOver: n })} />
                                    <Num label='Under' value={s.recoveryUnder} onCommit={n => set({ recoveryUnder: n })} />
                                </div>
                            )}
                            <SignalConditions s={s} set={set} />
                            <div className='sf-grid3 sn-nums'>
                                <Num label='Length (ticks)' value={s.duration} onCommit={n => set({ duration: n })} />
                                <Num label='Wait (s)' value={s.waitSeconds} onCommit={n => set({ waitSeconds: n })} hint='for entry' />
                                <Num
                                    label='Loss streak stop'
                                    value={s.maxConsecutiveLosses}
                                    onCommit={n => set({ maxConsecutiveLosses: n })}
                                    hint='0 = off'
                                />
                            </div>
                            <div className='sn-label'>Markets ({s.markets.length})</div>
                            <div className='sn-chips'>
                                {MARKETS.map(([sym]) => (
                                    <button
                                        key={sym}
                                        type='button'
                                        className={s.markets.includes(sym) ? 'on' : ''}
                                        aria-pressed={s.markets.includes(sym)}
                                        onClick={() => toggleMarket(sym)}
                                        title={marketName(sym)}
                                    >
                                        {shortName(sym)}
                                    </button>
                                ))}
                            </div>
                            <button
                                type='button'
                                className='sf-btn subtle'
                                onClick={() => set({ ...DEFAULT_SETTINGS })}
                                disabled={sx.running}
                            >
                                Reset to defaults
                            </button>
                        </div>
                    )}
                </section>

                <footer className='sn-foot'>
                    Digits are random and every contract has a payout margin, so over many trades the expected result is a
                    loss. Martingale makes losses bigger. Demo account first.
                </footer>
            </main>
        </div>
    );
};

export default SixfoldSimplePage;
