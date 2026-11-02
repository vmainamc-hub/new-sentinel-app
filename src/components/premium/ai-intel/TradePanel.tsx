// APEX INTEL: the simple trading screen, organised like Sixfold's: Run / Stop, one status line, the session numbers,
// the few settings that matter and the latest trades. It scans ALL markets at once and trades whichever shows the best
// entry right now. Over 2 / Under 7 are the main contracts; after a loss it recovers with Over 3 or Under 6, whichever is
// more viable. The Virtual Hook is Sixfold's. Everything else (scanner, competition, lab, library, agents) keeps running
// behind the scenes and is under Insights.
import { useEffect, useState, useSyncExternalStore } from 'react';
import '@/components/premium/sentinel/sentinel-simple.scss';
import { shortName } from '@/components/premium/sixfold/feed';
import { Num, Seg, Stat, Switch } from '@/components/premium/sixfold/SixfoldPage';
import { useFeedOf } from '@/components/premium/sixfold/use-feed';
import { type ExecConfig, type ExecEntry, MIN_STAKE } from './executor';
import { aiIntelExecutor } from './executor-instance';
import { apexFeed, apexSymbols } from './feed-source';
import { AutopilotPanel } from './AutopilotPanel';
import { autopilot } from './autopilot-instance';
import type { AiMode } from './guard';
import { intelService } from './intel-instance';
import { useExecutor } from './use-executor';
import { useStrategies } from './StrategyPanels';

