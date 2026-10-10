import type { CSSProperties, RefObject } from 'react';
import { BULK_MARKETS, OVER_BARRIERS, UNDER_BARRIERS, hitRate, type Recommendation } from '../over-under-engine';
import { MAX_BULK_RUNS, exposure, sanitizeBulk, type Tally } from '../bulk-run';

export type LogRow = {
    id: number;
    time: string;
    label: string;
    stake: number;
    state: 'open' | 'won' | 'lost' | 'failed';
    profit: number;
    exitDigit?: number | null;
    note?: string;
};

export type BulkForm = { duration: string; stake: string; runs: string };

export type BulkViewProps = {
    live: boolean;
    marketsReady: number;
    rec: Recommendation | null;
    watch: { market: string; label: string } | null;
    onLoadRec: () => void;
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

const RecommendationBar = ({ rec, watch, onLoadRec, marketsReady, live }: Pick<BulkViewProps, 'rec' | 'watch' | 'onLoadRec' | 'marketsReady' | 'live'>) => (
    <section className='apex-bt__rec' aria-label='Recommendation'>
        <div className='apex-bt__rec-main'>
            <small>AI RECOMMENDATION · OVER / UNDER</small>
            {rec ? (
                <>
                    <h2>
                        {rec.market} <b>{rec.label}</b>
                        <span className={`apex-bt__tag apex-bt__tag--${rec.action.toLowerCase()}`}>{rec.action}</span>
                    </h2>
                    <details className='apex-bt__why'>
                        <summary>Why this one?</summary>
                        <p>Engine verdict {rec.score}/100 (a ranking score, not a win probability) · danger {rec.danger}/100 · {rec.sample} ticks analysed.</p>
                        <ul>{rec.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                    </details>
                </>
            ) : (
                <>
                    <h2 className='is-idle'>{live ? 'No qualified setup right now' : 'Connecting to the live feed…'}</h2>
                    <p className='apex-bt__hint'>
                        {marketsReady}/{BULK_MARKETS.length} markets analysed.{' '}
                        {watch ? `Closest: ${watch.market} ${watch.label}, not yet actionable.` : 'The engine recommends only when a setup qualifies.'}
                    </p>
                </>
            )}
        </div>
        <button type='button' className='apex-bt__loadrec' disabled={!rec} onClick={onLoadRec}>Load to Trading Deck</button>
    </section>
);

const BulkTraderView = (props: BulkViewProps) => {
    const { symbol, digitPct, form, currency, running, tally, log } = props;
    const params = sanitizeBulk({ stake: Number(form.stake), runs: Number(form.runs), duration: Number(form.duration) });
    const max = Math.max(...digitPct);
    const min = Math.min(...digitPct);
    const hasData = digitPct.some(value => value > 0);
    const over = Number(props.overBarrier);
    const under = Number(props.underBarrier);
    const sides = [
        { side: 0 as const, label: `Over ${over}`, hit: hitRate(digitPct, 'DIGITOVER', over), cls: 'a' },
        { side: 1 as const, label: `Under ${under}`, hit: hitRate(digitPct, 'DIGITUNDER', under), cls: 'b' },
    ];

    return (
        <div className='apex-bt'>
            <RecommendationBar rec={props.rec} watch={props.watch} onLoadRec={props.onLoadRec} marketsReady={props.marketsReady} live={props.live} />

            <section className='apex-bt__panel' ref={props.traderRef} aria-label='Trading Deck'>
                <div className='apex-bt__head'>
                    <div><small>TRADING DECK</small><h2>Over / Under</h2></div>
                    <div className={`apex-bt__state${running ? ' is-running' : ''}`}>{running ? 'RUNNING' : 'IDLE'}</div>
                </div>

                <div className='apex-bt__grid2'>
                    <label>Market
                        <select value={symbol} disabled={running} onChange={event => props.onSymbol(event.target.value)}>
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
                    {props.recent.slice(-8).map((digit, index) => (
                        <span key={index} className={digit % 2 === 0 ? 'is-even' : 'is-odd'}>{digit % 2 === 0 ? 'E' : 'O'}</span>
                    ))}
                </div>

                <div className='apex-bt__form'>
                    <label>Ticks (duration)<input value={form.duration} disabled={running} inputMode='numeric' onChange={props.onForm('duration')} /></label>
                    <label>Stake ({currency})<input value={form.stake} disabled={running} inputMode='decimal' onChange={props.onForm('stake')} /></label>
                    <label>No. of bulk trades<input value={form.runs} disabled={running} inputMode='numeric' onChange={props.onForm('runs')} /></label>
                    <label>Over barrier
                        <select value={props.overBarrier} disabled={running} onChange={event => props.onOverBarrier(event.target.value)}>
                            {OVER_BARRIERS.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </label>
                    <label>Under barrier
                        <select value={props.underBarrier} disabled={running} onChange={event => props.onUnderBarrier(event.target.value)}>
                            {UNDER_BARRIERS.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </label>
                </div>
            </section>

            <section className='apex-bt__panel apex-bt__lower' aria-label='Over and Under'>
                <div className='apex-bt__sides'>
                    {sides.map(item => (
                        <button key={item.side} type='button' disabled={running || !hasData}
                            className={`apex-bt__side apex-bt__side--${item.cls}${props.pickSide === item.side ? ' is-pick' : ''}`}
                            onClick={() => props.onRun(item.side)}>
                            {props.pickSide === item.side && <em>AI PICK</em>}
                            <span>{item.label}</span>
                            <strong>{item.hit.toFixed(1)}%</strong>
                            <small>past hit · run ×{params.runs} together</small>
                        </button>
                    ))}
                </div>

                <p className='apex-bt__pickinfo'>{props.loadedNote}</p>

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

                {log.length > 0 && (
                    <div className='apex-bt__tablewrap apex-bt__log'>
                        <table>
                            <thead><tr><th>Time</th><th>Trade</th><th>Stake</th><th>Exit digit</th><th>Result</th></tr></thead>
                            <tbody>
                                {log.map(row => (
                                    <tr key={row.id}>
                                        <td>{row.time}</td><td>{row.label}</td><td>{row.stake.toFixed(2)}</td>
                                        <td>{row.exitDigit ?? '—'}</td>
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
