// VANGUARD: the "Sentinel Under 7 Psychology" bot's entry rules (and the same rules mirrored for Over 2), run on every market at once.
// Press Run and Vanguard reads each market's own digits; the first market and contract to meet every rule is bought, through the same trade machinery Sixfold uses (stake, recovery, limits,
// one trade at a time, stale-tick and refusal handling). Trades appear in the general Transactions panel.
import { useEffect } from 'react';
import type { SixfoldSettings } from '../sixfold/money';
import type { VhMode } from '../sixfold/virtual-hook';
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

    useEffect(() => {
        if (feed.status === 'offline') vanguardFeed.connect();
        // connect once when the page opens; the button below reconnects after a manual stop
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const rows = vx.rules?.rows ?? [];
    const ready = rows.filter(r => r.entry).length;
    return (
        <div className='sixfold sf vanguard'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    VANGUARD
                </b>
                <span className={`sf-feed ${feed.mode === 'live' ? feed.status : 'warn'}`}>{feed.status.toUpperCase()}</span>
            </header>

            <main className='sf-scanner'>
                <Panel>
                    <div className={`sf-phase t-${vx.running ? 'armed' : 'scan'}`}>
                        {vx.lastError ? vx.lastError : vx.stopReason && !vx.running ? vx.stopReason : PHASE[vx.phase] ?? vx.phase}
                    </div>
                    <div className='vg-mode' role='status'>
                        <span>{ready === 0 ? 'Waiting for a signal' : 'Signal ready'}</span>
                    </div>
                    {vx.running && vx.virtualHook.on && (
                        <div className='vg-mode' role='status'>
                            <span>
                                {vx.virtualHook.virtual
                                    ? `Virtual hook: paper trades only${vx.virtualHook.open ? ' · one open' : ''}`
                                    : `Virtual hook: real money · ${vx.virtualHook.realLosses}/${vx.virtualHook.enterLosses} losses to go virtual`}
                            </span>
                            {vx.virtualHook.virtual && (
                                <span>
                                    {vx.virtualHook.mode === 'STREAK'
                                        ? `${vx.virtualHook.virtualWins}/${vx.virtualHook.returnWins} paper wins to return`
                                        : `${vx.virtualHook.virtualDone}/${vx.virtualHook.fixedCount} paper trades`}
                                </span>
                            )}
                        </div>
                    )}
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

                <Panel eyebrow='SETTINGS'>
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
                        on={s.virtualHook}
                        onChange={v => set({ virtualHook: v })}
                        title='Virtual hook'
                        sub='After real losses in a row, trade on paper until the entries win again'
                    />
                    {s.virtualHook && (
                        <div className='sf-sub'>
                            <Seg<VhMode>
                                label='Virtual hook mode'
                                value={s.vhMode}
                                onChange={v => set({ vhMode: v })}
                                options={[
                                    ['STREAK', 'Until paper wins'],
                                    ['FIXED', 'Fixed paper trades'],
                                ]}
                            />
                            <div className='sf-grid3'>
                                <Num label='Go virtual after losses' value={s.vhEnterLosses} onCommit={n => set({ vhEnterLosses: n })} hint='real losses in a row' />
                                {s.vhMode === 'STREAK' ? (
                                    <Num label='Back to real after wins' value={s.vhReturnWins} onCommit={n => set({ vhReturnWins: n })} hint='paper wins in a row' />
                                ) : (
                                    <Num label='Paper trades' value={s.vhFixedCount} onCommit={n => set({ vhFixedCount: n })} hint='then back to real' />
                                )}
                            </div>
                        </div>
                    )}
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
                    </div>
                    <button className='sf-btn' onClick={() => set({ ...VANGUARD_DEFAULTS })} disabled={vx.running}>
                        Reset to defaults
                    </button>
                </Panel>

                <Panel eyebrow='TRADES'>
                    {vx.trades.length === 0 ? (
                        <p className='sf-muted'>No trades yet.</p>
                    ) : (
                        <ul className='sf-trades'>
                            {vx.trades.slice(0, 12).map(t => (
                                <li key={t.contractId} className={t.status}>
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

            </main>

            <footer className='sf-foot'>Digits are random: every trade carries a payout margin, so a bigger stake after a loss makes each loss bigger. Test on a demo account first.</footer>
        </div>
    );
};

export default VanguardPage;
