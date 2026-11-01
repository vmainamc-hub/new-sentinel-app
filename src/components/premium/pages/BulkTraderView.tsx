import { useState, type CSSProperties, type RefObject } from 'react';
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
    oneTick: { on: boolean; onToggle: () => void };
    symbol: string;
    onSymbol: (symbol: string) => void;
    price: number | null;
    digit: number | null;
    digitPct: number[];
    digitTrend?: number[] | null;
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

export type DigitRole = 'most' | 'second-most' | 'least' | 'second-least' | 'rising' | null;
export const ROLE_COLOR: Record<Exclude<DigitRole, null>, string> = {
    most: '#19d38a', 'second-most': '#ffd23f', least: '#ff4d6a', 'second-least': '#ff8a1f', rising: '#c05cff',
};
export const ROLE_NAME: Record<Exclude<DigitRole, null>, string> = {
    most: 'Most appearing', 'second-most': '2nd most', least: 'Least appearing', 'second-least': '2nd least', rising: 'Most increasing',
};
/** One role per digit: most / least win over the rest, then the fastest riser, then the 2nd most and 2nd least. */
export const digitRoles = (pct: number[], trend?: number[] | null): DigitRole[] => {
    const roles: DigitRole[] = Array(pct.length).fill(null);
    if (!pct.some(v => v > 0)) return roles;
    const order = pct.map((v, i) => i).sort((a, b) => pct[b] - pct[a] || a - b);
    const n = order.length;
    roles[order[0]] = 'most';
    roles[order[n - 1]] = 'least';
    if (trend && trend.length === n) {
        let best = -1;
        trend.forEach((v, i) => { if (!roles[i] && v > 0 && (best < 0 || v > trend[best])) best = i; });
        if (best >= 0) roles[best] = 'rising';
    }
    if (!roles[order[1]]) roles[order[1]] = 'second-most';
    if (!roles[order[n - 2]]) roles[order[n - 2]] = 'second-least';
    return roles;
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

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page shows is the trader's choice: every block below can be switched on or off from "View". The choice is remembered.
// ---------------------------------------------------------------------------------------------------------------------------------
export type ViewKey = 'signal' | 'auto' | 'stats' | 'log' | 'notes';
export const VIEW_OPTIONS: ReadonlyArray<readonly [ViewKey, string]> = [
    ['signal', 'Fusion signal'], ['auto', 'Auto trader'], ['stats', 'Run results'], ['log', 'Logs and tables'], ['notes', 'Notes and explanations'],
];
export const DEFAULT_VIEW: Record<ViewKey, boolean> = { signal: true, auto: true, stats: true, log: false, notes: false };
const VIEW_KEY = 'apex.bulk.view.v1';
const loadView = (): Record<ViewKey, boolean> => {
    try {
        const raw = JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? 'null') as Partial<Record<ViewKey, boolean>> | null;
        return { ...DEFAULT_VIEW, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([k, v]) => k in DEFAULT_VIEW && typeof v === 'boolean')) };
    } catch { return { ...DEFAULT_VIEW }; }
};
const saveView = (view: Record<ViewKey, boolean>) => { try { window.localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* not remembered */ } };

const ViewMenu = ({ view, onChange }: { view: Record<ViewKey, boolean>; onChange: (key: ViewKey, on: boolean) => void }) => (
    <details className='apex-bt__viewmenu'>
        <summary>View</summary>
        <div className='apex-bt__viewlist'>
            {VIEW_OPTIONS.map(([key, label]) => (
                <label key={key}><input type='checkbox' checked={view[key]} onChange={event => onChange(key, event.target.checked)} />{label}</label>
            ))}
            <button type='button' onClick={() => VIEW_OPTIONS.forEach(([key]) => onChange(key, DEFAULT_VIEW[key]))}>Reset view</button>
        </div>
    </details>
);