const money = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(0)}%`);

export function TradePanel() {
    const s = useExecutor();
    const feed = useFeedOf(apexFeed); // re-renders when markets are discovered
    const c = s.config;
    const locked = s.running;
    const set = (patch: Partial<ExecConfig>) => aiIntelExecutor.configure(patch);
    const setRec = (patch: Partial<ExecConfig['recovery']>) => set({ recovery: { ...c.recovery, ...patch } });
    const setVh = (patch: Partial<ExecConfig['virtualHook']>) => set({ virtualHook: { ...c.virtualHook, ...patch } });
    const intel = useSyncExternalStore(intelService.subscribe, intelService.getSnapshot, intelService.getSnapshot);
    const strategies = useStrategies();
    const running = strategies.filter(x => x.status === 'ACTIVE').length;
    const [more, setMore] = useState(false);
    const [logOpen, setLogOpen] = useState(false);
    useEffect(() => {
        if (apexFeed.getMode() === 'live' && apexFeed.getStatus() === 'offline') apexFeed.connect();
    }, []);
    const blocker = s.running ? null : aiIntelExecutor.startBlocker();
    const markets = apexSymbols();
    const watching = markets.filter(m => !c.excluded.includes(m)).length;
    const overOn = c.directions !== 'UNDER_7';
    const underOn = c.directions !== 'OVER_2';
    const setDirs = (over: boolean, under: boolean) => {
        if (!over && !under) return; // at least one main contract
        set({ directions: over && under ? 'BOTH' : over ? 'OVER_2' : 'UNDER_7' });
    };
    const toggleMarket = (m: string) => set({ excluded: c.excluded.includes(m) ? c.excluded.filter(x => x !== m) : [...c.excluded, m] });
    const recovering = c.recovery.enabled && s.consecutiveLosses > 0;
    type Row = { key: string; market: string; label: string; regime: string; rate: number | null; trades: number };
    const board: Row[] = recovering ? s.board.recovery : s.board.primary;

    const status = s.proposal
        ? `${s.proposal.label} · ${shortName(s.proposal.market)} · confirm to buy`
        : s.running
          ? s.phase === 'settling'
              ? s.vh.open
                  ? 'Paper trade open (no money)'
                  : 'In a trade'
              : s.phase === 'buying'
                ? 'Placing the trade'
                : s.vh.virtual
                  ? `Paper trading across ${watching} markets${s.vh.opening ? ' (opening)' : ''}`
                  : `Watching ${watching} markets for the best entry${recovering ? ' (recovery)' : ''}`
          : (s.stopMessage ?? `${watching} markets ready`);
    const top = board[0];
    const reason = s.running && !s.proposal ? (s.note ?? (top ? `Best now: ${shortName(top.market)} · ${top.label}` : null)) : null;
    const feedTone = feed.status === 'live' ? 'ok' : 'warn';

    return (
        <div className='sixfold sf sn ai-trade'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    APEX INTEL<small>MULTI-MARKET</small>
                </b>
                <span className={`sf-feed ${feedTone}`}>{feed.status.toUpperCase()}</span>
            </header>
            <main className='sn-wrap'>
                <section className='sn-card sn-main'>
                    <div className='sn-pl'>
                        <small>Session P/L</small>
                        <b className={s.session.pnl > 0 ? 'pos' : s.session.pnl < 0 ? 'neg' : ''}>{money(s.session.pnl)}</b>
                    </div>
                    {s.running ? (
                        <button className='sf-run stop' onClick={() => aiIntelExecutor.stop('Stopped by you')}>
                            Stop
                        </button>
                    ) : (
                        <button className='sf-run' disabled={Boolean(blocker)} onClick={() => aiIntelExecutor.start()}>
                            Run
                        </button>
                    )}
                    <div className='sn-status' role='status'>
                        {status}
                    </div>
                    {reason && <div className='sn-reason'>{reason}</div>}
                    {feed.status === 'offline' && !s.running && (
                        <button className='sf-btn primary' onClick={feed.connect}>
                            Connect live
                        </button>
                    )}
                    {blocker && <div className='sn-reason'>{blocker}</div>}
                    {(s.lastError || feed.error) && !s.running && <div className='sf-msg bad'>{s.lastError || feed.error}</div>}
                    {s.proposal && (
                        <div className='sf-grid2'>
                            <button className='sf-btn primary' onClick={() => aiIntelExecutor.confirmProposal()}>
                                Buy now · {s.proposal.stake.toFixed(2)}
                            </button>
                            <button className='sf-btn subtle' onClick={() => aiIntelExecutor.dismissProposal()}>
                                Skip
                            </button>
                        </div>
                    )}
                    <div className='sf-stats'>
                        <Stat label='Trades' value={s.session.trades} />
                        <Stat label='Won / lost' value={`${s.session.wins} / ${s.session.losses}`} />
                        <Stat label={s.next.paper ? 'Next (paper)' : s.next.recovery ? 'Next stake (recovery)' : 'Next stake'} value={s.next.stake.toFixed(2)} />
                    </div>
                    {c.virtualHook.enabled && s.paper.trades > 0 && (
                        <div className='sn-reason'>
                            Paper: {s.paper.wins} won of {s.paper.trades} ({money(s.paper.pnl)}), not counted above
                        </div>
                    )}
                </section>

                <section className='sn-card'>
                    <div className='sn-label'>Contracts</div>
                    <div className='sf-grid2'>
                        <Switch on={overOn} onChange={v => !locked && setDirs(v, underOn)} title='Over 2' sub='' />
                        <Switch on={underOn} onChange={v => !locked && setDirs(overOn, v)} title='Under 7' sub='' />
                    </div>
                    <div className='sf-grid3 sn-nums'>
                        <Num label='Stake' value={c.stake} onCommit={n => !locked && set({ stake: n })} hint={`min ${MIN_STAKE.toFixed(2)}`} />
                        <Num label='Take profit' value={c.targetProfit} onCommit={n => !locked && set({ targetProfit: n })} hint='0 = off' />
                        <Num label='Stop loss' value={c.stopLoss} onCommit={n => !locked && set({ stopLoss: n })} hint='0 = off' />
                    </div>

                    <Switch on={c.recovery.enabled} onChange={v => !locked && setRec({ enabled: v })} title='Recovery' sub='After a loss: Over 3 or Under 6, whichever is more viable' />
                    {c.recovery.enabled && (
                        <div className='sf-grid2 sn-nums'>
                            <Num label='Stake × per loss' value={c.recovery.multiplier} onCommit={n => !locked && setRec({ multiplier: n })} />
                            <Num label='Max steps' value={c.recovery.maxSteps} onCommit={n => !locked && setRec({ maxSteps: n })} hint='then stop' />
                        </div>
                    )}

                    <Switch on={c.virtualHook.enabled} onChange={v => !locked && setVh({ enabled: v })} title='Virtual hook' sub='Paper trades after losses, real again after paper wins' />
                    {c.virtualHook.enabled && (
                        <div className='sf-grid2 sn-nums'>
                            <Num label='Go virtual after losses' value={c.virtualHook.enterLosses} onCommit={n => !locked && setVh({ enterLosses: n })} hint='real losses in a row' />
                            <Num label='Back to real after wins' value={c.virtualHook.returnWins} onCommit={n => !locked && setVh({ returnWins: n })} hint='paper wins in a row' />
                        </div>
                    )}

                    <div className='sn-label'>AI guard</div>
                    <Seg<AiMode>
                        label='AI guard'
                        value={c.ai}
                        onChange={v => !locked && set({ ai: v })}
                        options={[
                            ['OFF', 'Off'],
                            ['GUARD', 'Guard'],
                            ['STRICT', 'Strict'],
                        ]}
                    />
                    <div className='sn-reason'>
                        {c.ai === 'OFF' ? 'Signals are not checked.' : c.ai === 'GUARD' ? 'Every signal is checked first; unstable markets, collapsed win share and failing strategies are skipped.' : 'Only signals with a stable market and proven edge over chance are traded (usually waits on random digits).'}
                    </div>

                    <Switch
                        on={c.mode === 'AUTO' && c.autoAuthorised}
                        onChange={v => !locked && set({ mode: v ? 'AUTO' : 'ASSISTED', autoAuthorised: v })}
                        title='Trade automatically'
                        sub={c.mode === 'AUTO' ? 'On: it buys on your account without asking, within your limits' : 'Off: you confirm each trade'}
                    />
                </section>

                <section className='sn-card'>
                    <div className='sn-label'>AI &amp; strategies</div>
                    <ul className='sf-trades ai-best'>
                        <li>
                            <b>Chief</b>
                            <span>{intel.report ? (intel.report.decision.decision === 'ENTER' ? `Enter ${intel.report.decision.market}` : 'No trade') : 'Evaluating…'}</span>
                            <span>{intel.report ? intel.report.decision.explanation[0] : ''}</span>
                            <em />
                        </li>
                        <li>
                            <b>Guard</b>
                            <span>{c.ai === 'OFF' ? 'Off' : `${s.aiGuard.allowed} passed · ${s.aiGuard.blocked} blocked`}</span>
                            <span>{s.aiGuard.note ?? ''}</span>
                            <em />
                        </li>
                        <li>
                            <b>Strategies</b>
                            <span>
                                {running} running
                            </span>
                            <span>{autopilot.getSnapshot().config.promote === 'OFF' ? 'manual promotion' : `auto (${autopilot.getSnapshot().config.promote.toLowerCase()})`}</span>
                            <em />
                        </li>
                    </ul>
                </section>

                <section className='sn-card'>
                    <div className='sn-label'>{recovering ? 'Best recovery entries now' : 'Best entries now'}</div>
                    {board.length === 0 ? (
                        <p className='sn-empty'>{s.running ? (s.note ?? 'Scanning…') : 'Press Run: every market is scanned, the best entries show here.'}</p>
                    ) : (
                        <ul className='sf-trades ai-best'>
                            {board.map(p => (
                                <li key={p.key}>
                                    <b>{shortName(p.market)}</b>
                                    <span>{p.label}</span>
                                    <span>{p.regime.toLowerCase().replace('_', ' ')}</span>
                                    <em>{pct(p.rate)} · {p.trades}</em>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className='sn-card'>
                    <div className='sn-label'>Latest trades</div>
                    {s.trades.length === 0 ? (
                        <p className='sn-empty'>No trades yet.</p>
                    ) : (
                        <ul className='sf-trades'>
                            {s.trades.slice(0, 8).map(t => (
                                <li key={t.id} className={t.status}>
                                    <b>{shortName(t.market)}</b>
                                    <span>
                                        {t.label}
                                        {t.recovery ? ' ↺' : ''}
                                        {t.virtual ? ' · paper' : ''}
                                    </span>
                                    <span className='dg'>
                                        <i>{t.triggerDigit ?? '·'}</i>→<i className={t.status === 'won' ? 'w' : t.status === 'lost' ? 'l' : ''}>{t.exitDigit ?? '·'}</i>
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
                            <Seg<ExecEntry>
                                label='Entry'
                                value={c.entry}
                                onChange={v => !locked && set({ entry: v })}
                                options={[
                                    ['AUTO', 'Best (auto)'],
                                    ['SETUP', 'Fixed digit'],
                                    ['ANY', 'Any tick'],
                                ]}
                            />
                            <div className='sf-grid3 sn-nums'>
                                <Num label='Length (ticks)' value={c.duration} onCommit={n => !locked && set({ duration: n })} />
                                <Num label='Max trades' value={c.maxTrades} onCommit={n => !locked && set({ maxTrades: n })} hint='0 = off' />
                            </div>
                            <Switch on={c.evidenceOnly} onChange={v => !locked && set({ evidenceOnly: v })} title='Only proven edge' sub='Trade a market only if it beats chance after false-discovery control (usually waits on random digits)' />
                            {c.virtualHook.enabled && (
                                <>
                                    <Switch on={c.virtualHook.opening} onChange={v => !locked && setVh({ opening: v })} title='Open every run on paper' sub='First trade is paper; real trading starts after a paper win' />
                                    <Seg<'STREAK' | 'FIXED'>
                                        label='Virtual hook mode'
                                        value={c.virtualHook.mode}
                                        onChange={v => !locked && setVh({ mode: v })}
                                        options={[
                                            ['STREAK', 'Until paper wins'],
                                            ['FIXED', 'Fixed paper trades'],
                                        ]}
                                    />
                                    {c.virtualHook.mode === 'FIXED' && <Num label='Paper trades' value={c.virtualHook.fixedCount} onCommit={n => !locked && setVh({ fixedCount: n })} hint='then back to real' />}
                                </>
                            )}
                            <div className='sn-label'>Strategies and research</div>
                            <AutopilotPanel />
                            <div className='sn-label'>Markets ({watching} of {markets.length})</div>
                            <div className='sn-chips'>
                                {markets.map(m => (
                                    <button key={m} type='button' className={c.excluded.includes(m) ? '' : 'on'} aria-pressed={!c.excluded.includes(m)} disabled={locked} onClick={() => toggleMarket(m)}>
                                        {shortName(m)}
                                    </button>
                                ))}
                            </div>
                            <button type='button' className='sn-more' aria-expanded={logOpen} onClick={() => setLogOpen(v => !v)}>
                                Activity log <span aria-hidden='true'>{logOpen ? '−' : '+'}</span>
                            </button>
                            {logOpen && (
                                <ul className='ai-log'>
                                    {s.log.slice(0, 25).map((l, i) => (
                                        <li key={`${l.at}-${i}`} className={l.kind}>
                                            <time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                <footer className='sn-foot'>
                    Real money on your connected Deriv account: try a demo account first. Digits are random and every contract has a payout margin, so over many trades the expected result is a loss. Recovery stakes make a losing run cost more. Nothing here predicts the next digit.
                </footer>
            </main>
        </div>
    );
}
