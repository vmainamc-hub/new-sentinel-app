// SENTINEL AI: the simple front face.
// Only what is needed to run it: Run / Stop, one status line, the session numbers, the few settings that matter and the latest
// trades. All the analysis (Pulse, the scanner, the Meter, the Entry Brain, the diagnosis funnel) still runs in the runner and
// the overlay; it is just no longer drawn here. Sixfold's own page is untouched.
import { useState } from 'react';
import { marketName, MARKETS, shortName } from '../sixfold/feed';
import { Num, Seg, Stat, Switch } from '../sixfold/SixfoldPage';
import { useFeed } from '../sixfold/use-feed';
import type { Phase } from '../sixfold/runner';
import SignalConditions, { MartingaleFields, VirtualHookFields } from '../sixfold/SignalConditions';
import { describeFunnel } from './funnel';
import { sentinelOverlay, sentinelRunner } from './runner-instance';
import { DEFAULT_TRADING, type EngineSettings, PRESETS, PROPOSITION_KEYS, type SignalSource } from './settings';
import { useSentinel } from './use-sentinel';
import './sentinel-simple.scss';

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

const STYLE_TAG: Record<string, string> = {
    hunter: 'Always a trade',
    careful: 'Fewest trades',
    balanced: 'Steady',
    active: 'Most trades',
};

const money = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const contractName = (key: string) => key.replace(':', ' ').replace('OVER', 'Over').replace('UNDER', 'Under');

const SentinelAiPage = () => {
    const { sx, engine, update } = useSentinel();
    const feed = useFeed();
    const s = sx.settings;
    const set = sentinelRunner.updateSettings.bind(sentinelRunner);

    const applyPreset = (id: string) => {
        const preset = PRESETS.find(p => p.id === id);
        if (!preset) return;
        update(preset.engine as Partial<EngineSettings>);
        set(preset.trading);
    };
    const toggleContract = (key: string) =>
        update({
            propositions: engine.propositions.includes(key)
                ? engine.propositions.filter(p => p !== key)
                : [...engine.propositions, key],
        });
    const toggleMarket = (symbol: string) =>
        set({ markets: s.markets.includes(symbol) ? s.markets.filter(m => m !== symbol) : [...s.markets, symbol] });

    // One line: what it is doing now. When it is looking but not trading, the first thing in the way (from the analysis).
    const status = sx.armed
        ? `${sx.armed.label} · ${shortName(sx.armed.symbol)} · waiting for entry`
        : sx.running
          ? PHASE_LABEL[sx.phase]
          : (sx.stopReason ?? `${sx.readyMarkets} of ${s.markets.length} markets ready`);
    const reason =
        sx.running && !sx.armed && sx.phase !== 'connecting'
            ? describeFunnel(sentinelOverlay.funnel(), sx.funnel, false).verdict
            : null;

    const [more, setMore] = useState(false);
    const feedTone = feed.mode === 'live' ? feed.status : 'warn';

    return (
        <div className='sixfold sf sentinel-ai-auto sn'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    SENTINEL<small>AI</small>
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
                        <button className='sf-run stop' onClick={() => sentinelRunner.stop('Stopped by you')}>
                            Stop
                        </button>
                    ) : (
                        <button className='sf-run' onClick={() => sentinelRunner.start()}>
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
                    <div className='sn-label'>Style</div>
                    <div className='sn-presets'>
                        {PRESETS.map(p => (
                            <button
                                key={p.id}
                                type='button'
                                className={engine.mode === p.id ? 'on' : ''}
                                onClick={() => applyPreset(p.id)}
                                disabled={sx.running}
                            >
                                <b>{p.name}</b>
                                <small>{STYLE_TAG[p.id]}</small>
                            </button>
                        ))}
                    </div>

                    <div className='sn-label'>Signals from</div>
                    <Seg<SignalSource>
                        label='Signals from'
                        value={engine.source}
                        onChange={source => update({ source })}
                        options={[
                            ['pulse', 'Pulse'],
                            ['digits', 'Digits Analysis'],
                        ]}
                    />

                    <div className='sn-nums'>
                        <Num
                            label='Green digits before buying'
                            value={s.winStreak}
                            onCommit={n => set({ winStreak: n, winStreakGate: true })}
                            hint='2–10 · it never buys in a red run'
                        />
                    </div>

                    <div className='sf-grid3 sn-nums'>
                        <Num label='Stake' value={s.stake} onCommit={n => set({ stake: n })} />
                        <Num
                            label='Take profit'
                            value={s.takeProfit}
                            onCommit={n => set({ takeProfit: n })}
                            hint='0 = off'
                        />
                        <Num label='Stop loss' value={s.stopLoss} onCommit={n => set({ stopLoss: n })} hint='0 = off' />
                    </div>

                    <Switch on={s.martingale} onChange={v => set({ martingale: v })} title='Martingale' sub='' />
                    {s.martingale && <MartingaleFields s={s} set={set} />}

                    <div className='sn-label'>Contracts</div>
                    <div className='sn-chips'>
                        {PROPOSITION_KEYS.map(k => (
                            <button
                                key={k}
                                type='button'
                                className={engine.propositions.includes(k) ? 'on' : ''}
                                aria-pressed={engine.propositions.includes(k)}
                                onClick={() => toggleContract(k)}
                                disabled={sx.running}
                            >
                                {contractName(k)}
                            </button>
                        ))}
                    </div>
                    <p className='sn-empty' data-testid='special-digit-rule'>
                        Special-digit rule, always on: Over trades only while digit 1 is dormant or falling and digit 8 is increasing. Under trades only
                        while digit 8 is dormant or falling and digit 1 is increasing.
                    </p>
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
                                    <em>
                                        {t.profit === null ? (t.status === 'open' ? 'open' : '?') : money(t.profit)}
                                    </em>
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
                            <Switch
                                on={s.recovery}
                                onChange={v => set({ recovery: v })}
                                title='Recovery barrier'
                                sub=''
                            />
                            {s.recovery && (
                                <div className='sf-grid2 sn-nums'>
                                    <Num label='Over' value={s.recoveryOver} onCommit={n => set({ recoveryOver: n })} />
                                    <Num
                                        label='Under'
                                        value={s.recoveryUnder}
                                        onCommit={n => set({ recoveryUnder: n })}
                                    />
                                </div>
                            )}
                            <Switch
                                on={s.virtualHook}
                                onChange={v => set({ virtualHook: v })}
                                title='Virtual hook'
                                sub=''
                            />
                            {s.virtualHook && <VirtualHookFields s={s} set={set} />}
                            <SignalConditions s={s} set={set} streakAlwaysOn gatesAlwaysOn />
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
                                onClick={() => set({ ...DEFAULT_TRADING })}
                                disabled={sx.running}
                            >
                                Reset to defaults
                            </button>
                        </div>
                    )}
                </section>

                <footer className='sn-foot'>
                    Digits are random and every contract has a payout margin, so over many trades the expected result is
                    a loss. Martingale makes losses bigger. Demo account first.
                </footer>
            </main>
        </div>
    );
};

export default SentinelAiPage;
