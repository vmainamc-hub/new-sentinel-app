import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { load, save_types } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

type StrategyId = 'over1_under8' | 'over2_under7' | 'over3_under6';
type ContractSide = 'DIGITOVER' | 'DIGITUNDER';
type Point = { x: number; y: number };
type Strategy = { id: StrategyId; label: string; over: number; under: number };
type Market = { symbol: string; name: string; pipSize: number };
type Result = {
    symbol: string;
    market: string;
    primarySide: ContractSide;
    primaryBarrier: number;
    recoverySide: ContractSide;
    recoveryBarrier: number;
    confidence: number;
    sampleSize: number;
    primaryRate: number;
    recentRate: number;
};

const STRATEGIES: Strategy[] = [
    { id: 'over1_under8', label: 'Over1 / Under8', over: 1, under: 8 },
    { id: 'over2_under7', label: 'Over2 / Under7', over: 2, under: 7 },
    { id: 'over3_under6', label: 'Over3 / Under6', over: 3, under: 6 },
];
const ORB_KEY = 'prodb.ai2.orb.v1';
const PANEL_KEY = 'prodb.ai2.panel.v1';
const TEMPLATE_URL = '/ai-scanner/grffy.xml';
const ORB = 58;
const PANEL_W = 430;
const PANEL_H = 520;
const GAP = 10;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const textFor = (side: ContractSide, barrier: number) => `${side === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`;

const readPoint = (key: string, fallback: Point): Point => {
    try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null');
        if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) return raw;
    } catch { /* UI preference only */ }
    return fallback;
};

const defaultOrb = (): Point => ({
    x: Math.max(GAP, window.innerWidth - ORB - 18),
    y: clamp(Math.round(window.innerHeight * 0.22), 90, window.innerHeight - ORB - 90),
});

const clampOrb = (point: Point): Point => ({
    x: clamp(point.x, GAP, window.innerWidth - ORB - GAP),
    y: clamp(point.y, GAP, window.innerHeight - ORB - GAP),
});

const panelSize = () => ({
    width: Math.min(PANEL_W, Math.max(280, window.innerWidth - 16)),
    height: Math.min(PANEL_H, Math.max(320, window.innerHeight - 84)),
});

const clampPanel = (point: Point, reserveRight = 0): Point => {
    const { width, height } = panelSize();
    const maxX = Math.max(GAP, window.innerWidth - reserveRight - width - GAP);
    return {
        x: clamp(point.x, GAP, maxX),
        y: clamp(point.y, 58, window.innerHeight - height - GAP),
    };
};

const pipSize = (item: any) => {
    const direct = Number(item?.pip_size ?? item?.decimal_places);
    if (Number.isFinite(direct) && direct >= 0 && direct <= 10) return Math.round(direct);
    const pip = Number(item?.pip);
    return Number.isFinite(pip) && pip > 0 && pip < 1 ? Math.max(0, Math.round(-Math.log10(pip))) : 2;
};

const marketsFrom = (items: any[]): Market[] => {
    const unique = new Map<string, Market>();
    items.forEach(item => {
        const symbol = String(item?.underlying_symbol || item?.symbol || '').trim();
        const name = String(item?.underlying_symbol_name || item?.display_name || item?.name || symbol).trim();
        if (!symbol) return;
        if (!/^R_\d+$/i.test(symbol) && !/^1HZ\d+V$/i.test(symbol) && !/volatility/i.test(name)) return;
        unique.set(symbol, { symbol, name: name || symbol, pipSize: pipSize(item) });
    });
    return [...unique.values()];
};

const digitsFrom = (prices: number[], decimals: number) => prices
    .map(Number)
    .filter(Number.isFinite)
    .map(price => Number(price.toFixed(clamp(decimals, 0, 10)).slice(-1)))
    .filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);

const rate = (digits: number[], side: ContractSide, barrier: number) => {
    if (!digits.length) return 0;
    const wins = digits.filter(digit => side === 'DIGITOVER' ? digit > barrier : digit < barrier).length;
    return wins / digits.length;
};

