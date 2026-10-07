import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { DerivWSAccountsService, type DerivAccount } from '@/services/derivws-accounts.service';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

const COMMON_TYPES = [
    ['CALL', 'Rise'], ['PUT', 'Fall'], ['DIGITEVEN', 'Even'], ['DIGITODD', 'Odd'],
    ['DIGITOVER', 'Digit Over'], ['DIGITUNDER', 'Digit Under'], ['DIGITMATCH', 'Digit Match'], ['DIGITDIFF', 'Digit Diff'],
];

const number = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const getSymbolCode = (item: any) => item?.underlying_symbol || item?.symbol || '';
const getSymbolName = (item: any) => item?.underlying_symbol_name || item?.display_name || getSymbolCode(item);
const getPipDecimals = (item: any) => {
    const pip = String(item?.pip_size ?? item?.pip ?? '0.01');
    const decimals = pip.includes('.') ? pip.split('.')[1].replace(/0+$/, '').length : 0;
    return Math.max(decimals, 0);
};
const needsBarrier = (type: string) => ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);

const useMarketSymbols = () => {
    const [symbols, setSymbols] = useState<any[]>([]);
    const [symbol, setSymbol] = useState('1HZ100V');
    const [error, setError] = useState('');

    useEffect(() => {
        let mounted = true;
        PremiumDerivApiService.activeSymbols().then(items => {
            if (!mounted) return;
            const usable = items.filter(item => getSymbolCode(item));
            setSymbols(usable);
            if (!usable.some(item => getSymbolCode(item) === symbol) && usable[0]) setSymbol(getSymbolCode(usable[0]));
        }).catch(err => mounted && setError(err instanceof Error ? err.message : String(err)));
        return () => { mounted = false; };
    }, []);

    return { symbols, symbol, setSymbol, error, selectedSymbol: symbols.find(item => getSymbolCode(item) === symbol) };
};

const MarketSelect = ({ symbols, symbol, onChange }: { symbols: any[]; symbol: string; onChange: (value: string) => void }) => (
    <select value={symbol} onChange={event => onChange(event.target.value)}>
        {symbols.map(item => <option key={getSymbolCode(item)} value={getSymbolCode(item)}>{getSymbolName(item)}</option>)}
    </select>
);

