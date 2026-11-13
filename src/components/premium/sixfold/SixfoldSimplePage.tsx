// SIXFOLD: the one tool Sixfold and Vanguard became.
// Run / Stop, one status line, what it is waiting for, the session numbers, the few settings that matter and the latest trades.
// Behind it every engine votes on every contract (scanner, Pulse, the Vanguard bot rules, the pressure engines, the edge gates), a
// digit is STUDIED for each contract, and the trade goes out when that digit prints (see fusion/fused-overlay.ts).
import { useEffect, useState } from 'react';
import '../sentinel/sentinel-simple.scss';
import { allMarketsFeed } from './all-markets-feed';
import { marketName, shortName } from './feed';
import { FUSED_DEFAULTS } from './fusion/fused-settings';
import { ENGINE_LABEL } from './fusion/consensus';
import { type FusedRow } from './fusion/fused-overlay';
import { ALL_MARKETS } from './markets';
import type { Selectivity } from './money';
import type { Phase } from './runner';
import { sixfoldFusion, sixfoldRunner } from './runner-instance';
import { MartingaleFields, VirtualHookFields } from './SignalConditions';
import { Num, Seg, Stat, Switch } from './SixfoldPage';
import { useFeedOf } from './use-feed';
import { useSixfold } from './use-sixfold';

const PHASE_LABEL: Record<Phase, string> = {
    idle: 'Ready',
    connecting: 'Connecting to the markets',
    scanning: 'Reading every market',
    watching: 'Watching every market for its entry digit',
    armed: 'Armed',
    buying: 'Placing the trade',
    settling: 'In a trade',
    cooling: 'Looking for the next trade',
};

const money = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

/** One line for a board row: what the engines said and the digit being waited for. */
const RowLine = ({ row }: { row: FusedRow }) => {
    const b = row.ballot;
    const digit = row.study?.trigger;
    return (
        <li>
            <b>{shortName(row.symbol)}</b>
            <span>{row.label}</span>
            <span title={digit?.note ?? 'No entry digit worked out yet'}>
                {digit ? `wait for ${digit.digit} (${digit.strength}${row.study?.source === 'both' ? ', both studies' : ''})` : 'studying…'}
            </span>
            <em title={b.veto ?? b.votes.map(v => `${ENGINE_LABEL[v.engine]}: ${v.note}`).join('\n')}>
                {b.veto ? 'held' : `${b.agree} for · ${b.disagree} against`}
            </em>
        </li>
    );
};

