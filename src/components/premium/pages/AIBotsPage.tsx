import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import {
    AI_BOTS, type AIBot, DEFAULT_RISK, RULES, type RiskParams, type RunState, type Signal, activeRule, applyResult,
    digitsFromPrices, initialRunState, sanitizeRisk, stopReason,
} from '../apex-logic';

const MARKETS = [
    { symbol: 'R_10', name: 'Volatility 10', pip: 3 }, { symbol: 'R_25', name: 'Volatility 25', pip: 3 },
    { symbol: 'R_50', name: 'Volatility 50', pip: 4 }, { symbol: 'R_75', name: 'Volatility 75', pip: 4 },
    { symbol: 'R_100', name: 'Volatility 100', pip: 2 }, { symbol: '1HZ10V', name: 'Volatility 10 (1s)', pip: 2 },
    { symbol: '1HZ25V', name: 'Volatility 25 (1s)', pip: 2 }, { symbol: '1HZ50V', name: 'Volatility 50 (1s)', pip: 2 },
    { symbol: '1HZ75V', name: 'Volatility 75 (1s)', pip: 2 }, { symbol: '1HZ100V', name: 'Volatility 100 (1s)', pip: 2 },
];

type LogRow = { id: number; time: string; label: string; stake: number; profit: number; phase: string };
const STOP_TEXT: Record<string, string> = {
    take_profit: 'Take profit reached.', stop_loss: 'Stop loss reached.', max_losses: 'Maximum consecutive losses reached.',
};
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;

const settle = async (contractId: number, isRunning: () => boolean): Promise<number> => {
    const started = Date.now();
    while (Date.now() - started < 90000) {
        const response = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId });
        const contract = response.proposal_open_contract || {};
        if (PremiumDerivApiService.isContractClosed(contract)) return num(contract.profit);
        await sleep(isRunning() ? 700 : 1200);
    }
    throw new Error('The contract did not settle in time. Check your Deriv statement.');
};