const AutoPanel = ({ auto, running, currency, view, onAutoToggle, onAutoForm, onLogDownload, onLogClear }:
    Pick<BulkViewProps, 'auto' | 'currency' | 'onAutoToggle' | 'onAutoForm' | 'onLogDownload' | 'onLogClear'> & { running: boolean; view: Record<ViewKey, boolean> }) => {
    const f = auto.form;
    const lock = auto.armed;
    const phase = !auto.armed
        ? 'Off. Run scans Fusion signals and trades them automatically.'
        : running ? 'Run in progress'
            : auto.entry ? (auto.entry.waiting ? `Signal found · waiting for ${auto.entry.need} ${auto.entry.want} ticks` : `Watching for ${auto.entry.need} ${auto.entry.want} ticks`)
                : auto.note;
    const won = auto.log.filter(row => row.result === 'WIN').length;
    const lost = auto.log.filter(row => row.result === 'LOSS').length;
    const field = (label: string, key: keyof AutoForm, mode: 'numeric' | 'decimal' = 'numeric') => (
        <label>{label}<input value={f[key]} disabled={lock} inputMode={mode} onChange={event => onAutoForm(key, event.target.value)} /></label>
    );
    return (
        <section className={`apex-bt__auto${auto.armed ? ' is-armed' : ''}`} aria-label='Auto trader'>
            <div className='apex-bt__runbar'>
                <button type='button' className={`apex-bt__run${auto.armed ? ' is-stop' : ''}`} onClick={onAutoToggle} aria-pressed={auto.armed}>
                    {auto.armed ? 'Stop' : 'Run'}
                </button>
                <div className='apex-bt__runinfo'>
                    <small>AUTO TRADER{auto.armed ? ` · ${auto.mode}` : ''}{auto.account ? ` · ${auto.account}` : ''}</small>
                    <p className={auto.armed ? 'is-on' : ''}>{phase}</p>
                    {auto.armed && auto.next && <p className='apex-bt__next'>Next: {auto.next}</p>}
                </div>
                <div className='apex-bt__mini'>
                    <span><small>Runs</small><b>{auto.runs}/{auto.maxRuns}</b></span>
                    <span><small>Won / Lost</small><b>{won} / {lost}</b></span>
                    <span><small>P/L</small><b className={auto.pnl >= 0 ? 'is-win' : 'is-loss'}>{auto.pnl.toFixed(2)} {currency}</b></span>
                </div>
            </div>

            {auto.armed && auto.entry && (
                <div className='apex-bt__auto-state'>
                    <span className='apex-bt__entry' title='Latest ticks against the barrier of the contract to be traded'>
                        <small>Entry: last {auto.entry.need} ticks must be {auto.entry.want}</small>
                        <span className='apex-bt__ticks'>
                            {auto.entry.symbols.length === 0 && <i>…</i>}
                            {auto.entry.symbols.map((symbol, index) => <i key={index} className={`is-${symbol === 'O' ? 'over' : symbol === 'U' ? 'under' : 'eq'}`}>{symbol}</i>)}
                        </span>
                    </span>
                </div>
            )}

            <details className='apex-bt__params'>
                <summary>Auto trader parameters</summary>
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
                {view.notes && (
                    <p className='apex-bt__auto-foot'>
                        Stops at +{auto.targetProfit.toFixed(2)} or −{auto.maxLoss.toFixed(2)} {currency}. A signal starts the watch; the buy happens when the latest ticks show the side
                        (O for Over, U for Under against the contract&apos;s barrier). After a losing run with recovery on, the next signal is traded at your recovery digit with the
                        martingale stake, and a win returns to normal. The deck stake at arming is the base stake. The deck is locked while armed, it stops itself at the limits or if
                        any purchase fails, and it is always off when the page loads.
                    </p>
                )}
            </details>

            {view.log && (
                <details className='apex-bt__params' open>
                    <summary>Auto run log ({auto.log.length})</summary>
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
                </details>
            )}
        </section>
    );
};

