import type { CSSProperties, RefObject } from 'react';
import {
    FAMILIES, FAMILY_ORDER, BULK_MARKETS, MAX_BULK_RUNS, type Family, type MarketScan, type ScanPick, type ScanResult,
    type Strength, type Tally, exposure, needsBarrier, pairPercents, sanitizeBulk,
} from '../bulk-engine';

export type LogRow = {
    id: number;
    time: string;
    label: string;
    stake: number;
    state: 'open' | 'won' | 'lost' | 'error';
    profit: number;
    note?: string;
};

export type BulkForm = { duration: string; stake: string; runs: string; maxLoss: string };

export type LoadedPick = { symbol: string; pick: ScanPick };

export type BulkViewProps = {
    family: Family;
    onFamily: (family: Family) => void;
    ticks: number;
    onTicks: (ticks: number) => void;
    scan: ScanResult;
    live: boolean;
    onRescan: () => void;
    symbol: string;
    onSymbol: (symbol: string) => void;
    barrier: string;
    onBarrier: (barrier: string) => void;
    loaded: LoadedPick | null;
    onLoad: (symbol: string) => void;
    form: BulkForm;
    onForm: (key: keyof BulkForm) => (event: { target: { value: string } }) => void;
    currency: string;
    running: boolean;
    status: string;
    error: string;
    tally: Tally;
    log: LogRow[];
    onExecute: (side: 0 | 1) => void;
    onStop: () => void;
    traderRef?: RefObject<HTMLElement>;
};

const TICK_OPTIONS = [300, 500, 1000, 2000, 5000];
const STRENGTH_TEXT: Record<Strength, string> = { strong: 'Strong', moderate: 'Moderate', weak: 'Weak', none: 'None' };
const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;
const signedPct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

const ringStyle = (pct: number, color: string) => ({ '--p': Math.min(100, pct * 3), '--c': color }) as CSSProperties;

