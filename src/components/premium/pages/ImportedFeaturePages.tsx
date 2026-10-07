import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { load, save_types } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import DashboardHome from './DashboardHome';
import type { PremiumSection } from '../types';

type Market = { symbol: string; label: string; pip: number };
type TradeResult = { contractId?: number; profit: number; status: string };
type BotIdea = { id: string; name: string; strategy: string; xml?: string; fileName?: string; createdAt: number; wins: number; losses: number; pnl: number };

type Direction = 'CALL' | 'PUT';
type DigitTrade = 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF';
type AutoTradeType = DigitTrade | Direction;

const SOURCE_BOT_PATH = '/free-bots/uploads/apex-sentinel';
const BOT_IDEAS_KEY = 'prodb.imported.bot-ideas.v1';
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const symbolCode = (item: any) => item?.underlying_symbol || item?.symbol || '';
const symbolName = (item: any) => item?.underlying_symbol_name || item?.display_name || item?.market_display_name || symbolCode(item);
const pipDigits = (item: any) => {
    const pip = String(item?.pip_size ?? item?.pip ?? '0.01');
    const fraction = pip.includes('.') ? pip.split('.')[1].replace(/0+$/, '') : '';
    return fraction.length || 2;
};
const lastDigit = (quote: number, decimals = 2) => Number(quote.toFixed(decimals).slice(-1));
const money = (value: unknown, currency = 'USD') => `${num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const getMarkets = (items: any[]): Market[] => items.map(item => ({
    symbol: symbolCode(item),
    label: symbolName(item),
    pip: pipDigits(item),
})).filter(item => item.symbol);

const useMarkets = () => {
    const [markets, setMarkets] = useState<Market[]>([]);
    const [symbol, setSymbol] = useState('1HZ100V');
    const [error, setError] = useState('');
    useEffect(() => {
        let alive = true;
        PremiumDerivApiService.activeSymbols().then(items => {
            if (!alive) return;
            const next = getMarkets(items);
            setMarkets(next);
            if (!next.some(item => item.symbol === symbol) && next[0]) setSymbol(next[0].symbol);
        }).catch(err => alive && setError(errorText(err)));
        return () => { alive = false; };
    }, []);
    return { markets, symbol, setSymbol, error, selected: markets.find(item => item.symbol === symbol) };
};

const useTicks = (symbol: string, count = 300) => {
    const [prices, setPrices] = useState<number[]>([]);
    const [error, setError] = useState('');
    const refresh = useCallback(async () => {
        if (!symbol) return;
        try { setPrices(await PremiumDerivApiService.ticksHistory(symbol, count)); setError(''); }
        catch (err) { setError(errorText(err)); }
    }, [symbol, count]);
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => {
        if (!symbol) return;
        let dispose: (() => void) | undefined;
        PremiumDerivApiService.subscribeTicks(symbol, tick => {
            const quote = num(tick?.quote, NaN);
            if (Number.isFinite(quote)) setPrices(current => [...current.slice(-(count - 1)), quote]);
        }).then(fn => { dispose = fn; }).catch(err => setError(errorText(err)));
        return () => dispose?.();
    }, [symbol, count]);
    return { prices, error, refresh };
};

const MarketSelect = ({ markets, value, onChange }: { markets: Market[]; value: string; onChange: (value: string) => void }) => (
    <select value={value} onChange={event => onChange(event.target.value)}>{markets.map(item => <option key={item.symbol} value={item.symbol}>{item.label}</option>)}</select>
);

const PageHeader = ({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: React.ReactNode }) => (
    <header className='prodb-import-header'><div><span>{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>{right}</header>
);

const waitForSettlement = async (contractId: number, timeoutMs = 65000): Promise<TradeResult> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const response = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId });
        const contract = response.proposal_open_contract || {};
        if (contract.is_sold || ['won', 'lost', 'sold'].includes(String(contract.status || '').toLowerCase())) {
            return { contractId, profit: num(contract.profit), status: contract.status || (num(contract.profit) >= 0 ? 'won' : 'lost') };
        }
        await sleep(700);
    }
    return { contractId, profit: 0, status: 'open' };
};

const purchase = async ({ symbol, contractType, stake, currency, barrier, duration = 1 }: { symbol: string; contractType: AutoTradeType | string; stake: number; currency: string; barrier?: string; duration?: number }) => {
    const proposal = await PremiumDerivApiService.proposal({
        amount: Math.max(stake, 0.01), basis: 'stake', contract_type: contractType, currency,
        underlying_symbol: symbol, duration: Math.max(1, Math.trunc(duration)), duration_unit: 't', barrier,
    });
    const ask = num(proposal.ask_price, stake);
    const bought = await PremiumDerivApiService.buy(proposal.id, ask);
    return { proposal, bought, settlement: await waitForSettlement(Number(bought.contract_id)) };
};

const readIdeas = (): BotIdea[] => {
    try { const parsed = JSON.parse(localStorage.getItem(BOT_IDEAS_KEY) || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
};
const saveIdeas = (ideas: BotIdea[]) => localStorage.setItem(BOT_IDEAS_KEY, JSON.stringify(ideas));

const loadXml = async (xml: string, name: string, openBotBuilder: () => void) => {
    openBotBuilder();
    await sleep(500);
    const workspace = window.Blockly?.derivWorkspace;
    if (!workspace) throw new Error('Bot Builder workspace is not ready yet. Open Bot Builder and try again.');
    await load({ block_string: xml, file_name: name, workspace, from: save_types.LOCAL, drop_event: {}, strategy_id: null, showIncompatibleStrategyDialog: false });
};

export const BotIdeasPage = ({ openBotBuilder }: { openBotBuilder: () => void }) => {
    const { authData } = useApiBase();
    const [ideas, setIdeas] = useState<BotIdea[]>(readIdeas);
    const [name, setName] = useState('');
    const [strategy, setStrategy] = useState('');
    const [xml, setXml] = useState('');
    const [fileName, setFileName] = useState('');
    const [editing, setEditing] = useState<string | null>(null);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');

    const persist = (next: BotIdea[]) => { setIdeas(next); saveIdeas(next); };
    const resetForm = () => { setName(''); setStrategy(''); setXml(''); setFileName(''); setEditing(null); };
    const submit = () => {
        setError('');
        if (!name.trim()) return setError('Give the bot idea a name.');
        if (strategy.trim().length < 120) return setError('Describe the strategy in at least 120 characters so it is useful when revisited.');
        const item: BotIdea = editing ? {
            ...(ideas.find(idea => idea.id === editing) as BotIdea), name: name.trim(), strategy: strategy.trim(), xml: xml || undefined, fileName: fileName || undefined,
        } : { id: crypto.randomUUID(), name: name.trim(), strategy: strategy.trim(), xml: xml || undefined, fileName: fileName || undefined, createdAt: Date.now(), wins: 0, losses: 0, pnl: 0 };
        persist(editing ? ideas.map(idea => idea.id === editing ? item : idea) : [item, ...ideas]);
        resetForm(); setMessage('Bot idea saved in this browser.');
    };
    const attach = (file?: File) => {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.xml')) return setError('Only XML bot files are supported.');
        const reader = new FileReader();
        reader.onload = () => { setXml(String(reader.result || '')); setFileName(file.name); };
        reader.onerror = () => setError('Could not read the XML file.');
        reader.readAsText(file);
    };

    return <div className='prodb-import-page'>
        <PageHeader eyebrow='IMPORTED · BOT IDEAS' title='Strategy Ideas' subtitle='The source Dashboard/Bot Ideas workflow is preserved as a premium idea board with XML attachment, editing, rating and direct Bot Builder loading.' right={<span className='prodb-import-chip'>{authData?.loginid || 'Deriv account'}</span>} />
        <div className='prodb-import-grid prodb-import-grid--ideas'>
            <section className='prodb-import-card prodb-import-form-card'><h2>{editing ? 'Edit bot idea' : 'Submit a bot idea'}</h2><label>Bot name<input value={name} onChange={e => setName(e.target.value)} placeholder='e.g. Over 3 recovery filter' /></label><label>Strategy description<textarea value={strategy} onChange={e => setStrategy(e.target.value)} rows={7} placeholder='Explain entry, exit, risk and recovery rules…' /></label><label className='prodb-import-file'>Optional XML bot<input type='file' accept='.xml,text/xml,application/xml' onChange={e => attach(e.target.files?.[0])} /><span>{fileName || 'Attach XML'}</span></label><div className='prodb-import-actions'><button className='is-primary' onClick={submit}>{editing ? 'Save changes' : 'Save idea'}</button>{editing && <button onClick={resetForm}>Cancel</button>}</div>{error && <div className='prodb-live-error'>{error}</div>}{message && <div className='prodb-live-success'>{message}</div>}</section>
            <section className='prodb-import-card'><div className='prodb-import-card__title'><div><h2>Saved ideas</h2><p>{ideas.length} idea{ideas.length === 1 ? '' : 's'} in this site profile</p></div></div><div className='prodb-idea-list'>{ideas.length === 0 ? <div className='prodb-live-empty'>No ideas yet. Add the first strategy on the left.</div> : ideas.map(idea => {
                const total = idea.wins + idea.losses; const stars = total < 3 ? 0 : Math.max(1, Math.min(5, Math.ceil((idea.wins / total) * 5)));
                return <article key={idea.id}><div className='prodb-idea-list__head'><div><strong>{idea.name}</strong><small>{new Date(idea.createdAt).toLocaleDateString()}</small></div><span>{stars ? `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}` : 'NEW'}</span></div><p>{idea.strategy}</p><div className='prodb-idea-list__meta'><span>Runs {total}</span><span>W {idea.wins}</span><span>L {idea.losses}</span><span className={idea.pnl >= 0 ? 'is-positive' : 'is-negative'}>{money(idea.pnl)}</span></div><div className='prodb-import-actions'>{idea.xml && <button className='is-primary' onClick={() => loadXml(idea.xml!, idea.fileName || `${idea.name}.xml`, openBotBuilder).catch(err => setError(errorText(err)))}>Load bot</button>}<button onClick={() => { setEditing(idea.id); setName(idea.name); setStrategy(idea.strategy); setXml(idea.xml || ''); setFileName(idea.fileName || ''); }}>Edit</button><button className='is-danger' onClick={() => persist(ideas.filter(item => item.id !== idea.id))}>Delete</button></div></article>;
            })}</div></section>
        </div>
    </div>;
};

export const QuickBotPage = ({ openBotBuilder, openSection }: { openBotBuilder: () => void; openSection: (section: PremiumSection) => void }) => <DashboardHome openBotBuilder={openBotBuilder} openSection={openSection} />;

export const SignalAIPage = () => {
    const { authData } = useApiBase(); const currency = authData?.currency || 'USD';
    const { markets, symbol, setSymbol, selected, error: marketError } = useMarkets();
    const [windowSize, setWindowSize] = useState(300); const { prices, error: tickError, refresh } = useTicks(symbol, windowSize);
    const [stake, setStake] = useState(1); const [duration, setDuration] = useState(1); const [busy, setBusy] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState('');
    const stats = useMemo(() => {
        if (prices.length < 2) return { rise: 0, fall: 0, confidence: 0, preferred: null as Direction | null, momentum: 0 };
        let up = 0, down = 0; const dirs: number[] = [];
        prices.slice(1).forEach((price, index) => { const d = price > prices[index] ? 1 : price < prices[index] ? -1 : 0; dirs.push(d); if (d > 0) up++; if (d < 0) down++; });
        const total = up + down || 1; const rise = up / total * 100; const fall = down / total * 100; const momentum = dirs.slice(-10).reduce((sum, value) => sum + value, 0);
        return { rise, fall, confidence: Math.min(100, Math.abs(rise - fall) * 2), preferred: rise === fall ? null : rise > fall ? 'CALL' as Direction : 'PUT' as Direction, momentum };
    }, [prices]);
    const execute = async (direction: Direction) => {
        if (!window.confirm(`Buy ${direction === 'CALL' ? 'Rise' : 'Fall'} on ${selected?.label || symbol} with ${money(stake, currency)} stake?`)) return;
        setBusy(direction); setError(''); setMessage('');
        try { const result = await purchase({ symbol, contractType: direction, stake, currency, duration }); setMessage(`${result.settlement.status.toUpperCase()} · ${money(result.settlement.profit, currency)} · contract ${result.bought.contract_id}`); }
        catch (err) { setError(errorText(err)); } finally { setBusy(''); }
    };
    const last = prices[prices.length - 1];
    return <div className='prodb-import-page'><PageHeader eyebrow='IMPORTED · SIGNAL AI' title='Signal AI' subtitle='The source Up & Down module is rebuilt on the authenticated Deriv feed: direction statistics, momentum, confidence, live proposal execution and settlement.' right={<span className='prodb-live-badge is-live'>LIVE {last === undefined ? '—' : last.toFixed(selected?.pip || 2)}</span>} />
        <div className='prodb-import-grid prodb-import-grid--signal'><section className='prodb-import-card'><div className='prodb-import-card__title'><h2>Market signal</h2><button onClick={refresh}>Refresh</button></div><div className='prodb-fields'><label>Market<MarketSelect markets={markets} value={symbol} onChange={setSymbol} /></label><label>Analysis window<input type='number' min='30' max='1000' value={windowSize} onChange={e => setWindowSize(clamp(Math.trunc(num(e.target.value, 300)), 30, 1000))} /></label><label>Stake ({currency})<input type='number' min='.01' step='.01' value={stake} onChange={e => setStake(Math.max(.01, num(e.target.value, 1)))} /></label><label>Duration (ticks)<input type='number' min='1' max='10' value={duration} onChange={e => setDuration(clamp(Math.trunc(num(e.target.value, 1)), 1, 10))} /></label></div><div className='prodb-signal-gauge'><div><small>RISE</small><strong>{stats.rise.toFixed(2)}%</strong><span style={{ width: `${stats.rise}%` }} /></div><div><small>FALL</small><strong>{stats.fall.toFixed(2)}%</strong><span style={{ width: `${stats.fall}%` }} /></div></div><div className='prodb-signal-summary'><span>Preferred <b>{stats.preferred === 'CALL' ? 'Rise' : stats.preferred === 'PUT' ? 'Fall' : 'Neutral'}</b></span><span>Confidence <b>{stats.confidence.toFixed(1)}%</b></span><span>10-tick momentum <b>{stats.momentum > 0 ? `+${stats.momentum}` : stats.momentum}</b></span><span>Samples <b>{Math.max(prices.length - 1, 0)}</b></span></div><div className='prodb-import-actions'><button className='is-up' disabled={Boolean(busy)} onClick={() => execute('CALL')}>{busy === 'CALL' ? 'Trading…' : 'Buy Rise'}</button><button className='is-down' disabled={Boolean(busy)} onClick={() => execute('PUT')}>{busy === 'PUT' ? 'Trading…' : 'Buy Fall'}</button></div>{(error || marketError || tickError) && <div className='prodb-live-error'>{error || marketError || tickError}</div>}{message && <div className='prodb-live-success'>{message}</div>}</section>
        <section className='prodb-import-card'><h2>Live direction tape</h2><div className='prodb-direction-tape'>{prices.slice(-60).map((price, index, arr) => { const previous = index ? arr[index - 1] : price; return <span key={`${price}-${index}`} className={price > previous ? 'up' : price < previous ? 'down' : 'flat'}>{price > previous ? '▲' : price < previous ? '▼' : '•'}</span>; })}</div><p className='prodb-import-note'>Signal AI is statistical context, not a guaranteed prediction. Purchases still use live Deriv proposals and the selected account.</p></section></div></div>;
};

const TRADE_LABELS: Record<AutoTradeType, string> = { DIGITOVER: 'Digit Over', DIGITUNDER: 'Digit Under', DIGITEVEN: 'Even', DIGITODD: 'Odd', DIGITMATCH: 'Matches', DIGITDIFF: 'Differs', CALL: 'Rise', PUT: 'Fall' };
const needsBarrier = (type: AutoTradeType) => ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
const conditionHit = (type: AutoTradeType, digit: number, barrier: number, recent: number[], mode: string) => {
    let hit = type === 'DIGITEVEN' ? digit % 2 === 0 : type === 'DIGITODD' ? digit % 2 === 1 : type === 'DIGITOVER' ? digit > barrier : type === 'DIGITUNDER' ? digit < barrier : type === 'DIGITMATCH' ? digit === barrier : type === 'DIGITDIFF' ? digit !== barrier : true;
    if (mode === 'INVERSE') hit = !hit;
    if (mode === 'PERCENTAGE' && recent.length >= 30) {
        const matches = recent.filter(value => conditionHit(type, value, barrier, [], 'STANDARD')).length;
        const rate = matches / recent.length;
        hit = rate >= (type === 'DIGITMATCH' ? .13 : type === 'DIGITDIFF' ? .82 : .55);
    }
    return hit;
};

export const AutoTraderPage = () => {
    const { authData } = useApiBase(); const currency = authData?.currency || 'USD';
    const { markets, symbol, setSymbol, selected, error: marketError } = useMarkets(); const { prices, error: tickError } = useTicks(symbol, 1000);
    const [type, setType] = useState<AutoTradeType>('DIGITOVER'); const [mode, setMode] = useState('STANDARD'); const [barrier, setBarrier] = useState(3); const [afterLossBarrier, setAfterLossBarrier] = useState(5); const [streak, setStreak] = useState(2); const [stake, setStake] = useState(1); const [martingale, setMartingale] = useState(2); const [martingaleMode, setMartingaleMode] = useState('after_one'); const [lossTrigger, setLossTrigger] = useState(2); const [takeProfit, setTakeProfit] = useState(20); const [stopLoss, setStopLoss] = useState(20); const [maxRuns, setMaxRuns] = useState(20); const [running, setRunning] = useState(false); const [stats, setStats] = useState({ runs: 0, wins: 0, losses: 0, pnl: 0, consecutiveLosses: 0 }); const [logs, setLogs] = useState<string[]>([]); const [strategyText, setStrategyText] = useState(''); const stopRef = useRef(false);
    const addLog = (text: string) => setLogs(current => [`${new Date().toLocaleTimeString()} · ${text}`, ...current].slice(0, 80));
    const applyText = () => {
        const text = strategyText.toLowerCase();
        if (text.includes('under')) setType('DIGITUNDER'); else if (text.includes('over')) setType('DIGITOVER'); else if (text.includes('even')) setType('DIGITEVEN'); else if (text.includes('odd')) setType('DIGITODD'); else if (text.includes('diff')) setType('DIGITDIFF'); else if (text.includes('match')) setType('DIGITMATCH'); else if (text.includes('rise')) setType('CALL'); else if (text.includes('fall')) setType('PUT');
        const stakeMatch = text.match(/stake\s*(?:=|is|of)?\s*(\d+(?:\.\d+)?)/); if (stakeMatch) setStake(num(stakeMatch[1], 1));
        const tp = text.match(/(?:take profit|tp)\s*(?:=|is|of)?\s*(\d+(?:\.\d+)?)/); if (tp) setTakeProfit(num(tp[1], 20));
        const sl = text.match(/(?:stop loss|sl)\s*(?:=|is|of)?\s*(\d+(?:\.\d+)?)/); if (sl) setStopLoss(num(sl[1], 20));
        const digit = text.match(/(?:over|under|match|differs?)\s*(\d)/); if (digit) setBarrier(num(digit[1], 3));
        if (text.includes('percentage')) setMode('PERCENTAGE'); else if (text.includes('inverse')) setMode('INVERSE');
        addLog('Applied strategy text to the execution controls.');
    };
    const start = async () => {
        if (running || !symbol) return;
        if (!window.confirm(`Start Auto Trader on ${selected?.label || symbol}? It can place up to ${maxRuns} real/demo contracts on the selected account.`)) return;
        stopRef.current = false; setRunning(true); setStats({ runs: 0, wins: 0, losses: 0, pnl: 0, consecutiveLosses: 0 }); addLog('Auto Trader started.');
        let local = { runs: 0, wins: 0, losses: 0, pnl: 0, consecutiveLosses: 0 }; let currentStake = stake;
        try {
            while (!stopRef.current && local.runs < maxRuns && local.pnl < takeProfit && local.pnl > -stopLoss) {
                const history = await PremiumDerivApiService.ticksHistory(symbol, Math.max(100, streak + 20)); const digits = history.map(price => lastDigit(price, selected?.pip || 2)); const digit = digits[digits.length - 1];
                const activeBarrier = local.consecutiveLosses > 0 ? afterLossBarrier : barrier; const recent = digits.slice(-100);
                const ready = type === 'CALL' || type === 'PUT' ? true : recent.slice(-streak).every(value => conditionHit(type, value, activeBarrier, recent, mode));
                if (!ready) { addLog(`Waiting · last digit ${digit}, ${TRADE_LABELS[type]} condition not ready.`); await sleep(900); continue; }
                addLog(`Qualified · ${TRADE_LABELS[type]} ${needsBarrier(type) ? activeBarrier : ''} · stake ${currentStake.toFixed(2)} ${currency}`);
                const result = await purchase({ symbol, contractType: type, stake: currentStake, currency, barrier: needsBarrier(type) ? String(activeBarrier) : undefined }); const profit = result.settlement.profit;
                local = { runs: local.runs + 1, wins: local.wins + (profit >= 0 ? 1 : 0), losses: local.losses + (profit < 0 ? 1 : 0), pnl: local.pnl + profit, consecutiveLosses: profit < 0 ? local.consecutiveLosses + 1 : 0 };
                const trigger = martingaleMode === 'after_one' ? 1 : martingaleMode === 'after_two' ? 2 : martingaleMode === 'custom' ? lossTrigger : Infinity;
                currentStake = profit < 0 && local.consecutiveLosses >= trigger ? Number((currentStake * martingale).toFixed(2)) : stake; if (profit >= 0) currentStake = stake;
                setStats({ ...local }); addLog(`${profit >= 0 ? 'WIN' : 'LOSS'} · ${money(profit, currency)} · total ${money(local.pnl, currency)}`); await sleep(250);
            }
        } catch (err) { addLog(`ERROR · ${errorText(err)}`); }
        finally { setRunning(false); stopRef.current = true; addLog('Auto Trader stopped.'); }
    };
    return <div className='prodb-import-page'><PageHeader eyebrow='IMPORTED · AUTO TRADER' title='Auto Trader' subtitle='Strategy modes, digit conditions, before/after-loss prediction, martingale triggers, TP/SL and real Deriv contract execution are brought over from the source Auto Trades module.' right={<span className={`prodb-import-chip ${running ? 'is-running' : ''}`}>{running ? 'RUNNING' : 'READY'}</span>} />
        <div className='prodb-import-grid prodb-import-grid--auto'><section className='prodb-import-card'><div className='prodb-fields'><label>Market<MarketSelect markets={markets} value={symbol} onChange={setSymbol} /></label><label>Trade type<select value={type} onChange={e => setType(e.target.value as AutoTradeType)}>{Object.entries(TRADE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Strategy mode<select value={mode} onChange={e => setMode(e.target.value)}><option>STANDARD</option><option>INVERSE</option><option>PERCENTAGE</option></select></label>{needsBarrier(type) && <><label>Prediction / barrier<input type='number' min='0' max='9' value={barrier} onChange={e => setBarrier(clamp(Math.trunc(num(e.target.value)), 0, 9))} /></label><label>After-loss barrier<input type='number' min='0' max='9' value={afterLossBarrier} onChange={e => setAfterLossBarrier(clamp(Math.trunc(num(e.target.value)), 0, 9))} /></label></>}<label>Trigger streak<input type='number' min='1' max='10' value={streak} onChange={e => setStreak(clamp(Math.trunc(num(e.target.value, 2)), 1, 10))} /></label><label>Base stake ({currency})<input type='number' min='.01' step='.01' value={stake} onChange={e => setStake(Math.max(.01, num(e.target.value, 1)))} /></label><label>Martingale mode<select value={martingaleMode} onChange={e => setMartingaleMode(e.target.value)}><option value='none'>No martingale</option><option value='after_one'>After one loss</option><option value='after_two'>After two losses</option><option value='custom'>Custom consecutive losses</option></select></label><label>Multiplier<input type='number' min='1' step='.1' value={martingale} onChange={e => setMartingale(Math.max(1, num(e.target.value, 2)))} /></label>{martingaleMode === 'custom' && <label>Loss trigger<input type='number' min='1' max='10' value={lossTrigger} onChange={e => setLossTrigger(clamp(Math.trunc(num(e.target.value, 2)), 1, 10))} /></label>}<label>Take profit<input type='number' min='.01' value={takeProfit} onChange={e => setTakeProfit(Math.max(.01, num(e.target.value, 20)))} /></label><label>Stop loss<input type='number' min='.01' value={stopLoss} onChange={e => setStopLoss(Math.max(.01, num(e.target.value, 20)))} /></label><label>Max runs<input type='number' min='1' max='100' value={maxRuns} onChange={e => setMaxRuns(clamp(Math.trunc(num(e.target.value, 20)), 1, 100))} /></label></div><label className='prodb-strategy-text'>Describe strategy in plain English<textarea rows={4} value={strategyText} onChange={e => setStrategyText(e.target.value)} placeholder='Example: over 3, stake 1, take profit 10, stop loss 5, after loss use 5, percentage mode' /></label><div className='prodb-import-actions'><button onClick={applyText}>Apply strategy text</button><button className='is-primary' disabled={running} onClick={start}>Start auto trade</button><button className='is-danger' disabled={!running} onClick={() => { stopRef.current = true; setRunning(false); }}>Stop</button></div>{(marketError || tickError) && <div className='prodb-live-error'>{marketError || tickError}</div>}</section>
        <section className='prodb-import-card'><div className='prodb-auto-metrics'><div><small>RUNS</small><strong>{stats.runs}</strong></div><div><small>WINS</small><strong>{stats.wins}</strong></div><div><small>LOSSES</small><strong>{stats.losses}</strong></div><div><small>NET P/L</small><strong className={stats.pnl >= 0 ? 'is-positive' : 'is-negative'}>{money(stats.pnl, currency)}</strong></div><div><small>LOSS STREAK</small><strong>{stats.consecutiveLosses}</strong></div><div><small>LAST DIGIT</small><strong>{prices.length ? lastDigit(prices[prices.length - 1], selected?.pip || 2) : '—'}</strong></div></div><div className='prodb-execution-log'>{logs.length === 0 ? <div className='prodb-live-empty'>Execution events will appear here.</div> : logs.map((line, index) => <code key={`${line}-${index}`}>{line}</code>)}</div></section></div></div>;
};

export const AdvancedManualTradingPage = () => {
    const { authData } = useApiBase(); const currency = authData?.currency || 'USD'; const { markets, symbol, setSymbol, selected, error: marketError } = useMarkets();
    const [windowSize, setWindowSize] = useState(1000); const { prices, error: tickError } = useTicks(symbol, windowSize); const [group, setGroup] = useState('even_odd'); const [barrier, setBarrier] = useState(3); const [stake, setStake] = useState(1); const [duration, setDuration] = useState(1); const [runs, setRuns] = useState(1); const [martingale, setMartingale] = useState(1); const [busy, setBusy] = useState(''); const [results, setResults] = useState<TradeResult[]>([]); const [error, setError] = useState('');
    const digits = useMemo(() => prices.map(price => lastDigit(price, selected?.pip || 2)), [prices, selected?.pip]); const counts = useMemo(() => Array.from({ length: 10 }, (_, digit) => digits.filter(value => value === digit).length), [digits]); const total = digits.length || 1; const max = Math.max(...counts), min = Math.min(...counts); const even = digits.filter(digit => digit % 2 === 0).length; const actions: Array<{ label: string; type: DigitTrade; barrier?: string }> = group === 'even_odd' ? [{ label: 'Even', type: 'DIGITEVEN' }, { label: 'Odd', type: 'DIGITODD' }] : group === 'over_under' ? [{ label: `Over ${barrier}`, type: 'DIGITOVER', barrier: String(barrier) }, { label: `Under ${barrier}`, type: 'DIGITUNDER', barrier: String(barrier) }] : [{ label: `Match ${barrier}`, type: 'DIGITMATCH', barrier: String(barrier) }, { label: `Differs ${barrier}`, type: 'DIGITDIFF', barrier: String(barrier) }];
    const execute = async (action: typeof actions[number]) => {
        if (!window.confirm(`Run ${runs} ${action.label} trade${runs === 1 ? '' : 's'} on ${selected?.label || symbol}?`)) return;
        setBusy(action.type); setError(''); setResults([]); let currentStake = stake; const next: TradeResult[] = [];
        try { for (let i = 0; i < runs; i++) { const bought = await purchase({ symbol, contractType: action.type, stake: currentStake, currency, barrier: action.barrier, duration }); next.push(bought.settlement); setResults([...next]); currentStake = bought.settlement.profit < 0 && martingale > 1 ? Number((currentStake * martingale).toFixed(2)) : stake; } } catch (err) { setError(errorText(err)); } finally { setBusy(''); }
    };
    return <div className='prodb-import-page'><PageHeader eyebrow='IMPORTED · MANUAL TRADING' title='Manual Trading' subtitle='The source digit desk is integrated with live tick statistics, coloured frequency ranks, trade groups, repeated runs and optional loss recovery.' />
        <section className='prodb-import-card'><div className='prodb-fields prodb-fields--manual'><label>Market<MarketSelect markets={markets} value={symbol} onChange={setSymbol} /></label><label>Ticks<input type='number' min='10' max='1000' value={windowSize} onChange={e => setWindowSize(clamp(Math.trunc(num(e.target.value, 1000)), 10, 1000))} /></label><label>Trade group<select value={group} onChange={e => setGroup(e.target.value)}><option value='even_odd'>Even / Odd</option><option value='over_under'>Over / Under</option><option value='matches_differs'>Matches / Differs</option></select></label>{group !== 'even_odd' && <label>Barrier<input type='number' min='0' max='9' value={barrier} onChange={e => setBarrier(clamp(Math.trunc(num(e.target.value)), 0, 9))} /></label>}<label>Stake<input type='number' min='.01' step='.01' value={stake} onChange={e => setStake(Math.max(.01, num(e.target.value, 1)))} /></label><label>Duration<input type='number' min='1' max='10' value={duration} onChange={e => setDuration(clamp(Math.trunc(num(e.target.value, 1)), 1, 10))} /></label><label>Runs<input type='number' min='1' max='100' value={runs} onChange={e => setRuns(clamp(Math.trunc(num(e.target.value, 1)), 1, 100))} /></label><label>Loss multiplier<input type='number' min='1' step='.1' value={martingale} onChange={e => setMartingale(Math.max(1, num(e.target.value, 1)))} /></label></div><div className='prodb-manual-tick'><div><small>CURRENT TICK</small><strong>{prices.length ? prices[prices.length - 1].toFixed(selected?.pip || 2) : '—'}</strong></div><div className='prodb-manual-digits'>{counts.map((count, digit) => <div key={digit}><span className={count === max ? 'is-high' : count === min ? 'is-low' : ''}>{digit}</span><small>{((count / total) * 100).toFixed(2)}%</small><em>{count}/{digits.length}</em></div>)}</div><div className='prodb-manual-parity'><span>Even <b>{((even / total) * 100).toFixed(2)}%</b></span><span>Odd <b>{(((digits.length - even) / total) * 100).toFixed(2)}%</b></span></div></div><div className='prodb-import-actions'>{actions.map(action => <button className={action.type === 'DIGITODD' || action.type === 'DIGITUNDER' || action.type === 'DIGITDIFF' ? 'is-down' : 'is-up'} disabled={Boolean(busy)} onClick={() => execute(action)} key={action.type}>{busy === action.type ? 'Executing…' : action.label}</button>)}</div>{(error || marketError || tickError) && <div className='prodb-live-error'>{error || marketError || tickError}</div>}{results.length > 0 && <div className='prodb-result-strip'>{results.map((result, index) => <span className={result.profit >= 0 ? 'is-win' : 'is-loss'} key={index}>{result.status} {money(result.profit, currency)}</span>)}</div>}</section></div>;
};

const analyseScanner = (strategy: string, prices: number[], decimals: number) => {
    const digits = prices.map(price => lastDigit(price, decimals)); const total = digits.length || 1;
    if (strategy === 'Even & Odd') { const even = digits.filter(d => d % 2 === 0).length; return even >= digits.length - even ? { label: 'Even', type: 'DIGITEVEN' as AutoTradeType, confidence: even / total * 100 } : { label: 'Odd', type: 'DIGITODD' as AutoTradeType, confidence: (digits.length - even) / total * 100 }; }
    if (strategy === 'Over & Under') { const over = digits.filter(d => d > 4).length; return over >= digits.length - over ? { label: 'Over 4', type: 'DIGITOVER' as AutoTradeType, barrier: '4', confidence: over / total * 100 } : { label: 'Under 5', type: 'DIGITUNDER' as AutoTradeType, barrier: '5', confidence: (digits.length - over) / total * 100 }; }
    if (strategy === 'Matches & Differs') { const counts = Array.from({ length: 10 }, (_, d) => digits.filter(v => v === d).length); const least = counts.indexOf(Math.min(...counts)); return { label: `Differs ${least}`, type: 'DIGITDIFF' as AutoTradeType, barrier: String(least), confidence: (1 - counts[least] / total) * 100 }; }
    let up = 0, down = 0; prices.slice(1).forEach((price, index) => price > prices[index] ? up++ : price < prices[index] ? down++ : undefined); const directional = up + down || 1; return up >= down ? { label: 'Rise', type: 'CALL' as AutoTradeType, confidence: up / directional * 100 } : { label: 'Fall', type: 'PUT' as AutoTradeType, confidence: down / directional * 100 };
};

export const SpeedbotPage = () => {
    const { authData } = useApiBase(); const currency = authData?.currency || 'USD'; const { markets, symbol, setSymbol, selected, error: marketError } = useMarkets(); const [windowSize, setWindowSize] = useState(1000); const { prices, error: tickError, refresh } = useTicks(symbol, windowSize); const [strategy, setStrategy] = useState('Matches & Differs'); const [mode, setMode] = useState('Analyze'); const [stake, setStake] = useState(1); const [runs, setRuns] = useState(1); const [tp, setTp] = useState(10); const [sl, setSl] = useState(10); const [busy, setBusy] = useState(false); const [logs, setLogs] = useState<string[]>([]); const signal = useMemo(() => analyseScanner(strategy, prices, selected?.pip || 2), [strategy, prices, selected?.pip]);
    const execute = async () => { if (!window.confirm(`Execute ${signal.label} for up to ${runs} run${runs === 1 ? '' : 's'}?`)) return; setBusy(true); let pnl = 0; const next: string[] = []; try { for (let i = 0; i < runs && pnl < tp && pnl > -sl; i++) { const trade = await purchase({ symbol, contractType: signal.type, stake, currency, barrier: signal.barrier }); pnl += trade.settlement.profit; next.unshift(`${trade.settlement.status.toUpperCase()} · ${signal.label} · ${money(trade.settlement.profit, currency)} · net ${money(pnl, currency)}`); setLogs([...next]); } } catch (err) { next.unshift(`ERROR · ${errorText(err)}`); setLogs([...next]); } finally { setBusy(false); } };
    return <div className='prodb-import-page'><PageHeader eyebrow='IMPORTED · SPEEDBOT' title='Speedbot Scanner' subtitle='The source scanner is rebuilt with real tick history, four analysis families and an optional execution mode using live Deriv proposals.' right={<span className='prodb-import-chip'>{signal.confidence.toFixed(1)}% signal</span>} /><div className='prodb-import-grid'><section className='prodb-import-card'><div className='prodb-fields'><label>Market<MarketSelect markets={markets} value={symbol} onChange={setSymbol} /></label><label>Strategy<select value={strategy} onChange={e => setStrategy(e.target.value)}><option>Matches & Differs</option><option>Even & Odd</option><option>Over & Under</option><option>Rise & Fall</option></select></label><label>Mode<select value={mode} onChange={e => setMode(e.target.value)}><option>Analyze</option><option>Trade</option></select></label><label>Tick sample<input type='number' min='50' max='1000' value={windowSize} onChange={e => setWindowSize(clamp(Math.trunc(num(e.target.value, 1000)), 50, 1000))} /></label><label>Stake<input type='number' min='.01' value={stake} onChange={e => setStake(Math.max(.01, num(e.target.value, 1)))} /></label><label>Runs<input type='number' min='1' max='100' value={runs} onChange={e => setRuns(clamp(Math.trunc(num(e.target.value, 1)), 1, 100))} /></label><label>Take profit<input type='number' min='.01' value={tp} onChange={e => setTp(Math.max(.01, num(e.target.value, 10)))} /></label><label>Stop loss<input type='number' min='.01' value={sl} onChange={e => setSl(Math.max(.01, num(e.target.value, 10)))} /></label></div><div className='prodb-scanner-result'><small>ANALYSIS COMPLETE</small><strong>{signal.label}</strong><span>Confidence {signal.confidence.toFixed(2)}% · {prices.length} ticks</span></div><div className='prodb-import-actions'><button onClick={refresh}>Re-analyze</button>{mode === 'Trade' && <button className='is-primary' disabled={busy} onClick={execute}>{busy ? 'Executing…' : `Trade ${signal.label}`}</button>}</div>{(marketError || tickError) && <div className='prodb-live-error'>{marketError || tickError}</div>}</section><section className='prodb-import-card'><h2>Scanner execution log</h2><div className='prodb-execution-log'>{logs.length ? logs.map((line, index) => <code key={index}>{line}</code>) : <div className='prodb-live-empty'>Analyze mode does not place a contract. Switch to Trade when you want to execute the current signal.</div>}</div></section></div></div>;
};

export const ProAIPage = () => {
    const { authData } = useApiBase(); const currency = authData?.currency || 'USD'; const { markets, symbol, setSymbol, selected, error: marketError } = useMarkets(); const { prices, error: tickError } = useTicks(symbol, 120); const [growthRate, setGrowthRate] = useState(.03); const [stake, setStake] = useState(1); const [takeProfitPct, setTakeProfitPct] = useState(100); const [autoCashout, setAutoCashout] = useState(true); const [martingale, setMartingale] = useState(1); const [runs, setRuns] = useState(1); const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<any>(null); const [results, setResults] = useState<TradeResult[]>([]); const [error, setError] = useState('');
    const getPreview = async () => { setError(''); try { setPreview(await PremiumDerivApiService.proposal({ amount: stake, basis: 'stake', contract_type: 'ACCU', currency, underlying_symbol: symbol, growth_rate: growthRate })); } catch (err) { setError(errorText(err)); } };
    useEffect(() => { if (symbol) void getPreview(); }, [symbol, growthRate, stake]);
    const execute = async () => { if (!preview?.id || !window.confirm(`Buy accumulator on ${selected?.label || symbol} at ${(growthRate * 100).toFixed(0)}% growth?`)) return; setBusy(true); setError(''); setResults([]); let currentStake = stake; const next: TradeResult[] = []; try { for (let i = 0; i < runs; i++) { const proposal = await PremiumDerivApiService.proposal({ amount: currentStake, basis: 'stake', contract_type: 'ACCU', currency, underlying_symbol: symbol, growth_rate: growthRate }); const bought = await PremiumDerivApiService.buy(proposal.id, num(proposal.ask_price, currentStake)); const contractId = Number(bought.contract_id); const started = Date.now(); let settled: TradeResult = { contractId, profit: 0, status: 'open' }; while (Date.now() - started < 65000) { const response = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId }); const contract = response.proposal_open_contract || {}; const profit = num(contract.profit); const pct = currentStake ? profit / currentStake * 100 : 0; if (autoCashout && pct >= takeProfitPct && !contract.is_sold) { await PremiumDerivApiService.sell(contractId, 0); }
                    if (contract.is_sold || ['won','lost','sold'].includes(String(contract.status || '').toLowerCase())) { settled = { contractId, profit, status: contract.status || (profit >= 0 ? 'won' : 'lost') }; break; } await sleep(650); }
                next.push(settled); setResults([...next]); currentStake = settled.profit < 0 && martingale > 1 ? Number((currentStake * martingale).toFixed(2)) : stake; } } catch (err) { setError(errorText(err)); } finally { setBusy(false); void getPreview(); } };
    return <div className='prodb-import-page'><PageHeader eyebrow='IMPORTED · PRO AI' title='Pro AI Accumulators' subtitle='The source Accumulators module is retained with live proposal preview, selectable growth rate, auto-cashout target, repeated runs and optional loss multiplier.' right={<span className='prodb-live-badge is-live'>LIVE {prices.length ? prices[prices.length - 1].toFixed(selected?.pip || 2) : '—'}</span>} /><div className='prodb-import-grid'><section className='prodb-import-card'><div className='prodb-fields'><label>Market<MarketSelect markets={markets} value={symbol} onChange={setSymbol} /></label><label>Growth rate<select value={growthRate} onChange={e => setGrowthRate(num(e.target.value, .03))}>{[.01,.02,.03,.04,.05].map(rate => <option key={rate} value={rate}>{rate * 100}%</option>)}</select></label><label>Stake<input type='number' min='.01' step='.01' value={stake} onChange={e => setStake(Math.max(.01, num(e.target.value, 1)))} /></label><label>Runs<input type='number' min='1' max='50' value={runs} onChange={e => setRuns(clamp(Math.trunc(num(e.target.value, 1)), 1, 50))} /></label><label>Take-profit %<input type='number' min='1' value={takeProfitPct} onChange={e => setTakeProfitPct(Math.max(1, num(e.target.value, 100)))} /></label><label>Loss multiplier<input type='number' min='1' step='.1' value={martingale} onChange={e => setMartingale(Math.max(1, num(e.target.value, 1)))} /></label></div><label className='prodb-check-row'><input type='checkbox' checked={autoCashout} onChange={e => setAutoCashout(e.target.checked)} /> Auto cashout when the contract profit reaches the configured percentage</label><div className='prodb-proposal-preview'><span>LIVE PROPOSAL</span><strong>{preview ? money(preview.ask_price, currency) : '—'}</strong><small>Maximum payout {preview?.payout ? money(preview.payout, currency) : '—'}</small></div><div className='prodb-import-actions'><button onClick={getPreview}>Refresh proposal</button><button className='is-primary' disabled={busy || !preview?.id} onClick={execute}>{busy ? 'Running…' : 'Buy accumulator'}</button></div>{(error || marketError || tickError) && <div className='prodb-live-error'>{error || marketError || tickError}</div>}</section><section className='prodb-import-card'><h2>Accumulator runs</h2><div className='prodb-result-list'>{results.length ? results.map((result, index) => <article key={index}><span>#{index + 1}</span><strong className={result.profit >= 0 ? 'is-positive' : 'is-negative'}>{money(result.profit, currency)}</strong><small>{result.status}</small></article>) : <div className='prodb-live-empty'>No accumulator contract has been run from this page yet.</div>}</div></section></div></div>;
};

export const SourceAnalysisToolsPage = () => <div className='prodb-import-page prodb-iframe-page'><PageHeader eyebrow='IMPORTED · ANALYSISTOOLS' title='Analysis Tools Hub' subtitle='The source Analysis Tool page is preserved inside the new premium shell.' /><iframe src='https://api.binarytool.site' title='Analysis Tools' allow='clipboard-read; clipboard-write' /></div>;

export const DTraderPage = () => <div className='prodb-import-page prodb-iframe-page'><PageHeader eyebrow='IMPORTED · DTRADER' title='DTrader Charts' subtitle='The source DTrader page is preserved with the Deriv chart workspace inside the premium navigation.' /><iframe src='https://charts.deriv.com/deriv' title='Deriv DTrader charts' allow='fullscreen' /></div>;

export const ImportedBestBotsSource = [
    { tag: 'APEX', title: 'grffy v1', file: 'grffy v1.xml', description: 'Apex Sentinel bundled strategy, ready for direct Bot Builder loading.' },
    { tag: 'APEX', title: 'Mr Duke Speed Bot.1', file: 'Mr Duke Speed Bot.1.xml', description: 'Fast execution bot bundled with Apex Sentinel.' },
    { tag: 'APEX', title: 'Wealth Generator', file: 'Wealth Generator.xml', description: 'Strategy bundled with Apex Sentinel for direct Bot Builder loading.' },
];

export const loadSourceBot = async (file: string, openBotBuilder: () => void) => {
    const candidatePaths = [`${SOURCE_BOT_PATH}/${encodeURIComponent(file)}`];
    let lastError = '';
    for (const path of candidatePaths) {
        try { const response = await fetch(path); if (!response.ok) { lastError = `${response.status}`; continue; } const xml = await response.text(); if (!xml.includes('<xml') && !xml.includes('block')) { lastError = 'not XML'; continue; } await loadXml(xml, file, openBotBuilder); return; } catch (err) { lastError = errorText(err); }
    }
    throw new Error(`The source bot file could not be loaded (${lastError || 'file not found'}).`);
};
