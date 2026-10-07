import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

type SpeedContract = {
    label: string;
    contractType: string;
    needsPrediction?: boolean;
};

type SpeedSettings = {
    symbol: string;
    contractType: string;
    basis: 'stake' | 'payout';
    amount: number;
    prediction: number;
    duration: number;
    durationUnit: 't' | 's' | 'm';
    maxTrades: number;
};

type MarketOption = { symbol: string; name: string };
type SpeedLog = { id: string; number: number; tick: string; ok: boolean; contractId?: number; error?: string };

const SETTINGS_KEY = 'prodb.speed-bot.settings.v1';
const CONTRACTS: SpeedContract[] = [
    { label: 'Digit Over', contractType: 'DIGITOVER', needsPrediction: true },
    { label: 'Digit Under', contractType: 'DIGITUNDER', needsPrediction: true },
    { label: 'Matches', contractType: 'DIGITMATCH', needsPrediction: true },
    { label: 'Differs', contractType: 'DIGITDIFF', needsPrediction: true },
    { label: 'Even', contractType: 'DIGITEVEN' },
    { label: 'Odd', contractType: 'DIGITODD' },
    { label: 'Rise', contractType: 'CALL' },
    { label: 'Fall', contractType: 'PUT' },
];

const DEFAULT_SETTINGS: SpeedSettings = {
    symbol: '1HZ100V',
    contractType: 'DIGITOVER',
    basis: 'stake',
    amount: 0.35,
    prediction: 1,
    duration: 1,
    durationUnit: 't',
    maxTrades: 0,
};

const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const symbolCode = (item: any) => String(item?.underlying_symbol || item?.symbol || '').trim();
const symbolName = (item: any) => String(item?.underlying_symbol_name || item?.display_name || item?.name || symbolCode(item)).trim();