const AIBotsPage = () => {
    const { authData } = useApiBase();
    const currency = authData?.currency || 'USD';
    const accountKind = (typeof localStorage !== 'undefined' && localStorage.getItem('account_type')) || '';
    const [botId, setBotId] = useState(AI_BOTS[0].id);
    const [symbol, setSymbol] = useState('R_100');
    const [form, setForm] = useState<Record<keyof RiskParams, string>>({
        stake: String(DEFAULT_RISK.stake), multiplier: String(DEFAULT_RISK.multiplier), maxStake: String(DEFAULT_RISK.maxStake),
        takeProfit: String(DEFAULT_RISK.takeProfit), stopLoss: String(DEFAULT_RISK.stopLoss),
        maxConsecutiveLosses: String(DEFAULT_RISK.maxConsecutiveLosses),
    });
    const [running, setRunning] = useState(false);
    const [state, setState] = useState<RunState | null>(null);
    const [log, setLog] = useState<LogRow[]>([]);
    const [status, setStatus] = useState('Choose a bot and press Start.');
    const [error, setError] = useState('');
    const runRef = useRef(false);
    const pricesRef = useRef<number[]>([]);
    const waiter = useRef<(() => void) | null>(null);
    const dispose = useRef<(() => void) | null>(null);
    const rowId = useRef(0);

    const bot: AIBot = AI_BOTS.find(item => item.id === botId) || AI_BOTS[0];

    const stop = useCallback((message?: string) => {
        runRef.current = false;
        setRunning(false);
        if (message) setStatus(message);
        waiter.current?.();
        try { dispose.current?.(); } catch { /* already closed */ }
        dispose.current = null;
    }, []);

    useEffect(() => () => stop(), [stop]);

    const nextTick = () => new Promise<void>(resolve => { waiter.current = resolve; });

    const place = async (signal: Signal, stake: number, market: string): Promise<number> => {
        const isRiseFall = signal.contract === 'CALL' || signal.contract === 'PUT';
        const proposal = await PremiumDerivApiService.proposal({
            amount: stake, basis: 'stake', contract_type: signal.contract, currency, underlying_symbol: market,
            duration: isRiseFall ? 5 : 1, duration_unit: 't', barrier: signal.barrier,
        });
        const bought = await PremiumDerivApiService.buy(proposal.id, num(proposal.ask_price, stake));
        return settle(Number(bought.contract_id), () => runRef.current);
    };

    const start = async () => {
        if (runRef.current) return;
        setError('');
        const risk = sanitizeRisk({
            stake: Number(form.stake), multiplier: Number(form.multiplier), maxStake: Number(form.maxStake),
            takeProfit: Number(form.takeProfit), stopLoss: Number(form.stopLoss), maxConsecutiveLosses: Number(form.maxConsecutiveLosses),
        });
        const market = MARKETS.find(item => item.symbol === symbol) || MARKETS[4];
        const accountText = accountKind ? `${accountKind} account` : 'the selected Deriv account';
        const confirmed = window.confirm(
            `Start "${bot.title}" on ${market.name}?\n\nThis places real trades on ${accountText} (${currency}).\n` +
            `Stake ${money(risk.stake, currency)}, ×${risk.multiplier} after a loss (max ${money(risk.maxStake, currency)}).\n` +
            `Stops at +${money(risk.takeProfit, currency)}, -${money(risk.stopLoss, currency)} or ${risk.maxConsecutiveLosses} losses in a row.\n\n` +
            'Trading involves risk of loss. Test on a demo account first.'
        );
        if (!confirmed) return;

        runRef.current = true;
        setRunning(true);
        setLog([]);
        let run = initialRunState(risk);
        setState(run);
        setStatus('Connecting to market data…');

        try {
            const history = await PremiumDerivApiService.ticksHistory(market.symbol, 30);
            pricesRef.current = history;
            dispose.current = await PremiumDerivApiService.subscribeTicks(market.symbol, tick => {
                const quote = Number(tick?.quote);
                if (!Number.isFinite(quote)) return;
                pricesRef.current = [...pricesRef.current.slice(-49), quote];
                const resolve = waiter.current; waiter.current = null; resolve?.();
            });
            setStatus('Running — waiting for a signal.');

            while (runRef.current) {
                await nextTick();
                if (!runRef.current) break;
                const prices = pricesRef.current;
                const rule = activeRule(bot, run.phase);
                const signal = RULES[rule]({ digits: digitsFromPrices(prices, market.pip), prices });
                if (!signal) continue;

                setStatus(`Signal: ${signal.label} · stake ${money(run.stake, currency)}`);
                const phase = run.phase;
                const stake = run.stake;
                const profit = await place(signal, stake, market.symbol);
                run = applyResult(run, bot, risk, profit);
                setState(run);
                setLog(rows => [{
                    id: (rowId.current += 1), time: new Date().toLocaleTimeString(), label: signal.label, stake, profit, phase,
                }, ...rows].slice(0, 40));

                const reason = stopReason(run, risk);
                if (reason) { stop(`${STOP_TEXT[reason]} Bot stopped.`); break; }
                if (runRef.current) setStatus('Running — waiting for a signal.');
            }
        } catch (err) {
            stop('Bot stopped because of an error.');
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const set = (key: keyof RiskParams) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));

    return (
        <div className='apex-ai'>
            <header className='apex-ai__head'>
                <h1>AI Bots</h1>
                <p>Native strategies that watch live ticks and trade on signal. Pick one, set your limits, then press Start.</p>
            </header>

            <div className='apex-ai__grid'>
                {AI_BOTS.map(item => (
                    <article key={item.id} className={`apex-ai__card apex-ai__card--${item.accent}${item.id === botId ? ' is-selected' : ''}`}>
                        <div className='apex-ai__card-top'><h2>{item.title}</h2><span>{String(item.index).padStart(2, '0')}</span></div>
                        <p>{item.description}</p>
                        <button type='button' disabled={running} onClick={() => setBotId(item.id)}>
                            {item.id === botId ? 'Selected' : 'Load AI Bot'} <span aria-hidden>→</span>
                        </button>
                    </article>
                ))}
            </div>

            <section className='apex-ai__runner'>
                <div className='apex-ai__runner-head'>
                    <div><small>SELECTED BOT</small><h2>{bot.title}</h2></div>
                    <div className={`apex-ai__badge${running ? ' is-live' : ''}`}>{running ? 'RUNNING' : 'STOPPED'}</div>
                </div>

                <div className='apex-ai__form'>
                    <label>Market
                        <select value={symbol} disabled={running} onChange={event => setSymbol(event.target.value)}>
                            {MARKETS.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}
                        </select>
                    </label>
                    <label>Stake ({currency})<input disabled={running} value={form.stake} onChange={set('stake')} inputMode='decimal' /></label>
                    <label>Multiplier after loss<input disabled={running} value={form.multiplier} onChange={set('multiplier')} inputMode='decimal' /></label>
                    <label>Max stake<input disabled={running} value={form.maxStake} onChange={set('maxStake')} inputMode='decimal' /></label>
                    <label>Take profit<input disabled={running} value={form.takeProfit} onChange={set('takeProfit')} inputMode='decimal' /></label>
                    <label>Stop loss<input disabled={running} value={form.stopLoss} onChange={set('stopLoss')} inputMode='decimal' /></label>
                    <label>Max losses in a row<input disabled={running} value={form.maxConsecutiveLosses} onChange={set('maxConsecutiveLosses')} inputMode='numeric' /></label>
                </div>

                <div className='apex-ai__actions'>
                    {running
                        ? <button type='button' className='is-stop' onClick={() => stop('Stopped. An open contract will still settle.')}>Stop</button>
                        : <button type='button' className='is-start' onClick={() => void start()}>Start</button>}
                    <span>{status}</span>
                </div>
                {error && <p className='apex-ai__error'>{error}</p>}

                <div className='apex-ai__stats'>
                    <div><small>Trades</small><strong>{state?.trades ?? 0}</strong></div>
                    <div><small>Wins / Losses</small><strong>{state?.wins ?? 0} / {state?.losses ?? 0}</strong></div>
                    <div><small>P/L</small><strong className={(state?.pnl ?? 0) >= 0 ? 'is-win' : 'is-loss'}>{money(state?.pnl ?? 0, currency)}</strong></div>
                    <div><small>Next stake</small><strong>{money(state?.stake ?? (Number(form.stake) || 0), currency)}</strong></div>
                    <div><small>Mode</small><strong>{state?.phase === 'recovery' ? 'Recovery' : 'Primary'}</strong></div>
                </div>

                <table className='apex-ai__log'>
                    <thead><tr><th>Time</th><th>Trade</th><th>Mode</th><th>Stake</th><th>Result</th></tr></thead>
                    <tbody>
                        {log.length === 0 && <tr><td colSpan={5} className='apex-ai__empty'>No trades yet.</td></tr>}
                        {log.map(row => (
                            <tr key={row.id}>
                                <td>{row.time}</td><td>{row.label}</td><td>{row.phase}</td><td>{row.stake.toFixed(2)}</td>
                                <td className={row.profit > 0 ? 'is-win' : 'is-loss'}>{row.profit > 0 ? '+' : ''}{row.profit.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className='apex-ai__note'>Trading involves risk of loss. Signals are rules, not predictions. Test on a demo account first.</p>
            </section>
        </div>
    );
};

export default AIBotsPage;