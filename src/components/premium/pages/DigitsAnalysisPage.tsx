import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import {
    type AnalysisMode, DIGIT_PAIRS, type DigitPair, type MarketDigits, candidateTrades, digitsFromPrices, rankMarkets,
    streakStats,
} from '../apex-logic';

type MarketDef = { symbol: string; name: string; pip: number };

// Fallback pip decimals; the live active_symbols response overrides these when available.
const MARKETS: MarketDef[] = [
    { symbol: 'R_10', name: 'Volatility 10', pip: 3 },
    { symbol: 'R_25', name: 'Volatility 25', pip: 3 },
    { symbol: 'R_50', name: 'Volatility 50', pip: 4 },
    { symbol: 'R_75', name: 'Volatility 75', pip: 4 },
    { symbol: 'R_100', name: 'Volatility 100', pip: 2 },
    { symbol: '1HZ10V', name: 'Volatility 10 (1s)', pip: 2 },
    { symbol: '1HZ25V', name: 'Volatility 25 (1s)', pip: 2 },
    { symbol: '1HZ30V', name: 'Volatility 30 (1s)', pip: 3 },
    { symbol: '1HZ50V', name: 'Volatility 50 (1s)', pip: 2 },
    { symbol: '1HZ75V', name: 'Volatility 75 (1s)', pip: 2 },
    { symbol: '1HZ90V', name: 'Volatility 90 (1s)', pip: 3 },
    { symbol: '1HZ100V', name: 'Volatility 100 (1s)', pip: 2 },
];

const pipDecimals = (item: any, fallback: number) => {
    const pip = String(item?.pip_size ?? item?.pip ?? '');
    if (!pip) return fallback;
    if (!pip.includes('.')) return pip === '1' ? 0 : fallback;
    return pip.split('.')[1].replace(/0+$/, '').length || fallback;
};