const analyze = async (market: Market, strategy: Strategy, requestedTicks: number): Promise<Result> => {
    const prices = await PremiumDerivApiService.ticksHistory(market.symbol, requestedTicks, 'ticks');
    const digits = digitsFrom(prices, market.pipSize);
    if (digits.length < 30) throw new Error(`${market.name} returned only ${digits.length} usable ticks.`);
    const recent = digits.slice(-Math.min(250, Math.max(30, Math.round(digits.length * .12))));
    const candidates = [
        { primarySide: 'DIGITOVER' as ContractSide, primaryBarrier: strategy.over, recoverySide: 'DIGITUNDER' as ContractSide, recoveryBarrier: strategy.under },
        { primarySide: 'DIGITUNDER' as ContractSide, primaryBarrier: strategy.under, recoverySide: 'DIGITOVER' as ContractSide, recoveryBarrier: strategy.over },
    ].map(candidate => {
        const primaryRate = rate(digits, candidate.primarySide, candidate.primaryBarrier);
        const recentRate = rate(recent, candidate.primarySide, candidate.primaryBarrier);
        const recoveryRate = rate(recent, candidate.recoverySide, candidate.recoveryBarrier);
        const confidence = primaryRate * .55 + recentRate * .30 + recoveryRate * .15;
        return { ...candidate, primaryRate, recentRate, confidence };
    });
    const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
    return { symbol: market.symbol, market: market.name, sampleSize: digits.length, ...best, confidence: clamp(best.confidence, 0, 1) };
};

const direct = (element: Element, tag: string, name?: string) => Array.from(element.children).find(child =>
    child.localName === tag && (!name || child.getAttribute('name') === name)
);

const numericField = (block: Element) => {
    const value = direct(block, 'value', 'VALUE');
    if (!value) return undefined;
    return Array.from(value.getElementsByTagName('field')).find(field => field.getAttribute('name') === 'NUM');
};

const configureTemplate = (xml: string, result: Result) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Scanner bot XML is invalid.');
    const fields = Array.from(doc.getElementsByTagName('field'));
    const setFirst = (name: string, value: string) => {
        const field = fields.find(item => item.getAttribute('name') === name);
        if (!field) throw new Error(`Scanner template is missing ${name}.`);
        field.textContent = value;
    };

    setFirst('MARKET_LIST', 'synthetic_index');
    setFirst('SUBMARKET_LIST', result.symbol.startsWith('1HZ') ? 'random_index_1s' : 'random_index');
    setFirst('SYMBOL_LIST', result.symbol);
    setFirst('TRADETYPECAT_LIST', 'digits');
    setFirst('TRADETYPE_LIST', 'overunder');
    setFirst('TYPE_LIST', 'both');

    const blocks = Array.from(doc.getElementsByTagName('block'));
    blocks.filter(block => block.getAttribute('type') === 'variables_set').forEach(block => {
        const variable = direct(block, 'field', 'VAR')?.textContent?.trim();
        const number = numericField(block);
        if (!number) return;
        if (variable === 'Prediction before loss') number.textContent = String(result.primaryBarrier);
        if (variable === 'Prediction after loss') number.textContent = String(result.recoveryBarrier);
    });

    const beforePurchase = blocks.find(block => block.getAttribute('type') === 'before_purchase');
    const purchases = beforePurchase
        ? Array.from(beforePurchase.getElementsByTagName('block')).filter(block => block.getAttribute('type') === 'purchase')
        : [];
    const primary = purchases[0]?.getElementsByTagName('field')[0];
    const recovery = purchases[1]?.getElementsByTagName('field')[0];
    if (!primary || !recovery) throw new Error('Scanner template purchase blocks are missing.');
    primary.textContent = result.primarySide;
    recovery.textContent = result.recoverySide;

    // Verify the generated bot before it reaches Blockly. The visible scanner
    // signal and the first purchase branch must always be identical.
    if (primary.textContent !== result.primarySide || recovery.textContent !== result.recoverySide) {
        throw new Error('Scanner signal and generated bot do not match.');
    }
    return new XMLSerializer().serializeToString(doc.documentElement);
};

const waitForWorkspace = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace) return workspace;
        await sleep(100);
    }
    throw new Error('Bot Builder is not ready. Try Load Scanner Bot again.');
};

