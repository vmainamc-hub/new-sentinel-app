import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { load, save_types } from '@/external/bot-skeleton';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

type StrategyId = 'over1_under8' | 'over2_under7' | 'over3_under6';
type ContractSide = 'DIGITOVER' | 'DIGITUNDER';
type Position = { x: number; y: number };

type ScannerStrategy = {
    id: StrategyId;
    label: string;
    over: number;
    under: number;
};

type ScannerMarket = {
    symbol: string;
    name: string;
    pipSize: number;
};

type ScanResult = {
    symbol: string;
    market: string;
    primarySide: ContractSide;
    primaryBarrier: number;
    recoverySide: ContractSide;
    recoveryBarrier: number;
    confidence: number;
    primaryRate: number;
    recentRate: number;
    recoveryRate: number;
    sampleSize: number;
};

const STRATEGIES: ScannerStrategy[] = [
    { id: 'over1_under8', label: 'Over1 / Under8', over: 1, under: 8 },
    { id: 'over2_under7', label: 'Over2 / Under7', over: 2, under: 7 },
    { id: 'over3_under6', label: 'Over3 / Under6', over: 3, under: 6 },
];

const BUTTON_SIZE = 58;
const PANEL_WIDTH = 430;
const PANEL_HEIGHT = 500;
const SCREEN_MARGIN = 10;
const POSITION_KEY = 'prodb.ai-scanner.position.v1';
const PANEL_POSITION_KEY = 'prodb.ai-scanner.panel-position.v1';
const TEMPLATE_URL = '/ai-scanner/grffy.xml';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

const defaultButtonPosition = (): Position => {
    if (typeof window === 'undefined') return { x: 20, y: 180 };
    return {
        x: Math.max(SCREEN_MARGIN, window.innerWidth - BUTTON_SIZE - 18),
        y: clamp(Math.round(window.innerHeight * 0.22), 90, window.innerHeight - BUTTON_SIZE - 110),
    };
};

const panelDimensions = () => {
    if (typeof window === 'undefined') return { width: PANEL_WIDTH, height: PANEL_HEIGHT };
    return {
        width: Math.min(PANEL_WIDTH, Math.max(280, window.innerWidth - 16)),
        height: Math.min(PANEL_HEIGHT, Math.max(330, window.innerHeight - 86)),
    };
};

