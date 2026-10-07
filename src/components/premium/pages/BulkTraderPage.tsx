import { useEffect, useMemo, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

type TradeMode = 'Even/Odd' | 'Over/Under' | 'Matches/Differs';

type DigitFamily = {
    mode: TradeMode;
    sides: [string, string];
    contracts: [string, string];
};

const DIGIT_FAMILIES: DigitFamily[] = [
    { mode: 'Even/Odd', sides: ['Even', 'Odd'], contracts: ['DIGITEVEN', 'DIGITODD'] },
    { mode: 'Over/Under', sides: ['Over', 'Under'], contracts: ['DIGITOVER', 'DIGITUNDER'] },
    { mode: 'Matches/Differs', sides: ['Matches', 'Differs'], contracts: ['DIGITMATCH', 'DIGITDIFF'] },
];

const symbolCode = (item: any) => item?.underlying_symbol || item?.symbol || '';
const symbolName = (item: any) => item?.underlying_symbol_name || item?.display_name || symbolCode(item);
const pipDecimals = (item: any) => {
    const pip = String(item?.pip_size ?? item?.pip ?? '0.01');
    return pip.includes('.') ? pip.split('.')[1].replace(/0+$/, '').length : 0;
};
const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const BulkTraderPage = () => {
    const { authData } = useApiBase();
    const [symbols, setSymbols] = useState<any[]>([]);
    const [availableContracts, setAvailableContracts] = useState<string[]>([]);
    const [symbol, setSymbol] = useState('1HZ100V');
    const [mode, setMode] = useState<TradeMode>('Even/Odd');
    const [side, setSide] = useState('Even');
    const [barrier, setBarrier] = useState('5');
    const [windowSize, setWindowSize] = useState(1000);
    const [duration, setDuration] = useState(1);
    const [stake, setStake] = useState(0.5);
    const [runs, setRuns] = useState(1);
    const [prices, setPrices] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);
    const [results, setResults] = useState<any[]>([]);
    const [error, setError] = useState('');
    const currency = authData?.currency || 'USD';
    const selectedSymbol = symbols.find(item => symbolCode(item) === symbol);
    const decimals = pipDecimals(selectedSymbol);

    useEffect(() => {
        PremiumDerivApiService.activeSymbols().then(items => {
            const list = items
                .filter(item => symbolCode(item))
                .sort((a, b) => symbolName(a).localeCompare(symbolName(b)));
            setSymbols(list);
            if (!list.some(item => symbolCode(item) === symbol) && list[0]) setSymbol(symbolCode(list[0]));
        }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, []);

    useEffect(() => {
        if (!symbol) return;
        setAvailableContracts([]);
        PremiumDerivApiService.contractsFor(symbol).then(data => {
            const available = Array.isArray(data?.available) ? data.available : [];
            const types = [...new Set(available.map((item: any) => String(item.contract_type || '')).filter(Boolean))];
            setAvailableContracts(types);
            const supportedFamily = DIGIT_FAMILIES.find(family => family.contracts.some(type => types.includes(type)));
            if (supportedFamily && !supportedFamily.contracts.includes(contractType)) {
                setMode(supportedFamily.mode);
                setSide(supportedFamily.sides[0]);
            }
        }).catch(() => {
            // Keep all digit families selectable if contract metadata is temporarily unavailable.
            setAvailableContracts([]);
        });
    }, [symbol]);

    useEffect(() => {
        if (!symbol) return;
        let dispose: (() => void) | undefined;
        setError('');
        PremiumDerivApiService.ticksHistory(symbol, windowSize)
            .then(setPrices)
            .catch(err => setError(err instanceof Error ? err.message : String(err)));
        PremiumDerivApiService.subscribeTicks(symbol, tick => {
            const quote = numeric(tick?.quote, NaN);
            if (Number.isFinite(quote)) setPrices(current => [...current.slice(-(windowSize - 1)), quote]);
        }).then(fn => { dispose = fn; }).catch(err => setError(err instanceof Error ? err.message : String(err)));
        return () => dispose?.();
    }, [symbol, windowSize]);

    useEffect(() => {
        const family = DIGIT_FAMILIES.find(item => item.mode === mode) || DIGIT_FAMILIES[0];
        setSide(family.sides[0]);
    }, [mode]);

    const family = DIGIT_FAMILIES.find(item => item.mode === mode) || DIGIT_FAMILIES[0];
    const contractType = family.contracts[family.sides.indexOf(side) === 1 ? 1 : 0];
    const barrierDigit = Math.min(Math.max(Math.trunc(numeric(barrier, 5)), 0), 9);

    const digits = useMemo(() => prices.map(price => Number(price.toFixed(decimals).slice(-1))), [prices, decimals]);
    const counts = useMemo(() => Array.from({ length: 10 }, (_, digit) => digits.filter(value => value === digit).length), [digits]);
    const total = digits.length || 1;
    const max = Math.max(...counts), min = Math.min(...counts);
    const current = prices.at(-1);

    const pairStats = useMemo(() => {
        let leftCount = 0;
        let rightCount = 0;
        let leftLabel = family.sides[0];
        let rightLabel = family.sides[1];

        if (mode === 'Even/Odd') {
            leftCount = digits.filter(value => value % 2 === 0).length;
            rightCount = digits.length - leftCount;
        } else if (mode === 'Over/Under') {
            leftCount = digits.filter(value => value > barrierDigit).length;
            rightCount = digits.filter(value => value < barrierDigit).length;
            leftLabel = `Over ${barrierDigit}`;
            rightLabel = `Under ${barrierDigit}`;
        } else {
            leftCount = digits.filter(value => value === barrierDigit).length;
            rightCount = digits.filter(value => value !== barrierDigit).length;
            leftLabel = `Matches ${barrierDigit}`;
            rightLabel = `Differs ${barrierDigit}`;
        }

        return {
            leftLabel,
            rightLabel,
            leftPercent: (leftCount / total) * 100,
            rightPercent: (rightCount / total) * 100,
        };
    }, [barrierDigit, digits, family.sides, mode, total]);

    const modeSupported = (candidate: DigitFamily) =>
        availableContracts.length === 0 || candidate.contracts.some(type => availableContracts.includes(type));

    const contractSupported = availableContracts.length === 0 || availableContracts.includes(contractType);

    const execute = async () => {
        if (!contractSupported) {
            setError(`${mode} is not available for ${symbolName(selectedSymbol) || symbol}. Choose another market or digit trade type.`);
            return;
        }
        const count = Math.min(Math.max(Math.trunc(runs), 1), 100);
        const perTrade = Math.max(stake, 0.01);
        const estimate = count * perTrade;
        if (!window.confirm(`Place ${count} ${side} digit purchase(s) on ${symbolName(selectedSymbol) || symbol}? Estimated stake: ${estimate.toFixed(2)} ${currency}.`)) return;
        setBusy(true); setError(''); setResults([]);
        const completed: any[] = [];
        try {
            for (let index = 0; index < count; index += 1) {
                try {
                    const proposal = await PremiumDerivApiService.proposal({
                        amount: perTrade,
                        basis: 'stake',
                        contract_type: contractType,
                        currency,
                        underlying_symbol: symbol,
                        duration: Math.max(Math.trunc(duration), 1),
                        duration_unit: 't',
                        barrier: ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(contractType) ? String(barrierDigit) : undefined,
                    });
                    const maxPrice = numeric(proposal.ask_price, perTrade);
                    const buy = await PremiumDerivApiService.buy(proposal.id, maxPrice);
                    completed.push({ index: index + 1, ok: true, contract_id: buy.contract_id, price: buy.buy_price ?? maxPrice });
                } catch (err) {
                    completed.push({ index: index + 1, ok: false, error: err instanceof Error ? err.message : String(err) });
                }
                setResults([...completed]);
            }
        } finally {
            setBusy(false);
        }
    };

    return <div className='prodb-bulk-page'>
        <div className='prodb-form-row'>
            <label>MARKET
                <select value={symbol} onChange={e => setSymbol(e.target.value)}>
                    {symbols.map(item => <option value={symbolCode(item)} key={symbolCode(item)}>{symbolName(item)} · {symbolCode(item)}</option>)}
                </select>
            </label>
            <label>DIGIT TRADE TYPE
                <select value={mode} onChange={e => setMode(e.target.value as TradeMode)}>
                    {DIGIT_FAMILIES.map(item => <option key={item.mode} value={item.mode} disabled={!modeSupported(item)}>{item.mode}</option>)}
                </select>
            </label>
        </div>

        <div className='prodb-form-row prodb-bulk-side-row'>
            <label>CONTRACT
                <select value={side} onChange={e => setSide(e.target.value)}>
                    {family.sides.map((item, index) => <option key={item} disabled={availableContracts.length > 0 && !availableContracts.includes(family.contracts[index])}>{item}</option>)}
                </select>
            </label>
            {mode !== 'Even/Odd' && <label>DIGIT BARRIER
                <select value={String(barrierDigit)} onChange={e => setBarrier(e.target.value)}>
                    {Array.from({ length: 10 }, (_, digit) => <option value={digit} key={digit}>{digit}</option>)}
                </select>
            </label>}
        </div>

        <label className='prodb-full-input'>NUMBER OF ANALYSIS TICKS
            <input type='number' min='10' max='5000' value={windowSize} onChange={e => setWindowSize(Math.min(Math.max(numeric(e.target.value, 1000), 10), 5000))}/>
        </label>

        <div className='prodb-bulk-stats'>
            <div className='prodb-current-tick'><small>CURRENT DERIV TICK</small><strong>{current === undefined ? '—' : current.toFixed(decimals)}</strong></div>
            <button className='prodb-ai-scanner' type='button'>DERIV LIVE</button>
            <div className='prodb-digit-row'>{counts.map((count, digit) => <div key={digit}><span className={count === max ? 'ring-teal' : count === min ? 'ring-red' : ''}>{digit}</span><small>{((count / total) * 100).toFixed(2)}%</small></div>)}</div>
            <div className='prodb-sequence'>{digits.slice(-20).map((digit,index)=><span className={digit % 2 === 0 ? 'even':'odd'} key={`${index}-${digit}`}>{digit}</span>)}</div>
        </div>

        <div className='prodb-form-row prodb-form-row--three'>
            <label>DURATION (TICKS)<input type='number' min='1' value={duration} onChange={e => setDuration(numeric(e.target.value, 1))}/></label>
            <label>STAKE ({currency})<input type='number' min='.01' step='.01' value={stake} onChange={e => setStake(numeric(e.target.value, .5))}/></label>
            <label>NO. OF BULK TRADES<input type='number' min='1' max='100' value={runs} onChange={e => setRuns(numeric(e.target.value, 1))}/></label>
        </div>

        <div className='prodb-trade-pair'>
            <div><span>{pairStats.leftLabel}</span><strong>{pairStats.leftPercent.toFixed(2)}%</strong><small>{mode === 'Over/Under' ? 'equal digits excluded' : 'analysis window'}</small></div>
            <div><span>{pairStats.rightLabel}</span><strong>{pairStats.rightPercent.toFixed(2)}%</strong><small>{mode === 'Over/Under' ? 'equal digits excluded' : 'analysis window'}</small></div>
        </div>

        <button className='prodb-bulk-execute' onClick={execute} disabled={busy || !symbol || !contractSupported}>
            {busy ? `EXECUTING ${results.length}/${Math.min(Math.max(Math.trunc(runs),1),100)}…` : `EXECUTE ${side.toUpperCase()}`}
        </button>
        {!contractSupported && <div className='prodb-live-error'>{side} is not available on the selected market.</div>}
        {error && <div className='prodb-live-error'>{error}</div>}
        {results.length > 0 && <div className='prodb-bulk-results'>{results.slice(-12).map(item => <span className={item.ok ? 'is-ok' : 'is-fail'} key={item.index}>#{item.index} {item.ok ? `✓ ${item.contract_id || ''}` : `✕ ${item.error}`}</span>)}</div>}
    </div>;
};

export default BulkTraderPage;