const SixfoldSimplePage = () => {
    const sx = useSixfold(true, sixfoldRunner);
    const feed = useFeedOf(allMarketsFeed);
    const s = sx.settings;
    const set = sixfoldRunner.updateSettings.bind(sixfoldRunner);
    const [more, setMore] = useState(false);

    // Always start on the live Deriv feed.
    useEffect(() => {
        if (feed.mode === 'live' && feed.status === 'offline') allMarketsFeed.connect();
        // connect once when the page opens; the button below reconnects after a manual stop
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleMarket = (symbol: string) =>
        set({ markets: s.markets.includes(symbol) ? s.markets.filter(m => m !== symbol) : [...s.markets, symbol] });

    // The contracts being watched for their entry digit, best supported first, with the studied digit of each.
    const watched = new Set(sx.watching.map(w => `${w.symbol}|${w.cellKey}`));
    const rows = sixfoldFusion
        .rows()
        .filter(r => watched.has(`${r.symbol}|${r.key}`))
        .slice(0, 6);
    const idleSec = Math.round(sixfoldFusion.idleMs() / 1000);
    const markets = new Set(sx.watching.map(w => w.symbol)).size;

    const status = sx.running
        ? sx.watching.length
            ? `Watching ${sx.watching.length} contract${sx.watching.length === 1 ? '' : 's'} on ${markets} market${markets === 1 ? '' : 's'}: the first to print its entry digit is bought`
            : PHASE_LABEL[sx.phase]
        : (sx.stopReason ?? `${sx.readyMarkets} of ${s.markets.length} markets ready`);
    const top = sx.queue[0];
    const reason =
        sx.running && sx.watching.length === 0 && sx.phase !== 'connecting' && top && !top.ok
            ? `Best: ${shortName(top.cell.symbol)} · ${top.cell.label}. ${top.reason}`
            : null;
    const feedTone = feed.mode === 'live' ? feed.status : 'warn';

    return (
        <div className='sixfold sf sn'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    SIXFOLD<small>AUTO</small>
                </b>
                <span className={`sf-feed ${feedTone}`}>{feed.mode === 'import' ? 'IMPORTED' : feed.status.toUpperCase()}</span>
            </header>

            <main className='sn-wrap'>
                <section className='sn-card sn-main'>
                    <div className='sn-pl'>
                        <small>Session P/L</small>
                        <b className={sx.session.pnl > 0 ? 'pos' : sx.session.pnl < 0 ? 'neg' : ''}>{money(sx.session.pnl)}</b>
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
                    {sx.running && idleSec >= 15 && sx.phase !== 'settling' && (
                        <div className='sn-reason'>No trade for {idleSec}s: the bar is easing step by step so something comes up.</div>
                    )}
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
                    <div className='sn-label'>Waiting for an entry digit</div>
                    {rows.length === 0 ? (
                        <p className='sn-empty'>{sx.running ? 'Nothing is ready yet. Each contract needs its digit studied and the engines to agree.' : 'Press Run to start watching.'}</p>
                    ) : (
                        <ul className='sf-trades'>
                            {rows.map(r => (
                                <RowLine key={`${r.symbol}|${r.key}`} row={r} />
                            ))}
                        </ul>
                    )}
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
                    {s.martingale && <MartingaleFields s={s} set={set} />}

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
                                    <span className='dg' title='entry digit, then the digit the contract settled on'>
                                        <i>{t.entryDigit ?? '·'}</i>→
                                        <i className={t.status === 'won' ? 'w' : t.status === 'lost' ? 'l' : ''}>{t.exitDigit ?? '·'}</i>
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
                            <Switch on={s.recovery} onChange={v => set({ recovery: v })} title='Recovery barrier' sub='' />
                            {s.recovery && (
                                <div className='sf-grid2 sn-nums'>
                                    <Num label='Over' value={s.recoveryOver} onCommit={n => set({ recoveryOver: n })} />
                                    <Num label='Under' value={s.recoveryUnder} onCommit={n => set({ recoveryUnder: n })} />
                                </div>
                            )}
                            <Switch on={s.virtualHook} onChange={v => set({ virtualHook: v })} title='Virtual hook' sub='' />
                            {s.virtualHook && <VirtualHookFields s={s} set={set} />}
                            <div className='sf-grid3 sn-nums'>
                                <Num label='Length (ticks)' value={s.duration} onCommit={n => set({ duration: n })} />
                                <Num
                                    label='Loss streak stop'
                                    value={s.maxConsecutiveLosses}
                                    onCommit={n => set({ maxConsecutiveLosses: n })}
                                    hint='0 = off'
                                />
                                <Num label='Bot gate (1-3)' value={s.gateMin} onCommit={n => set({ gateMin: n })} hint='Vanguard bot' />
                            </div>
                            <div className='sn-label'>Markets ({s.markets.length})</div>
                            <div className='sn-chips'>
                                {ALL_MARKETS.map(([sym]) => (
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
                                onClick={() => set({ ...FUSED_DEFAULTS })}
                                disabled={sx.running}
                            >
                                Reset to defaults
                            </button>
                        </div>
                    )}
                </section>

                <footer className='sn-foot'>
                    Digits are random and every contract has a payout margin, so over many trades the expected result is a loss. The
                    engines agreeing and the studied digit decide WHEN a trade goes out, not whether it wins. Martingale makes losses
                    bigger. Demo account first.
                </footer>
            </main>
        </div>
    );
};

export default SixfoldSimplePage;