const BulkTraderView = (props: BulkViewProps) => {
    const { symbol, digitPct, form, currency, running, tally, log } = props;
    const [view, setView] = useState<Record<ViewKey, boolean>>(loadView);
    const setViewKey = (key: ViewKey, on: boolean) => setView(current => { const next = { ...current, [key]: on }; saveView(next); return next; });
    const params = sanitizeBulk({ stake: Number(form.stake), runs: Number(form.runs), duration: Number(form.duration) });
    const roles = digitRoles(digitPct, props.digitTrend);
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
    const settled = log.filter(row => row.state === 'won' || row.state === 'lost');
    const busy = running || props.auto.armed;

    return (
        <div className='apex-bt'>
            <div className='apex-bt__top'>
                <div><small>BULK TRADER</small><h2>Over / Under</h2></div>
                <div className='apex-bt__topright'>
                    <span className={`apex-bt__state${running ? ' is-running' : ''}`}>{running ? 'RUNNING' : props.auto.armed ? 'AUTO ON' : 'IDLE'}</span>
                    <ViewMenu view={view} onChange={setViewKey} />
                </div>
            </div>

            {view.signal && (
                <RecommendationBar rec={props.rec} watch={props.watch} onLoadRec={props.onLoadRec} marketsReady={props.marketsReady} live={props.live}
                    locked={props.locked} canLock={props.canLock} onToggleLock={props.onToggleLock} />
            )}

            {view.auto && (
                <AutoPanel auto={props.auto} running={props.running} currency={currency} view={view} onAutoToggle={props.onAutoToggle} onAutoForm={props.onAutoForm}
                    onLogDownload={props.onLogDownload} onLogClear={props.onLogClear} />
            )}

            <section className='apex-bt__panel' ref={props.traderRef} aria-label='Trading Deck'>
                <div className='apex-bt__deckhead'>
                    <label>Market
                        <select value={symbol} disabled={busy} onChange={event => props.onSymbol(event.target.value)}>
                            {BULK_MARKETS.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}
                        </select>
                    </label>
                    <div className='apex-bt__tick'>
                        <small>CURRENT TICK</small>
                        <strong>{props.price !== null ? props.price : '—'}</strong>
                    </div>
                </div>

                <div className='apex-bt__rings'>
                    {digitPct.map((pct, digit) => (
                        <div key={digit} className={`apex-bt__ring${digit === props.digit ? ' is-current' : ''}`}
                            style={ringStyle(pct, roles[digit] ? ROLE_COLOR[roles[digit] as Exclude<DigitRole, null>] : '#2a8cf0')}
                            title={roles[digit] ? ROLE_NAME[roles[digit] as Exclude<DigitRole, null>] : undefined}>
                            <span>{digit}<small>{pct.toFixed(1)}%</small></span>
                        </div>
                    ))}
                </div>
                {hasData && (
                    <div className='apex-bt__legend' aria-label='Digit colours'>
                        {(Object.keys(ROLE_COLOR) as Exclude<DigitRole, null>[]).map(role => (
                            <span key={role}><i style={{ background: ROLE_COLOR[role] }} />{ROLE_NAME[role]}</span>
                        ))}
                    </div>
                )}

                <div className='apex-bt__strip'>
                    {props.recent.slice(-8).map((digit, index) => {
                        // Every digit is either O or U, split at the barrier of the loaded signal (Over barrier when nothing is loaded).
                        // Over b: digits above b are O, b and below are U.  Under b: digits below b are U, b and above are O.
                        const mark = props.pickSide === 1 ? (digit < under ? 'U' : 'O') : (digit > over ? 'O' : 'U');
                        return <span key={index} className={mark === 'O' ? 'is-even' : 'is-odd'}>{mark}</span>;
                    })}
                </div>

                <div className='apex-bt__form'>
                    <label>Ticks (duration)<input value={form.duration} disabled={busy} inputMode='numeric' onChange={props.onForm('duration')} /></label>
                    <label>Stake ({currency})<input value={form.stake} disabled={busy} inputMode='decimal' onChange={props.onForm('stake')} /></label>
                    <label>No. of bulk trades<input value={form.runs} disabled={busy} inputMode='numeric' onChange={props.onForm('runs')} /></label>
                    <label>Over barrier
                        <select value={props.overBarrier} disabled={busy} onChange={event => props.onOverBarrier(event.target.value)}>
                            {overList.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </label>
                    <label>Under barrier
                        <select value={props.underBarrier} disabled={busy} onChange={event => props.onUnderBarrier(event.target.value)}>
                            {underList.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </label>
                </div>

                <div className='apex-bt__switches'>
                    <div className='apex-bt__siglock'>
                        <button type='button' role='switch' aria-checked={props.oneTick.on} className={`apex-bt__switch${props.oneTick.on ? ' is-on' : ''}`} onClick={props.oneTick.onToggle}
                            title={props.oneTick.on ? 'Only as many trades as fit before the next tick are sent, so they all share one exit digit.' : 'All trades are sent, even if some land on the next tick and settle on a different digit.'}>
                            <i aria-hidden='true' />
                            <span>One tick {props.oneTick.on ? 'ON' : 'OFF'}</span>
                        </button>
                        {view.notes && <small>{props.oneTick.on
                            ? 'Only as many trades as fit before the next tick are sent, so they all share one exit digit.'
                            : 'All trades are sent, even if some land on the next tick and settle on a different digit.'}</small>}
                    </div>
                    <div className='apex-bt__siglock'>
                        <button type='button' role='switch' aria-checked={lock.on} className={`apex-bt__switch${lock.on ? ' is-on' : ''}`} onClick={lock.onToggle}
                            title={lock.on ? 'Signal lock on: Over/Under open only for a loaded EXECUTE signal' : 'Signal lock off: Over/Under are free with any barrier'}>
                            <i aria-hidden='true' />
                            <span>Signal lock {lock.on ? 'ON' : 'OFF'}</span>
                        </button>
                        {view.notes && <small>{lock.on
                            ? 'Over / Under stay locked until a signal is loaded and the engine says EXECUTE. The auto trader always locks them while it is on.'
                            : 'Over / Under are free: choose any barrier and trade either side at any time. The auto trader still locks them while it is on.'}</small>}
                    </div>
                </div>
                {view.notes && <p className='apex-bt__pickinfo'>{lock.on && lock.note ? lock.note : props.loadedNote}</p>}

                <div className='apex-bt__sides' aria-label='Over and Under'>
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
                                <small>{lock.on && !open ? '🔒 locked · waiting for an EXECUTE signal' : `run ×${params.runs} together`}</small>
                            </button>
                        );
                    })}
                </div>

                {(props.status || running) && (
                    <div className='apex-bt__status'>
                        <span>{props.status}</span>
                        {running && <button type='button' className='apex-bt__stop' onClick={props.onStop}>Stop / Exit</button>}
                    </div>
                )}
                {props.error && <p className='apex-bt__error' role='alert'>{props.error}</p>}

                {view.stats && (
                    <div className='apex-bt__chips' aria-label='Run results'>
                        <span><small>Exposure</small><b>{money(exposure(params), currency)}</b></span>
                        <span><small>Placed</small><b>{tally.placed} / {tally.requested || params.runs}</b></span>
                        <span><small>W / L</small><b>{tally.wins} / {tally.losses}</b></span>
                        <span><small>P/L</small><b className={tally.pnl >= 0 ? 'is-win' : 'is-loss'}>{money(tally.pnl, currency)}</b></span>
                        {settled.length > 0 && (
                            <span className='apex-bt__exits' aria-label='Settlement digits'>
                                <small>Exit digits</small>
                                {settled.slice(0, 12).map(row => (
                                    <i key={row.id} className={row.state === 'won' ? 'is-win' : 'is-loss'} title={row.state === 'won' ? 'Won' : 'Lost'}>
                                        {row.exitDigit ?? (row.exitFinal ? '?' : '…')}
                                    </i>
                                ))}
                            </span>
                        )}
                    </div>
                )}
                {view.stats && props.syncNote && <p className='apex-bt__sync'>{props.syncNote}</p>}

                {view.log && log.length > 0 && (
                    <details className='apex-bt__params' open>
                        <summary>Manual trade log ({log.length})</summary>
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
                    </details>
                )}
            </section>

            {view.notes && (
                <p className='apex-bt__foot'>
                    A recommendation is not a trade and not a prediction: pressing Over or Under places up to {MAX_BULK_RUNS} real contracts at once. The engine&apos;s
                    score ranks setups; it is not a win probability. Digit contracts on synthetic indices are random and payouts include Deriv&apos;s margin, so the
                    expected return is negative. Test on a demo account first.
                </p>
            )}
        </div>
    );
};

export default BulkTraderView;
