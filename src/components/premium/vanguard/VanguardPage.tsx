// VANGUARD: the "Sentinel Under 7 Psychology" bot's entry rules (and the same rules mirrored for Over 2), run on every market at once.
// Press Run and Vanguard reads each market's own digits; the first market and contract to meet every rule is bought, through the same trade machinery Sixfold uses (stake, recovery, limits,
// one trade at a time, stale-tick and refusal handling). Trades appear in the general Transactions panel.
import { useEffect, useMemo } from 'react';
import { marketName, shortName } from '../sixfold/feed';
import { ALL_MARKETS } from '../sixfold/markets';
import type { SixfoldSettings } from '../sixfold/money';
import { Num, Panel, Seg, Stat, Switch } from '../sixfold/SixfoldPage';
import { useFeedOf } from '../sixfold/use-feed';
import { useRunner } from '../sixfold/use-sixfold';
import '../sixfold/sixfold.scss';
import './vanguard.scss';
import { vanguardFeed, vanguardRunner } from './vanguard-instance';
import { VANGUARD_DEFAULTS } from './vanguard-settings';

const money = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

const PHASE: Record<string, string> = {
    idle: 'Stopped',
    connecting: 'Connecting to the market feed…',
    watching: 'Watching every market for the bot rules',
    armed: 'Buying…',
    buying: 'Buying…',
    settling: 'Waiting for the result',
    cooling: 'Looking again',
    scanning: 'Watching every market for the bot rules',
};