const Scanner = ({ family, onFamily, ticks, onTicks, scan, live, onRescan, onLoad, loaded, symbol }: BulkViewProps) => (
    <section className='apex-bt__panel'>
        <div className='apex-bt__head'>
            <div>
                <small>STEP 1</small>
                <h2>Engine-ranked scanner · 13 volatility indices</h2>
                <span className='apex-bt__live'>
                    <i className={live ? 'is-on' : ''} />
                    {scan.marketsReady > 0
                        ? `Live · ${scan.marketsReady}/${BULK_MARKETS.length} markets ready · ${scan.hypotheses} candidates tested`
                        : 'Connecting…'}
                </span>
            </div>
            <div className='apex-bt__controls'>
                <div className='apex-bt__tabs' role='tablist'>
                    {FAMILY_ORDER.map(id => (
                        <button key={id} type='button' role='tab' aria-selected={id === family}
                            className={id === family ? 'is-active' : ''} onClick={() => onFamily(id)}>
                            {FAMILIES[id].title}
                        </button>
                    ))}
                </div>
                <label>Sample
                    <select value={ticks} onChange={event => onTicks(Number(event.target.value))}>
                        {TICK_OPTIONS.map(value => <option key={value} value={value}>Last {value} ticks</option>)}
                    </select>
                </label>
                <button type='button' className='apex-bt__ghost' onClick={onRescan}>Rescan</button>
            </div>
        </div>

        <p className='apex-bt__engine-note'>Three analysis engines rank Even/Odd, Over/Under, and Matches/Differs candidates from live tick history. Scores are research rankings, not calibrated win probabilities or proof of an edge. The scanner never starts trades automatically; each purchase still requires your confirmation.</p>

        <div className='apex-bt__tablewrap'>
            <table>
                <thead>
                    <tr><th>#</th><th>Market</th><th>Pick</th><th>Engine score</th><th>Stat. evidence</th><th>Past hit</th><th>z</th><th /></tr>
                </thead>
                <tbody>
                    {scan.ranked.length === 0 && <tr><td colSpan={8} className='apex-bt__empty'>Collecting ticks from all markets…</td></tr>}
                    {scan.ranked.map((market, index) => {
                        const best = market.best as ScanPick;
                        const active = loaded?.symbol === market.symbol && loaded.pick.family === family && symbol === market.symbol;
                        return (
                            <tr key={market.symbol} className={`${index === 0 ? 'is-best' : ''}${active ? ' is-loaded' : ''}`}>
                                <td>{index + 1}</td>
                                <td><b>{market.name}</b><small>{market.symbol} · last digit {market.lastDigit}</small></td>
                                <td><b className='apex-bt__pick'>{best.label}</b><small>{best.agree} windows agree</small></td>
                                <td><span className='apex-bt__meter'><i style={{ width: `${best.score}%` }} /></span><b>{best.score}</b></td>
                                <td><span className={`apex-bt__badge apex-bt__badge--${best.strength}`}>{STRENGTH_TEXT[best.strength]}</span></td>
                                <td>{best.hitPct}%<small>vs {best.breakEvenPct}% to break even</small></td>
                                <td>{best.z > 0 ? '+' : ''}{best.z}</td>
                                <td><button type='button' className='apex-bt__load' onClick={() => onLoad(market.symbol)}>{active ? 'Loaded' : 'Load'}</button></td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
        {scan.note && <p className='apex-bt__note'>{scan.note}</p>}
    </section>
);

const Trader = (props: BulkViewProps) => {
    const { family, scan, symbol, onSymbol, barrier, onBarrier, loaded, form, onForm, currency, running, status, error, tally, log } = props;
    const def = FAMILIES[family];
    const market: MarketScan | undefined = scan.markets.find(item => item.symbol === symbol);
    const ready = Boolean(market?.ready);
    const barrierDigit = Math.trunc(Number(barrier)) || 0;
    const usesBarrier = needsBarrier(def.contracts[0]);
    const [pctA, pctB] = pairPercents(market?.digitPct ?? new Array<number>(10).fill(0), family, barrierDigit);
    const invalidDiffersBarrier = family === 'matchesdiffers' && ![2, 3, 4, 5, 6, 7].includes(barrierDigit);
    const labelFor = (side: 0 | 1) => {
        if (family === 'matchesdiffers' && side === 1 && invalidDiffersBarrier) return 'Differs (2–7 only)';
        return usesBarrier ? `${def.sides[side]} ${barrierDigit}` : def.sides[side];
    };
    const params = sanitizeBulk({ stake: Number(form.stake), runs: Number(form.runs), duration: Number(form.duration), maxLoss: Number(form.maxLoss) });

    const isPick = (side: 0 | 1) => Boolean(
        loaded && loaded.symbol === symbol && loaded.pick.family === family && loaded.pick.side === side &&
        (loaded.pick.barrier === null || loaded.pick.barrier === barrierDigit)
    );

    const pcts = market?.digitPct ?? new Array<number>(10).fill(0);
    const max = Math.max(...pcts);
    const min = Math.min(...pcts);

    return (
        <section className='apex-bt__panel' ref={props.traderRef}>
            <div className='apex-bt__head'>
                <div><small>STEP 2</small><h2>Bulk trader</h2></div>
                <div className={`apex-bt__state${running ? ' is-running' : ''}`}>{running ? 'RUNNING' : 'IDLE'}</div>
            </div>

            <div className='apex-bt__grid2'>
                <label>Market
                    <select value={symbol} disabled={running} onChange={event => onSymbol(event.target.value)}>
                        {BULK_MARKETS.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}
                    </select>
                </label>
                <label>Trade type
                    <select value={family} disabled>
                        <option value={family}>{def.title}</option>
                    </select>
                </label>
            </div>

            <div className='apex-bt__tick'>
                <small>CURRENT TICK</small>
                <strong>{market?.lastPrice != null ? market.lastPrice : market?.lastDigit ?? '—'}</strong>
            </div>

            <div className='apex-bt__rings'>
                {pcts.map((pct, digit) => (
                    <div key={digit} className={`apex-bt__ring${digit === market?.lastDigit ? ' is-current' : ''}`}
                        style={ringStyle(pct, pct === max && pct > 0 ? '#19d38a' : pct === min ? '#ff4d6a' : '#2a8cf0')}>
                        <span>{digit}<small>{pct.toFixed(1)}%</small></span>
                    </div>
                ))}
            </div>

            <div className='apex-bt__strip'>
                {(market?.recent ?? []).slice(-8).map((digit, index) => (
                    <span key={index} className={digit % 2 === 0 ? 'is-even' : 'is-odd'}>{digit % 2 === 0 ? 'E' : 'O'}</span>
                ))}
            </div>

            <div className='apex-bt__form'>
                <label>Ticks (duration)<input value={form.duration} disabled={running} inputMode='numeric' onChange={onForm('duration')} /></label>
                <label>Stake ({currency})<input value={form.stake} disabled={running} inputMode='decimal' onChange={onForm('stake')} /></label>
                <label>No. of bulk trades<input value={form.runs} disabled={running} inputMode='numeric' onChange={onForm('runs')} /></label>
                {usesBarrier && (
                    <label>{family === 'overunder' ? 'Barrier digit' : 'Digit'}
                        <select value={barrier} disabled={running} onChange={event => onBarrier(event.target.value)}>
                            {Array.from({ length: 10 }, (_, digit) => <option key={digit} value={digit}>{digit}</option>)}
                        </select>
                    </label>
                )}
                <label>Stop at loss ≥ ({currency})<input value={form.maxLoss} disabled={running} inputMode='decimal' onChange={onForm('maxLoss')} /></label>
            </div>

            <div className='apex-bt__sides'>
                {([0, 1] as const).map(side => (
                    <button key={side} type='button' disabled={running || !ready || (family === 'matchesdiffers' && side === 1 && invalidDiffersBarrier)}
                        className={`apex-bt__side apex-bt__side--${side === 0 ? 'a' : 'b'}${isPick(side) ? ' is-pick' : ''}`}
                        onClick={() => props.onExecute(side)}>
                        {isPick(side) && <em>AI PICK</em>}
                        <span>{labelFor(side)}</span>
                        <strong>{(side === 0 ? pctA : pctB).toFixed(1)}%</strong>
                        <small>past hit · execute ×{params.runs}</small>
                    </button>
                ))}
            </div>

            <p className='apex-bt__pickinfo'>
                {loaded && loaded.pick.family === family
                    ? <><b>{loaded.pick.label}</b> on {BULK_MARKETS.find(m => m.symbol === loaded.symbol)?.name}. {loaded.pick.reason} Observed {signedPct(loaded.pick.observedEV)} · projected after shrinkage {signedPct(loaded.pick.projectedEV)}.</>
                    : 'Load a pick from the scanner, or choose your own market, digit and side.'}
            </p>

            <div className='apex-bt__status'>
                <span>{status}</span>
                {running && <button type='button' className='apex-bt__stop' onClick={props.onStop}>Stop</button>}
            </div>
            {error && <p className='apex-bt__error'>{error}</p>}

            <div className='apex-bt__stats'>
                <div><small>Exposure</small><strong>{money(exposure(params), currency)}</strong></div>
                <div><small>Placed / settled</small><strong>{tally.placed} / {tally.settled}</strong></div>
                <div><small>Wins / losses</small><strong>{tally.wins} / {tally.losses}</strong></div>
                <div><small>Realised P/L</small><strong className={tally.pnl >= 0 ? 'is-win' : 'is-loss'}>{money(tally.pnl, currency)}</strong></div>
            </div>

            {log.length > 0 && (
                <div className='apex-bt__tablewrap apex-bt__log'>
                    <table>
                        <thead><tr><th>Time</th><th>Trade</th><th>Stake</th><th>Result</th></tr></thead>
                        <tbody>
                            {log.map(row => (
                                <tr key={row.id}>
                                    <td>{row.time}</td><td>{row.label}</td><td>{row.stake.toFixed(2)}</td>
                                    <td className={row.state === 'won' ? 'is-win' : row.state === 'open' ? '' : 'is-loss'}>
                                        {row.state === 'open' ? 'Open…' : row.state === 'error' ? `Failed: ${row.note ?? ''}` : `${row.profit >= 0 ? '+' : ''}${row.profit.toFixed(2)}`}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
};

const BulkTraderView = (props: BulkViewProps) => (
    <div className='apex-bt'>
        <header className='apex-bt__title'>
            <h1>AI Bulk Trader</h1>
            <p>Scan all 13 volatility indices, load the ranked pick, and place it in bulk. Up to {MAX_BULK_RUNS} trades per run.</p>
        </header>
        <Scanner {...props} />
        <Trader {...props} />
        <p className='apex-bt__foot'>
            The scanner combines the new strategy engines with separate historical significance diagnostics. Engine scores rank hypotheses; they are not win probabilities and do not prove an edge. Synthetic-index digit contracts are random and payouts include Deriv&apos;s margin, so expected return is generally negative. Test on a demo account first.
            Test on a demo account first.
        </p>
    </div>
);

export default BulkTraderView;
