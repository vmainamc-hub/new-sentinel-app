import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import {
    BULK_MARKETS, DEFAULT_BULK, FAMILIES, MAX_HISTORY, type Family, type MarketInput, type Tally, barrierError, digitsFromTicks,
    emptyTally, exposure, inferDecimals, lastDigit, lossLimitHit, needsBarrier, recordPlaced, recordSettled, sanitizeBulk, scanMarkets,
} from '../bulk-engine';
import BulkTraderView, { type BulkForm, type LoadedPick, type LogRow } from './BulkTraderView';

type MarketStore = Record<string, { digits: number[]; price: number | null }>;

const IDLE = 'Bot is not running.';
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const DIGIT_CONTRACTS = new Set(['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF']);

const BulkTraderPage = () => {
    const { authData } = useApiBase();
    const currency = authData?.currency || 'USD';
    const accountKind = (typeof localStorage !== 'undefined' && localStorage.getItem('account_type')) || '';

    const [family, setFamily] = useState<Family>('evenodd');
    const [ticks, setTicks] = useState(1000);
    const [symbol, setSymbol] = useState('1HZ100V');
    const [barrier, setBarrier] = useState('5');
    const [loaded, setLoaded] = useState<LoadedPick | null>(null);
    const [form, setForm] = useState<BulkForm>({
        duration: String(DEFAULT_BULK.duration), stake: String(DEFAULT_BULK.stake),
        runs: String(DEFAULT_BULK.runs), maxLoss: String(DEFAULT_BULK.maxLoss),
    });
    const [version, setVersion] = useState(0);
    const [reloadKey, setReloadKey] = useState(0);
    const [live, setLive] = useState(false);
    const [error, setError] = useState('');
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState(IDLE);
    const [tally, setTally] = useState<Tally>(emptyTally());
    const [log, setLog] = useState<LogRow[]>([]);

    const store = useRef<MarketStore>({});
    const decimals = useRef<Record<string, number>>(Object.fromEntries(BULK_MARKETS.map(market => [market.symbol, market.pip])));
    const dirty = useRef(false);
    const mounted = useRef(true);
    const runRef = useRef(false);
    const tallyRef = useRef<Tally>(emptyTally());
    const rowSeq = useRef(0);
    const traderRef = useRef<HTMLElement>(null);

    useEffect(() => () => { mounted.current = false; runRef.current = false; }, []);

    // ------------------------------------------------------------------
    // Market data: 5000 ticks of history, then live ticks. Jump indices are included only
    // when Deriv confirms that at least one digit contract is actually available.
    // ------------------------------------------------------------------
    useEffect(() => {
        let alive = true;
        const disposers: Array<() => void> = [];
        store.current = {};
        setLive(false);
        setError('');

        const run = async () => {
            const queue = [...BULK_MARKETS];
            const worker = async () => {
                for (let market = queue.shift(); market && alive; market = queue.shift()) {
                    try {
                        if (market.symbol.startsWith('JD')) {
                            const capabilities = await PremiumDerivApiService.contractsFor(market.symbol);
                            const types = (Array.isArray(capabilities?.available) ? capabilities.available : [])
                                .flatMap((item: any) => Array.isArray(item?.contract_type) ? item.contract_type : [item?.contract_type])
                                .filter((type: unknown): type is string => typeof type === 'string');
                            if (!types.some(type => DIGIT_CONTRACTS.has(type))) {
                                console.info(`[AI Bulk Trader] ${market.symbol} has no digit contracts available and is omitted from the digit scanner.`);
                                continue;
                            }
                        }
                        const prices = await PremiumDerivApiService.ticksHistory(market.symbol, MAX_HISTORY);
                        if (!alive) return;
                        // Decimals come from the ticks themselves (Deriv strips trailing zeros), so a wrong
                        // fallback pip can never silently shift every digit.
                        const places = inferDecimals(prices, market.pip);
                        decimals.current[market.symbol] = places;
                        store.current[market.symbol] = {
                            digits: digitsFromTicks(prices, places).slice(-MAX_HISTORY),
                            price: prices.length ? prices[prices.length - 1] : null,
                        };
                        dirty.current = true;
                        const dispose = await PremiumDerivApiService.subscribeTicks(market.symbol, tick => {
                            const quote = Number(tick?.quote);
                            const entry = store.current[market.symbol];
                            if (!Number.isFinite(quote) || !entry) return;
                            const pip = Number(tick?.pip_size);
                            if (Number.isInteger(pip) && pip >= 0) decimals.current[market.symbol] = Math.max(decimals.current[market.symbol], pip);
                            entry.digits.push(lastDigit(quote, decimals.current[market.symbol]));
                            if (entry.digits.length > MAX_HISTORY) entry.digits.splice(0, entry.digits.length - MAX_HISTORY);
                            entry.price = quote;
                            dirty.current = true;
                        });
                        if (alive) disposers.push(dispose); else dispose();
                    } catch (err) {
                        if (alive) setError(errorText(err));
                    }
                }
            };
            await Promise.all([worker(), worker(), worker(), worker()]);
            if (alive) setLive(true);
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
    }, [reloadKey]);

    const inputs: MarketInput[] = useMemo(
        () => BULK_MARKETS.filter(market => Boolean(store.current[market.symbol])).map(market => ({
            symbol: market.symbol, name: market.name,
            digits: store.current[market.symbol]?.digits ?? [], price: store.current[market.symbol]?.price ?? null,
        })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [version]
    );
    const scan = useMemo(() => scanMarkets(family, inputs, ticks), [family, inputs, ticks]);

    // ------------------------------------------------------------------
    // Scanner -> trader hand-off. Nothing is applied automatically; the user chooses to load a pick.
    // ------------------------------------------------------------------
    const onLoad = useCallback((target: string) => {
        const market = scan.markets.find(item => item.symbol === target);
        if (!market?.best) return;
        setSymbol(target);
        if (market.best.barrier !== null) setBarrier(String(market.best.barrier));
        setLoaded({ symbol: target, pick: market.best });
        setError('');
        window.setTimeout(() => traderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }, [scan]);

    const onForm = (key: keyof BulkForm) => (event: { target: { value: string } }) =>
        setForm(current => ({ ...current, [key]: event.target.value }));

    // ------------------------------------------------------------------
    // Bulk execution: place N purchases through the app's authenticated Deriv socket and track settlement.
    // ------------------------------------------------------------------
    const execute = async (side: 0 | 1) => {
        if (runRef.current) return;
        setError('');
        const def = FAMILIES[family];
        const contract = def.contracts[side];
        const params = sanitizeBulk({
            stake: Number(form.stake), runs: Number(form.runs), duration: Number(form.duration), maxLoss: Number(form.maxLoss),
        });
        const barrierDigit = Math.trunc(Number(barrier));
        const invalid = barrierError(contract, barrierDigit);
        if (invalid) { setError(invalid); return; }

        const market = BULK_MARKETS.find(item => item.symbol === symbol) ?? BULK_MARKETS[0];
        try {
            const capabilities = await PremiumDerivApiService.contractsFor(market.symbol);
            const types = (Array.isArray(capabilities?.available) ? capabilities.available : [])
                .flatMap((item: any) => Array.isArray(item?.contract_type) ? item.contract_type : [item?.contract_type]);
            if (!types.includes(contract)) {
                setError(`${contract} is not available for ${market.name} on the selected Deriv account. Choose a supported contract or market.`);
                return;
            }
        } catch (err) {
            setError(`Could not verify contract availability for ${market.name}: ${errorText(err)}`);
            return;
        }
        const label = needsBarrier(contract) ? `${def.sides[side]} ${barrierDigit}` : def.sides[side];
        const accountText = accountKind ? `${accountKind} account` : 'the selected Deriv account';
        const confirmed = window.confirm(
            `Place ${params.runs} × ${label} on ${market.name}?\n\nThis places real trades on ${accountText} (${currency}).\n` +
            `Stake ${money(params.stake, currency)} each · ${params.duration} tick(s) · total exposure ${money(exposure(params), currency)}.\n` +
            `${params.maxLoss > 0 ? `Stops placing new trades once settled losses reach ${money(params.maxLoss, currency)}.` : 'No loss limit set.'}\n\n` +
            'Statistics describe past ticks and do not predict results. Trading involves risk of loss. Test on a demo account first.'
        );
        if (!confirmed) return;

        runRef.current = true;
        setRunning(true);
        setLog([]);
        tallyRef.current = emptyTally();
        setTally(tallyRef.current);

        const owned = new Map<number, number>(); // contract id -> log row id
        const settled = new Set<number>();
        const off = PremiumDerivApiService.onContractUpdate(update => {
            const id = Math.trunc(Number(update?.contract_id));
            if (!owned.has(id) || settled.has(id) || !PremiumDerivApiService.isContractClosed(update)) return;
            settled.add(id);
            const profit = num(update.profit);
            tallyRef.current = recordSettled(tallyRef.current, profit);
            if (!mounted.current) return;
            setTally(tallyRef.current);
            const rowId = owned.get(id);
            setLog(rows => rows.map(row => (row.id === rowId ? { ...row, profit, state: profit > 0 ? 'won' : 'lost' } : row)));
        });

        let final = IDLE;
        try {
            for (let index = 0; index < params.runs && runRef.current && mounted.current; index += 1) {
                if (lossLimitHit(tallyRef.current, params.maxLoss)) {
                    final = `Loss limit of ${money(params.maxLoss, currency)} reached. No further trades placed.`;
                    break;
                }
                setStatus(`Placing trade ${index + 1}/${params.runs}…`);
                try {
                    const proposal = await PremiumDerivApiService.proposal({
                        amount: params.stake, basis: 'stake', contract_type: contract, currency, underlying_symbol: market.symbol,
                        duration: params.duration, duration_unit: 't', barrier: needsBarrier(contract) ? String(barrierDigit) : undefined,
                    });
                    const bought = await PremiumDerivApiService.buy(proposal.id, num(proposal.ask_price, params.stake));
                    const contractId = Math.trunc(Number(bought.contract_id));
                    const rowId = (rowSeq.current += 1);
                    owned.set(contractId, rowId);
                    tallyRef.current = recordPlaced(tallyRef.current);
                    setTally(tallyRef.current);
                    setLog(rows => [{ id: rowId, time: new Date().toLocaleTimeString(), label, stake: params.stake, state: 'open' as const, profit: 0 }, ...rows].slice(0, 100));
                } catch (err) {
                    // A failed purchase (insufficient balance, market closed, ...) would repeat for every trade: stop here.
                    const message = errorText(err);
                    setLog(rows => [{ id: (rowSeq.current += 1), time: new Date().toLocaleTimeString(), label, stake: params.stake, state: 'error' as const, profit: 0, note: message }, ...rows]);
                    setError(message);
                    final = 'Stopped because a purchase failed.';
                    break;
                }
            }
            if (final === IDLE && !runRef.current) final = 'Stopped. Open trades will still settle.';

            const deadline = Date.now() + 45000;
            while (settled.size < owned.size && Date.now() < deadline && mounted.current) {
                setStatus(`Waiting for ${owned.size - settled.size} open trade(s) to settle…`);
                await sleep(500);
            }
            if (settled.size < owned.size && final === IDLE) final = 'Some trades had not settled yet. Check your Deriv statement.';
        } finally {
            off();
            runRef.current = false;
            if (mounted.current) {
                setRunning(false);
                setStatus(final === IDLE ? `Done. ${tallyRef.current.settled} trade(s) settled · P/L ${money(tallyRef.current.pnl, currency)}.` : final);
            }
        }
    };

    const stop = () => { runRef.current = false; setStatus('Stopping after the current trade…'); };

    return <BulkTraderView
        family={family} onFamily={setFamily} ticks={ticks} onTicks={setTicks} scan={scan} live={live}
        onRescan={() => setReloadKey(value => value + 1)}
        symbol={symbol} onSymbol={setSymbol} barrier={barrier} onBarrier={setBarrier}
        loaded={loaded} onLoad={onLoad} form={form} onForm={onForm}
        currency={currency} running={running} status={status} error={error} tally={tally} log={log}
        onExecute={side => void execute(side)} onStop={stop} traderRef={traderRef}
    />;
};

export default BulkTraderPage;
