import type { CSSProperties, RefObject } from 'react';
import { BULK_MARKETS, FREE_BARRIERS, OVER_BARRIERS, UNDER_BARRIERS, hitRate, type Recommendation } from '../over-under-engine';
import { MAX_BULK_RUNS, exposure, sanitizeBulk, type Tally } from '../bulk-run';
import type { AutoLogRow } from '../auto-log';

export type LogRow = {
    id: number;
    time: string;
    label: string;
    stake: number;
    state: 'open' | 'won' | 'lost' | 'failed';
    profit: number;
    exitDigit?: number | null;
    /** True once the exit digit is known, or every lookup for it has been tried. */
    exitFinal?: boolean;
    note?: string;
};

export type BulkForm = { duration: string; stake: string; runs: string };
export type AutoForm = {
    grade: string; cooldownSec: string; maxRuns: string; maxLoss: string; targetProfit: string; entryTicks: string; entryWaitSec: string;
    recovery: string; recoveryOver: string; recoveryUnder: string; martingale: string; maxSteps: string; onCap: string;
    entryMode: string; lossPauseAfter: string; lossPauseSec: string; dangerCeiling: string; pressure: string;
};
export type AutoView = {
    armed: boolean; form: AutoForm; runs: number; pnl: number; note: string; maxRuns: number; maxLoss: number; targetProfit: number; account: string;
    mode: string; recovery: boolean; next: string; rule: string; log: AutoLogRow[];
    entry: { need: number; want: string; symbols: string[]; waiting: boolean } | null;
};

/** The signal lock: ON keeps Over/Under shut until the loaded signal reads EXECUTE; OFF leaves both free with any barrier. */
export type SignalLockView = {
    on: boolean;
    /** The one button the signal has unlocked (it wears the EXECUTE tag); null while everything is shut or the lock is off. */
    openSide: 0 | 1 | null;
    note: string;
    onToggle: () => void;
};

export type BulkViewProps = {
    live: boolean;
    marketsReady: number;
    rec: Recommendation | null;
    watch: { market: string; label: string } | null;
    onLoadRec: () => void;
    locked: boolean;
    canLock: boolean;
    onToggleLock: () => void;
    auto: AutoView;
    onAutoToggle: () => void;
    onLogDownload: () => void;
    onLogClear: () => void;
    onAutoForm: (key: keyof AutoForm, value: string) => void;
    signalLock: SignalLockView;
    symbol: string;
    onSymbol: (symbol: string) => void;
    price: number | null;
    digit: number | null;
    digitPct: number[];
    recent: number[];
    form: BulkForm;
    onForm: (key: keyof BulkForm) => (event: { target: { value: string } }) => void;
    overBarrier: string;
    underBarrier: string;
    onOverBarrier: (value: string) => void;
    onUnderBarrier: (value: string) => void;
    /** Which button carries the AI PICK tag (the loaded recommendation, while it still matches the deck). */
    pickSide: 0 | 1 | null;
    loadedNote: string;
    currency: string;
    running: boolean;
    status: string;
    error: string;
    tally: Tally;
    syncNote: string;
    log: LogRow[];
    onRun: (side: 0 | 1) => void;
    onStop: () => void;
    traderRef?: RefObject<HTMLElement>;
};

const ringStyle = (pct: number, color: string) => ({ '--p': Math.min(100, pct * 3), '--c': color }) as CSSProperties;
const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;

