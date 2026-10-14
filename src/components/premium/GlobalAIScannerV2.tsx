import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/hooks/useStore';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import { SCANNER_BOTS } from './ai-scanner/scanner-bots';
import { loadSignalIntoScannerBot, prefetchScannerBots } from './ai-scanner/scanner-loader';

type StrategyId = 'over1_under8' | 'over2_under7' | 'over3_under6';
type ContractSide = 'DIGITOVER' | 'DIGITUNDER';
type Point = { x: number; y: number };
type Strategy = { id: StrategyId; label: string; over: number; under: number };
type Market = { symbol: string; name: string; pipSize: number; submarket?: string };
type Result = {
    symbol: string;
    market: string;
    submarket?: string;
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
const ORB = 58;
const PANEL_W = 430;
const PANEL_H = 520;
const GAP = 10;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const textFor = (side: ContractSide, barrier: number) => `${side === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`;

const readPoint = (key: string, fallback: Point): Point => {
    try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null');
        if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) return raw;
    } catch { /* UI preference only */ }
    return fallback;
};

const defaultOrb = (): Point => ({
    // Bottom-left, just above the status bar, so it never covers the tab bar or page content.
    x: GAP + 10,
    y: Math.max(GAP, window.innerHeight - ORB - 58),
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
        const submarket = String(item?.submarket || '').trim();
        unique.set(symbol, { symbol, name: name || symbol, pipSize: pipSize(item), ...(submarket ? { submarket } : {}) });
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
    return { symbol: market.symbol, market: market.name, submarket: market.submarket, sampleSize: digits.length, ...best, confidence: clamp(best.confidence, 0, 1) };
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

    // Download bots 11 and 26 as soon as the scanner opens, so loading one later never depends on a fresh request.
    useEffect(() => {
        if (open) prefetchScannerBots();
    }, [open]);

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
        const bot = SCANNER_BOTS[result.primarySide];
        setLoading(true); setError('');
        setStatus(`Configuring bot ${bot.number} for ${textFor(result.primarySide, result.primaryBarrier)} on ${result.market}…`);
        try {
            await loadSignalIntoScannerBot({
                symbol: result.symbol,
                contract: result.primarySide,
                barrier: result.primaryBarrier,
                submarket: result.submarket,
            }, openBotBuilder);
            try {
                localStorage.setItem('prodb.ai2.last-signal', JSON.stringify({
                    symbol: result.symbol,
                    market: result.market,
                    trade: result.primarySide,
                    barrier: result.primaryBarrier,
                    recovery_trade: bot.recovery.contract,
                    recovery_barrier: bot.recovery.barrier,
                    bot_number: bot.number,
                }));
            } catch { /* the signal note is a convenience only */ }
            setStatus(`Loaded bot ${bot.number} (${bot.name}): ${textFor(result.primarySide, result.primaryBarrier)} · recovery ${textFor(bot.recovery.contract, bot.recovery.barrier)} · ${result.market}. Press Run in Bot Builder.`);
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
            <div className='prodb-ai2-selection'><div><span>SELECTED MARKET</span><strong>{result?.market || 'Scan to find the best market'}</strong><small>{result ? `${result.symbol} · ${result.sampleSize} ticks` : '—'}</small></div><div><span>TRADE TYPE</span><strong>{result ? textFor(result.primarySide, result.primaryBarrier) : 'Waiting for scan'}</strong><small>{result ? `Bot ${SCANNER_BOTS[result.primarySide].number} · Recovery: ${textFor(SCANNER_BOTS[result.primarySide].recovery.contract, SCANNER_BOTS[result.primarySide].recovery.barrier)}` : '—'}</small></div></div>
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
