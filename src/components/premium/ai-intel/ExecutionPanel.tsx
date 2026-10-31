// APEX INTEL: Live Execution and Trade History. Real trades: they go to your connected Deriv account.
import { useEffect, useState } from 'react';
import { marketName, sixfoldFeed } from '@/components/premium/sixfold/feed';
import { useFeed } from '@/components/premium/sixfold/use-feed';
import { AUTO_MARKET, type ExecConfig, type ExecTrade, MIN_STAKE } from './executor';
import { aiIntelExecutor } from './executor-instance';
import { useExecutor } from './use-executor';

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

/** Number input that keeps what you type until it is a valid number. */
function NumField({ label, value, onCommit, min, step = 1, disabled, hint }: { label: string; value: number; onCommit: (n: number) => void; min?: number; step?: number; disabled?: boolean; hint?: string }) {
    const [text, setText] = useState(String(value));
    useEffect(() => setText(String(value)), [value]);
    return (
        <label className='ai-field'>
            {label}
            <input
                type='number'
                inputMode='decimal'
                value={text}
                min={min}
                step={step}
                disabled={disabled}
                title={hint}
                onChange={e => {
                    setText(e.target.value);
                    const n = Number(e.target.value);
                    if (e.target.value !== '' && Number.isFinite(n)) onCommit(n);
                }}
                onBlur={() => setText(String(value))}
            />
        </label>
    );
}