const PageHeader = ({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) => (
    <header className='prodb-live-header'><span>{eyebrow}</span><div><h1>{title}</h1><p>{subtitle}</p></div></header>
);

export const ManualTraderPage = () => {
    const { authData } = useApiBase();
    const { symbols, symbol, setSymbol, error: marketError } = useMarketSymbols();
    const [contractTypes, setContractTypes] = useState<string[]>(COMMON_TYPES.map(([type]) => type));
    const [contractType, setContractType] = useState('CALL');
    const [stake, setStake] = useState(1);
    const [duration, setDuration] = useState(1);
    const [durationUnit, setDurationUnit] = useState<'t' | 's' | 'm' | 'h' | 'd'>('t');
    const [barrier, setBarrier] = useState('5');
    const [tick, setTick] = useState<number | null>(null);
    const [proposal, setProposal] = useState<any>(null);
    const [portfolio, setPortfolio] = useState<any[]>([]);
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const currency = authData?.currency || 'USD';

    const refreshPortfolio = useCallback(() => {
        PremiumDerivApiService.portfolio().then(data => setPortfolio(Array.isArray(data.contracts) ? data.contracts : [])).catch(() => setPortfolio([]));
    }, []);

    useEffect(() => { refreshPortfolio(); }, [refreshPortfolio]);

    useEffect(() => {
        if (!symbol) return;
        setProposal(null);
        PremiumDerivApiService.contractsFor(symbol).then(data => {
            const available = Array.isArray(data.available) ? data.available : [];
            const types = [...new Set(available.map((item: any) => item.contract_type).filter(Boolean))] as string[];
            if (types.length) {
                setContractTypes(types);
                if (!types.includes(contractType)) setContractType(types[0]);
            }
        }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, [symbol]);

    useEffect(() => {
        if (!symbol) return;
        let dispose: (() => void) | undefined;
        PremiumDerivApiService.subscribeTicks(symbol, incoming => setTick(number(incoming?.quote, null as any))).then(fn => { dispose = fn; }).catch(err => setError(err instanceof Error ? err.message : String(err)));
        return () => dispose?.();
    }, [symbol]);

    const requestProposal = async () => {
        setBusy('proposal'); setError(''); setMessage('');
        try {
            const quote = await PremiumDerivApiService.proposal({
                amount: Math.max(stake, 0.01), basis: 'stake', contract_type: contractType, currency,
                underlying_symbol: symbol, duration: Math.max(Math.trunc(duration), 1), duration_unit: durationUnit,
                barrier: needsBarrier(contractType) ? barrier : undefined,
            });
            setProposal(quote);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(''); }
    };

    const buy = async () => {
        if (!proposal?.id) return;
        const maximum = number(proposal.ask_price, stake);
        if (!window.confirm(`Buy ${contractType} on ${symbol} for up to ${maximum.toFixed(2)} ${currency}?`)) return;
        setBusy('buy'); setError('');
        try {
            const purchase = await PremiumDerivApiService.buy(proposal.id, maximum);
            setMessage(`Purchased contract ${purchase.contract_id || ''}.`);
            setProposal(null);
            refreshPortfolio();
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(''); }
    };

    const sell = async (contractId: number) => {
        setBusy(`sell:${contractId}`); setError('');
        try { await PremiumDerivApiService.sell(contractId, 0); refreshPortfolio(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(''); }
    };

    return <div className='prodb-live-page'>
        <PageHeader eyebrow='DERIV OPTIONS · AUTHENTICATED WS' title='Manual Trader' subtitle='Live symbols, proposals, purchases and open positions use the current Deriv account session.' />
        <div className='prodb-live-grid prodb-live-grid--trade'>
            <section className='prodb-live-card'>
                <div className='prodb-live-card__title'><h2>Trade ticket</h2><span className='prodb-live-badge is-live'>LIVE {tick === null ? '—' : tick}</span></div>
                <div className='prodb-fields'>
                    <label>Market<MarketSelect symbols={symbols} symbol={symbol} onChange={setSymbol} /></label>
                    <label>Contract type<select value={contractType} onChange={e => { setContractType(e.target.value); setProposal(null); }}>{contractTypes.map(type => <option key={type} value={type}>{COMMON_TYPES.find(([code]) => code === type)?.[1] || type}</option>)}</select></label>
                    <label>Stake ({currency})<input type='number' min='0.01' step='0.01' value={stake} onChange={e => setStake(number(e.target.value, 1))} /></label>
                    <label>Duration<input type='number' min='1' value={duration} onChange={e => setDuration(number(e.target.value, 1))} /></label>
                    <label>Unit<select value={durationUnit} onChange={e => setDurationUnit(e.target.value as any)}><option value='t'>Ticks</option><option value='s'>Seconds</option><option value='m'>Minutes</option><option value='h'>Hours</option><option value='d'>Days</option></select></label>
                    {needsBarrier(contractType) && <label>Digit barrier<input inputMode='numeric' value={barrier} onChange={e => setBarrier(e.target.value.replace(/\D/g, '').slice(0, 1))} /></label>}
                </div>
                <div className='prodb-live-actions'><button onClick={requestProposal} disabled={Boolean(busy)}>{busy === 'proposal' ? 'Pricing…' : 'Get live price'}</button>{proposal?.id && <button className='is-primary' onClick={buy} disabled={Boolean(busy)}>Buy @ {number(proposal.ask_price, stake).toFixed(2)} {currency}</button>}</div>
                {proposal?.id && <div className='prodb-proposal'><span>Proposal ID</span><code>{proposal.id}</code><b>Payout {number(proposal.payout).toFixed(2)} {currency}</b></div>}
                {(error || marketError) && <div className='prodb-live-error'>{error || marketError}</div>}{message && <div className='prodb-live-success'>{message}</div>}
            </section>
            <section className='prodb-live-card'>
                <div className='prodb-live-card__title'><h2>Open contracts</h2><button className='is-ghost' onClick={refreshPortfolio}>Refresh</button></div>
                <div className='prodb-position-list'>{portfolio.length === 0 ? <div className='prodb-live-empty'>No open contracts on this account.</div> : portfolio.map((item: any) => <article key={item.contract_id}><div><strong>{item.contract_type}</strong><span>{item.underlying_symbol || item.symbol || 'Market'}</span></div><div><b>{number(item.buy_price).toFixed(2)} {item.currency || currency}</b><button disabled={Boolean(busy)} onClick={() => sell(Number(item.contract_id))}>{busy === `sell:${item.contract_id}` ? 'Selling…' : 'Sell at market'}</button></div></article>)}</div>
            </section>
        </div>
    </div>;
};

export const ChartsPage = () => {
    const { symbols, symbol, setSymbol, selectedSymbol, error: marketError } = useMarketSymbols();
    const [prices, setPrices] = useState<number[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!symbol) return;
        let dispose: (() => void) | undefined;
        setLoading(true); setError('');
        PremiumDerivApiService.ticksHistory(symbol, 300).then(history => setPrices(history)).catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setLoading(false));
        PremiumDerivApiService.subscribeTicks(symbol, tick => setPrices(current => [...current.slice(-299), number(tick?.quote)])).then(fn => { dispose = fn; }).catch(err => setError(err instanceof Error ? err.message : String(err)));
        return () => dispose?.();
    }, [symbol]);

    const path = useMemo(() => {
        const data = prices.slice(-120);
        if (data.length < 2) return '';
        const min = Math.min(...data), max = Math.max(...data), spread = max - min || 1;
        return data.map((value, index) => `${index ? 'L' : 'M'} ${(index / (data.length - 1)) * 1000} ${280 - ((value - min) / spread) * 250}`).join(' ');
    }, [prices]);
    const last = prices.at(-1);
    const decimals = getPipDecimals(selectedSymbol);

    return <div className='prodb-live-page'>
        <PageHeader eyebrow='DERIV MARKET DATA · TICKS + HISTORY' title='Charts' subtitle='Historical ticks and the live tick stream come directly from the Deriv WebSocket API.' />
        <section className='prodb-live-card prodb-chart-card'>
            <div className='prodb-chart-toolbar'><label>Market<MarketSelect symbols={symbols} symbol={symbol} onChange={setSymbol} /></label><div><small>LIVE QUOTE</small><strong>{last === undefined ? '—' : last.toFixed(decimals)}</strong></div><span className='prodb-live-badge is-live'>{loading ? 'LOADING' : 'STREAMING'}</span></div>
            <div className='prodb-chart-canvas'>{path ? <svg viewBox='0 0 1000 300' preserveAspectRatio='none' aria-label='Live Deriv tick chart'><path d={path} fill='none' stroke='currentColor' strokeWidth='3' vectorEffect='non-scaling-stroke' /></svg> : <div className='prodb-live-empty'>Waiting for market data…</div>}</div>
            <div className='prodb-chart-stats'><span>Points <b>{prices.length}</b></span><span>Low <b>{prices.length ? Math.min(...prices).toFixed(decimals) : '—'}</b></span><span>High <b>{prices.length ? Math.max(...prices).toFixed(decimals) : '—'}</b></span></div>
            {(error || marketError) && <div className='prodb-live-error'>{error || marketError}</div>}
        </section>
    </div>;
};

export const AnalysisToolsPage = () => {
    const { symbols, symbol, setSymbol, selectedSymbol, error: marketError } = useMarketSymbols();
    const [windowSize, setWindowSize] = useState(1000);
    const [prices, setPrices] = useState<number[]>([]);
    const [error, setError] = useState('');
    const decimals = getPipDecimals(selectedSymbol);

    const refresh = useCallback(() => {
        if (!symbol) return;
        setError('');
        PremiumDerivApiService.ticksHistory(symbol, windowSize).then(setPrices).catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, [symbol, windowSize]);

    useEffect(() => { refresh(); }, [refresh]);
    useEffect(() => {
        if (!symbol) return;
        let dispose: (() => void) | undefined;
        PremiumDerivApiService.subscribeTicks(symbol, tick => setPrices(current => [...current.slice(-(windowSize - 1)), number(tick?.quote)])).then(fn => { dispose = fn; }).catch(() => undefined);
        return () => dispose?.();
    }, [symbol, windowSize]);

    const digits = useMemo(() => prices.map(price => Number(price.toFixed(decimals).slice(-1))), [prices, decimals]);
    const counts = useMemo(() => Array.from({ length: 10 }, (_, digit) => digits.filter(value => value === digit).length), [digits]);
    const total = digits.length || 1;
    const even = digits.filter(value => value % 2 === 0).length;
    const odd = digits.length - even;
    const highest = Math.max(...counts), lowest = Math.min(...counts);

    return <div className='prodb-live-page'>
        <PageHeader eyebrow='DERIV MARKET DATA · STATISTICAL VIEW' title='Analysis Tools' subtitle='Digit frequencies and parity are calculated from Deriv tick history and kept live with tick subscriptions.' />
        <section className='prodb-live-card'>
            <div className='prodb-analysis-controls'><label>Market<MarketSelect symbols={symbols} symbol={symbol} onChange={setSymbol} /></label><label>Tick window<input type='number' min='10' max='5000' value={windowSize} onChange={e => setWindowSize(Math.min(Math.max(number(e.target.value, 1000), 10), 5000))} /></label><button onClick={refresh}>Refresh history</button></div>
            <div className='prodb-analysis-tick'><small>LATEST DERIV TICK</small><strong>{prices.at(-1)?.toFixed(decimals) ?? '—'}</strong><span>{digits.at(-1) ?? '—'}</span></div>
            <div className='prodb-analysis-digits'>{counts.map((count, digit) => <div key={digit}><span className={count === highest ? 'is-high' : count === lowest ? 'is-low' : ''}>{digit}</span><b>{((count / total) * 100).toFixed(2)}%</b><small>{count}/{digits.length}</small></div>)}</div>
            <div className='prodb-analysis-bars'><div style={{ flex: even || 1 }}><span>Even</span><strong>{((even / total) * 100).toFixed(2)}%</strong></div><div style={{ flex: odd || 1 }}><span>Odd</span><strong>{((odd / total) * 100).toFixed(2)}%</strong></div></div>
            <div className='prodb-analysis-sequence'>{digits.slice(-30).map((digit, index) => <span className={digit % 2 === 0 ? 'is-even' : 'is-odd'} key={`${index}-${digit}`}>{digit}</span>)}</div>
            {(error || marketError) && <div className='prodb-live-error'>{error || marketError}</div>}
        </section>
    </div>;
};

export const CopyTradingPage = () => {
    const { authData } = useApiBase();
    const { symbols, symbol, setSymbol, error: marketError } = useMarketSymbols();
    const [accounts, setAccounts] = useState<DerivAccount[]>(() => DerivWSAccountsService.getStoredAccounts() || []);
    const [selected, setSelected] = useState<string[]>([]);
    const [contractType, setContractType] = useState('CALL');
    const [stake, setStake] = useState(1);
    const [duration, setDuration] = useState(1);
    const [durationUnit, setDurationUnit] = useState<'t' | 's' | 'm' | 'h' | 'd'>('t');
    const [barrier, setBarrier] = useState('5');
    const [results, setResults] = useState<any[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => { PremiumDerivApiService.refreshAccounts().then(items => { setAccounts(items); setSelected(items.map(item => item.account_id)); }).catch(err => setError(err instanceof Error ? err.message : String(err))); }, []);

    const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    const execute = async () => {
        const chosen = accounts.filter(account => selected.includes(account.account_id));
        if (!chosen.length) return setError('Select at least one Deriv Options account.');
        const currencies = [...new Set(chosen.map(account => account.currency || 'USD'))];
        if (currencies.length !== 1) return setError('Selected accounts must use the same Options currency for one copied contract.');
        const totalStake = stake * chosen.length;
        if (!window.confirm(`Copy this ${contractType} purchase to ${chosen.length} account(s)? Approximate combined stake: ${totalStake.toFixed(2)} ${currencies[0]}.`)) return;
        setBusy(true); setError(''); setResults([]);
        try {
            const response = await PremiumDerivApiService.copyTradeAcrossOwnAccounts(selected, {
                amount: Math.max(stake, 0.01), basis: 'stake', contract_type: contractType,
                currency: currencies[0] || authData?.currency || 'USD', underlying_symbol: symbol,
                duration: Math.max(Math.trunc(duration), 1), duration_unit: durationUnit,
                barrier: needsBarrier(contractType) ? barrier : undefined,
            });
            setResults(response);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(false); }
    };

    return <div className='prodb-live-page'>
        <PageHeader eyebrow='DERIV OPTIONS · MULTI-ACCOUNT OTP' title='Copy Trading' subtitle='Copy one purchase across your own OAuth-authorised Options accounts. Each selected account receives its own OTP-authenticated WebSocket session.' />
        <div className='prodb-live-grid prodb-live-grid--copy'>
            <section className='prodb-live-card'>
                <h2>Your Deriv Options accounts</h2>
                <div className='prodb-copy-accounts'>{accounts.map(account => <label key={account.account_id} className={selected.includes(account.account_id) ? 'is-selected' : ''}><input type='checkbox' checked={selected.includes(account.account_id)} onChange={() => toggle(account.account_id)} /><span><strong>{account.account_type === 'demo' ? 'Demo' : 'Real'} · {account.currency}</strong><small>{account.account_id}</small></span><b>{number(account.balance).toFixed(2)} {account.currency}</b></label>)}</div>
                <p className='prodb-api-note'>This OAuth mode copies only across accounts owned by the signed-in user. Deriv&apos;s third-party bulk-purchase endpoint uses per-account trade-scoped Personal Access Tokens instead of the user&apos;s OAuth bearer token.</p>
            </section>
            <section className='prodb-live-card'>
                <h2>Copy trade ticket</h2>
                <div className='prodb-fields'><label>Market<MarketSelect symbols={symbols} symbol={symbol} onChange={setSymbol} /></label><label>Contract<select value={contractType} onChange={e => setContractType(e.target.value)}>{COMMON_TYPES.map(([type, label]) => <option value={type} key={type}>{label}</option>)}</select></label><label>Stake per account<input type='number' min='.01' step='.01' value={stake} onChange={e => setStake(number(e.target.value, 1))} /></label><label>Duration<input type='number' min='1' value={duration} onChange={e => setDuration(number(e.target.value, 1))} /></label><label>Unit<select value={durationUnit} onChange={e => setDurationUnit(e.target.value as any)}><option value='t'>Ticks</option><option value='s'>Seconds</option><option value='m'>Minutes</option><option value='h'>Hours</option><option value='d'>Days</option></select></label>{needsBarrier(contractType) && <label>Digit barrier<input value={barrier} onChange={e => setBarrier(e.target.value.replace(/\D/g, '').slice(0, 1))} /></label>}</div>
                <button className='prodb-copy-execute' onClick={execute} disabled={busy}>{busy ? 'Executing on selected accounts…' : `Copy to ${selected.length} account${selected.length === 1 ? '' : 's'}`}</button>
                {results.length > 0 && <div className='prodb-copy-results'>{results.map(item => <div className={item.ok ? 'is-ok' : 'is-fail'} key={item.account_id}><strong>{item.account_id}</strong><span>{item.ok ? `Contract ${item.result?.contract_id || 'purchased'}` : item.error}</span></div>)}</div>}
                {(error || marketError) && <div className='prodb-live-error'>{error || marketError}</div>}
            </section>
        </div>
    </div>;
};