const defaultPanelPosition = (): Position => {
    if (typeof window === 'undefined') return { x: 18, y: 100 };
    const { width } = panelDimensions();
    const mobile = window.innerWidth <= 768;
    if (mobile) return { x: 8, y: Math.max(68, Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--prodb-mobile-header-stack')) || 68) };

    // Leave the native right-side Run Panel its own lane. The scanner opens on
    // the application workspace and can then be dragged anywhere in that area.
    const x = window.innerWidth - width - 390;
    return { x: clamp(x, 18, window.innerWidth - width - 18), y: 100 };
};

const readStoredPosition = (key: string, fallback: () => Position): Position => {
    if (typeof window === 'undefined') return fallback();
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return parsed;
    } catch {
        // Ignore malformed saved UI state.
    }
    return fallback();
};

const clampButtonPosition = (position: Position): Position => {
    if (typeof window === 'undefined') return position;
    return {
        x: clamp(position.x, SCREEN_MARGIN, window.innerWidth - BUTTON_SIZE - SCREEN_MARGIN),
        y: clamp(position.y, SCREEN_MARGIN, window.innerHeight - BUTTON_SIZE - SCREEN_MARGIN),
    };
};

const clampPanelPosition = (position: Position): Position => {
    if (typeof window === 'undefined') return position;
    const { width, height } = panelDimensions();
    const topBoundary = window.innerWidth <= 768 ? 62 : 70;
    return {
        x: clamp(position.x, 8, window.innerWidth - width - 8),
        y: clamp(position.y, topBoundary, window.innerHeight - height - 8),
    };
};

const toPipSize = (market: any) => {
    const direct = Number(market?.pip_size ?? market?.decimal_places);
    if (Number.isFinite(direct) && Number.isInteger(direct) && direct >= 0 && direct <= 10) return direct;
    const pip = Number(market?.pip_size ?? market?.pip);
    if (Number.isFinite(pip) && pip > 0 && pip < 1) return Math.max(0, Math.round(-Math.log10(pip)));
    return 2;
};

const normalizeMarkets = (symbols: any[]): ScannerMarket[] => {
    const unique = new Map<string, ScannerMarket>();
    symbols.forEach(item => {
        const symbol = String(item?.underlying_symbol || item?.symbol || '').trim();
        const name = String(item?.underlying_symbol_name || item?.display_name || item?.name || symbol).trim();
        if (!symbol) return;

        const isVolatilitySymbol = /^R_\d+$/i.test(symbol) || /^1HZ\d+V$/i.test(symbol);
        const isVolatilityName = /volatility/i.test(name);
        if (!isVolatilitySymbol && !isVolatilityName) return;
        unique.set(symbol, { symbol, name: name || symbol, pipSize: toPipSize(item) });
    });
    return [...unique.values()];
};

const lastDigits = (prices: unknown[], pipSize: number) => prices
    .map(price => Number(price))
    .filter(Number.isFinite)
    .map(price => {
        const fixed = price.toFixed(Math.max(0, Math.min(10, pipSize)));
        const digit = Number(fixed.charAt(fixed.length - 1));
        return Number.isInteger(digit) ? digit : -1;
    })
    .filter(digit => digit >= 0 && digit <= 9);

const winRate = (digits: number[], side: ContractSide, barrier: number) => {
    if (!digits.length) return 0;
    const wins = digits.reduce((count, digit) => count + (side === 'DIGITOVER' ? Number(digit > barrier) : Number(digit < barrier)), 0);
    return wins / digits.length;
};

const expectedRate = (side: ContractSide, barrier: number) => side === 'DIGITOVER' ? (9 - barrier) / 10 : barrier / 10;

const analyzeMarket = async (market: ScannerMarket, strategy: ScannerStrategy, tickCount: number): Promise<ScanResult> => {
    // PremiumDerivApiService.ticksHistory() already normalizes the Deriv response
    // into a plain number[]. The previous scanner incorrectly tried to read
    // history.history.prices and therefore treated every successful response as 0 ticks.
    let prices = await PremiumDerivApiService.ticksHistory(market.symbol, tickCount, 'ticks');
    if (!Array.isArray(prices)) prices = [];

    // Some markets can return fewer records than requested. A scanner should use
    // the real sample it received rather than fail because it did not equal 3000.
    if (prices.length < 30 && tickCount > 500) {
        const fallback = await PremiumDerivApiService.ticksHistory(market.symbol, 500, 'ticks');
        if (Array.isArray(fallback) && fallback.length > prices.length) prices = fallback;
    }

    const digits = lastDigits(prices, market.pipSize);
    if (digits.length < 30) {
        throw new Error(`${market.name} returned only ${digits.length} usable ticks.`);
    }

    const recentCount = Math.min(250, Math.max(30, Math.round(digits.length * 0.1)));
    const recent = digits.slice(-recentCount);
    const candidates = [
        {
            primarySide: 'DIGITOVER' as ContractSide,
            primaryBarrier: strategy.over,
            recoverySide: 'DIGITUNDER' as ContractSide,
            recoveryBarrier: strategy.under,
        },
        {
            primarySide: 'DIGITUNDER' as ContractSide,
            primaryBarrier: strategy.under,
            recoverySide: 'DIGITOVER' as ContractSide,
            recoveryBarrier: strategy.over,
        },
    ].map(candidate => {
        const primaryRate = winRate(digits, candidate.primarySide, candidate.primaryBarrier);
        const recentRate = winRate(recent, candidate.primarySide, candidate.primaryBarrier);
        const recoveryRate = winRate(recent, candidate.recoverySide, candidate.recoveryBarrier);
        const baseline = expectedRate(candidate.primarySide, candidate.primaryBarrier);
        const edge = primaryRate - baseline;
        const confidence = (primaryRate * 0.55) + (recentRate * 0.30) + (recoveryRate * 0.15) + Math.max(-0.03, Math.min(0.03, edge));
        return { ...candidate, primaryRate, recentRate, recoveryRate, confidence };
    });

    const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
    return {
        symbol: market.symbol,
        market: market.name,
        ...best,
        confidence: Math.max(0, Math.min(1, best.confidence)),
        sampleSize: digits.length,
    };
};

const strategyText = (side: ContractSide, barrier: number) => `${side === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`;

const directChild = (element: Element, tag: string, name?: string) => Array.from(element.children).find(child =>
    child.localName === tag && (!name || child.getAttribute('name') === name)
);

const numericValueField = (block: Element) => {
    const value = directChild(block, 'value', 'VALUE');
    if (!value) return undefined;
    return Array.from(value.getElementsByTagName('field')).find(field => field.getAttribute('name') === 'NUM');
};

const configureTemplate = (xmlText: string, result: ScanResult) => {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(xmlText, 'application/xml');
    const parseError = documentNode.getElementsByTagName('parsererror')[0];
    if (parseError) throw new Error('The scanner bot template XML could not be parsed.');

    const fields = Array.from(documentNode.getElementsByTagName('field'));
    const setField = (name: string, value: string) => {
        const field = fields.find(item => item.getAttribute('name') === name);
        if (field) field.textContent = value;
    };

    setField('MARKET_LIST', 'synthetic_index');
    setField('SUBMARKET_LIST', result.symbol.startsWith('1HZ') ? 'random_index_1s' : 'random_index');
    setField('SYMBOL_LIST', result.symbol);
    setField('TRADETYPECAT_LIST', 'digits');
    setField('TRADETYPE_LIST', 'overunder');
    setField('TYPE_LIST', 'both');

    const blocks = Array.from(documentNode.getElementsByTagName('block'));
    blocks.filter(block => block.getAttribute('type') === 'variables_set').forEach(block => {
        const variableField = directChild(block, 'field', 'VAR');
        const variableName = variableField?.textContent?.trim();
        const numberField = numericValueField(block);
        if (!numberField) return;
        if (variableName === 'Prediction before loss') numberField.textContent = String(result.primaryBarrier);
        if (variableName === 'Prediction after loss') numberField.textContent = String(result.recoveryBarrier);
    });

    const beforePurchase = blocks.find(block => block.getAttribute('type') === 'before_purchase');
    const purchases = beforePurchase
        ? Array.from(beforePurchase.getElementsByTagName('block')).filter(block => block.getAttribute('type') === 'purchase')
        : [];
    const primaryPurchase = purchases[0]?.getElementsByTagName('field')[0];
    const recoveryPurchase = purchases[1]?.getElementsByTagName('field')[0];
    if (!primaryPurchase || !recoveryPurchase) throw new Error('The scanner template purchase blocks were not found.');
    primaryPurchase.textContent = result.primarySide;
    recoveryPurchase.textContent = result.recoverySide;

    return new XMLSerializer().serializeToString(documentNode.documentElement);
};

const waitForWorkspace = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace) return workspace;
        await sleep(100);
    }
    throw new Error('Bot Builder workspace is not ready. Please try again.');
};