const GlobalAIScannerV2 = ({ openBotBuilder }: { openBotBuilder: () => void }) => {
    const store = useStore();
    const isRunPanelOpen = Boolean(store?.run_panel?.is_drawer_open);
    const [orb, setOrb] = useState<Point>(() => clampOrb(readPoint(ORB_KEY, defaultOrb())));
    const [panel, setPanel] = useState<Point>(() => clampPanel(readPoint(PANEL_KEY, { x: 18, y: 92 })));
    const [open, setOpen] = useState(false);
    const [strategyId, setStrategyId] = useState<StrategyId>('over1_under8');
    const [tickCount, setTickCount] = useState(3000);
    const [scanning, setScanning] = useState(false);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('Not scanned yet');
    const [error, setError] = useState('');
    const [result, setResult] = useState<Result | null>(null);
    const [top, setTop] = useState<Result[]>([]);
    const orbDrag = useRef({ id: -1, ox: 0, oy: 0, sx: 0, sy: 0, moved: false });
    const panelDrag = useRef({ id: -1, ox: 0, oy: 0 });
    const suppressClick = useRef(false);
    const strategy = useMemo(() => STRATEGIES.find(item => item.id === strategyId) || STRATEGIES[0], [strategyId]);
    const reserveRight = isRunPanelOpen && window.innerWidth > 768 ? 380 : 0;

    useEffect(() => {
        const resize = () => {
            setOrb(current => clampOrb(current));
            setPanel(current => clampPanel(current, reserveRight));
        };
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, [reserveRight]);

    useEffect(() => {
        if (isRunPanelOpen) setOpen(false);
    }, [isRunPanelOpen]);

    useEffect(() => { try { localStorage.setItem(ORB_KEY, JSON.stringify(orb)); } catch { /* UI only */ } }, [orb]);
    useEffect(() => { try { localStorage.setItem(PANEL_KEY, JSON.stringify(panel)); } catch { /* UI only */ } }, [panel]);

    const orbDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
        orbDrag.current = { id: e.pointerId, ox: e.clientX - orb.x, oy: e.clientY - orb.y, sx: e.clientX, sy: e.clientY, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const orbMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (orbDrag.current.id !== e.pointerId) return;
        if (Math.hypot(e.clientX - orbDrag.current.sx, e.clientY - orbDrag.current.sy) > 5) orbDrag.current.moved = true;
        if (orbDrag.current.moved) setOrb(clampOrb({ x: e.clientX - orbDrag.current.ox, y: e.clientY - orbDrag.current.oy }));
    };
    const orbUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (orbDrag.current.id !== e.pointerId) return;
        suppressClick.current = orbDrag.current.moved;
        orbDrag.current.id = -1;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    const orbClick = () => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        const { width } = panelSize();
        const suggested = { x: Math.max(GAP, orb.x - width - 10), y: Math.max(62, orb.y - 10) };
        setPanel(current => clampPanel(current.x === 18 && current.y === 92 ? suggested : current, reserveRight));
        setOpen(value => !value);
    };

    const panelDown = (e: ReactPointerEvent<HTMLElement>) => {
        if ((e.target as HTMLElement).closest('button')) return;
        panelDrag.current = { id: e.pointerId, ox: e.clientX - panel.x, oy: e.clientY - panel.y };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const panelMove = (e: ReactPointerEvent<HTMLElement>) => {
        if (panelDrag.current.id !== e.pointerId) return;
        setPanel(clampPanel({ x: e.clientX - panelDrag.current.ox, y: e.clientY - panelDrag.current.oy }, reserveRight));
    };
    const panelUp = (e: ReactPointerEvent<HTMLElement>) => {
        if (panelDrag.current.id !== e.pointerId) return;
        panelDrag.current.id = -1;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };

    const scan = useCallback(async () => {
        if (scanning) return;
        const count = clamp(Math.trunc(Number(tickCount) || 3000), 100, 5000);
        setTickCount(count);
        setScanning(true); setError(''); setResult(null); setTop([]);
        setStatus('Loading Deriv volatility markets…');
        try {
            const markets = marketsFrom(await PremiumDerivApiService.activeSymbols());
            if (!markets.length) throw new Error('No supported volatility markets were returned.');
            const completed: Result[] = [];
            const failures: string[] = [];
            for (let i = 0; i < markets.length; i += 3) {
                const batch = markets.slice(i, i + 3);
                setStatus(`Scanning ${i + 1}-${Math.min(i + batch.length, markets.length)} of ${markets.length} markets…`);
                const settled = await Promise.allSettled(batch.map(market => analyze(market, strategy, count)));
                settled.forEach((entry, index) => entry.status === 'fulfilled'
                    ? completed.push(entry.value)
                    : failures.push(`${batch[index].name}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`));
            }
            if (!completed.length) throw new Error(failures[0] || 'No market returned usable tick history.');
            completed.sort((a, b) => b.confidence - a.confidence || b.recentRate - a.recentRate);
            const best = completed[0];
            setResult(best); setTop(completed.slice(0, 3));
            setStatus(`Signal: ${best.market} · ${textFor(best.primarySide, best.primaryBarrier)} · bot will be configured to match this signal.`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStatus('Scan failed');
        } finally { setScanning(false); }
    }, [scanning, strategy, tickCount]);

    const loadBot = useCallback(async () => {
        if (!result || loading) return;
        setLoading(true); setError('');
        setStatus(`Configuring bot for ${textFor(result.primarySide, result.primaryBarrier)} on ${result.market}…`);
        try {
            const response = await fetch(TEMPLATE_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Scanner template returned HTTP ${response.status}.`);
            const configured = configureTemplate(await response.text(), result);
            localStorage.setItem('prodb.ai2.last-signal', JSON.stringify({
                symbol: result.symbol,
                market: result.market,
                trade: result.primarySide,
                barrier: result.primaryBarrier,
                recovery_trade: result.recoverySide,
                recovery_barrier: result.recoveryBarrier,
            }));
            openBotBuilder();
            const workspace = await waitForWorkspace();
            await load({
                block_string: configured,
                file_name: `AI ${result.symbol} ${textFor(result.primarySide, result.primaryBarrier)}.xml`,
                workspace,
                from: save_types.LOCAL,
                drop_event: {},
                strategy_id: null,
                showIncompatibleStrategyDialog: false,
            });
            setStatus(`Loaded bot: ${textFor(result.primarySide, result.primaryBarrier)} · recovery ${textFor(result.recoverySide, result.recoveryBarrier)} · ${result.market}`);
            setOpen(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStatus('Could not configure scanner bot');
        } finally { setLoading(false); }
    }, [loading, openBotBuilder, result]);

    const panelNode = open ? <section
        className='prodb-ai2-panel'
        role='dialog'
        aria-modal='false'
        aria-label='Entry Scanner'
        style={{ left: panel.x, top: panel.y }}
    >
        <header className='prodb-ai2-panel__header' onPointerDown={panelDown} onPointerMove={panelMove} onPointerUp={panelUp}>
            <strong>Entry Scanner</strong><span>Drag window</span><button type='button' onClick={() => setOpen(false)} aria-label='Close scanner'>×</button>
        </header>
        <div className='prodb-ai2-panel__body'>
            <div className='prodb-ai2-tabs'>{STRATEGIES.map(item => <button key={item.id} type='button' className={strategyId === item.id ? 'is-active' : ''} onClick={() => { setStrategyId(item.id); setResult(null); setTop([]); setStatus('Not scanned yet'); setError(''); }}>{item.label}</button>)}</div>
            <div className='prodb-ai2-intro'><div><strong>Digits Scanner</strong><small>Scans all supported volatility markets and configures the XML bot to the winning signal.</small></div><label><span>TICKS</span><input type='number' min='100' max='5000' step='100' value={tickCount} onChange={e => setTickCount(Number(e.target.value))} /></label></div>
            <div className='prodb-ai2-selection'><div><span>SELECTED MARKET</span><strong>{result?.market || 'Scan to find the best market'}</strong><small>{result ? `${result.symbol} · ${result.sampleSize} ticks` : '—'}</small></div><div><span>TRADE TYPE</span><strong>{result ? textFor(result.primarySide, result.primaryBarrier) : 'Waiting for scan'}</strong><small>{result ? `Recovery: ${textFor(result.recoverySide, result.recoveryBarrier)}` : '—'}</small></div></div>
            <div className={`prodb-ai2-status ${error ? 'is-error' : result ? 'is-ready' : ''}`}>{scanning && <i />}<span>{error || status}</span></div>
            {top.length > 0 && <div className='prodb-ai2-ranking'>{top.map((item, index) => <div key={item.symbol} className={index === 0 ? 'is-best' : ''}><b>#{index + 1}</b><span>{item.market}<small>{textFor(item.primarySide, item.primaryBarrier)}</small></span><strong>{(item.confidence * 100).toFixed(1)}%</strong></div>)}</div>}
            <div className='prodb-ai2-actions'><button type='button' className='is-primary' disabled={scanning || loading} onClick={() => void scan()}>{scanning ? 'Scanning…' : 'Scan Markets'}</button><button type='button' disabled={!result || scanning || loading} onClick={() => void loadBot()}>{loading ? 'Configuring…' : 'Load Matching Bot'}</button></div>
        </div>
    </section> : null;

    return <>
        <button type='button' className='prodb-ai-button prodb-ai2-orb' style={{ left: orb.x, top: orb.y }} title='AI Entry Scanner · drag to move' aria-label='Open AI entry scanner' onPointerDown={orbDown} onPointerMove={orbMove} onPointerUp={orbUp} onClick={orbClick}><span>AI</span></button>
        {panelNode && createPortal(panelNode, document.body)}
    </>;
};

export default GlobalAIScannerV2;
