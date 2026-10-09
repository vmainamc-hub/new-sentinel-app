import { useEffect, useMemo, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

const CONTRACT_LABELS: Record<string, string> = {
    CALL: 'Rise', PUT: 'Fall', CALLE: 'Rise Equals', PUTE: 'Fall Equals',
    DIGITEVEN: 'Even', DIGITODD: 'Odd', DIGITOVER: 'Digit Over', DIGITUNDER: 'Digit Under',
    DIGITMATCH: 'Digit Match', DIGITDIFF: 'Digit Diff',
};
// This compact interface collects tick duration and an optional digit barrier. Other contract
// families need extra inputs (for example multiplier, selected tick, or expiry settings) and
// remain available through the native interfaces that collect those fields.
const QUICK_TRADE_TYPES = new Set(['CALL', 'PUT', 'CALLE', 'PUTE', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF']);
type AvailableContract = { contract_type: string; contract_category?: string; sentiment?: string };
const contractLabel = (type: string) => CONTRACT_LABELS[type] || type;

const needsBarrier = (type: string) => ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
const symbolCode = (item: any) => item?.underlying_symbol || item?.symbol || '';
const symbolName = (item: any) => item?.underlying_symbol_name || item?.display_name || symbolCode(item);
const num = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const GlobalQuickTrade = ({ hidden = false }: { hidden?: boolean }) => {
    const { authData } = useApiBase();
    const [open, setOpen] = useState(false);
    const [symbols, setSymbols] = useState<any[]>([]);
    const [symbol, setSymbol] = useState('1HZ100V');
    const [contractType, setContractType] = useState('CALL');
    const [contractOptions, setContractOptions] = useState<AvailableContract[]>([]);
    const [loadingContracts, setLoadingContracts] = useState(false);
    const [stake, setStake] = useState(1);
    const [duration, setDuration] = useState(1);
    const [barrier, setBarrier] = useState('5');
    const [proposal, setProposal] = useState<any>(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const currency = authData?.currency || 'USD';

    useEffect(() => {
        if (!open || symbols.length) return;
        setError('');
        PremiumDerivApiService.activeSymbols()
            .then(items => {
                const usable = items.filter(item => symbolCode(item));
                setSymbols(usable);
                if (!usable.some(item => symbolCode(item) === symbol) && usable[0]) setSymbol(symbolCode(usable[0]));
            })
            .catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, [open, symbol, symbols.length]);

    // Deriv exposes different contract types for different markets. Never offer a contract
    // unless contracts_for confirms it is available for the currently selected symbol.
    useEffect(() => {
        if (!open || !symbol) return;
        let active = true;
        setLoadingContracts(true);
        setContractOptions([]);
        setProposal(null);
        setError('');
        PremiumDerivApiService.contractsFor(symbol)
            .then(response => {
                if (!active) return;
                const available = Array.isArray(response?.available) ? response.available : [];
                const unique = new Map<string, AvailableContract>();
                available.forEach((item: any) => {
                    const raw = item?.contract_type;
                    (Array.isArray(raw) ? raw : [raw]).forEach((type: unknown) => {
                        if (typeof type !== 'string' || !type || !QUICK_TRADE_TYPES.has(type)) return;
                        if (!unique.has(type)) unique.set(type, { contract_type: type, contract_category: item.contract_category, sentiment: item.sentiment });
                    });
                });
                const options = [...unique.values()].sort((a, b) => contractLabel(a.contract_type).localeCompare(contractLabel(b.contract_type)));
                setContractOptions(options);
                if (options.length) setContractType(current => options.some(option => option.contract_type === current) ? current : options[0].contract_type);
                else setError(`Deriv reports no available contracts for ${symbol}. Choose another market or check trading permissions.`);
            })
            .catch(err => {
                if (active) {
                    setContractOptions([]);
                    setError(err instanceof Error ? err.message : String(err));
                }
            })
            .finally(() => { if (active) setLoadingContracts(false); });
        return () => { active = false; };
    }, [open, symbol]);

    useEffect(() => { setProposal(null); setMessage(''); }, [symbol, contractType, stake, duration, barrier]);

    const selectedName = useMemo(() => symbolName(symbols.find(item => symbolCode(item) === symbol)) || symbol, [symbol, symbols]);
    const selectedContractIsAvailable = contractOptions.some(item => item.contract_type === contractType);

    const getPrice = async () => {
        if (!symbol || loadingContracts || !selectedContractIsAvailable) {
            setError('Wait for Deriv to confirm the contract types available for this market.');
            return;
        }
        setBusy('proposal'); setError(''); setMessage('');
        try {
            const quote = await PremiumDerivApiService.proposal({
                amount: Math.max(stake, 0.01),
                basis: 'stake',
                contract_type: contractType,
                currency,
                underlying_symbol: symbol,
                duration: Math.max(1, Math.trunc(duration)),
                duration_unit: 't',
                barrier: needsBarrier(contractType) ? barrier : undefined,
            });
            setProposal(quote);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy('');
        }
    };

    const buy = async () => {
        if (!proposal?.id) return;
        setBusy('buy'); setError(''); setMessage('');
        try {
            const maximum = num(proposal.ask_price, stake);
            const purchase = await PremiumDerivApiService.buy(proposal.id, maximum);
            setMessage(`Contract ${purchase.contract_id || ''} purchased. It will be tracked in the Run Panel.`);
            setProposal(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy('');
        }
    };

    if (hidden) return null;

    return <div className={`prodb-global-trade ${open ? 'is-open' : ''}`}>
        {open && <div className='prodb-global-trade__panel'>
            <div className='prodb-global-trade__head'><div><small>AUTHENTICATED DERIV OPTIONS</small><strong>Quick Trade</strong></div><button type='button' onClick={() => setOpen(false)} aria-label='Close quick trade'>×</button></div>
            <p>Available from every section. Purchases use the selected Deriv account and are mirrored into the native Run Panel.</p>
            <div className='prodb-global-trade__fields'>
                <label>Market<select value={symbol} onChange={event => setSymbol(event.target.value)}>{symbols.map(item => <option key={symbolCode(item)} value={symbolCode(item)}>{symbolName(item)}</option>)}</select></label>
                <label>Contract<select value={contractType} onChange={event => setContractType(event.target.value)} disabled={loadingContracts || !contractOptions.length}>{contractOptions.map(item => <option key={item.contract_type} value={item.contract_type}>{contractLabel(item.contract_type)}</option>)}</select></label>
                <label>Stake ({currency})<input type='number' min='.01' step='.01' value={stake} onChange={event => setStake(Math.max(.01, num(event.target.value, 1)))} /></label>
                <label>Ticks<input type='number' min='1' value={duration} onChange={event => setDuration(Math.max(1, num(event.target.value, 1)))} /></label>
                {needsBarrier(contractType) && <label>Digit barrier<input inputMode='numeric' value={barrier} onChange={event => setBarrier(event.target.value.replace(/\D/g, '').slice(0, 1))} /></label>}
            </div>
            <div className='prodb-global-trade__market'><span>{selectedName}</span>{proposal?.id && <b>Ask {num(proposal.ask_price, stake).toFixed(2)} {currency}</b>}</div>
            <div className='prodb-global-trade__actions'><button type='button' onClick={getPrice} disabled={Boolean(busy) || loadingContracts || !selectedContractIsAvailable}>{busy === 'proposal' ? 'Pricing…' : loadingContracts ? 'Loading contracts…' : 'Get live price'}</button>{proposal?.id && <button type='button' className='is-buy' onClick={buy} disabled={Boolean(busy)}>{busy === 'buy' ? 'Buying…' : 'Buy contract'}</button>}</div>
            {error && <div className='prodb-live-error'>{error}</div>}
            {message && <div className='prodb-live-success'>{message}</div>}
        </div>}
        <button type='button' className='prodb-global-trade__launcher' onClick={() => setOpen(value => !value)} aria-expanded={open}>TRADE</button>
    </div>;
};

export default GlobalQuickTrade;
