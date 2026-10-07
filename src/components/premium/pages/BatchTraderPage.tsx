import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

type BatchContract = {
    label: string;
    contractType: string;
    needsPrediction?: boolean;
};

type MarketOption = {
    symbol: string;
    name: string;
};

type BatchLog = {
    id: string;
    batch: number;
    tick: string;
    requested: number;
    bought: number;
    failed: number;
};

const CONTRACTS: BatchContract[] = [
    { label: 'Digit Over', contractType: 'DIGITOVER', needsPrediction: true },
    { label: 'Digit Under', contractType: 'DIGITUNDER', needsPrediction: true },
    { label: 'Matches', contractType: 'DIGITMATCH', needsPrediction: true },
    { label: 'Differs', contractType: 'DIGITDIFF', needsPrediction: true },
    { label: 'Even', contractType: 'DIGITEVEN' },
    { label: 'Odd', contractType: 'DIGITODD' },
    { label: 'Rise', contractType: 'CALL' },
    { label: 'Fall', contractType: 'PUT' },
];

const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const symbolCode = (item: any) => String(item?.underlying_symbol || item?.symbol || '').trim();
const symbolName = (item: any) => String(item?.underlying_symbol_name || item?.display_name || item?.name || symbolCode(item)).trim();

const BatchTraderPage = () => {
    const { authData, activeLoginid } = useApiBase();
    const currency = authData?.currency || 'USD';
    const [markets, setMarkets] = useState<MarketOption[]>([]);
    const [symbol, setSymbol] = useState('R_10');
    const [contractType, setContractType] = useState('DIGITOVER');
    const [availableContracts, setAvailableContracts] = useState<string[]>([]);
    const [stake, setStake] = useState(0.35);
    const [prediction, setPrediction] = useState(1);
    const [tradesPerBatch, setTradesPerBatch] = useState(5);
    const [armed, setArmed] = useState(false);
    const [currentTick, setCurrentTick] = useState<any>(null);
    const [status, setStatus] = useState('Ready to arm the next-tick batch engine.');
    const [error, setError] = useState('');
    const [batchesFired, setBatchesFired] = useState(0);
    const [contractsBought, setContractsBought] = useState(0);
    const [contractsFailed, setContractsFailed] = useState(0);
    const [contractsSettled, setContractsSettled] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [activeBatches, setActiveBatches] = useState(0);
    const [logs, setLogs] = useState<BatchLog[]>([]);

    const armedRef = useRef(false);
    const settingsRef = useRef({ symbol, contractType, stake, prediction, tradesPerBatch, currency });
    const lastTriggeredTickRef = useRef('');
    const batchSequenceRef = useRef(0);
    const pendingContractsRef = useRef(new Map<number, true>());
    const settlementRefreshRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => () => { mountedRef.current = false; armedRef.current = false; }, []);

    useEffect(() => {
        settingsRef.current = {
            symbol,
            contractType,
            stake: Math.max(0.01, numeric(stake, 0.35)),
            prediction: clamp(Math.trunc(numeric(prediction, 1)), 0, 9),
            tradesPerBatch: clamp(Math.trunc(numeric(tradesPerBatch, 5)), 1, 50),
            currency,
        };
    }, [contractType, currency, prediction, stake, symbol, tradesPerBatch]);

    useEffect(() => {
        PremiumDerivApiService.activeSymbols().then(items => {
            const unique = new Map<string, MarketOption>();
            items.forEach((item: any) => {
                const code = symbolCode(item);
                const name = symbolName(item);
                if (!code) return;
                if (!/^R_\d+$/i.test(code) && !/^1HZ\d+V$/i.test(code) && !/volatility/i.test(name)) return;
                unique.set(code, { symbol: code, name: name || code });
            });
            const list = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
            if (!mountedRef.current) return;
            setMarkets(list);
            const preferred = list.find(item => item.symbol === 'R_10') || list[0];
            if (preferred && !list.some(item => item.symbol === symbol)) setSymbol(preferred.symbol);
        }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, []);

    useEffect(() => {
        if (!symbol) return;
        setAvailableContracts([]);
        PremiumDerivApiService.contractsFor(symbol).then(data => {
            if (!mountedRef.current) return;
            const available = Array.isArray(data?.available) ? data.available : [];
            const types = [...new Set(available.map((item: any) => String(item?.contract_type || '')).filter(Boolean))];
            setAvailableContracts(types);
            if (types.length && !types.includes(contractType)) {
                const fallback = CONTRACTS.find(item => types.includes(item.contractType));
                if (fallback) setContractType(fallback.contractType);
            }
        }).catch(() => setAvailableContracts([]));
    }, [symbol]);

    const refreshSettlements = useCallback(async () => {
        if (settlementRefreshRef.current || pendingContractsRef.current.size === 0) return;
        settlementRefreshRef.current = true;
        try {
            const ids = [...pendingContractsRef.current.keys()];
            const settled = await Promise.allSettled(ids.map(async contractId => {
                const response = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId });
                return { contractId, contract: response?.proposal_open_contract };
            }));

            settled.forEach(item => {
                if (item.status !== 'fulfilled') return;
                const { contractId, contract } = item.value;
                const isClosed = Boolean(contract?.is_sold) || ['won', 'lost', 'sold'].includes(String(contract?.status || '').toLowerCase());
                if (!isClosed || !pendingContractsRef.current.has(contractId)) return;
                pendingContractsRef.current.delete(contractId);
                const profit = numeric(contract?.profit, 0);
                if (mountedRef.current) {
                    setContractsSettled(value => value + 1);
                    setTotalProfit(value => value + profit);
                }
            });
        } finally {
            settlementRefreshRef.current = false;
        }
    }, []);

    const fireBatchForTick = useCallback(async (tick: any) => {
        if (!armedRef.current) return;
        const epoch = String(tick?.epoch ?? '');
        const quote = String(tick?.quote ?? '');
        const tickKey = `${epoch}:${quote}`;
        if (!tickKey || tickKey === lastTriggeredTickRef.current) return;
        lastTriggeredTickRef.current = tickKey;

        const settings = { ...settingsRef.current };
        const selectedContract = CONTRACTS.find(item => item.contractType === settings.contractType) || CONTRACTS[0];
        const batchNumber = ++batchSequenceRef.current;
        const batchSize = settings.tradesPerBatch;
        const totalStake = settings.stake * batchSize;

        if (mountedRef.current) {
            setBatchesFired(value => value + 1);
            setActiveBatches(value => value + 1);
            setStatus(`Batch #${batchNumber} firing ${batchSize} trade${batchSize === 1 ? '' : 's'} from tick ${quote || epoch}…`);
            setError('');
        }

        const purchases = await Promise.allSettled(Array.from({ length: batchSize }, async () => {
            const proposal = await PremiumDerivApiService.proposal({
                amount: settings.stake,
                basis: 'stake',
                contract_type: settings.contractType,
                currency: settings.currency,
                underlying_symbol: settings.symbol,
                duration: 1,
                duration_unit: 't',
                barrier: selectedContract.needsPrediction ? String(settings.prediction) : undefined,
            });
            const maxPrice = numeric(proposal?.ask_price, settings.stake);
            return PremiumDerivApiService.buy(proposal.id, maxPrice);
        }));

        let bought = 0;
        let failed = 0;
        const failures: string[] = [];
        purchases.forEach(item => {
            if (item.status === 'fulfilled') {
                bought += 1;
                const contractId = Math.trunc(numeric(item.value?.contract_id, 0));
                if (contractId > 0) pendingContractsRef.current.set(contractId, true);
            } else {
                failed += 1;
                failures.push(item.reason instanceof Error ? item.reason.message : String(item.reason));
            }
        });

        if (!mountedRef.current) return;
        setContractsBought(value => value + bought);
        setContractsFailed(value => value + failed);
        setActiveBatches(value => Math.max(0, value - 1));
        setLogs(current => [{
            id: `${batchNumber}-${epoch}-${Date.now()}`,
            batch: batchNumber,
            tick: quote || epoch || '—',
            requested: batchSize,
            bought,
            failed,
        }, ...current].slice(0, 12));

        if (failures.length) setError(`${failed}/${batchSize} purchase${failed === 1 ? '' : 's'} failed in batch #${batchNumber}: ${failures[0]}`);
        setStatus(armedRef.current
            ? `ARMED · next tick will fire ${batchSize} trades · ${totalStake.toFixed(2)} ${settings.currency} per batch`
            : 'Stopped · no new batches will be fired.');
    }, []);

    useEffect(() => {
        if (!symbol) return;
        let dispose: (() => void) | undefined;
        PremiumDerivApiService.subscribeTicks(symbol, tick => {
            if (!mountedRef.current) return;
            setCurrentTick(tick);
            void refreshSettlements();
            if (armedRef.current) void fireBatchForTick(tick);
        }).then(fn => { dispose = fn; }).catch(err => {
            if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
        });
        return () => dispose?.();
    }, [fireBatchForTick, refreshSettlements, symbol]);

    const selectedContract = CONTRACTS.find(item => item.contractType === contractType) || CONTRACTS[0];
    const selectedMarket = markets.find(item => item.symbol === symbol);
    const normalizedBatchSize = clamp(Math.trunc(numeric(tradesPerBatch, 5)), 1, 50);
    const normalizedStake = Math.max(0.01, numeric(stake, 0.35));
    const totalBatchStake = normalizedBatchSize * normalizedStake;
    const contractSupported = availableContracts.length === 0 || availableContracts.includes(contractType);

    const arm = () => {
        if (!activeLoginid) {
            setError('Select a Deriv account before starting Batch Trader.');
            return;
        }
        if (!contractSupported) {
            setError(`${selectedContract.label} is not available on ${selectedMarket?.name || symbol}.`);
            return;
        }
        const message = `Arm Batch Trader?\n\n${normalizedBatchSize} ${selectedContract.label} trade(s) will be fired on EVERY new tick until Stop is pressed.\nStake per trade: ${normalizedStake.toFixed(2)} ${currency}\nStake per tick: ${totalBatchStake.toFixed(2)} ${currency}\nMarket: ${selectedMarket?.name || symbol}`;
        if (!window.confirm(message)) return;
        lastTriggeredTickRef.current = `${currentTick?.epoch ?? ''}:${currentTick?.quote ?? ''}`;
        armedRef.current = true;
        setArmed(true);
        setError('');
        setStatus(`ARMED · waiting for next tick · ${normalizedBatchSize} trades / tick · ${totalBatchStake.toFixed(2)} ${currency}`);
    };

    const stop = () => {
        armedRef.current = false;
        setArmed(false);
        setStatus(activeBatches > 0
            ? `Stopped · ${activeBatches} already-triggered batch${activeBatches === 1 ? '' : 'es'} may still finish.`
            : 'Stopped · no new batches will be fired.');
    };

    return <div className='prodb-batch-page'>
        <section className='prodb-batch-card'>
            <div className='prodb-batch-card__heading'>
                <div>
                    <span>BATCH TRADER</span>
                    <h1>Fire a full batch on every new tick</h1>
                    <p>Arm once. Each fresh Deriv tick triggers the selected number of 1-tick contracts until you press Stop.</p>
                </div>
                <div className={`prodb-batch-live ${armed ? 'is-armed' : ''}`}><i />{armed ? 'ARMED' : 'READY'}</div>
            </div>

            <div className='prodb-batch-grid'>
                <label>VOLATILITY
                    <select value={symbol} disabled={armed} onChange={event => setSymbol(event.target.value)}>
                        {markets.map(item => <option value={item.symbol} key={item.symbol}>{item.name}</option>)}
                    </select>
                </label>
                <label>TRADE TYPE
                    <select value={contractType} disabled={armed} onChange={event => setContractType(event.target.value)}>
                        {CONTRACTS.map(item => <option
                            key={item.contractType}
                            value={item.contractType}
                            disabled={availableContracts.length > 0 && !availableContracts.includes(item.contractType)}
                        >{item.label}</option>)}
                    </select>
                </label>
                <label>STAKE ({currency})
                    <input type='number' min='.01' step='.01' value={stake} disabled={armed} onChange={event => setStake(numeric(event.target.value, .35))} />
                </label>
                <label>PREDICTION
                    <input type='number' min='0' max='9' step='1' value={prediction} disabled={armed || !selectedContract.needsPrediction} onChange={event => setPrediction(clamp(Math.trunc(numeric(event.target.value, 1)), 0, 9))} />
                </label>
                <label>TRADES PER BATCH
                    <input type='number' min='1' max='50' step='1' value={tradesPerBatch} disabled={armed} onChange={event => setTradesPerBatch(clamp(Math.trunc(numeric(event.target.value, 5)), 1, 50))} />
                </label>
                <div className='prodb-batch-tick'>
                    <span>CURRENT TICK</span>
                    <strong>{currentTick?.quote ?? '—'}</strong>
                    <small>{selectedMarket?.name || symbol || 'Waiting for market'}</small>
                </div>
            </div>

            <div className={`prodb-batch-summary ${armed ? 'is-armed' : ''}`}>
                <strong>{normalizedBatchSize} trades on every next tick</strong>
                <span>Total stake / tick: {totalBatchStake.toFixed(2)} {currency}</span>
            </div>

            <div className='prodb-batch-actions'>
                <button type='button' className='prodb-batch-fire' disabled={armed || !symbol || !contractSupported} onClick={arm}>Fire Batch</button>
                <button type='button' className='prodb-batch-stop' disabled={!armed} onClick={stop}>Stop</button>
            </div>

            <div className={`prodb-batch-status ${error ? 'is-error' : armed ? 'is-armed' : ''}`}>
                {armed && <i />}
                <span>{error || status}</span>
            </div>
        </section>

        <section className='prodb-batch-profit'>
            <span>TOTAL PROFIT</span>
            <strong className={totalProfit < 0 ? 'is-negative' : ''}>{totalProfit < 0 ? '-' : ''}{currency === 'USD' ? '$' : ''}{Math.abs(totalProfit).toFixed(2)}{currency !== 'USD' ? ` ${currency}` : ''}</strong>
            <small>Settled contracts from this Batch Trader session</small>
        </section>

        <section className='prodb-batch-stats'>
            <div><span>Batches fired</span><strong>{batchesFired}</strong></div>
            <div><span>Contracts bought</span><strong>{contractsBought}</strong></div>
            <div><span>Settled</span><strong>{contractsSettled}</strong></div>
            <div><span>Failed</span><strong>{contractsFailed}</strong></div>
            <div><span>Active batches</span><strong>{activeBatches}</strong></div>
            <div><span>Open tracking</span><strong>{pendingContractsRef.current.size}</strong></div>
        </section>

        {logs.length > 0 && <section className='prodb-batch-log'>
            <header><strong>Recent batches</strong><span>Every row was triggered by a fresh market tick</span></header>
            {logs.map(item => <div key={item.id}>
                <b>#{item.batch}</b>
                <span>Tick {item.tick}</span>
                <span>{item.bought}/{item.requested} bought</span>
                <strong className={item.failed ? 'is-fail' : ''}>{item.failed ? `${item.failed} failed` : 'Complete'}</strong>
            </div>)}
        </section>}
    </div>;
};

export default BatchTraderPage;