export function ExecutionPanel() {
    const s = useExecutor();
    useFeed(); // re-render when discovery adds markets
    const c = s.config;
    const locked = s.running;
    const set = (patch: Partial<ExecConfig>) => aiIntelExecutor.configure(patch);
    const setRec = (patch: Partial<ExecConfig['recovery']>) => aiIntelExecutor.configure({ recovery: { ...c.recovery, ...patch } });
    const blocker = s.running ? null : aiIntelExecutor.startBlocker();
    const auto = c.market === AUTO_MARKET;
    const where = auto ? (s.selected ? `${marketName(s.selected.market)} · ${s.selected.label}` : 'AUTO: no market picked yet') : marketName(c.market);

    return (
        <section className='ai-exec'>
            <div className='ai-warn'>
                <b>Real money.</b> These trades are placed on your connected Deriv account. Run it on a demo account first. Digits are random: no setting here makes a trade more likely to win, and recovery stakes make a losing run cost more.
            </div>

            {s.running && (
                <div className='ai-live'>
                    <div>
                        <strong>{s.phase === 'waiting' ? 'Waiting for an entry digit' : s.phase === 'ready' ? 'Signal ready: confirm to buy' : s.phase === 'buying' ? 'Buying…' : 'Contract open'}</strong>
                        <small>
                            {where} · next {s.next?.label} at {s.next?.stake.toFixed(2)}
                            {s.next?.recovery ? ' (recovery)' : ''} · enters on digit {s.next?.triggers.join(' ')}
                        </small>
                    </div>
                    <button className='ai-btn stop' onClick={() => aiIntelExecutor.stop('Stopped by you')}>
                        STOP
                    </button>
                </div>
            )}
            {s.proposal && (
                <div className='ai-proposal'>
                    <div>
                        <b>
                            {s.proposal.label}
                            {s.proposal.recovery ? ` · recovery step ${s.proposal.step}` : ''}
                        </b>
                        <small>
                            Stake {s.proposal.stake.toFixed(2)} on {auto && s.selected ? marketName(s.selected.market) : marketName(c.market)} · entry digit {s.proposal.triggerDigit} · {c.duration} tick{c.duration > 1 ? 's' : ''}
                        </small>
                    </div>
                    <button className='ai-btn primary' onClick={() => aiIntelExecutor.confirmProposal()}>
                        Buy now
                    </button>
                    <button className='ai-btn' onClick={() => aiIntelExecutor.dismissProposal()}>
                        Skip
                    </button>
                </div>
            )}
            {s.lastError && !s.running ? <div className='ai-error'>{s.lastError}</div> : null}
            {s.stopMessage && !s.running ? <div className='ai-info'>{s.stopMessage}</div> : null}

            {auto && s.running && (
                <div className='ai-card wide'>
                    <h3>Auto-pick</h3>
                    {s.selected ? (
                        <>
                            <strong>
                                {marketName(s.selected.market)} · {s.selected.label}
                            </strong>
                            <small>{s.selected.reason}. Regime: {s.selected.regime.toLowerCase().replace('_', ' ')}. Reviewed every few seconds; never changed while a contract is open.</small>
                        </>
                    ) : (
                        <small>{s.pickNote ?? 'Choosing…'}</small>
                    )}
                    {s.candidates.length > 1 && (
                        <small>
                            Next best: {s.candidates.slice(1, 4).map(p => `${marketName(p.market)} ${p.label}`).join(' · ')}
                        </small>
                    )}
                </div>
            )}
            <div className='ai-grid'>
                <div className='ai-card'>
                    <h3>Contract</h3>
                    <label className='ai-field'>
                        Market
                        <select value={c.market} disabled={locked} onChange={e => set({ market: e.target.value })}>
                            <option value={AUTO_MARKET}>AUTO: the tool picks market, direction and entry</option>
                            {sixfoldFeed.getSymbols().map(sym => (
                                <option key={sym} value={sym}>
                                    {marketName(sym)}
                                </option>
                            ))}
                        </select>
                    </label>
                    {auto && (
                        <>
                            <label className='ai-field'>
                                Directions to consider
                                <select value={c.pick.directions} disabled={locked} onChange={e => set({ pick: { ...c.pick, directions: e.target.value as ExecConfig['pick']['directions'] } })}>
                                    <option value='BOTH'>OVER 2 and UNDER 7</option>
                                    <option value='OVER_2'>OVER 2 only</option>
                                    <option value='UNDER_7'>UNDER 7 only</option>
                                </select>
                            </label>
                            <label className='ai-check'>
                                <input type='checkbox' checked={c.pick.evidenceOnly} disabled={locked} onChange={e => set({ pick: { ...c.pick, evidenceOnly: e.target.checked } })} />
                                Only trade when a market beats chance after false-discovery control (usually waits on random digits)
                            </label>
                            <small>
                                Off: it trades the best-ranked fresh market even without proven edge. The ranking uses the lower bound of the win-rate interval, so a lucky short run cannot lead.
                            </small>
                        </>
                    )}
                    {!auto && (<>
                    <label className='ai-field'>
                        Direction
                        <select value={c.direction} disabled={locked} onChange={e => set({ direction: e.target.value as ExecConfig['direction'] })}>
                            <option value='OVER_2'>OVER 2 (wins on 3–9)</option>
                            <option value='UNDER_7'>UNDER 7 (wins on 0–6)</option>
                        </select>
                    </label>
                    <label className='ai-field'>
                        Entry
                        <select value={c.entry} disabled={locked} onChange={e => set({ entry: e.target.value as ExecConfig['entry'] })}>
                            <option value='SETUP'>SETUP: wait for a non-winning digit</option>
                            <option value='ANY'>ANY: buy as soon as free</option>
                            <option value='CUSTOM'>CUSTOM: my own digits</option>
                        </select>
                    </label>
                    {c.entry === 'CUSTOM' && (
                        <div className='ai-digits' role='group' aria-label='Entry digits'>
                            {Array.from({ length: 10 }, (_, d) => (
                                <button
                                    key={d}
                                    className={c.customDigits.includes(d) ? 'on' : ''}
                                    disabled={locked}
                                    onClick={() => set({ customDigits: c.customDigits.includes(d) ? c.customDigits.filter(x => x !== d) : [...c.customDigits, d].sort() })}
                                >
                                    {d}
                                </button>
                            ))}
                        </div>
                    )}
                    </>)}
                    <NumField label='Contract length (ticks)' value={c.duration} min={1} disabled={locked} onCommit={n => set({ duration: n })} />
                </div>

                <div className='ai-card'>
                    <h3>Stake and recovery</h3>
                    <NumField label={`Stake (min ${MIN_STAKE.toFixed(2)})`} value={c.stake} min={MIN_STAKE} step={0.05} disabled={locked} onCommit={n => set({ stake: n })} />
                    <label className='ai-check'>
                        <input type='checkbox' checked={c.recovery.enabled} disabled={locked} onChange={e => setRec({ enabled: e.target.checked })} />
                        Recovery after a loss
                    </label>
                    {c.recovery.enabled && (
                        <>
                            <NumField label='Stake multiplier per loss' value={c.recovery.multiplier} min={1} step={0.1} disabled={locked} onCommit={n => setRec({ multiplier: n })} />
                            <NumField label='Max recovery steps' value={c.recovery.maxSteps} min={1} disabled={locked} onCommit={n => setRec({ maxSteps: n })} />
                            <label className='ai-check'>
                                <input type='checkbox' checked={c.recovery.barrierOn} disabled={locked} onChange={e => setRec({ barrierOn: e.target.checked })} />
                                Switch barrier while recovering
                            </label>
                            {c.recovery.barrierOn && (
                                <div className='ai-two'>
                                    <NumField label='Recovery Over barrier' value={c.recovery.overBarrier} min={0} disabled={locked} onCommit={n => setRec({ overBarrier: n })} />
                                    <NumField label='Recovery Under barrier' value={c.recovery.underBarrier} min={1} disabled={locked} onCommit={n => setRec({ underBarrier: n })} />
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className='ai-card'>
                    <h3>Limits</h3>
                    <NumField label='Max stake per trade' value={c.maxStake} min={0} step={0.5} disabled={locked} onCommit={n => set({ maxStake: n })} hint='A stake above this stops the run' />
                    <NumField label='Stop loss (0 = off)' value={c.stopLoss} min={0} step={0.5} disabled={locked} onCommit={n => set({ stopLoss: n })} />
                    <NumField label='Target profit (0 = off)' value={c.targetProfit} min={0} step={0.5} disabled={locked} onCommit={n => set({ targetProfit: n })} />
                    <NumField label='Max trades (0 = off)' value={c.maxTrades} min={0} disabled={locked} onCommit={n => set({ maxTrades: n })} />
                </div>

                <div className='ai-card'>
                    <h3>Mode</h3>
                    <label className='ai-field'>
                        Execution mode
                        <select value={c.mode} disabled={locked} onChange={e => set({ mode: e.target.value as ExecConfig['mode'] })}>
                            <option value='ASSISTED'>ASSISTED: I confirm every trade</option>
                            <option value='AUTO'>AUTO: buys by itself</option>
                        </select>
                    </label>
                    {c.mode === 'AUTO' && (
                        <label className='ai-check warn'>
                            <input type='checkbox' checked={c.autoAuthorised} disabled={locked} onChange={e => set({ autoAuthorised: e.target.checked })} />I authorise Apex Intel to buy contracts on my account without asking, within the limits above.
                        </label>
                    )}
                    {!s.running ? (
                        <>
                            <button className='ai-btn primary big' disabled={Boolean(blocker)} onClick={() => aiIntelExecutor.start()}>
                                {c.mode === 'AUTO' ? 'Start AUTO trading' : 'Start (confirm each trade)'}
                            </button>
                            {blocker ? <small className='ai-why'>{blocker}</small> : null}
                        </>
                    ) : (
                        <button className='ai-btn stop big' onClick={() => aiIntelExecutor.stop('Stopped by you')}>
                            STOP NOW
                        </button>
                    )}
                </div>
            </div>

            <div className='ai-stats'>
                <div>
                    <small>Session P/L</small>
                    <b className={s.session.pnl >= 0 ? 'pos' : 'neg'}>{signed(s.session.pnl)}</b>
                </div>
                <div>
                    <small>Trades</small>
                    <b>
                        {s.session.wins}W / {s.session.losses}L
                    </b>
                </div>
                <div>
                    <small>Losses in a row</small>
                    <b>{s.consecutiveLosses}</b>
                </div>
                <div>
                    <small>Next stake</small>
                    <b>{s.next?.stake.toFixed(2)}</b>
                </div>
            </div>

            <div className='ai-two-col'>
                <div className='ai-card'>
                    <h3>Session log</h3>
                    {s.log.length === 0 ? <small>Nothing yet.</small> : null}
                    <ul className='ai-log'>
                        {s.log.slice(0, 25).map((l, i) => (
                            <li key={`${l.at}-${i}`} className={l.kind}>
                                <time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}
                            </li>
                        ))}
                    </ul>
                </div>
                <TradeTable trades={s.trades.slice(0, 12)} title='Recent trades' />
            </div>
        </section>
    );
}

function TradeTable({ trades, title }: { trades: ExecTrade[]; title: string }) {
    return (
        <div className='ai-card'>
            <h3>{title}</h3>
            {trades.length === 0 ? <small>No trades yet.</small> : null}
            <ul className='ai-trades'>
                {trades.map(t => (
                    <li key={t.id} className={t.status}>
                        <span>{new Date(t.at).toLocaleTimeString()}</span>
                        <span>{t.label}{t.recovery ? ` ·R${t.step}` : ''}</span>
                        <span>{t.stake.toFixed(2)}</span>
                        <span>{t.status === 'open' ? 'open' : t.profit === null ? '?' : signed(t.profit)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function HistoryPanel() {
    const s = useExecutor();
    const exportCsv = () => {
        const head = ['time', 'market', 'contract', 'recovery_step', 'stake', 'duration_ticks', 'entry_digit', 'exit_digit', 'profit', 'status', 'contract_id'];
        const rows = s.trades.map(t => [new Date(t.at).toISOString(), t.market, t.label, t.step, t.stake, t.duration, t.triggerDigit, t.exitDigit, t.profit, t.status, t.contractId]);
        const blob = new Blob([[head, ...rows].map(r => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'apex-intel-trades.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    };
    return (
        <section>
            <div className='ai-toolbar'>
                <button className='ai-btn' disabled={!s.trades.length} onClick={exportCsv}>
                    Export CSV
                </button>
                <small>Real trades placed by Apex Intel, kept in this browser (latest 500).</small>
            </div>
            <TradeTable trades={s.trades} title={`Trades (${s.trades.length})`} />
        </section>
    );
}