const readSettings = (): SpeedSettings => {
    try {
        const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? { ...DEFAULT_SETTINGS, ...parsed } : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
};

const SpeedBotPage = () => {
    const { authData, activeLoginid } = useApiBase();
    const currency = authData?.currency || 'USD';
    const [settings, setSettings] = useState<SpeedSettings>(() => readSettings());
    const [markets, setMarkets] = useState<MarketOption[]>([]);
    const [availableContracts, setAvailableContracts] = useState<string[]>([]);
    const [running, setRunning] = useState(false);
    const [currentTick, setCurrentTick] = useState<any>(null);
    const [status, setStatus] = useState('Ready. Start Speed Bot to buy one contract on every fresh tick.');
    const [error, setError] = useState('');
    const [tradesTriggered, setTradesTriggered] = useState(0);
    const [contractsBought, setContractsBought] = useState(0);
    const [contractsFailed, setContractsFailed] = useState(0);
    const [contractsSettled, setContractsSettled] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [inFlight, setInFlight] = useState(0);
    const [logs, setLogs] = useState<SpeedLog[]>([]);

    const mountedRef = useRef(true);
    const runningRef = useRef(false);
    const settingsRef = useRef(settings);
    const lastTickRef = useRef('');
    const sequenceRef = useRef(0);
    const tradesTriggeredRef = useRef(0);
    const settlementBusyRef = useRef(false);
    const pendingContractsRef = useRef(new Map<number, true>());

    useEffect(() => () => {
        mountedRef.current = false;
        runningRef.current = false;
    }, []);

    useEffect(() => {
        settingsRef.current = settings;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* preferences only */ }
    }, [settings]);

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
            if (list.length && !list.some(item => item.symbol === settingsRef.current.symbol)) {
                setSettings(current => ({ ...current, symbol: list[0].symbol }));
            }
        }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, []);

    useEffect(() => {
        if (!settings.symbol) return;
        setAvailableContracts([]);
        PremiumDerivApiService.contractsFor(settings.symbol).then(data => {
            if (!mountedRef.current) return;
            const available = Array.isArray(data?.available) ? data.available : [];
            const types = [...new Set(available.map((item: any) => String(item?.contract_type || '')).filter(Boolean))];
            setAvailableContracts(types);
            if (types.length && !types.includes(settingsRef.current.contractType)) {
                const fallback = CONTRACTS.find(item => types.includes(item.contractType));
                if (fallback) setSettings(current => ({ ...current, contractType: fallback.contractType }));
            }
        }).catch(() => setAvailableContracts([]));
    }, [settings.symbol]);

    useEffect(() => {
        runningRef.current = false;
        setRunning(false);
        setStatus('Account ready. Press Start when you want Speed Bot to trade every tick.');
    }, [activeLoginid]);

    const stop = useCallback((reason = 'Stopped · no new contracts will be triggered.') => {
        runningRef.current = false;
        if (mountedRef.current) {
            setRunning(false);
            setStatus(reason);
        }
    }, []);

    const refreshSettlements = useCallback(async () => {
        if (settlementBusyRef.current || pendingContractsRef.current.size === 0) return;
        settlementBusyRef.current = true;
        try {
            const ids = [...pendingContractsRef.current.keys()];
            const settled = await Promise.allSettled(ids.map(async contractId => {
                const response = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId });
                return { contractId, contract: response?.proposal_open_contract };
            }));

            settled.forEach(item => {
                if (item.status !== 'fulfilled') return;
                const { contractId, contract } = item.value;
                const closed = Boolean(contract?.is_sold) || ['won', 'lost', 'sold'].includes(String(contract?.status || '').toLowerCase());
                if (!closed || !pendingContractsRef.current.has(contractId)) return;
                pendingContractsRef.current.delete(contractId);
                if (mountedRef.current) {
                    setContractsSettled(value => value + 1);
                    setTotalProfit(value => value + numeric(contract?.profit, 0));
                }
            });
        } finally {
            settlementBusyRef.current = false;
        }
    }, []);

    const executeTick = useCallback(async (tick: any) => {
        if (!runningRef.current) return;
        const tickKey = `${tick?.epoch ?? ''}:${tick?.quote ?? ''}`;
        if (!tickKey || tickKey === lastTickRef.current) return;
        lastTickRef.current = tickKey;

        const config = { ...settingsRef.current };
        if (config.maxTrades > 0 && tradesTriggeredRef.current >= config.maxTrades) {
            stop(`Maximum of ${config.maxTrades} trades reached. Speed Bot stopped.`);
            return;
        }

        const contract = CONTRACTS.find(item => item.contractType === config.contractType) || CONTRACTS[0];
        const tradeNumber = ++sequenceRef.current;
        tradesTriggeredRef.current += 1;

        if (mountedRef.current) {
            setTradesTriggered(tradesTriggeredRef.current);
            setInFlight(value => value + 1);
            setStatus(`Tick ${tick?.quote ?? tick?.epoch ?? '—'} · placing ${contract.label} #${tradeNumber}…`);
            setError('');
        }

        try {
            const proposal = await PremiumDerivApiService.proposal({
                amount: Math.max(0.01, numeric(config.amount, 0.35)),
                basis: config.basis,
                contract_type: config.contractType,
                currency,
                underlying_symbol: config.symbol,
                duration: Math.max(1, Math.trunc(numeric(config.duration, 1))),
                duration_unit: config.durationUnit,
                barrier: contract.needsPrediction ? String(clamp(Math.trunc(numeric(config.prediction, 1)), 0, 9)) : undefined,
            });
            const maxPrice = numeric(proposal?.ask_price, config.amount);
            const purchase = await PremiumDerivApiService.buy(proposal.id, maxPrice);
            const contractId = Math.trunc(numeric(purchase?.contract_id, 0));
            if (contractId > 0) pendingContractsRef.current.set(contractId, true);

            if (mountedRef.current) {
                setContractsBought(value => value + 1);
                setLogs(current => [{ id: `${tradeNumber}-${Date.now()}`, number: tradeNumber, tick: String(tick?.quote ?? '—'), ok: true, contractId }, ...current].slice(0, 15));
                setStatus(runningRef.current ? 'RUNNING · the next fresh tick will trigger another contract.' : 'Stopped.');
            }
        } catch (tradeError) {
            const message = tradeError instanceof Error ? tradeError.message : String(tradeError);
            if (mountedRef.current) {
                setContractsFailed(value => value + 1);
                setLogs(current => [{ id: `${tradeNumber}-${Date.now()}`, number: tradeNumber, tick: String(tick?.quote ?? '—'), ok: false, error: message }, ...current].slice(0, 15));
                setError(message);
            }
        } finally {
            if (mountedRef.current) setInFlight(value => Math.max(0, value - 1));
        }
    }, [currency, stop]);

    useEffect(() => {
        if (!settings.symbol) return;
        let dispose: (() => void) | undefined;
        PremiumDerivApiService.subscribeTicks(settings.symbol, tick => {
            if (!mountedRef.current) return;
            setCurrentTick(tick);
            void refreshSettlements();
            if (runningRef.current) void executeTick(tick);
        }).then(fn => { dispose = fn; }).catch(err => {
            if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
        });
        return () => dispose?.();
    }, [executeTick, refreshSettlements, settings.symbol]);

    const selectedContract = useMemo(() => CONTRACTS.find(item => item.contractType === settings.contractType) || CONTRACTS[0], [settings.contractType]);
    const selectedMarket = markets.find(item => item.symbol === settings.symbol);
    const contractSupported = availableContracts.length === 0 || availableContracts.includes(settings.contractType);

    const start = () => {
        if (!activeLoginid) return setError('Select a Deriv account before starting Speed Bot.');
        if (!contractSupported) return setError(`${selectedContract.label} is not available on ${selectedMarket?.name || settings.symbol}.`);
        const amount = Math.max(0.01, numeric(settings.amount, 0.35));
        const limit = settings.maxTrades > 0 ? `\nMaximum trades: ${settings.maxTrades}` : '\nMaximum trades: Unlimited until Stop';
        const prediction = selectedContract.needsPrediction ? `\nPrediction: ${clamp(Math.trunc(settings.prediction), 0, 9)}` : '';
        if (!window.confirm(`Start Speed Bot?\n\nONE ${selectedContract.label} contract will be purchased on EVERY fresh tick.\nMarket: ${selectedMarket?.name || settings.symbol}\n${settings.basis === 'stake' ? 'Stake' : 'Payout'}: ${amount.toFixed(2)} ${currency}\nDuration: ${settings.duration}${settings.durationUnit}${prediction}${limit}`)) return;

        tradesTriggeredRef.current = 0;
        sequenceRef.current = 0;
        lastTickRef.current = `${currentTick?.epoch ?? ''}:${currentTick?.quote ?? ''}`;
        runningRef.current = true;
        setRunning(true);
        setTradesTriggered(0);
        setError('');
        setStatus('RUNNING · waiting for the next fresh tick.');
    };

    const update = <K extends keyof SpeedSettings>(key: K, value: SpeedSettings[K]) => setSettings(current => ({ ...current, [key]: value }));

    return <div className='prodb-speed-page'>
        <header className='prodb-speed-head'>
            <div><span>EVERY-TICK EXECUTION</span><h1>Speed Bot</h1><p>One configured Deriv contract is fired on every fresh tick until Stop or the optional trade limit is reached.</p></div>
            <div className={`prodb-speed-live ${running ? 'is-running' : ''}`}><i />{running ? 'RUNNING' : 'STOPPED'}</div>
        </header>

        <section className='prodb-speed-card'>
            <div className='prodb-speed-grid'>
                <label>VOLATILITY<select value={settings.symbol} disabled={running} onChange={e => update('symbol', e.target.value)}>{markets.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}</select></label>
                <label>TRADE TYPE<select value={settings.contractType} disabled={running} onChange={e => update('contractType', e.target.value)}>{CONTRACTS.map(item => <option key={item.contractType} value={item.contractType} disabled={availableContracts.length > 0 && !availableContracts.includes(item.contractType)}>{item.label}</option>)}</select></label>
                <label>BASIS<select value={settings.basis} disabled={running} onChange={e => update('basis', e.target.value as SpeedSettings['basis'])}><option value='stake'>Stake</option><option value='payout'>Payout</option></select></label>
                <label>{settings.basis === 'stake' ? 'STAKE' : 'PAYOUT'} ({currency})<input type='number' min='.01' step='.01' value={settings.amount} disabled={running} onChange={e => update('amount', Math.max(.01, numeric(e.target.value, .35)))} /></label>
                {selectedContract.needsPrediction && <label>PREDICTION<input type='number' min='0' max='9' value={settings.prediction} disabled={running} onChange={e => update('prediction', clamp(Math.trunc(numeric(e.target.value, 1)), 0, 9))} /></label>}
                <label>DURATION<input type='number' min='1' value={settings.duration} disabled={running} onChange={e => update('duration', Math.max(1, Math.trunc(numeric(e.target.value, 1))))} /></label>
                <label>DURATION UNIT<select value={settings.durationUnit} disabled={running} onChange={e => update('durationUnit', e.target.value as SpeedSettings['durationUnit'])}><option value='t'>Ticks</option><option value='s'>Seconds</option><option value='m'>Minutes</option></select></label>
                <label>MAX TRADES <small>0 = unlimited</small><input type='number' min='0' value={settings.maxTrades} disabled={running} onChange={e => update('maxTrades', Math.max(0, Math.trunc(numeric(e.target.value, 0))))} /></label>
            </div>

            <div className='prodb-speed-summary'><b>Current tick: {currentTick?.quote ?? '—'}</b><span>{selectedContract.label}{selectedContract.needsPrediction ? ` ${settings.prediction}` : ''} · {settings.duration}{settings.durationUnit} · one purchase / tick</span></div>
            <div className='prodb-speed-actions'><button type='button' className='is-start' disabled={running || !contractSupported} onClick={start}>Start Speed Bot</button><button type='button' className='is-stop' disabled={!running} onClick={() => stop()}>Stop</button></div>
            {error && <div className='prodb-live-error'>{error}</div>}
            <div className='prodb-speed-status'>{status}</div>
        </section>

        <section className='prodb-speed-stats'>
            <div><small>TRIGGERED</small><strong>{tradesTriggered}</strong></div>
            <div><small>BOUGHT</small><strong>{contractsBought}</strong></div>
            <div><small>FAILED</small><strong>{contractsFailed}</strong></div>
            <div><small>SETTLED</small><strong>{contractsSettled}</strong></div>
            <div><small>IN FLIGHT</small><strong>{inFlight}</strong></div>
            <div className={totalProfit >= 0 ? 'is-profit' : 'is-loss'}><small>TOTAL PROFIT</small><strong>{totalProfit.toFixed(2)} {currency}</strong></div>
        </section>

        {logs.length > 0 && <section className='prodb-speed-log'><h2>Recent every-tick executions</h2>{logs.map(item => <div key={item.id} className={item.ok ? 'is-ok' : 'is-fail'}><b>#{item.number}</b><span>Tick {item.tick}</span><strong>{item.ok ? `Contract ${item.contractId || 'purchased'}` : item.error}</strong></div>)}</section>}
    </div>;
};

export default SpeedBotPage;