const RecommendationBar = ({ rec, watch, onLoadRec, marketsReady, live, locked, canLock, onToggleLock }: Pick<BulkViewProps, 'rec' | 'watch' | 'onLoadRec' | 'marketsReady' | 'live' | 'locked' | 'canLock' | 'onToggleLock'>) => (
    <section className={`apex-bt__rec${locked ? ' is-locked' : ''}`} aria-label='Recommendation'>
        <div className='apex-bt__rec-main'>
            <small>{locked ? 'LOCKED SIGNAL · OVER / UNDER' : 'AI RECOMMENDATION · OVER / UNDER'}</small>
            {rec ? (
                <>
                    <h2>
                        {rec.market} <b>{rec.label}</b>
                        <span className={`apex-bt__tag apex-bt__tag--${rec.action.toLowerCase()}`}>{rec.action.replace('_', ' ')}</span>
                        {locked && <span className='apex-bt__tag apex-bt__tag--locked'>LOCKED</span>}
                    </h2>
                    {locked && <p className='apex-bt__hint'>No other signals will appear until you unlock.
                        {rec.action === 'OBSERVE' || rec.action === 'STAND_DOWN' ? ` The engine currently reads ${rec.action.replace('_', ' ')} for this signal.` : ''}</p>}
                    <details className='apex-bt__why'>
                        <summary>Why this one?</summary>
                        <p>Engine verdict {rec.score}/100 (a ranking score, not a win probability) · danger {rec.danger}/100 · {rec.sample} ticks analysed.</p>
                        <ul>{rec.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                    </details>
                </>
            ) : (
                <>
                    <h2 className='is-idle'>{live ? 'No qualified setup right now' : 'Connecting to the live feed…'}</h2>
                    <p className='apex-bt__hint'>{marketsReady}/{BULK_MARKETS.length} markets analysed.{' '}
                        {watch ? `Closest: ${watch.market} ${watch.label}, not yet actionable.` : 'The engine recommends only when a setup qualifies.'}</p>
                </>
            )}
        </div>
        <div className='apex-bt__rec-actions'>
            <button type='button' className={`apex-bt__lock${locked ? ' is-on' : ''}`} disabled={!locked && !canLock} onClick={onToggleLock}
                aria-pressed={locked} title={locked ? 'Unlock to let new signals through' : 'Hold this signal in place and put it in the Trading Deck'}>
                {locked ? '🔓 Unlock signal' : '🔒 Lock signal'}
            </button>
            <button type='button' className='apex-bt__loadrec' disabled={!rec} onClick={onLoadRec}>Load to Trading Deck</button>
        </div>
    </section>
);

const AutoPanel = ({ auto, running, currency, onAutoToggle, onAutoForm, onLogDownload, onLogClear }: Pick<BulkViewProps, 'auto' | 'currency' | 'onAutoToggle' | 'onAutoForm' | 'onLogDownload' | 'onLogClear'> & { running: boolean }) => {
    const f = auto.form;
    const lock = auto.armed;
    const field = (label: string, key: keyof AutoForm, mode: 'numeric' | 'decimal' = 'numeric') => (
        <label>{label}<input value={f[key]} disabled={lock} inputMode={mode} onChange={event => onAutoForm(key, event.target.value)} /></label>
    );
    return (
        <section className={`apex-bt__auto${auto.armed ? ' is-armed' : ''}`} aria-label='Auto trader'>
            <div className='apex-bt__auto-head'>
                <div>
                    <small>AUTO TRADER</small>
                    <p className={`apex-bt__auto-note${auto.armed ? ' is-on' : ''}`}>{auto.note}</p>
                </div>
                <button type='button' className={`apex-bt__arm${auto.armed ? ' is-on' : ''}`} onClick={onAutoToggle} aria-pressed={auto.armed}>
                    {auto.armed ? 'Disarm auto trader' : 'Arm auto trader'}
                </button>
            </div>

            {auto.armed && (
                <div className='apex-bt__auto-state'>
                    <span className={`apex-bt__mode${auto.mode === 'NORMAL' ? '' : ' is-recovery'}`}>{auto.mode}</span>
                    {auto.next && <span className='apex-bt__next'>{auto.next}</span>}
                    {auto.entry && (
                        <span className='apex-bt__entry' title='Latest ticks against the barrier of the contract to be traded'>
                            <small>Entry: last {auto.entry.need} ticks must be {auto.entry.want}</small>
                            <span className='apex-bt__ticks'>
                                {auto.entry.symbols.length === 0 && <i>…</i>}
                                {auto.entry.symbols.map((symbol, index) => <i key={index} className={`is-${symbol === 'O' ? 'over' : symbol === 'U' ? 'under' : 'eq'}`}>{symbol}</i>)}
                            </span>
                        </span>
                    )}
                </div>
            )}

            <h3>Trigger and limits</h3>
            <div className='apex-bt__auto-form'>
                <label>Trade on
                    <select value={f.grade} disabled={lock} onChange={event => onAutoForm('grade', event.target.value)}>
                        <option value='EXECUTE'>EXECUTE signals only</option>
                        <option value='ANY'>EXECUTE + PREPARE</option>
                    </select>
                </label>
                {field('Max auto runs', 'maxRuns')}
                {field(`Stop at loss (${currency})`, 'maxLoss', 'decimal')}
                {field(`Target profit (${currency})`, 'targetProfit', 'decimal')}
                {field('Cooldown (s)', 'cooldownSec')}
            </div>

            <h3>Entry</h3>
            <div className='apex-bt__auto-form'>
                <label>Entry rule
                    <select value={f.entryMode} disabled={lock} onChange={event => onAutoForm('entryMode', event.target.value)}>
                        <option value='DYNAMIC'>Dynamic (adapts)</option>
                        <option value='FIXED'>Fixed</option>
                    </select>
                </label>
                {field(f.entryMode === 'DYNAMIC' ? 'Base entry ticks (0 = off)' : 'Entry ticks (0 = off)', 'entryTicks')}
                {field(f.entryMode === 'DYNAMIC' ? 'Base wait (s)' : 'Wait for entry (s)', 'entryWaitSec')}
                <label>Digit pressure check
                    <select value={f.pressure} disabled={lock} onChange={event => onAutoForm('pressure', event.target.value)}>
                        <option value='off'>Off</option>
                        <option value='on'>On</option>
                    </select>
                </label>
            </div>
            {f.entryMode === 'DYNAMIC' && (
                <div className='apex-bt__auto-form'>
                    {field('Rest after N losing runs (0 = never)', 'lossPauseAfter')}
                    {field('Rest for (s)', 'lossPauseSec')}
                    {field('Skip when danger is at least (0 = off)', 'dangerCeiling')}
                </div>
            )}
            {auto.rule && <p className='apex-bt__rule'>Entry rule now: {auto.rule}</p>}

            <h3>Recovery and martingale</h3>
            <div className='apex-bt__auto-form'>
                <label>Recovery
                    <select value={f.recovery} disabled={lock} onChange={event => onAutoForm('recovery', event.target.value)}>
                        <option value='off'>Off</option>
                        <option value='on'>On</option>
                    </select>
                </label>
                <label>Recovery Over digit
                    <select value={f.recoveryOver} disabled={lock || f.recovery !== 'on'} onChange={event => onAutoForm('recoveryOver', event.target.value)}>
                        {[1, 2, 3].map(d => <option key={d} value={d}>Over {d}</option>)}
                    </select>
                </label>
                <label>Recovery Under digit
                    <select value={f.recoveryUnder} disabled={lock || f.recovery !== 'on'} onChange={event => onAutoForm('recoveryUnder', event.target.value)}>
                        {[8, 7, 6].map(d => <option key={d} value={d}>Under {d}</option>)}
                    </select>
                </label>
                <label>Martingale ×<input value={f.martingale} disabled={lock || f.recovery !== 'on'} inputMode='decimal' onChange={event => onAutoForm('martingale', event.target.value)} /></label>
                <label>Max recovery steps<input value={f.maxSteps} disabled={lock || f.recovery !== 'on'} inputMode='numeric' onChange={event => onAutoForm('maxSteps', event.target.value)} /></label>
                <label>At the limit
                    <select value={f.onCap} disabled={lock || f.recovery !== 'on'} onChange={event => onAutoForm('onCap', event.target.value)}>
                        <option value='STOP'>Stop</option>
                        <option value='RESET'>Reset to normal</option>
                    </select>
                </label>
            </div>

            <h3>Run log</h3>
            <div className='apex-bt__log-actions'>
                <button type='button' onClick={onLogDownload} disabled={auto.log.length === 0}>Download CSV ({auto.log.length})</button>
                <button type='button' onClick={onLogClear} disabled={auto.log.length === 0 || auto.armed}>Clear</button>
            </div>
            {auto.log.length > 0 && (
                <div className='apex-bt__log-wrap'>
                    <table className='apex-bt__log'>
                        <thead><tr><th>Time</th><th>Contract</th><th>Mode</th><th>Entry rule</th><th>Ticks</th><th>Exit digits</th><th>Result</th><th>P/L</th></tr></thead>
                        <tbody>
                            {auto.log.slice(0, 8).map(row => (
                                <tr key={row.id}>
                                    <td>{new Date(row.at).toLocaleTimeString()}</td><td>{row.contract}</td><td>{row.mode}</td><td>{row.rule}</td>
                                    <td>{row.pattern || '–'}</td><td>{row.exits || '–'}</td>
                                    <td className={row.result === 'WIN' ? 'is-win' : row.result === 'LOSS' ? 'is-loss' : ''}>{row.result}</td>
                                    <td className={row.pnl >= 0 ? 'is-win' : 'is-loss'}>{row.pnl.toFixed(2)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <p className='apex-bt__auto-foot'>
                Runs {auto.runs}/{auto.maxRuns} · Session P/L <b className={auto.pnl >= 0 ? 'is-win' : 'is-loss'}>{auto.pnl.toFixed(2)} {currency}</b>
                {` · stops at +${auto.targetProfit.toFixed(2)} or −${auto.maxLoss.toFixed(2)}`}
                {auto.account ? ` · ${auto.account} account` : ''}{running ? ' · run in progress' : ''}
                <br />
                A signal starts the watch; the buy happens when the latest ticks show the side (O for Over, U for Under against the contract&apos;s barrier). After a losing run
                with recovery on, the next signal is traded at your recovery digit with the martingale stake, and a win returns to normal. The deck stake at arming is the base stake.
                The deck is locked while armed, it stops itself at the limits or if any purchase fails, and it is always off when the page loads.
            </p>
        </section>
    );
};

const BulkTraderView = (props: BulkViewProps) => {
    const { symbol, digitPct, form, currency, running, tally, log } = props;
    const params = sanitizeBulk({ stake: Number(form.stake), runs: Number(form.runs), duration: Number(form.duration) });
    const max = Math.max(...digitPct);
    const min = Math.min(...digitPct);
    const hasData = digitPct.some(value => value > 0);
    const over = Number(props.overBarrier);
    const under = Number(props.underBarrier);
    const lock = props.signalLock;
    const overList = lock.on ? OVER_BARRIERS : FREE_BARRIERS.DIGITOVER;
    const underList = lock.on ? UNDER_BARRIERS : FREE_BARRIERS.DIGITUNDER;
    const sides = [
        { side: 0 as const, label: `Over ${over}`, hit: hitRate(digitPct, 'DIGITOVER', over), cls: 'a' },
        { side: 1 as const, label: `Under ${under}`, hit: hitRate(digitPct, 'DIGITUNDER', under), cls: 'b' },
    ];

    return (
        <div className='apex-bt'>
            <RecommendationBar rec={props.rec} watch={props.watch} onLoadRec={props.onLoadRec} marketsReady={props.marketsReady} live={props.live}
                locked={props.locked} canLock={props.canLock} onToggleLock={props.onToggleLock} />

            <AutoPanel auto={props.auto} running={props.running} currency={currency} onAutoToggle={props.onAutoToggle} onAutoForm={props.onAutoForm} onLogDownload={props.onLogDownload} onLogClear={props.onLogClear} />

            <section className='apex-bt__panel' ref={props.traderRef} aria-label='Trading Deck'>
                <div className='apex-bt__head'>
                    <div><small>TRADING DECK</small><h2>Over / Under</h2></div>
                    <div className={`apex-bt__state${running ? ' is-running' : ''}`}>{running ? 'RUNNING' : 'IDLE'}</div>
                </div>

                <div className='apex-bt__grid2'>
                    <label>Market
                        <select value={symbol} disabled={running || props.auto.armed} onChange={event => props.onSymbol(event.target.value)}>
                            {BULK_MARKETS.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}
                        </select>
                    </label>
                    <label>Trade type
                        <select value='overunder' disabled><option value='overunder'>Over / Under</option></select>
                    </label>
                </div>

                <div className='apex-bt__tick'>
                    <small>CURRENT TICK</small>
                    <strong>{props.price !== null ? props.price : '—'}</strong>
                </div>

                <div className='apex-bt__rings'>
                    {digitPct.map((pct, digit) => (
                        <div key={digit} className={`apex-bt__ring${digit === props.digit ? ' is-current' : ''}`}
                            style={ringStyle(pct, hasData && pct === max ? '#19d38a' : hasData && pct === min ? '#ff4d6a' : '#2a8cf0')}>
                            <span>{digit}<small>{pct.toFixed(1)}%</small></span>
                        </div>
                    ))}
                </div>

                <div className='apex-bt__strip'>
                    {props.recent.slice(-8).map((digit, index) => {
                        // Every digit is either O or U, split at the barrier of the loaded signal (Over barrier when nothing is loaded).
                        // Over b: digits above b are O, b and below are U.  Under b: digits below b are U, b and above are O.
                        const mark = props.pickSide === 1 ? (digit < under ? 'U' : 'O') : (digit > over ? 'O' : 'U');
                        return <span key={index} className={mark === 'O' ? 'is-even' : 'is-odd'}>{mark}</span>;
                    })}
                </div>

                <div className='apex-bt__form'>
                    <label>Ticks (duration)<input value={form.duration} disabled={running || props.auto.armed} inputMode='numeric' onChange={props.onForm('duration')} /></label>
                    <label>Stake ({currency})<input value={form.stake} disabled={running || props.auto.armed} inputMode='decimal' onChange={props.onForm('stake')} /></label>
                    <label>No. of bulk trades<input value={form.runs} disabled={running || props.auto.armed} inputMode='numeric' onChange={props.onForm('runs')} /></label>
                    <label>Over barrier
                        <select value={props.overBarrier} disabled={running || props.auto.armed} onChange={event => props.onOverBarrier(event.target.value)}>
                            {overList.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </label>
                    <label>Under barrier
                        <select value={props.underBarrier} disabled={running || props.auto.armed} onChange={event => props.onUnderBarrier(event.target.value)}>
                            {underList.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </label>
                </div>
            </section>

            <section className='apex-bt__panel apex-bt__lower' aria-label='Over and Under'>
                <div className='apex-bt__siglock'>
                    <button type='button' role='switch' aria-checked={lock.on} className={`apex-bt__switch${lock.on ? ' is-on' : ''}`} onClick={lock.onToggle}
                        title={lock.on ? 'Signal lock on: Over/Under open only for a loaded EXECUTE signal' : 'Signal lock off: Over/Under are free with any barrier'}>
                        <i aria-hidden='true' />
                        <span>Signal lock {lock.on ? 'ON' : 'OFF'}</span>
                    </button>
                    <small>{lock.on
                        ? 'Over / Under stay locked until a signal is loaded and the engine says EXECUTE. The auto trader always locks them while it is on.'
                        : 'Over / Under are free: choose any barrier and trade either side at any time. The auto trader still locks them while it is on.'}</small>
                </div>

                <div className='apex-bt__sides'>
                    {sides.map(item => {
                        const open = !lock.on || lock.openSide === item.side;
                        const executeTag = lock.on && lock.openSide === item.side;
                        return (
                            <button key={item.side} type='button' disabled={running || !hasData || props.auto.armed || !open}
                                className={`apex-bt__side apex-bt__side--${item.cls}${!lock.on && props.pickSide === item.side ? ' is-pick' : ''}${executeTag ? ' is-execute' : ''}${lock.on && !open ? ' is-gated' : ''}`}
                                onClick={() => props.onRun(item.side)}>
                                {executeTag && <em>EXECUTE SIGNAL</em>}
                                {!lock.on && props.pickSide === item.side && <em>AI PICK</em>}
                                <span>{item.label}</span>
                                <strong>{item.hit.toFixed(1)}%</strong>
                                <small>{lock.on && !open ? '🔒 locked · waiting for an EXECUTE signal' : `past hit · run ×${params.runs} together`}</small>
                            </button>
                        );
                    })}
                </div>

                <p className='apex-bt__pickinfo'>{lock.on && lock.note ? lock.note : props.loadedNote}</p>

                <div className='apex-bt__status'>
                    <span>{props.status}</span>
                    {running && <button type='button' className='apex-bt__stop' onClick={props.onStop}>Stop / Exit</button>}
                </div>
                {props.error && <p className='apex-bt__error' role='alert'>{props.error}</p>}

                <div className='apex-bt__stats'>
                    <div><small>Exposure</small><strong>{money(exposure(params), currency)}</strong></div>
                    <div><small>Placed / requested</small><strong>{tally.placed} / {tally.requested || params.runs}</strong></div>
                    <div><small>Settled · W / L</small><strong>{tally.settled} · {tally.wins} / {tally.losses}</strong></div>
                    <div><small>Realised P/L</small><strong className={tally.pnl >= 0 ? 'is-win' : 'is-loss'}>{money(tally.pnl, currency)}</strong></div>
                </div>
                {props.syncNote && <p className='apex-bt__sync'>{props.syncNote}</p>}
                {log.some(row => row.state === 'won' || row.state === 'lost') && (
                    <div className='apex-bt__exits' aria-label='Settlement digits'>
                        <small>Settlement digits</small>
                        {log.filter(row => row.state === 'won' || row.state === 'lost').map(row => (
                            <span key={row.id} className={row.state === 'won' ? 'is-win' : 'is-loss'} title={row.state === 'won' ? 'Won' : 'Lost'}>
                                {row.exitDigit ?? (row.exitFinal ? '?' : '…')}
                            </span>
                        ))}
                    </div>
                )}

                {log.length > 0 && (
                    <div className='apex-bt__tablewrap apex-bt__log'>
                        <table>
                            <thead><tr><th>Time</th><th>Trade</th><th>Stake</th><th>Exit digit</th><th>Result</th></tr></thead>
                            <tbody>
                                {log.map(row => (
                                    <tr key={row.id}>
                                        <td>{row.time}</td><td>{row.label}</td><td>{row.stake.toFixed(2)}</td>
                                        <td>{row.exitDigit ?? (row.state === 'failed' ? '—' : row.exitFinal ? 'n/a' : '…')}</td>
                                        <td className={row.state === 'won' ? 'is-win' : row.state === 'open' ? '' : 'is-loss'}>
                                            {row.state === 'open' ? 'Open…' : row.state === 'failed' ? `Failed: ${row.note ?? ''}` : `${row.profit >= 0 ? '+' : ''}${row.profit.toFixed(2)}`}
                                        </td>

                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <p className='apex-bt__foot'>
                A recommendation is not a trade and not a prediction: pressing Over or Under places up to {MAX_BULK_RUNS} real contracts at once. The engine&apos;s
                score ranks setups; it is not a win probability. Digit contracts on synthetic indices are random and payouts include Deriv&apos;s margin, so the
                expected return is negative. Test on a demo account first.
            </p>
        </div>
    );
};

export default BulkTraderView;