const GlobalAIScanner = ({ openBotBuilder }: { openBotBuilder: () => void }) => {
    const [position, setPosition] = useState<Position>(() => clampButtonPosition(readStoredPosition(POSITION_KEY, defaultButtonPosition)));
    const [panelPosition, setPanelPosition] = useState<Position>(() => clampPanelPosition(readStoredPosition(PANEL_POSITION_KEY, defaultPanelPosition)));
    const [isOpen, setIsOpen] = useState(false);
    const [strategyId, setStrategyId] = useState<StrategyId>('over1_under8');
    const [tickCount, setTickCount] = useState(3000);
    const [scanning, setScanning] = useState(false);
    const [loadingBot, setLoadingBot] = useState(false);
    const [status, setStatus] = useState('Not scanned yet');
    const [error, setError] = useState('');
    const [result, setResult] = useState<ScanResult | null>(null);
    const [topResults, setTopResults] = useState<ScanResult[]>([]);
    const orbDrag = useRef({ pointerId: -1, offsetX: 0, offsetY: 0, startX: 0, startY: 0, moved: false });
    const panelDrag = useRef({ pointerId: -1, offsetX: 0, offsetY: 0 });

    const strategy = useMemo(() => STRATEGIES.find(item => item.id === strategyId) || STRATEGIES[0], [strategyId]);

    useEffect(() => {
        const handleResize = () => {
            setPosition(current => clampButtonPosition(current));
            setPanelPosition(current => clampPanelPosition(current));
        };
        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('orientationchange', handleResize);
        };
    }, []);

    useEffect(() => {
        try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* UI preference only */ }
    }, [position]);

    useEffect(() => {
        try { localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(panelPosition)); } catch { /* UI preference only */ }
    }, [panelPosition]);

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        orbDrag.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - position.x,
            offsetY: event.clientY - position.y,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (orbDrag.current.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - orbDrag.current.startX, event.clientY - orbDrag.current.startY);
        if (distance > 4) orbDrag.current.moved = true;
        if (!orbDrag.current.moved) return;
        setPosition(clampButtonPosition({
            x: event.clientX - orbDrag.current.offsetX,
            y: event.clientY - orbDrag.current.offsetY,
        }));
    };

    const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (orbDrag.current.pointerId !== event.pointerId) return;
        const wasMoved = orbDrag.current.moved;
        orbDrag.current.pointerId = -1;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        if (!wasMoved) {
            setPanelPosition(current => clampPanelPosition(current));
            setIsOpen(value => !value);
        }
    };

    const handlePanelPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        if (target.closest('button')) return;
        panelDrag.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - panelPosition.x,
            offsetY: event.clientY - panelPosition.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePanelPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        if (panelDrag.current.pointerId !== event.pointerId) return;
        setPanelPosition(clampPanelPosition({
            x: event.clientX - panelDrag.current.offsetX,
            y: event.clientY - panelDrag.current.offsetY,
        }));
    };

    const handlePanelPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
        if (panelDrag.current.pointerId !== event.pointerId) return;
        panelDrag.current.pointerId = -1;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    };

    const scanMarkets = useCallback(async () => {
        if (scanning) return;
        const count = Math.max(100, Math.min(5000, Math.round(Number(tickCount) || 3000)));
        setTickCount(count);
        setScanning(true);
        setError('');
        setResult(null);
        setTopResults([]);
        setStatus('Loading Deriv volatility markets…');

        try {
            const activeSymbols = await PremiumDerivApiService.activeSymbols();
            const markets = normalizeMarkets(activeSymbols);
            if (!markets.length) throw new Error('No supported Deriv volatility markets were returned.');

            const completed: ScanResult[] = [];
            const failures: string[] = [];
            const concurrency = 3;
            for (let index = 0; index < markets.length; index += concurrency) {
                const batch = markets.slice(index, index + concurrency);
                setStatus(`Scanning markets ${index + 1}-${Math.min(index + batch.length, markets.length)} of ${markets.length}…`);
                const settled = await Promise.allSettled(batch.map(market => analyzeMarket(market, strategy, count)));
                settled.forEach((item, batchIndex) => {
                    if (item.status === 'fulfilled') completed.push(item.value);
                    else failures.push(`${batch[batchIndex].name}: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`);
                });
            }

            if (!completed.length) throw new Error(failures[0] || 'The scanner could not obtain usable tick history from any market.');
            completed.sort((a, b) => b.confidence - a.confidence || b.recentRate - a.recentRate);
            const best = completed[0];
            setResult(best);
            setTopResults(completed.slice(0, 3));
            setStatus(`Best setup found · ${strategyText(best.primarySide, best.primaryBarrier)} · ${(best.confidence * 100).toFixed(1)}% scanner score`);
        } catch (scanError) {
            setError(scanError instanceof Error ? scanError.message : String(scanError));
            setStatus('Scan failed');
        } finally {
            setScanning(false);
        }
    }, [scanning, strategy, tickCount]);

    const loadScannerBot = useCallback(async () => {
        if (!result || loadingBot) return;
        setLoadingBot(true);
        setError('');
        setStatus('Preparing scanner bot…');
        try {
            const response = await fetch(TEMPLATE_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Scanner template returned HTTP ${response.status}.`);
            const template = await response.text();
            const configured = configureTemplate(template, result);

            openBotBuilder();
            const workspace = await waitForWorkspace();
            const fileName = `AI Scanner - ${result.symbol} - ${strategyText(result.primarySide, result.primaryBarrier)}.xml`;
            await load({
                block_string: configured,
                file_name: fileName,
                workspace,
                from: save_types.LOCAL,
                drop_event: {},
                strategy_id: null,
                showIncompatibleStrategyDialog: false,
            });
            setStatus(`Loaded ${result.market} · ${strategyText(result.primarySide, result.primaryBarrier)} into Bot Builder`);
            setIsOpen(false);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
            setStatus('Could not load scanner bot');
        } finally {
            setLoadingBot(false);
        }
    }, [loadingBot, openBotBuilder, result]);

    const selectedTrade = result ? strategyText(result.primarySide, result.primaryBarrier) : 'Waiting for scan';

    return (
        <>
            <button
                type='button'
                className='prodb-ai-button prodb-ai-scanner__orb'
                aria-label='Open AI entry scanner'
                title='AI Entry Scanner · drag to move'
                style={{ left: position.x, top: position.y }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                <span>AI</span>
            </button>

            {isOpen && <section
                className='prodb-ai-scanner'
                role='dialog'
                aria-modal='false'
                aria-label='Entry Scanner'
                style={{ left: panelPosition.x, top: panelPosition.y, right: 'auto' }}
            >
                <header
                    className='prodb-ai-scanner__header'
                    title='Drag scanner window'
                    onPointerDown={handlePanelPointerDown}
                    onPointerMove={handlePanelPointerMove}
                    onPointerUp={handlePanelPointerUp}
                >
                    <strong><span className='prodb-ai-scanner__drag-dots'>⋮⋮</span> Entry Scanner</strong>
                    <button type='button' aria-label='Close scanner' onPointerDown={event => event.stopPropagation()} onClick={() => setIsOpen(false)}>×</button>
                </header>

                <div className='prodb-ai-scanner__body'>
                    <div className='prodb-ai-scanner__tabs' role='tablist' aria-label='Scanner strategy'>
                        {STRATEGIES.map(item => <button
                            key={item.id}
                            type='button'
                            role='tab'
                            aria-selected={strategyId === item.id}
                            className={strategyId === item.id ? 'is-active' : ''}
                            disabled={scanning || loadingBot}
                            onClick={() => {
                                setStrategyId(item.id);
                                setResult(null);
                                setTopResults([]);
                                setStatus('Not scanned yet');
                                setError('');
                            }}
                        >{item.label}</button>)}
                    </div>

                    <div className='prodb-ai-scanner__intro'>
                        <div>
                            <strong>Digits Scanner</strong>
                            <small>Scans {strategy.label.replace('/', 'and')} with recovery confirmation.</small>
                        </div>
                        <label>
                            <span>TICKS</span>
                            <input
                                type='number'
                                min={100}
                                max={5000}
                                step={100}
                                value={tickCount}
                                disabled={scanning || loadingBot}
                                onChange={event => setTickCount(Number(event.target.value))}
                            />
                        </label>
                    </div>

                    <div className='prodb-ai-scanner__selection'>
                        <div>
                            <span>SELECTED MARKET</span>
                            <strong>{result?.market || 'Scan to find the best market'}</strong>
                            {result && <small>{result.symbol} · {result.sampleSize.toLocaleString()} ticks</small>}
                        </div>
                        <div>
                            <span>TRADE TYPE</span>
                            <strong>{selectedTrade}</strong>
                            {result && <small>Recovery: {strategyText(result.recoverySide, result.recoveryBarrier)}</small>}
                        </div>
                    </div>

                    <div className={`prodb-ai-scanner__status ${error ? 'is-error' : result ? 'is-ready' : ''}`}>
                        {scanning && <i />}
                        <span>{error || status}</span>
                    </div>

                    {topResults.length > 0 && <div className='prodb-ai-scanner__ranking' aria-label='Top scanner results'>
                        {topResults.map((item, index) => <div key={item.symbol} className={index === 0 ? 'is-best' : ''}>
                            <b>#{index + 1}</b>
                            <span>{item.market}<small>{strategyText(item.primarySide, item.primaryBarrier)}</small></span>
                            <strong>{(item.confidence * 100).toFixed(1)}%</strong>
                        </div>)}
                    </div>}

                    <div className='prodb-ai-scanner__actions'>
                        <button type='button' className='is-primary' disabled={scanning || loadingBot} onClick={() => void scanMarkets()}>
                            {scanning ? 'Scanning…' : 'Scan Markets'}
                        </button>
                        <button type='button' disabled={!result || scanning || loadingBot} onClick={() => void loadScannerBot()}>
                            {loadingBot ? 'Loading…' : 'Load Scanner Bot'}
                        </button>
                    </div>
                </div>
            </section>}
        </>
    );
};

export default GlobalAIScanner;