const VanguardPage = () => {
    const feed = useFeedOf(vanguardFeed);
    const vx = useRunner(vanguardRunner, true);
    const s = vx.settings;
    const set = (patch: Partial<SixfoldSettings>) => vanguardRunner.updateSettings(patch);
    const toggleMarket = (symbol: string) => set({ markets: s.markets.includes(symbol) ? s.markets.filter(m => m !== symbol) : [...s.markets, symbol] });

    useEffect(() => {
        if (feed.status === 'offline') vanguardFeed.connect();
        // connect once when the page opens; the button below reconnects after a manual stop
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const rows = useMemo(() => {
        const list = [...(vx.rules?.rows ?? [])];
        // markets that meet every rule first, then the closest ones
        return list.sort((a, b) => Number(b.entry) - Number(a.entry) || Number(b.ready) - Number(a.ready) || (b.score ?? -1) - (a.score ?? -1));
    }, [vx.rules]);
    const ready = rows.filter(r => r.entry).length;
    const contractLabel = (side: 'UNDER' | 'OVER') => (side === 'UNDER' ? `Under ${s.primaryUnder}` : `Over ${s.primaryOver}`);
    const mode = vx.rules?.paper
        ? `Paper mode: ${vx.rules.paperLosses}/${vx.rules.paperNeeded} paper losses before a signal is bought for real`
        : 'Real mode: the next signal is bought';

    return (
        <div className='sixfold sf vanguard'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    VANGUARD<small>BOT RULES · EVERY MARKET</small>
                </b>
                <span className={`sf-feed ${feed.mode === 'live' ? feed.status : 'warn'}`}>{feed.status.toUpperCase()}</span>
            </header>

            <main className='sf-scanner'>
                <Panel eyebrow='RUN' title='Bot rules on every market, both ways'>
                    <div className={`sf-phase t-${vx.running ? 'armed' : 'scan'}`}>
                        {vx.lastError ? vx.lastError : vx.stopReason && !vx.running ? vx.stopReason : PHASE[vx.phase] ?? vx.phase}
                    </div>
                    <div className='vg-mode' role='status'>
                        <span>{s.virtualMode ? mode : 'Paper mode is off: the first signal is bought'}</span>
                        {vx.rules?.paperPending && <span>Paper trade waiting on {shortName(vx.rules.paperPending)}</span>}
                        <span>{ready === 0 ? 'No market meets every rule right now' : `${ready} contract${ready === 1 ? '' : 's'} meet every rule`}</span>
                    </div>
                    {vx.running ? (
                        <button className='sf-run stop' onClick={() => vanguardRunner.stop('Stopped by you')}>
                            Stop
                        </button>
                    ) : (
                        <button className='sf-run' onClick={() => vanguardRunner.start()}>
                            Run
                        </button>
                    )}
                    {!vx.running && feed.status !== 'live' && (
                        <button className='sf-btn' onClick={feed.connect}>
                            Connect live
                        </button>
                    )}
                    <div className='sf-grid3'>
                        <Stat label='Trades' value={vx.session.trades} />
                        <Stat label='Won / lost' value={`${vx.session.wins} / ${vx.session.losses}`} />
                        <Stat label='Profit' value={money(vx.session.pnl)} tone={vx.session.pnl > 0 ? 'pos' : vx.session.pnl < 0 ? 'neg' : undefined} />
                    </div>
                </Panel>

                <Panel eyebrow='RULES BOARD' title='What each market still needs'>
                    <p className='sf-muted'>
                        Every market is read on its own digits, once for Under {s.primaryUnder} (the bot's rules) and once for Over {s.primaryOver} (the same rules
                        mirrored). A trade needs all seven checks to be true on the same tick. The last column shows the first thing still missing.
                    </p>
                    <div className='vg-board' role='table' aria-label='Rules board'>
                        <div className='vg-row vg-head' role='row'>
                            <span>Market</span>
                            <span>Contract</span>
                            <span title='Regime score out of 12'>Score</span>
                            <span className='vg-dots' title='Regime ≥ 10 · Pressure · No veto · Winning · Digit 8 · Last ≤ 6 · Gate'>
                                Checks
                            </span>
                            <span>Missing</span>
                        </div>
                        {rows.map(r => (
                            <div key={`${r.symbol}|${r.side}`} className={`vg-row ${r.entry ? 'go' : ''}`} role='row'>
                                <b title={marketName(r.symbol)}>{shortName(r.symbol)}</b>
                                <span>{contractLabel(r.side)}</span>
                                <span className='n'>{r.score === null ? '·' : `${r.score}/12`}</span>
                                <span className='vg-dots'>
                                    {r.checks.length === 0 ? (
                                        <i className='vg-dot' />
                                    ) : (
                                        r.checks.map(c => <i key={c.key} className={`vg-dot ${c.ok ? 'ok' : ''}`} title={`${c.label}: ${c.ok ? 'yes' : 'no'}`} />)
                                    )}
                                </span>
                                <small>{r.entry ? 'All rules met' : r.waitingOn}</small>
                            </div>
                        ))}
                        {rows.length === 0 && <p className='sf-muted'>Waiting for the market feed…</p>}
                    </div>
                </Panel>

                <Panel eyebrow='PAPER TRADES' title={vx.rules ? `${vx.rules.paperWon} won, ${vx.rules.paperLost} lost on paper` : 'Paper trades'}>
                    <p className='sf-muted'>
                        While paper mode is on, a signal is recorded and settled on the next tick instead of being bought. Paper trades also show in the Transactions
                        panel as Virtual Win or Virtual Loss, and never count in your real totals.
                    </p>
                    {(vx.rules?.paperTrades.length ?? 0) === 0 ? (
                        <p className='sf-muted'>No paper trades yet.</p>
                    ) : (
                        <ul className='sf-trades'>
                            {vx.rules?.paperTrades.slice(0, 10).map(t => (
                                <li key={t.id} className={t.status === 'won' ? 'won' : t.status === 'lost' ? 'lost' : 'open'}>
                                    <b>{marketName(t.symbol)}</b>
                                    <span>{t.label}</span>
                                    <span className='dg' title='digit at the signal, then the digit it settled on'>
                                        <i>{t.entryDigit ?? '·'}</i>→<i className={t.status === 'won' ? 'w' : t.status === 'lost' ? 'l' : ''}>{t.exitDigit ?? '·'}</i>
                                    </span>
                                    <em>{t.status === 'open' ? 'waiting' : t.status === 'void' ? 'no tick' : t.status === 'won' ? 'paper win' : 'paper loss'}</em>
                                </li>
                            ))}
                        </ul>
                    )}
                </Panel>

                <Panel eyebrow='SETTINGS' title='How it trades'>
                    <p className='sf-muted'>
                        Buys Digits Under {s.primaryUnder} and Over {s.primaryOver}.{' '}
                        {s.recovery ? `After a loss it switches to Under ${s.recoveryUnder} / Over ${s.recoveryOver}` : 'No recovery contract'}
                        {s.martingale ? `, sized so one win pays back ${s.recoverShare}% of what is owed (capped).` : '.'}
                    </p>
                    <div className='sf-grid3'>
                        <Num label='Stake' value={s.stake} onCommit={n => set({ stake: n })} />
                        <Num label='TP' value={s.takeProfit} onCommit={n => set({ takeProfit: n })} hint='0 = off' />
                        <Num label='SL' value={s.stopLoss} onCommit={n => set({ stopLoss: n })} hint='0 = off' />
                    </div>
                    <div className='sf-field'>
                        <span>Contracts</span>
                        <Switch on={s.useUnder} onChange={v => set({ useUnder: v })} title={`Under ${s.primaryUnder}`} sub={`The bot's own rules. Recovery: Under ${s.recoveryUnder}`} />
                        <Switch on={s.useOver} onChange={v => set({ useOver: v })} title={`Over ${s.primaryOver}`} sub={`The same rules mirrored. Recovery: Over ${s.recoveryOver}`} />
                    </div>
                    <Switch on={s.recovery} onChange={v => set({ recovery: v })} title='Recovery contract' sub={`Under ${s.recoveryUnder} / Over ${s.recoveryOver} after a loss`} />
                    <Switch on={s.martingale} onChange={v => set({ martingale: v })} title='Recovery stake' sub='Bigger stake after a loss, as the bot does' />
                    {s.martingale && (
                        <div className='sf-grid3'>
                            <Num label='Win pays back %' value={s.recoverShare} onCommit={n => set({ recoverShare: n })} hint='50 = half' />
                            <Num label='Max steps' value={s.maxSteps} onCommit={n => set({ maxSteps: n })} hint='0 = no cap' />
                            <Num label='Streak budget ×' value={s.streakBudget} onCommit={n => set({ streakBudget: n })} hint='× stake' />
                        </div>
                    )}
                    <Num label='Stop after losses in a row' value={s.maxConsecutiveLosses} onCommit={n => set({ maxConsecutiveLosses: n })} hint='0 = off' />
                    <Switch
                        on={s.virtualMode}
                        onChange={v => set({ virtualMode: v })}
                        title='Paper mode first'
                        sub='Signals are paper-traded until losses happen; a real win sends it back to paper'
                    />
                    {s.virtualMode && <Num label='Paper losses before real' value={s.virtualLosses} onCommit={n => set({ virtualLosses: n })} hint='the bot uses 2' />}
                    <div className='sf-field'>
                        <span>Psychology gate</span>
                        <Seg<'1' | '2'>
                            label='Psychology gate'
                            value={String(Math.min(2, s.gateMin)) as '1' | '2'}
                            onChange={v => set({ gateMin: Number(v) })}
                            options={[
                                ['1', 'At least 1'],
                                ['2', 'At least 2 (the original)'],
                            ]}
                        />
                        <small>How many digits in each group must be moving the right way. The original bot asked for 2, which let almost nothing through.</small>
                    </div>
                    <div className='sf-field'>
                        <span>Markets ({s.markets.length} on)</span>
                        <div className='sf-chips'>
                            {ALL_MARKETS.map(([sym]) => (
                                <button
                                    key={sym}
                                    type='button'
                                    className={`sf-chip ${s.markets.includes(sym) ? 'on' : ''}`}
                                    aria-pressed={s.markets.includes(sym)}
                                    onClick={() => toggleMarket(sym)}
                                    title={vx.unavailable.includes(sym) ? `${marketName(sym)}: Deriv is not streaming this market, so it is skipped` : marketName(sym)}
                                    data-unavailable={vx.unavailable.includes(sym) || undefined}
                                >
                                    {shortName(sym)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <button className='sf-btn' onClick={() => set({ ...VANGUARD_DEFAULTS })} disabled={vx.running}>
                        Reset to defaults
                    </button>
                </Panel>

                <Panel eyebrow='THIS SESSION' title='Trades'>
                    {vx.trades.length === 0 ? (
                        <p className='sf-muted'>No trades yet.</p>
                    ) : (
                        <ul className='sf-trades'>
                            {vx.trades.slice(0, 12).map(t => (
                                <li key={t.contractId} className={t.status}>
                                    <b>{t.name}</b>
                                    <span>
                                        {t.label}
                                        {t.recovery ? ' ↺' : ''}
                                    </span>
                                    <span className='dg' title='entry digit, then the digit the contract settled on'>
                                        <i>{t.entryDigit ?? '·'}</i>→<i className={t.status === 'won' ? 'w' : t.status === 'lost' ? 'l' : ''}>{t.exitDigit ?? '·'}</i>
                                    </span>
                                    <span>stake {t.stake.toFixed(2)}</span>
                                    <em>{t.profit === null ? (t.status === 'open' ? 'open' : '?') : money(t.profit)}</em>
                                </li>
                            ))}
                        </ul>
                    )}
                </Panel>

                <Panel eyebrow='ACTIVITY' title='What Vanguard is doing'>
                    <ul className='sf-log'>
                        {vx.log.slice(0, 14).map(l => (
                            <li key={l.id} className={l.kind}>
                                <time>{new Date(l.at).toLocaleTimeString([], { hour12: false })}</time>
                                <span>{l.text}</span>
                            </li>
                        ))}
                        {vx.log.length === 0 && <li className='info'>Nothing yet. Press Run.</li>}
                    </ul>
                </Panel>
            </main>

            <footer className='sf-foot'>
                Vanguard applies the bot's entry rules (and their mirror for Over {s.primaryOver}) to the last 30 digits of each market. Deriv digits are generated randomly, so the rules choose when to
                trade, not whether a trade will win, and every contract carries a payout margin: over many trades the expected result is a loss. Watching
                more markets gives more chances to trade, not better odds on any one trade. A bigger stake after a loss makes each loss bigger and cannot change
                that. Test on a demo account first. Not financial advice.
            </footer>
        </div>
    );
};

export default VanguardPage;