const clampInt = (value: string, min: number, max: number, fallback: number) => {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const DigitsAnalysisPage = () => {
    const [mode, setMode] = useState<AnalysisMode>('over_under');
    const [pairIndex, setPairIndex] = useState(1);
    const [marketSymbol, setMarketSymbol] = useState('R_100');
    const [locked, setLocked] = useState(false);
    const [analysisTicks, setAnalysisTicks] = useState(1000);
    const [viewLast, setViewLast] = useState(100);
    const [analysisInput, setAnalysisInput] = useState('1000');
    const [viewInput, setViewInput] = useState('100');
    const [error, setError] = useState('');
    const [version, setVersion] = useState(0);
    const store = useRef<Record<string, number[]>>({});
    const decimals = useRef<Record<string, number>>(Object.fromEntries(MARKETS.map(m => [m.symbol, m.pip])));
    const dirty = useRef(false);

    const pair: DigitPair = DIGIT_PAIRS[pairIndex] ?? DIGIT_PAIRS[1];

    useEffect(() => {
        let alive = true;
        const disposers: Array<() => void> = [];
        store.current = {};
        setError('');

        const run = async () => {
            try {
                const symbols = await PremiumDerivApiService.activeSymbols();
                symbols.forEach((item: any) => {
                    const code = item?.underlying_symbol || item?.symbol;
                    if (code && decimals.current[code] !== undefined) decimals.current[code] = pipDecimals(item, decimals.current[code]);
                });
            } catch { /* keep fallback pip sizes */ }

            const queue = [...MARKETS];
            const worker = async () => {
                for (let market = queue.shift(); market && alive; market = queue.shift()) {
                    try {
                        const prices = await PremiumDerivApiService.ticksHistory(market.symbol, analysisTicks);
                        if (!alive) return;
                        store.current[market.symbol] = digitsFromPrices(prices, decimals.current[market.symbol]).slice(-analysisTicks);
                        dirty.current = true;
                        const dispose = await PremiumDerivApiService.subscribeTicks(market.symbol, tick => {
                            const quote = Number(tick?.quote);
                            if (!Number.isFinite(quote)) return;
                            const digit = Number(quote.toFixed(decimals.current[market.symbol]).slice(-1));
                            const list = store.current[market.symbol] || (store.current[market.symbol] = []);
                            list.push(digit);
                            if (list.length > analysisTicks) list.splice(0, list.length - analysisTicks);
                            dirty.current = true;
                        });
                        if (alive) disposers.push(dispose); else dispose();
                    } catch (err) {
                        if (alive) setError(err instanceof Error ? err.message : String(err));
                    }
                }
            };
            await Promise.all([worker(), worker(), worker(), worker()]);
        };
        void run();

        const timer = window.setInterval(() => {
            if (dirty.current) { dirty.current = false; setVersion(value => value + 1); }
        }, 700);

        return () => {
            alive = false;
            window.clearInterval(timer);
            disposers.forEach(dispose => { try { dispose(); } catch { /* already closed */ } });
        };
    }, [analysisTicks]);

    const markets: MarketDigits[] = useMemo(
        () => MARKETS.map(market => ({ symbol: market.symbol, name: market.name, digits: store.current[market.symbol] || [] })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [version]
    );
    const ranking = useMemo(() => rankMarkets(markets, mode, pair, analysisTicks), [markets, mode, pair, analysisTicks]);
    const best = useMemo(() => {
        if (locked) return ranking.find(item => item.symbol === marketSymbol) || null;
        return ranking[0] || null;
    }, [ranking, locked, marketSymbol]);
    const bestDigits = best ? markets.find(market => market.symbol === best.symbol)?.digits || [] : [];
    const stats = useMemo(() => (best ? streakStats(bestDigits, best.trade, viewLast) : null), [best, bestDigits, viewLast]);
    const tradeOptions = candidateTrades(mode, pair);

    const applySettings = useCallback(() => {
        setViewLast(clampInt(viewInput, 10, 1000, 100));
        const next = clampInt(analysisInput, 100, 5000, 1000);
        setAnalysisInput(String(next)); setViewInput(String(clampInt(viewInput, 10, 1000, 100)));
        setAnalysisTicks(next);
    }, [analysisInput, viewInput]);

    return (
        <div className='apex-da'>
            <section className='apex-da__panel'>
                <div className='apex-da__head'>
                    <div>
                        <h1>Digits Analysis</h1>
                        <span className='apex-da__live'>
                            <i className={bestDigits.length ? 'is-on' : ''} />
                            {bestDigits.length ? `Live · ${bestDigits.length} ticks` : 'Connecting…'}
                        </span>
                    </div>
                    <div className='apex-da__controls'>
                        <label>Mode
                            <select value={mode} onChange={event => setMode(event.target.value as AnalysisMode)}>
                                <option value='over_under'>Over / Under</option>
                                <option value='even_odd'>Even / Odd</option>
                            </select>
                        </label>
                        <label>Market
                            <select value={marketSymbol} onChange={event => setMarketSymbol(event.target.value)}>
                                {MARKETS.map(market => <option key={market.symbol} value={market.symbol}>{market.name}</option>)}
                            </select>
                        </label>
                        <button type='button' className={locked ? 'is-active' : ''} onClick={() => setLocked(value => !value)}>
                            {locked ? 'Unlock' : 'Lock'}
                        </button>
                        {mode === 'over_under' && (
                            <label>Pair
                                <select value={pairIndex} onChange={event => setPairIndex(Number(event.target.value))}>
                                    {DIGIT_PAIRS.map((item, index) => <option key={index} value={index}>Over {item.over} / Under {item.under}</option>)}
                                </select>
                            </label>
                        )}
                        <label>Analysis ticks
                            <input value={analysisInput} inputMode='numeric' onChange={event => setAnalysisInput(event.target.value)} />
                        </label>
                        <label>View last
                            <input value={viewInput} inputMode='numeric' onChange={event => setViewInput(event.target.value)} />
                        </label>
                        <button type='button' onClick={applySettings}>Set</button>
                    </div>
                </div>

                {error && <p className='apex-da__error'>{error}</p>}

                <div className='apex-da__body'>
                    <div className='apex-da__ranking'>
                        <h2>Ranking</h2>
                        <table>
                            <thead><tr><th>#</th><th>Market</th><th>Trade</th><th>%</th><th>Latest</th></tr></thead>
                            <tbody>
                                {ranking.length === 0 && <tr><td colSpan={5} className='apex-da__empty'>Waiting for market data…</td></tr>}
                                {ranking.map((item, index) => (
                                    <tr key={item.symbol} className={best?.symbol === item.symbol ? 'is-best' : ''}>
                                        <td>{index + 1}</td>
                                        <td>{item.name}</td>
                                        <td className='is-win'>{item.trade.label}</td>
                                        <td className='is-win'>{item.percent.toFixed(1)}%</td>
                                        <td className={item.latestWins ? 'is-win' : 'is-loss'}>{item.latest}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className='apex-da__best'>
                        <small>{locked ? 'LOCKED MARKET' : 'BEST MARKET'}</small>
                        {best && stats ? (
                            <>
                                <div className='apex-da__best-title'>
                                    <strong>{best.name}</strong>
                                    <span>{best.trade.label} {best.percent.toFixed(1)}%</span>
                                </div>
                                <p>{best.gap.toFixed(1)} pts {tradeOptions.length === 2 ? 'pair gap' : 'gap'}</p>
                                <div className='apex-da__stats'>
                                    <div>
                                        <small>STREAK</small>
                                        <strong className={stats.current.type === 'Loss' ? 'is-loss' : 'is-win'}>
                                            {stats.current.type ? `${stats.current.type} × ${stats.current.length}` : '—'}
                                        </strong>
                                        <span>Wins {stats.wins} · Losses {stats.losses}</span>
                                    </div>
                                    <div>
                                        <small>LATEST</small>
                                        <strong className={stats.latest.win ? 'is-win' : 'is-loss'}>
                                            {stats.latest.digit ?? '—'} · {stats.latest.win ? 'Win' : 'Loss'}
                                        </strong>
                                        <span>Longest win streak × {stats.longestWin}</span>
                                    </div>
                                </div>
                                <small>LAST {stats.cells.length} DIGITS</small>
                                <div className='apex-da__digits'>
                                    {stats.cells.map((cell, index) => (
                                        <b key={index} className={cell.win ? 'is-win' : 'is-loss'}>{cell.digit}</b>
                                    ))}
                                </div>
                            </>
                        ) : <p className='apex-da__empty'>Select a market with data to see details.</p>}
                    </div>
                </div>
                <p className='apex-da__note'>Statistics describe past ticks only and do not predict future results.</p>
            </section>
        </div>
    );
};

export default DigitsAnalysisPage;