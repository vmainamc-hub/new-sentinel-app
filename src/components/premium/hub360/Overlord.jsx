import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { isProduction, WS_SERVERS } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { isRateLimitError, planRateLimitRetry, reconnectDelayMs } from './rate-limit';
import { useStore } from '@/hooks/useStore';
import { readExecutionSpeed, SLOW_DELAY_MS } from '../execution-speed';
import { ASSESS_MS, assessOverlord } from '../overlord-engine/assess';
import { isTradableBarrier } from '../overlord-engine/engine';
import { fetchHistories } from '../overlord-engine/history';
import { legacyPercentage } from '../overlord-engine/legacy';
import { assessParity, PARITY_ASSESS_MS } from '../overlord-engine/parity-assess';
import { legacyParityPct } from '../overlord-engine/parity-engine';
import { getHub360AuthContext, getHub360AuthenticatedUrl } from './auth360';
import { digitOfQuote, freshVh, normalizeVh, tradeWins, vhAfterReal, vhAfterVirtual } from './oracle/trade-plan';
import { useHub360Module } from './use-hub360-module';

const volatilityList = [
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
    '1HZ10V',
    '1HZ25V',
    '1HZ30V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V',
];

const symbolNames = {
    R_10: 'Volatility 10',
    R_25: 'Volatility 25',
    R_50: 'Volatility 50',
    R_75: 'Volatility 75',
    R_100: 'Volatility 100',
    '1HZ10V': 'Vol 10 (1s)',
    '1HZ25V': 'Vol 25 (1s)',
    '1HZ30V': 'Vol 30 (1s)',
    '1HZ50V': 'Vol 50 (1s)',
    '1HZ75V': 'Vol 75 (1s)',
    '1HZ100V': 'Vol 100 (1s)',
};

const CONTRACT_TYPE_MAP = {
    RISE: 'CALL',
    FALL: 'PUT',
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
    OVER: 'DIGITOVER',
    UNDER: 'DIGITUNDER',
    MATCHES: 'DIGITMATCH',
    DIFFERS: 'DIGITDIFF',
};

const getDerivContractType = type => CONTRACT_TYPE_MAP[type] || type;

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SCAN_WS_URL = DERIV_PUBLIC_WS_URL;
const ENGINE_PICK_FRESH_MS = 15 * 60 * 1000; // a market picked less than this long ago is reused by Run (no second scan)
const SCAN_TIMEOUT_MS = 6000;
const SCAN_MAX_RETRIES = 3;

const alertSound = new Audio('/assets/media/announcement.mp3');

// Virtual Hook (same rules as the Oracle and Sentinel AI): only digit contracts can be settled on paper.
const DIGIT_TYPES = ['EVEN', 'ODD', 'OVER', 'UNDER'];
const VIRTUAL_ID_BASE = 9_000_000_000_000; // paper trades never share an id with a real contract
const VIRTUAL_TIMEOUT_MS = 120_000;
const pipDecimals = pip => {
    const n = Number(pip);
    if (!Number.isFinite(n) || n < 0) return 2;
    return n > 0 && n < 1 ? Math.round(-Math.log10(n)) : Math.trunc(n);
};

const parseSessionNumber = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const formatContractSpot = value => {
    if (value === null || value === undefined || value === '') {
        return '-';
    }

    return String(value);
};

const Overlord = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};

    // ------------------ STATE ------------------
    const [tradeType, setTradeType] = useState('EVEN');
    const [predictionDigit, setPredictionDigit] = useState('4');
    const [analysisStarted, setAnalysisStarted] = useState(false);
    const [scannedHistory, setScannedHistory] = useState([]);
    const [strongestSignal, setStrongestSignal] = useState(null);
    const [assessInfo, setAssessInfo] = useState(null); // live assessment progress, null when not assessing
    // Market choice, one dropdown: 'one' = the market selected, 'any' = the engines pick the market, 'all' = the engines
    // pick the market, side and barrier. In 'any' and 'all' nothing has to be selected, and Run picks by itself.
    const [marketMode, setMarketModeState] = useState(() => {
        try {
            const saved = window.localStorage.getItem('overlord_market_mode');
            return saved === 'any' || saved === 'all' ? saved : 'one';
        } catch {
            return 'one';
        }
    });
    const setMarketMode = mode => {
        setMarketModeState(mode);
        try {
            window.localStorage.setItem('overlord_market_mode', mode);
        } catch {}
    };
    const anyMarket = marketMode !== 'one';
    const smartContract = marketMode === 'all'; // the engine may choose the side and barrier too
    const lastEnginePickRef = useRef(0); // when the engines last picked a market
    const scanBusyRef = useRef(false);
    const runEngineScanRef = useRef(null);
    const scanPromiseRef = useRef(null); // the scan in flight, so Run waits for it instead of starting another
    const runParityScanRef = useRef(null);

    const [symbol, setSymbol] = useState('1HZ10V'); // v2.3: a market is always selected, Find Market only suggests a better one
    const [contractType, setContractType] = useState('EVEN');
    const [initialStake, setInitialStake] = useState('1');
    const [duration, setDuration] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [useMartingale, setUseMartingale] = useState(true);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState('2.1');

    // NEW: Recovery Mode State
    const [useRecovery, setUseRecovery] = useState(false);
    const [recoveryType, setRecoveryType] = useState('OVER');
    const [recoveryPrediction, setRecoveryPrediction] = useState('4'); // Upgrade: Recovery Prediction State

    const [isRunning, setIsRunning] = useState(false);
    const [useVirtualHook, setUseVirtualHook] = useState(false);
    const [vhMode, setVhMode] = useState('STREAK');
    const [vhEnterLosses, setVhEnterLosses] = useState('2');
    const [vhReturnWins, setVhReturnWins] = useState('2');
    const [vhFixedCount, setVhFixedCount] = useState('3');
    const [paperStats, setPaperStats] = useState({ trades: 0, wins: 0, active: false });
    const [logs, setLogs] = useState([]);
    const [results, setResults] = useState([]);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [totalRuns, setTotalRuns] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [proposalError, setProposalError] = useState('');

    // ------------------ REFS ------------------
    const wsRef = useRef(null);
    const tickData = useRef({});
    const totalProfitRef = useRef(0);
    const baseStakeRef = useRef(1);
    const currentStakeRef = useRef(1);
    const isRunningRef = useRef(false);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const scanRunIdRef = useRef(0);
    const reconnectTimeoutRef = useRef(null);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    // Rate-limit pause, reconnect backoff, and always-current copies of the two callbacks the timers need.
    const rateLimitAttemptRef = useRef(0);
    const cooldownUntilRef = useRef(0);
    const rateLimitTimerRef = useRef(null);
    const reconnectAttemptRef = useRef(0);
    const nextConnectAtRef = useRef(0);
    const connectTradingSocketRef = useRef(null);
    const vhOnRef = useRef(false);
    const vhConfigRef = useRef(normalizeVh({}));
    const vhStateRef = useRef(freshVh());
    const virtualOpenRef = useRef(null); // the paper trade waiting for its tick(s)
    const virtualTimerRef = useRef(null);
    const virtualCountRef = useRef(0);
    const speedGateRef = useRef(false); // a Slow-mode wait before the next trade is already running
    const lastTickEpochRef = useRef(null);
    const requestProposalRef = useRef(null);
    const tickSubsRef = useRef({ ws: null, symbols: new Set() });
    const socketRequiresAuthRef = useRef(false);
    const contractMetaRef = useRef({});
    const lastProcessedContractIdRef = useRef(null);
    const completedContractsRef = useRef(new Set());
    const activeContractsRef = useRef(new Set());
    const contractTimeoutsRef = useRef(new Map()); // Track contract update timeouts
    const transactionRecoveryTimeoutsRef = useRef(new Map()); // Track sell-event recovery timers
    const pendingProposalRef = useRef(false); // Track if a proposal/buy is in flight

    const symbolRef = useRef(symbol);
    const contractTypeRef = useRef(contractType);
    const predictionDigitRef = useRef(predictionDigit);
    const targetProfitRef = useRef(targetProfit);
    const stopLossRef = useRef(stopLoss);
    const martingaleMultiplierRef = useRef(martingaleMultiplier);
    const useMartingaleRef = useRef(useMartingale);

    // NEW: Recovery Refs
    const lastTradeWasLossRef = useRef(false);
    const activeContractTypeRef = useRef(contractType);
    const useRecoveryRef = useRef(useRecovery);
    const recoveryTypeRef = useRef(recoveryType);
    const recoveryPredictionRef = useRef(recoveryPrediction); // Upgrade: Recovery Prediction Ref

    // ------------------ SYNC REFS ------------------
    useEffect(() => {
        isRunningRef.current = isRunning;
    }, [isRunning]);
    useEffect(() => {
        run_panel?.setIsRunning?.(isRunning);
        if (!isRunning && !run_panel?.has_open_contract) {
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [isRunning, run_panel]);
    useHub360Module('hub360-overlord', isRunning);
    useEffect(() => {
        contractTypeRef.current = contractType;
    }, [contractType]);
    useEffect(() => {
        symbolRef.current = symbol;
    }, [symbol]);
    useEffect(() => {
        useMartingaleRef.current = useMartingale;
    }, [useMartingale]);
    // v2.3: the contract type picked in the form is what gets traded, whether or not Find Market was used.
    useEffect(() => {
        setContractType(tradeType);
    }, [tradeType]);

    useEffect(() => {
        predictionDigitRef.current = predictionDigit;
    }, [predictionDigit]);
    useEffect(() => {
        targetProfitRef.current = targetProfit;
    }, [targetProfit]);
    useEffect(() => {
        stopLossRef.current = stopLoss;
    }, [stopLoss]);
    useEffect(() => {
        martingaleMultiplierRef.current = martingaleMultiplier;
    }, [martingaleMultiplier]);

    // Sync Recovery Refs
    useEffect(() => {
        useRecoveryRef.current = useRecovery;
    }, [useRecovery]);
    useEffect(() => {
        recoveryTypeRef.current = recoveryType;
    }, [recoveryType]);
    useEffect(() => {
        recoveryPredictionRef.current = recoveryPrediction;
    }, [recoveryPrediction]); // Upgrade: Sync Recovery Prediction

    useEffect(() => {
        vhOnRef.current = useVirtualHook;
        vhConfigRef.current = normalizeVh({
            mode: vhMode,
            enterLosses: vhEnterLosses,
            returnWins: vhReturnWins,
            fixedCount: vhFixedCount,
        });
        if (!useVirtualHook) {
            vhStateRef.current = freshVh();
            setPaperStats(p => (p.active ? { ...p, active: false } : p));
        }
    }, [useVirtualHook, vhMode, vhEnterLosses, vhReturnWins, vhFixedCount]);

    const isRiseFallRecoveryPair = useCallback(() => {
        const types = [contractTypeRef.current, recoveryTypeRef.current];
        return types.includes('RISE') && types.includes('FALL');
    }, []);

    const getNextContractType = useCallback(() => {
        if (useRecoveryRef.current && isRiseFallRecoveryPair()) {
            return activeContractTypeRef.current;
        }

        return useRecoveryRef.current && lastTradeWasLossRef.current
            ? recoveryTypeRef.current
            : contractTypeRef.current;
    }, [isRiseFallRecoveryPair]);

    const showToast = (title, icon = 'success') => {
        Swal.fire({
            title: title,
            icon: icon,
            toast: true,
            position: 'top',
            showConfirmButton: false,
            timer: 2800,
            timerProgressBar: true,
            background: 'transparent', // Let our CSS handle the background
            customClass: {
                popup: `ovl-swal-popup ovl-swal-${icon}`,
                title: 'ovl-swal-title',
                timerProgressBar: 'swal2-timer-progress-bar',
            },
            showClass: {
                popup: 'animate__animated animate__fadeInDown animate__faster',
            },
            hideClass: {
                popup: 'animate__animated animate__fadeOutUp animate__faster',
            },
        });
    };

    const logMessage = msg => {
        setLogs(prev => [msg, ...prev]);
        console.log(msg);
    };

    const getStoredAuthContext = useCallback(() => getHub360AuthContext(), []);
    const getAuthenticatedUrl = useCallback(async () => {
        try {
            return await getHub360AuthenticatedUrl();
        } catch (error) {
            console.error('[Hub360] Auth error:', error);
            return null;
        }
    }, []);

    const handleInitialStakeChange = useCallback(event => {
        const { value } = event.target;
        setInitialStake(value);
    }, []);

    const handleTargetProfitChange = useCallback(event => {
        const { value } = event.target;
        setTargetProfit(value);
        targetProfitRef.current = value;
    }, []);

    const handleStopLossChange = useCallback(event => {
        const { value } = event.target;
        setStopLoss(value);
        stopLossRef.current = value;
    }, []);

    const extractDigit = (sId, price) => {
        const dec = sId.startsWith('1HZ') || sId === 'R_100' ? 2 : sId === 'R_75' || sId === 'R_50' ? 4 : 3;
        const fixed = Number(price).toFixed(dec);
        return parseInt(fixed.split('.')[1]?.slice(-1) || fixed.slice(-1));
    };

    const publishNativeContract = useCallback(
        contractData => {
            if (!transactions || !summary_card) return;
            transactions.onBotContractEvent(contractData);
            summary_card.onBotContractEvent(contractData);
        },
        [summary_card, transactions]
    );

    const publishNativeError = useCallback(
        message => {
            if (journal?.onError) {
                journal.onError(message);
            }
        },
        [journal]
    );

    const publishNativeResult = useCallback(
        contractData => {
            if (journal?.onLogSuccess) {
                journal.onLogSuccess({
                    log_type: contractData.profit > 0 ? 'profit' : 'lost',
                    extra: {
                        currency: contractData.currency,
                        profit: contractData.profit,
                    },
                });
            }
        },
        [journal]
    );

    // Paper trades go to the Transactions panel only, flagged virtual: never counted in the real totals or limits.
    const pushPaper = useCallback(
        data => {
            try {
                transactions?.pushTransaction?.({ ...data, is_virtual_hook: 1, run_id: run_panel?.run_id });
            } catch (error) {
                console.debug('Paper trade row skipped.', error);
            }
        },
        [transactions, run_panel]
    );

    const releaseTicks = useCallback(() => {
        const subs = tickSubsRef.current;
        if (subs.ws && subs.ws.readyState === WebSocket.OPEN && subs.symbols.size) {
            subs.ws.send(JSON.stringify({ forget_all: 'ticks' }));
        }
        tickSubsRef.current = { ws: null, symbols: new Set() };
    }, []);

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const { preserveOpenContract = Boolean(run_panel?.has_open_contract) } = options;

            setIsRunning(false);
            isRunningRef.current = false;

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserveOpenContract) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }

            if (!preserveOpenContract) {
                lastProcessedContractIdRef.current = null;
                completedContractsRef.current.clear();
                activeContractsRef.current.clear();
                pendingProposalRef.current = false; // Clear pending flag

                // Clear all pending contract timeouts (including allowance timeouts)
                contractTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
                contractTimeoutsRef.current.clear();
                transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
                transactionRecoveryTimeoutsRef.current.clear();
            }

            if (!virtualOpenRef.current) releaseTicks(); // a paper trade in flight still settles, then the ticks are released

            run_panel?.setIsRunning?.(false);
            run_panel?.toggleDrawer?.(true);
            run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

            if (preserveOpenContract) {
                run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
            } else {
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }

            logMessage(reason);
        },
        [releaseTicks, run_panel]
    );

    const handleStop = useCallback(() => {
        stopTradingBot('Bot stopped.');
    }, [stopTradingBot]);

    // A paper trade: the same pick as a real one, nothing bought. It settles on the market's real ticks.
    const startVirtualTrade = useCallback(
        plan => {
            const ws = wsRef.current;
            const market = symbolRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN || !market || virtualOpenRef.current) return;

            if (tickSubsRef.current.ws !== ws) tickSubsRef.current = { ws, symbols: new Set() };
            if (!tickSubsRef.current.symbols.has(market)) {
                ws.send(JSON.stringify({ ticks: market, subscribe: 1 }));
                tickSubsRef.current.symbols.add(market);
            }

            const id = VIRTUAL_ID_BASE + (virtualCountRef.current += 1);
            const derivType = getDerivContractType(plan.type);
            // Same rule as the bot builder's virtual trades: the first tick after the purchase is tick 1 (also for a
            // one-tick contract), and the trade settles on tick `duration`.
            virtualOpenRef.current = {
                id,
                symbol: market,
                type: plan.type,
                barrier: plan.barrier,
                remaining: Math.max(1, parseInt(duration, 10) || 1),
                entry: null,
                row: null,
            };
            lastTickEpochRef.current = null;
            virtualOpenRef.current.row = {
                contract_id: id,
                display_name: symbolNames[market] || market,
                underlying_symbol: market,
                shortcode: `OVERLORD_PAPER_${derivType}_${market}`,
                contract_type: derivType,
                currency: client?.currency || 'USD',
                date_start: Math.floor(Date.now() / 1000),
                is_sold: 0,
                is_expired: 0,
                status: 'open',
                buy_price: 0,
                sell_price: 0,
                payout: 0,
                bid_price: 0,
                profit: 0,
                barrier: plan.barrier !== null ? String(plan.barrier) : undefined,
                transaction_ids: { buy: id },
            };
            pushPaper(virtualOpenRef.current.row);
            logMessage(
                `Virtual ${plan.type}${plan.barrier !== null ? ` ${plan.barrier}` : ''}${
                    plan.recovery ? ' (recovery)' : ''
                } on ${symbolNames[market] || market}: paper trade, no money staked.`
            );

            if (virtualTimerRef.current) clearTimeout(virtualTimerRef.current);
            virtualTimerRef.current = window.setTimeout(() => {
                if (virtualOpenRef.current?.id !== id) return;
                virtualOpenRef.current = null;
                logMessage('A virtual trade never settled (no ticks arrived); it was dropped.');
                if (isRunningRef.current) requestProposalRef.current?.();
            }, VIRTUAL_TIMEOUT_MS);
        },
        [client?.currency, duration, pushPaper]
    );

    const onVirtualTick = useCallback(
        tick => {
            const v = virtualOpenRef.current;
            if (!v || !tick || tick.symbol !== v.symbol) return;
            const digit = digitOfQuote(tick.quote, tick.pip_size);
            if (digit === null) return;
            if (tick.epoch && tick.epoch === lastTickEpochRef.current) return; // the same tick twice counts once
            lastTickEpochRef.current = tick.epoch;
            const spot = Number.isFinite(Number(tick.pip_size))
                ? Number(tick.quote).toFixed(pipDecimals(tick.pip_size))
                : String(tick.quote);
            v.remaining -= 1;
            if (v.entry === null) {
                v.entry = spot;
                v.row = { ...v.row, entry_spot: spot, entry_tick_time: tick.epoch };
            }
            if (v.remaining > 0) {
                pushPaper(v.row); // still open: show the entry spot
                return;
            }

            virtualOpenRef.current = null;
            if (virtualTimerRef.current) {
                clearTimeout(virtualTimerRef.current);
                virtualTimerRef.current = null;
            }
            const won = tradeWins(v.type, v.barrier, digit);
            pushPaper({
                ...v.row,
                is_sold: 1,
                is_expired: 1,
                status: won ? 'won' : 'lost',
                virtual_result: won ? 'win' : 'loss',
                exit_spot: spot,
                exit_tick_time: tick.epoch,
                transaction_ids: { buy: v.id, sell: v.id },
            });
            logMessage(
                `Virtual ${v.type}${v.barrier !== null ? ` ${v.barrier}` : ''} ${won ? 'won' : 'lost'} on paper (digit ${digit}). No money moved.`
            );

            const step = vhAfterVirtual(vhStateRef.current, won, vhConfigRef.current);
            if (step.event === 'returned') logMessage('Virtual Hook: the paper trades did it. Back to real money.');
            vhStateRef.current = step.state;
            setPaperStats(p => ({ trades: p.trades + 1, wins: p.wins + (won ? 1 : 0), active: step.state.virtual }));

            if (isRunningRef.current) {
                window.setTimeout(() => requestProposalRef.current?.(), 0);
            } else {
                releaseTicks();
            }
        },
        [pushPaper, releaseTicks]
    );

    const requestProposal = useCallback(
        opts => {
            if (!isRunningRef.current) {
                return;
            }

            // Deriv told us to slow down: come back when the pause is over instead of sending into the limit again.
            const cooldownMs = cooldownUntilRef.current - Date.now();
            if (cooldownMs > 0) {
                if (!rateLimitTimerRef.current) {
                    logMessage(`⏳ Waiting ${(cooldownMs / 1000).toFixed(1)}s for Deriv's rate limit to clear`);
                    rateLimitTimerRef.current = window.setTimeout(() => {
                        rateLimitTimerRef.current = null;
                        requestProposalRef.current?.();
                    }, cooldownMs);
                }
                return;
            }

            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                logMessage('⚠️ WebSocket not ready for proposal request');
                return;
            }

            if (!isAuthorizedRef.current) {
                logMessage('⚠️ Not authorized yet, cannot request proposal');
                return;
            }

            // Prevent multiple simultaneous proposals
            if (pendingProposalRef.current) {
                logMessage(`⏳ Waiting for pending proposal/trade to complete`);
                return;
            }

            // Ensure we're not making multiple simultaneous proposals
            if (activeContractsRef.current.size > 0) {
                logMessage(`⏳ Waiting for ${activeContractsRef.current.size} active contract(s) to resolve`);
                return;
            }

            if (virtualOpenRef.current) return; // a paper trade is still waiting for its tick

            // The bottom bar's Execution switch: Fast buys at once, Slow waits before each purchase. Real and paper trades both obey it.
            if (!(opts && opts.skipDelay === true)) {
                const delay = readExecutionSpeed() === 'slow' ? SLOW_DELAY_MS : 0;
                if (delay) {
                    if (!speedGateRef.current) {
                        speedGateRef.current = true;
                        window.setTimeout(() => {
                            speedGateRef.current = false;
                            if (isRunningRef.current) requestProposalRef.current?.({ skipDelay: true });
                        }, delay);
                    }
                    return;
                }
            }

            const activeType = getNextContractType();
            // Recovering = Recovery mode is on and the last trade lost. This must NOT depend on the contract type being
            // different: OVER 2 -> recovery OVER 3 uses the same type but a different digit. (RISE/FALL pairs just swap
            // direction and have no digit.)
            const isRecovering = useRecoveryRef.current && lastTradeWasLossRef.current && !isRiseFallRecoveryPair();
            activeContractTypeRef.current = activeType;

            const activePrediction = isRecovering ? recoveryPredictionRef.current : predictionDigitRef.current;
            const parsedDuration = Math.max(1, parseInt(duration, 10) || 1);

            // Virtual Hook: while it is paper time, the same pick is traded on paper and nothing is bought.
            if (
                vhOnRef.current &&
                vhStateRef.current.virtual &&
                DIGIT_TYPES.includes(contractTypeRef.current) &&
                DIGIT_TYPES.includes(activeType)
            ) {
                const needsBarrier = activeType === 'OVER' || activeType === 'UNDER';
                startVirtualTrade({
                    type: activeType,
                    barrier: needsBarrier ? parseInt(activePrediction, 10) : null,
                    recovery: isRecovering,
                });
                return;
            }

            const derivContractType = getDerivContractType(activeType);

            const proposalPayload = {
                proposal: 1,
                amount: Number(currentStakeRef.current).toFixed(2),
                basis: 'stake',
                contract_type: derivContractType,
                currency: client?.currency || 'USD',
                underlying_symbol: symbolRef.current,
                duration: parsedDuration,
                duration_unit: 't',
            };

            if (['OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(activeType)) {
                proposalPayload.barrier = parseInt(activePrediction, 10);
            }

            logMessage(
                `📋 Sending ${isRecovering ? 'RECOVERY ' : ''}proposal: ${derivContractType}${
                    proposalPayload.barrier !== undefined ? ` ${proposalPayload.barrier}` : ''
                } on ${symbolRef.current} x${currentStakeRef.current}`
            );
            pendingProposalRef.current = true; // Mark proposal as pending
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            wsRef.current.send(JSON.stringify(proposalPayload));
        },
        [client?.currency, duration, getNextContractType, isRiseFallRecoveryPair, run_panel, startVirtualTrade]
    );
    requestProposalRef.current = requestProposal;

    // ------------------ CENTRAL SOCKET HANDLER ------------------
    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);

            if (data.msg_type === 'tick') {
                onVirtualTick(data.tick);
                return;
            }

            if (data.msg_type === 'authorize') {
                if (!isAuthorizedRef.current) {
                    logMessage('Authorization successful');
                    isAuthorizedRef.current = true;
                    if (isRunningRef.current && activeContractsRef.current.size === 0) requestProposal();
                }
                return;
            }
            /*
    
    if (data.msg_type === "authorize") {
        logMessage("✅ Authorization Successful");
        isAuthorizedRef.current = true;
        if (isRunningRef.current) executeTrade();
    }

    */
            if (!data.error && ['proposal', 'buy', 'proposal_open_contract'].includes(data.msg_type)) {
                rateLimitAttemptRef.current = 0;
                if (data.msg_type === 'buy') {
                    setProposalError(previous => (previous.startsWith('Deriv asked us to slow down') ? '' : previous));
                }
            }

            if (data.msg_type === 'proposal' && !data.error) {
                if (!isRunningRef.current) {
                    return;
                }

                const proposalId = data.proposal?.id;
                const askPrice = data.proposal?.ask_price;

                if (!proposalId || askPrice === undefined) {
                    logMessage('⚠️ Proposal received but missing ID or price');
                    return;
                }

                logMessage(`✅ Proposal ready: ID ${proposalId} | Price: ${askPrice}`);
                wsRef.current.send(JSON.stringify({ buy: proposalId, price: askPrice }));
                return;
            }

            if (data.error) {
                // Rate limit: pause, then repeat what was refused (a contract's updates, or a fresh trade cycle).
                // Never leave the bot waiting on a reply that Deriv already refused to send.
                if (isRateLimitError(data)) {
                    const plan = planRateLimitRetry(data, {
                        attempt: rateLimitAttemptRef.current,
                        isRunning: isRunningRef.current,
                        isContractActive: id => activeContractsRef.current.has(String(id)),
                    });
                    rateLimitAttemptRef.current += 1;
                    cooldownUntilRef.current = Date.now() + plan.delayMs;
                    const slowDownMessage = `Deriv asked us to slow down (${plan.callName}). Retrying in ${(plan.delayMs / 1000).toFixed(1)}s.`;
                    setProposalError(slowDownMessage);
                    logMessage(`⏳ ${slowDownMessage}`);
                    pendingProposalRef.current = false;

                    if (plan.kind === 'resend_contract') {
                        window.setTimeout(() => {
                            const stillOpen = activeContractsRef.current.has(String(plan.payload.contract_id));
                            if (stillOpen && wsRef.current?.readyState === WebSocket.OPEN) {
                                wsRef.current.send(JSON.stringify(plan.payload));
                            }
                        }, plan.delayMs);
                    } else if (plan.kind === 'new_proposal') {
                        if (rateLimitTimerRef.current) window.clearTimeout(rateLimitTimerRef.current);
                        rateLimitTimerRef.current = window.setTimeout(() => {
                            rateLimitTimerRef.current = null;
                            if (activeContractsRef.current.size === 0) requestProposalRef.current?.();
                        }, plan.delayMs);
                    }
                    return;
                }

                const errorCode = data.error.code;
                const errorMessage = data.error.message;
                const openPositionLimitReached =
                    /(cannot hold more than \d+ contracts|open positions of this asset and trade type|open position limit)/i.test(
                        errorMessage || ''
                    );
                const sessionTradingLimitReached =
                    [
                        'CompanyWideLimitExceeded',
                        'DailyProfitLimitExceeded',
                        'ProductSpecificTurnoverLimitExceeded',
                        'MaxAggregateOpenStakeExceeded',
                    ].includes(errorCode) ||
                    /(no further trading is allowed|maximum daily stake|growth rate and instrument)/i.test(
                        errorMessage || ''
                    );

                setProposalError(errorMessage);
                logMessage(`❌ Error: ${errorMessage}`);
                pendingProposalRef.current = false; // Clear pending flag on error so we can retry
                publishNativeError(errorMessage);

                if (openPositionLimitReached) {
                    stopTradingBot('Open position limit reached. Bot stopped until current contracts settle.', {
                        preserveOpenContract: false,
                    });
                    return;
                }

                if (sessionTradingLimitReached) {
                    stopTradingBot('Trading is blocked for this contract type in the current session. Bot stopped.', {
                        preserveOpenContract: false,
                    });
                }
                return;
            }

            // Deriv trade-engine recovery pattern:
            // if there's a sell transaction but contract stream still looks open,
            // request proposal_open_contract again after a short delay.
            if (data.msg_type === 'transaction') {
                const action = data.transaction?.action;
                const sellContractId = data.transaction?.contract_id;
                const contractKey = String(sellContractId ?? '');

                if (action !== 'sell' || !sellContractId || !activeContractsRef.current.has(contractKey)) {
                    return;
                }

                if (completedContractsRef.current.has(contractKey)) {
                    return;
                }

                if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
                }

                logMessage(`🧾 Sell transaction received for #${contractKey}; validating final contract snapshot...`);

                const recoveryTimeoutId = window.setTimeout(() => {
                    transactionRecoveryTimeoutsRef.current.delete(contractKey);

                    if (
                        !activeContractsRef.current.has(contractKey) ||
                        completedContractsRef.current.has(contractKey)
                    ) {
                        return;
                    }

                    if (wsRef.current?.readyState !== WebSocket.OPEN) {
                        logMessage(`⚠️ Recovery check skipped for #${contractKey}; socket not open.`);
                        return;
                    }

                    logMessage(`🔁 Requesting final proposal_open_contract for #${contractKey} after sell event`);
                    wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: sellContractId }));
                }, 1500);

                transactionRecoveryTimeoutsRef.current.set(contractKey, recoveryTimeoutId);
                return;
            }

            if (data.msg_type === 'buy') {
                const { contract_id, transaction_id, buy_price, longcode } = data.buy;
                const contractKey = String(contract_id);
                const displayType =
                    contractMetaRef.current[contractKey]?.contract_type ||
                    getDerivContractType(activeContractTypeRef.current);
                const market = symbolRef.current;

                logMessage(
                    `🛒 Trade executed: Contract #${contract_id} | Type: ${displayType} | Stake: ${currentStakeRef.current}`
                );

                const transactionPayload = {
                    id: contract_id,
                    contract_id,
                    transaction_ids: { buy: transaction_id },
                    buy_price: buy_price ?? parseFloat(currentStakeRef.current),
                    currency: client?.currency || 'USD',
                    display_name: symbolNames[market] || market,
                    underlying: market,
                    underlying_symbol: market,
                    contract_type: displayType,
                    longcode,
                    date_start: Math.floor(Date.now() / 1000),
                };

                contractMetaRef.current[contractKey] = transactionPayload;
                activeContractsRef.current.add(contractKey);
                pendingProposalRef.current = false; // Clear pending flag now that contract is active
                publishNativeContract(transactionPayload);
                run_panel?.setHasOpenContract?.(true);
                run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

                setResults(prev => [
                    {
                        id: prev.length + 1,
                        contract_type: displayType,
                        entry_spot: '-',
                        exit_spot: '-',
                        stake: parseFloat(currentStakeRef.current).toFixed(2),
                        profit: '-',
                        status: '⏳',
                        contract_id,
                    },
                    ...prev,
                ]);

                // Subscribe to this contract's updates
                logMessage(`📡 Subscribing to contract updates for #${contract_id}`);
                wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));

                // Set timeout to force completion if updates stop coming (contracts expire after duration+buffer)
                const parsedDuration = Math.max(1, parseInt(duration, 10) || 1);
                const timeoutMs = (parsedDuration + 5) * 1000; // Duration in seconds + 5 second buffer for market ticks

                // Clear any existing timeout for this contract
                if (contractTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(contractTimeoutsRef.current.get(contractKey));
                }

                const timeoutId = window.setTimeout(() => {
                    logMessage(`⚠️ Contract #${contractKey} timeout (${timeoutMs}ms) - forcing status request`);

                    // Force a one-time check for this contract's status (without subscribe)
                    if (wsRef.current?.readyState === WebSocket.OPEN && activeContractsRef.current.has(contractKey)) {
                        logMessage(`🔍 Requesting final status for contract #${contractKey}`);
                        wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id }));

                        // If still not resolved after additional 2 seconds, forcefully mark as pending timeout
                        const allowanceId = window.setTimeout(() => {
                            if (activeContractsRef.current.has(contractKey)) {
                                logMessage(
                                    `❌ Contract #${contractKey} NOT closing naturally - marking as stalled for retry`
                                );
                                contractTimeoutsRef.current.delete(contractKey);
                            }
                        }, 2000);

                        contractTimeoutsRef.current.set(`${contractKey}-allowance`, allowanceId);
                    } else {
                        contractTimeoutsRef.current.delete(contractKey);
                    }
                }, timeoutMs);

                contractTimeoutsRef.current.set(contractKey, timeoutId);
                return;
            }

            if (data.msg_type === 'proposal_open_contract') {
                const c = data.proposal_open_contract;
                if (!c) return;

                const contractKey = String(c.contract_id);
                const isTrackedContract = activeContractsRef.current.has(contractKey);

                const normalizedStatus = String(c.status || '').toLowerCase();
                const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
                const isExpired = c.is_expired === 1 || c.is_expired === true || c.is_expired === '1';
                const isSettleable = c.is_settleable === 1 || c.is_settleable === true || c.is_settleable === '1';
                const isSold =
                    c.is_sold === 1 ||
                    c.is_sold === true ||
                    c.is_sold === '1' ||
                    hasClosedStatus ||
                    isExpired ||
                    isSettleable;

                if (!isRunningRef.current && !isTrackedContract) return;
                if (completedContractsRef.current.has(contractKey)) {
                    return;
                }

                const entrySpot = formatContractSpot(
                    c.entry_spot_display_value ?? c.entry_tick_display_value ?? c.entry_spot ?? c.entry_tick
                );
                const exitSpot = formatContractSpot(
                    c.exit_spot_display_value ??
                        c.exit_tick_display_value ??
                        c.exit_spot ??
                        c.exit_tick ??
                        c.current_spot_display_value ??
                        c.current_spot
                );
                const profit = parseFloat(c.profit ?? 0);
                const contractStatus = c.status || 'open'; // 'open', 'closed' or custom
                const resultStatus = profit > 0 ? 'won' : 'lost';
                const normalizedClosedStatus = normalizedStatus || resultStatus;

                // Debug logging for contract updates
                if (activeContractsRef.current.has(contractKey)) {
                    logMessage(
                        `📊 Contract #${contractKey} update: entry=${entrySpot} exit=${exitSpot} profit=${profit} status=${contractStatus} is_sold=${c.is_sold}`
                    );
                }

                const nativeContract = {
                    ...(contractMetaRef.current[contractKey] || {}),
                    ...c,
                    id: c.contract_id,
                    contract_id: c.contract_id,
                    contract_type:
                        contractMetaRef.current[contractKey]?.contract_type ||
                        getDerivContractType(activeContractTypeRef.current),
                    display_name: c.display_name || symbolNames[symbolRef.current] || symbolRef.current,
                    underlying_symbol: c.underlying_symbol || c.underlying || symbolRef.current,
                    underlying: c.underlying || symbolRef.current,
                    buy_price:
                        c.buy_price ??
                        contractMetaRef.current[contractKey]?.buy_price ??
                        parseFloat(currentStakeRef.current),
                    currency: c.currency || client?.currency || 'USD',
                    transaction_ids: contractMetaRef.current[contractKey]?.transaction_ids || c.transaction_ids,
                    entry_spot: entrySpot,
                    exit_spot: isSold ? exitSpot : undefined,
                    is_sold: isSold,
                    is_expired: isExpired || c.is_expired,
                    is_settleable: isSettleable || c.is_settleable,
                    result: isSold ? resultStatus : undefined,
                    status: isSold ? normalizedClosedStatus : c.status || 'open',
                };

                publishNativeContract(nativeContract);

                // Always update results with latest data
                setResults(prev =>
                    prev.map(r =>
                        r.contract_id === c.contract_id
                            ? {
                                  ...r,
                                  entry_spot: entrySpot || r.entry_spot,
                                  ...(isSold ? { exit_spot: exitSpot, profit: profit.toFixed(2) } : {}),
                                  status: isSold ? (profit >= 0 ? 'WIN' : 'LOSS') : 'PENDING',
                              }
                            : r
                    )
                );

                // Only process contract closure once per contract
                if (!isSold) {
                    return;
                }

                if (lastProcessedContractIdRef.current === contractKey) {
                    return;
                }

                // Mark contract as completed and remove from active set
                logMessage(
                    `✅ Contract #${contractKey} CLOSED | Entry: ${entrySpot} → Exit: ${exitSpot} | Profit: ${profit.toFixed(2)} | Status: ${profit >= 0 ? 'WIN' : 'LOSS'}`
                );

                // Clear all timeouts for this contract
                if (contractTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(contractTimeoutsRef.current.get(contractKey));
                    contractTimeoutsRef.current.delete(contractKey);
                }
                if (contractTimeoutsRef.current.has(`${contractKey}-allowance`)) {
                    clearTimeout(contractTimeoutsRef.current.get(`${contractKey}-allowance`));
                    contractTimeoutsRef.current.delete(`${contractKey}-allowance`);
                }
                if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
                    transactionRecoveryTimeoutsRef.current.delete(contractKey);
                }

                completedContractsRef.current.add(contractKey);
                activeContractsRef.current.delete(contractKey);
                lastProcessedContractIdRef.current = contractKey;
                totalProfitRef.current += profit;
                lastTradeWasLossRef.current = profit <= 0;

                if (vhOnRef.current && DIGIT_TYPES.includes(contractTypeRef.current)) {
                    const step = vhAfterReal(vhStateRef.current, profit > 0, vhConfigRef.current);
                    vhStateRef.current = step.state;
                    if (step.event === 'entered') {
                        logMessage(
                            `Virtual Hook: ${vhConfigRef.current.enterLosses} real loss(es) in a row. Trading on paper until it wins again.`
                        );
                        setPaperStats(p => ({ ...p, active: true }));
                    }
                }

                if (useRecoveryRef.current && isRiseFallRecoveryPair() && profit <= 0) {
                    activeContractTypeRef.current = activeContractTypeRef.current === 'RISE' ? 'FALL' : 'RISE';
                }

                setTotalProfit(totalProfitRef.current.toFixed(2));
                setTotalRuns(p => p + 1);
                if (profit > 0) setWins(p => p + 1);
                else setLosses(p => p + 1);

                if (useMartingaleRef.current) {
                    currentStakeRef.current =
                        profit <= 0
                            ? (currentStakeRef.current * parseFloat(martingaleMultiplierRef.current)).toFixed(2)
                            : Number(baseStakeRef.current).toFixed(2);
                }

                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(
                    isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                );
                publishNativeResult(nativeContract);

                // Check stopping conditions AFTER contract is fully processed
                if (!isRunningRef.current) {
                    logMessage('Bot is not running, skipping proposal request.');
                    return;
                }

                if (totalProfitRef.current >= parseFloat(targetProfitRef.current)) {
                    logMessage(
                        `🎯 Target profit reached: ${totalProfitRef.current.toFixed(2)} >= ${targetProfitRef.current}`
                    );
                    showToast('CONGRATULATIONS! Target Profit Reached!', 'success');
                    stopTradingBot('Target profit reached. Bot stopped.', { preserveOpenContract: false });
                    return;
                }

                if (totalProfitRef.current <= -parseFloat(stopLossRef.current)) {
                    logMessage(`🛑 Stop loss hit: ${totalProfitRef.current.toFixed(2)} <= -${stopLossRef.current}`);
                    showToast('OOPS! Your stop loss has been hit!', 'error');
                    stopTradingBot('Stop loss reached. Bot stopped.', { preserveOpenContract: false });
                    return;
                }

                // Request next proposal only if conditions are met
                logMessage(`📊 Requesting new proposal. Active contracts: ${activeContractsRef.current.size}`);
                requestProposal();
            }
        },
        [
            client?.currency,
            isRiseFallRecoveryPair,
            onVirtualTick,
            publishNativeContract,
            publishNativeError,
            publishNativeResult,
            requestProposal,
            run_panel,
            stopTradingBot,
        ]
    );

    // Failed or dropped connections are retried 1 s, 2 s, 4 s ... (max 30 s) apart, never in a tight loop.
    const noteConnectFailure = useCallback(() => {
        const delay = reconnectDelayMs(reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        nextConnectAtRef.current = Date.now() + delay;
        return delay;
    }, []);

    const connectTradingSocket = useCallback(
        async (options = {}) => {
            const { requireAuth = false, forceReconnect = false } = options;
            const wsReady = wsRef.current?.readyState;

            if (
                !forceReconnect &&
                (wsReady === WebSocket.OPEN || wsReady === WebSocket.CONNECTING || isConnectingRef.current)
            ) {
                return true;
            }

            if (forceReconnect && wsRef.current) {
                skipReconnectRef.current = true;
                const existingSocket = wsRef.current;
                wsRef.current = null;
                isAuthorizedRef.current = false;

                try {
                    existingSocket.close();
                } catch (error) {
                    console.error('[Overlord] Failed to close existing socket:', error);
                }
            }

            isConnectingRef.current = true;
            socketRequiresAuthRef.current = requireAuth;

            try {
                const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

                if (requireAuth && !authenticatedUrl) {
                    setProposalError('Unable to create an authenticated Deriv session.');
                    noteConnectFailure();
                    return false;
                }

                const socketUrl = authenticatedUrl || SCAN_WS_URL;
                const isAuthenticatedSocket = Boolean(authenticatedUrl);

                wsRef.current = new WebSocket(socketUrl);
                wsRef.current.onopen = () => {
                    logMessage(
                        isAuthenticatedSocket ? 'Trading socket connected' : 'Trading socket connected (public)'
                    );
                    setProposalError('');
                    reconnectAttemptRef.current = 0;
                    nextConnectAtRef.current = 0;
                    isAuthorizedRef.current = isAuthenticatedSocket;

                    if (isAuthenticatedSocket) {
                        logMessage('Authorized trading session ready');
                        wsRef.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
                        activeContractsRef.current.forEach(activeContractId => {
                            wsRef.current.send(
                                JSON.stringify({
                                    proposal_open_contract: 1,
                                    contract_id: Number(activeContractId),
                                    subscribe: 1,
                                })
                            );
                        });
                    }

                    // Request proposal AFTER authentication on startup
                    if (isRunningRef.current && isAuthenticatedSocket && activeContractsRef.current.size === 0) {
                        logMessage('Requesting initial proposal after connection...');
                        requestProposal();
                    }
                };
                wsRef.current.onmessage = handleSocketMessage;
                wsRef.current.onerror = event => {
                    logMessage('Trading socket error');
                    console.error(event);
                };
                const thisSocket = wsRef.current;
                wsRef.current.onclose = () => {
                    // An older socket that closes late must not wipe out the newer one that replaced it.
                    if (wsRef.current && wsRef.current !== thisSocket) {
                        skipReconnectRef.current = false;
                        return;
                    }
                    logMessage('Trading socket closed');
                    isAuthorizedRef.current = false;
                    wsRef.current = null;
                    transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
                    transactionRecoveryTimeoutsRef.current.clear();

                    const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
                    skipReconnectRef.current = false;

                    if (shouldReconnect) {
                        reconnectTimeoutRef.current = window.setTimeout(() => {
                            // Only a bot that is running (or still settling a contract) needs its session back.
                            if (!isRunningRef.current && activeContractsRef.current.size === 0) return;
                            connectTradingSocketRef.current?.({ requireAuth: socketRequiresAuthRef.current });
                        }, noteConnectFailure());
                    }
                };

                return true;
            } catch (error) {
                logMessage(`Trading connection failed: ${error.message}`);
                setProposalError(error.message);
                noteConnectFailure();
                return false;
            } finally {
                isConnectingRef.current = false;
            }
        },
        [getAuthenticatedUrl, handleSocketMessage, noteConnectFailure, requestProposal]
    );
    connectTradingSocketRef.current = connectTradingSocket;

    // The trading session exists only while the bot is running (or still has a contract to settle): Run opens it, and the
    // watchdog releases it once the bot is idle. Dependencies are empty on purpose: a new callback identity (for example
    // after editing the duration) must never close a running session.
    useEffect(() => {
        shouldReconnectRef.current = true;

        const watchdogId = window.setInterval(() => {
            if (!shouldReconnectRef.current) return;

            const isBusy = isRunningRef.current || activeContractsRef.current.size > 0;
            if (!isBusy) {
                if (wsRef.current?.readyState === WebSocket.OPEN && !pendingProposalRef.current) {
                    skipReconnectRef.current = true;
                    try {
                        wsRef.current.close();
                    } catch {
                        /* already closing */
                    }
                }
                return;
            }

            if (Date.now() < nextConnectAtRef.current) return;
            connectTradingSocketRef.current?.({ requireAuth: socketRequiresAuthRef.current });
        }, 1500);

        return () => {
            shouldReconnectRef.current = false;
            window.clearInterval(watchdogId);
            [reconnectTimeoutRef, rateLimitTimerRef].forEach(timerRef => {
                if (timerRef.current) {
                    window.clearTimeout(timerRef.current);
                    timerRef.current = null;
                }
            });
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        const handleExternalStop = () => {
            if (!isRunningRef.current && !run_panel?.has_open_contract) return;

            stopTradingBot('Bot stopped from the Deriv run panel.', {
                preserveOpenContract: Boolean(run_panel?.has_open_contract),
            });
        };

        observer.register('bot.click_stop', handleExternalStop);
        observer.register('hub360.stop', handleExternalStop);
        observer.register('hub360.stop.hub360-overlord', handleExternalStop);

        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', handleExternalStop);
                observer.unregister('hub360.stop', handleExternalStop);
                observer.unregister('hub360.stop.hub360-overlord', handleExternalStop);
            }
        };
    }, [run_panel?.has_open_contract, stopTradingBot]);

    // ------------------ BOT CONTROL ------------------
    const handleStart = useCallback(async () => {
        if (isRunning) {
            handleStop();
            return;
        }
        const parityTrade = tradeType === 'EVEN' || tradeType === 'ODD';
        if (anyMarket && (tradeType === 'OVER' || tradeType === 'UNDER' || parityTrade)) {
            // Any market: the engines pick the market (and the side and barrier when that toggle is on) before the first trade.
            if (scanBusyRef.current) return;
            // A scan you started with Find Market is still running: let it finish and use its pick, never start a second one.
            if (scanPromiseRef.current) {
                scanBusyRef.current = true;
                try {
                    await scanPromiseRef.current;
                } catch {
                    // the scan reports its own errors
                } finally {
                    scanBusyRef.current = false;
                }
            }
            if (Date.now() - lastEnginePickRef.current > ENGINE_PICK_FRESH_MS) {
                scanBusyRef.current = true;
                let picked = null;
                try {
                    picked = await (parityTrade ? runParityScanRef : runEngineScanRef).current?.();
                } finally {
                    scanBusyRef.current = false;
                }
                if (!picked) {
                    showToast('No market could be picked. Try again.', 'warning');
                    return;
                }
            }
        }
        if (!symbolRef.current) {
            showToast('No Signal , Please Scan First', 'warning');
            return;
        }
        if (!getStoredAuthContext()) {
            showToast('LOGIN REQUIRED', 'error');
            return;
        }

        const parsedInitialStake = parseSessionNumber(initialStake, 1);
        const parsedTargetProfit = parseSessionNumber(targetProfitRef.current, 100);
        const parsedStopLoss = parseSessionNumber(stopLossRef.current, 100);

        baseStakeRef.current = parsedInitialStake;
        currentStakeRef.current = parsedInitialStake;
        targetProfitRef.current = parsedTargetProfit.toString();
        stopLossRef.current = parsedStopLoss.toString();
        totalProfitRef.current = 0;
        lastTradeWasLossRef.current = false; // Reset recovery on clean start
        activeContractTypeRef.current = contractTypeRef.current;
        contractMetaRef.current = {};
        lastProcessedContractIdRef.current = null;
        completedContractsRef.current.clear();
        activeContractsRef.current.clear();
        pendingProposalRef.current = false; // Clear pending flag on fresh start
        speedGateRef.current = false;
        // The hook opens on paper (like Sentinel AI's) and goes to real money by its own return rule.
        vhStateRef.current =
            vhOnRef.current && DIGIT_TYPES.includes(contractTypeRef.current)
                ? { virtual: true, realLosses: 0, virtualWins: 0, virtualDone: 0 }
                : freshVh();
        virtualOpenRef.current = null;
        setPaperStats({ trades: 0, wins: 0, active: vhStateRef.current.virtual });

        // Clear any pending timeouts from previous session (including allowance timeouts)
        contractTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
        contractTimeoutsRef.current.clear();
        transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
        transactionRecoveryTimeoutsRef.current.clear();

        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();
        logMessage(
            `Session configured: target ${parsedTargetProfit.toFixed(2)} USD, stop ${parsedStopLoss.toFixed(2)} USD.`
        );
        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `overlord-${Date.now()}`;
        }
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        setIsRunning(true);
        isRunningRef.current = true;
        rateLimitAttemptRef.current = 0;
        cooldownUntilRef.current = 0;
        reconnectAttemptRef.current = 0;
        nextConnectAtRef.current = 0;

        const wsReady = wsRef.current?.readyState;
        if (wsRef.current && wsReady === WebSocket.OPEN && isAuthorizedRef.current) {
            requestProposal();
            return;
        }

        const didStartConnection = await connectTradingSocket({
            requireAuth: true,
            forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current),
        });

        if (!didStartConnection) {
            setIsRunning(false);
            isRunningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [
        anyMarket,
        tradeType,
        connectTradingSocket,
        contractType,
        getStoredAuthContext,
        handleStop,
        initialStake,
        isRunning,
        requestProposal,
        run_panel,
        summary_card,
        symbol,
        targetProfit,
        transactions,
    ]);

    useEffect(() => {
        observer.register('overlord.start', handleStart);
        observer.register('overlord.stop', handleStop);

        return () => {
            if (observer.isRegistered('overlord.start')) {
                observer.unregister('overlord.start', handleStart);
            }
            if (observer.isRegistered('overlord.stop')) {
                observer.unregister('overlord.stop', handleStop);
            }
        };
    }, [handleStart, handleStop]);

    // ------------------ SIGNAL LOGIC ------------------
    const calculateStatsForType = (sId, targetType) => {
        const prices = tickData.current[sId];
        if (!prices || prices.length < 20) return null;
        const total = prices.length;
        let occurrences = 0;
        const pred = parseInt(predictionDigitRef.current);
        const digits = prices.map(p => extractDigit(sId, p));

        if (['EVEN', 'ODD', 'OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(targetType)) {
            if (targetType === 'EVEN') occurrences = digits.filter(d => d % 2 === 0).length;
            else if (targetType === 'ODD') occurrences = digits.filter(d => d % 2 !== 0).length;
            else if (targetType === 'OVER') occurrences = digits.filter(d => d > pred).length;
            else if (targetType === 'UNDER') occurrences = digits.filter(d => d < pred).length;
            else if (targetType === 'MATCHES') occurrences = digits.filter(d => d === pred).length;
            else if (targetType === 'DIFFERS') occurrences = digits.filter(d => d !== pred).length;
        } else if (targetType === 'RISE' || targetType === 'FALL') {
            for (let i = 1; i < prices.length; i++) {
                if (targetType === 'RISE' && Number(prices[i]) > Number(prices[i - 1])) occurrences++;
                else if (targetType === 'FALL' && Number(prices[i]) < Number(prices[i - 1])) occurrences++;
            }
        }
        return (occurrences / total) * 100;
    };

    const handleFetchSignal = async () => {
        if (analysisStarted) return;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage('🚀 Starting scan...');

        const results = [];
        for (const v of volatilityList) {
            try {
                const result = await new Promise(resolve => {
                    const ws = new WebSocket(SCAN_WS_URL);
                    const timer = setTimeout(() => {
                        ws.close();
                        resolve(null);
                    }, 4000);
                    ws.onopen = () =>
                        ws.send(JSON.stringify({ ticks_history: v, style: 'ticks', count: 50, end: 'latest' }));
                    ws.onmessage = msg => {
                        const data = JSON.parse(msg.data);
                        if (data.history?.prices) {
                            clearTimeout(timer);
                            tickData.current[v] = data.history.prices;
                            const percentage = calculateStatsForType(v, tradeType);
                            ws.close();
                            resolve({ id: v, name: symbolNames[v], percentage });
                        }
                    };
                    ws.onerror = () => {
                        clearTimeout(timer);
                        ws.close();
                        resolve(null);
                    };
                });
                if (result) {
                    results.push(result);
                    setScannedHistory([...results].sort((a, b) => a.percentage - b.percentage));
                }
            } catch (err) {
                console.error(err);
            }
        }

        if (results.length > 0) {
            const best = [...results].sort((a, b) => a.percentage - b.percentage)[0];
            // Measured, not invented: how often this outcome showed up in the sampled ticks on the chosen market.
            setStrongestSignal({ ...best, confidence: Number(best.percentage).toFixed(1) });
            setSymbol(best.id);
            setContractType(tradeType);
            logMessage(`✅ Scan Complete: ${best.name}`);
            try {
                alertSound.play().catch(() => {});
            } catch {}
        }
        setAnalysisStarted(false);
    };

    const scanSymbol = useCallback((volatilityId, selectedTradeType, scanRunId, attempt = 1) => {
        return new Promise(resolve => {
            const ws = new WebSocket(SCAN_WS_URL);
            let isSettled = false;

            const finish = value => {
                if (isSettled) return;
                isSettled = true;
                resolve(value);
            };

            const timer = setTimeout(() => {
                ws.close();
                finish({
                    id: volatilityId,
                    name: symbolNames[volatilityId],
                    percentage: null,
                    status: 'timeout',
                    attempt,
                });
            }, SCAN_TIMEOUT_MS);

            ws.onopen = () => {
                ws.send(JSON.stringify({ ticks_history: volatilityId, style: 'ticks', count: 50, end: 'latest' }));
            };

            ws.onmessage = msg => {
                const data = JSON.parse(msg.data);
                if (!data.history?.prices) return;

                clearTimeout(timer);
                tickData.current[volatilityId] = data.history.prices;
                const percentage = calculateStatsForType(volatilityId, selectedTradeType);
                const result = {
                    id: volatilityId,
                    name: symbolNames[volatilityId],
                    percentage,
                    status: 'success',
                    attempt,
                };

                if (scanRunIdRef.current === scanRunId) {
                    setScannedHistory(prev => {
                        const deduped = prev.filter(item => item.id !== volatilityId);
                        return [...deduped, result].sort((a, b) => {
                            if (a.status !== 'success' && b.status === 'success') return 1;
                            if (a.status === 'success' && b.status !== 'success') return -1;
                            if (a.percentage === null) return 1;
                            if (b.percentage === null) return -1;
                            return a.percentage - b.percentage;
                        });
                    });
                }

                ws.close();
                finish(result);
            };

            ws.onerror = () => {
                clearTimeout(timer);
                ws.close();
                finish({
                    id: volatilityId,
                    name: symbolNames[volatilityId],
                    percentage: null,
                    status: 'error',
                    attempt,
                });
            };

            ws.onclose = () => {
                clearTimeout(timer);
            };
        });
    }, []);

    const handleFetchSignalFast = async () => {
        if (analysisStarted) return;

        const scanRunId = Date.now();
        scanRunIdRef.current = scanRunId;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage('🚀 Starting fast scan...');

        const settledResults = await Promise.allSettled(
            volatilityList.map(volatilityId => scanSymbol(volatilityId, tradeType, scanRunId))
        );

        if (scanRunIdRef.current !== scanRunId) return;

        const results = settledResults
            .filter(result => result.status === 'fulfilled' && result.value)
            .map(result => result.value);

        if (results.length > 0) {
            const best = [...results].sort((a, b) => a.percentage - b.percentage)[0];
            // Measured, not invented: how often this outcome showed up in the sampled ticks on the chosen market.
            setStrongestSignal({ ...best, confidence: Number(best.percentage).toFixed(1) });
            setSymbol(best.id);
            setContractType(tradeType);
            logMessage(`✅ Fast scan complete: ${best.name}`);
            try {
                alertSound.play().catch(() => {});
            } catch {}
        }

        setAnalysisStarted(false);
    };

    const handleFetchSignalGuaranteed = async () => {
        if (analysisStarted) return;

        const scanRunId = Date.now();
        scanRunIdRef.current = scanRunId;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage('Starting guaranteed full-market scan...');

        let pendingSymbols = [...volatilityList];
        const finalResultsMap = new Map();

        for (let attempt = 1; attempt <= SCAN_MAX_RETRIES && pendingSymbols.length > 0; attempt++) {
            const settledResults = await Promise.allSettled(
                pendingSymbols.map(volatilityId => scanSymbol(volatilityId, tradeType, scanRunId, attempt))
            );

            if (scanRunIdRef.current !== scanRunId) return;

            const roundResults = settledResults
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

            roundResults.forEach(result => {
                finalResultsMap.set(result.id, result);
            });

            pendingSymbols = roundResults.filter(result => result.status !== 'success').map(result => result.id);

            if (pendingSymbols.length > 0 && attempt < SCAN_MAX_RETRIES) {
                logMessage(`Retrying ${pendingSymbols.length} market(s): ${pendingSymbols.join(', ')}`);
            }
        }

        if (scanRunIdRef.current !== scanRunId) return;

        const results = volatilityList.map(volatilityId => finalResultsMap.get(volatilityId)).filter(Boolean);

        const successfulResults = results.filter(
            result => result.status === 'success' && typeof result.percentage === 'number'
        );

        if (successfulResults.length > 0) {
            const best = [...successfulResults].sort((a, b) => a.percentage - b.percentage)[0];
            // Measured, not invented: how often this outcome showed up in the sampled ticks on the chosen market.
            setStrongestSignal({ ...best, confidence: Number(best.percentage).toFixed(1) });
            setSymbol(best.id);
            setContractType(tradeType);
            if (successfulResults.length === volatilityList.length) {
                logMessage(
                    `Guaranteed scan complete: ${best.name} after checking all ${successfulResults.length} markets.`
                );
            } else {
                const missingSymbols = volatilityList.filter(
                    volatilityId => !successfulResults.some(result => result.id === volatilityId)
                );
                logMessage(`Scan complete: ${best.name}. Some markets did not finish: ${missingSymbols.join(', ')}`);
            }
            try {
                alertSound.play().catch(() => {});
            } catch {}
        } else {
            const missingSymbols = volatilityList.filter(
                volatilityId => !successfulResults.some(result => result.id === volatilityId)
            );
            logMessage(`Scan incomplete after ${SCAN_MAX_RETRIES} attempts. Missing: ${missingSymbols.join(', ')}`);
        }

        setAnalysisStarted(false);
    };

    // Advanced Over/Under Find Market: deep history for every market, then the harmonised engine
    // (Overlord's original condition + Oracle's layers + Apex Sentinel's layers) picks one market.
    const handleFindMarketEngine = async () => {
        if (analysisStarted) {
            scanRunIdRef.current = Date.now(); // stop: a newer id makes the running scan abandon its result
            setAnalysisStarted(false);
            return;
        }
        await runEngineScan();
    };

    // Returns the engine's pick, or null (stopped, invalid input, or no market returned enough ticks).
    const runEngineScanInner = async () => {
        const side = tradeType;
        const barrier = parseInt(predictionDigitRef.current, 10);
        if (!smartContract && !isTradableBarrier(side, barrier)) {
            showToast(
                side === 'OVER' ? 'Over needs a prediction from 0 to 8' : 'Under needs a prediction from 1 to 9',
                'warning'
            );
            return null;
        }

        const scanRunId = Date.now();
        scanRunIdRef.current = scanRunId;
        const cancelled = () => scanRunIdRef.current !== scanRunId;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage(
            smartContract ? '🚀 Advanced scan: engine picks market, side and barrier...' : '🚀 Advanced scan...'
        );

        const fetched = await fetchHistories(SCAN_WS_URL, volatilityList, {
            cancelled,
            onResult: r => {
                if (cancelled()) return;
                const read = r.series ? legacyPercentage(r.series.digits, side, barrier) : null;
                setScannedHistory(prev => [
                    ...prev.filter(item => item.id !== r.symbol),
                    { id: r.symbol, name: symbolNames[r.symbol], percentage: read, status: r.status },
                ]);
            },
        });
        if (cancelled()) return null;

        const series = {};
        fetched.forEach(r => {
            if (r.series) series[r.symbol] = r.series;
        });
        await new Promise(resolve => setTimeout(resolve, 0)); // let the progress card paint before the CPU-heavy part
        if (cancelled()) return null;

        // The markets are watched live for a few seconds and re-scanned before any market is shown.
        logMessage(`👀 Watching ${Object.keys(series).length} markets live for ${Math.round(ASSESS_MS / 1000)}s...`);
        setAssessInfo({ elapsedMs: 0, assessMs: ASSESS_MS, ticks: 0, rounds: 0, leader: null, flagged: 0 });
        let assessed;
        try {
            assessed = await assessOverlord({
                series,
                symbols: volatilityList,
                side,
                barrier: Number.isFinite(barrier) ? barrier : 2,
                mode: smartContract ? 'smart' : 'selected',
                // Every market gets the slow walk-forward model engine too (the full set of engines judges each candidate).
                ensembleTop: smartContract ? 24 : 99,
                url: SCAN_WS_URL,
                cancelled,
                onProgress: p => {
                    if (!cancelled()) setAssessInfo(p);
                },
            });
        } finally {
            setAssessInfo(null);
        }
        if (cancelled() || assessed.cancelled) return null;
        if (!assessed.liveTicks)
            logMessage('Live ticks were not available, so the answer comes from the history only.');
        const scan = assessed.scan;

        const best = scan.best;
        if (best) {
            // Refs are set directly as well: Run may start in the same tick, before the effects copy state into refs.
            symbolRef.current = best.symbol;
            contractTypeRef.current = best.side;
            lastEnginePickRef.current = Date.now();
            setSymbol(best.symbol);
            if (smartContract) {
                setPredictionDigit(String(best.barrier));
                predictionDigitRef.current = String(best.barrier);
                setTradeType(best.side);
            }
            setContractType(best.side);
            setStrongestSignal({
                id: best.symbol,
                name: symbolNames[best.symbol],
                confidence: Number(best.legacyPct ?? 0).toFixed(1),
                engine: best,
                legacyOnly: scan.legacyOnly,
            });
            logMessage(`✅ ${best.tier}: ${symbolNames[best.symbol]} ${best.label} (score ${best.score})`);
            try {
                alertSound.play().catch(() => {});
            } catch {}
        } else {
            logMessage('Scan incomplete: no market returned enough ticks. Try again.');
        }
        setAnalysisStarted(false);
        return best ?? null;
    };
    const trackScan = run => {
        const promise = run();
        scanPromiseRef.current = promise;
        const clear = () => {
            if (scanPromiseRef.current === promise) scanPromiseRef.current = null;
        };
        promise.then(clear, clear);
        return promise;
    };
    const runEngineScan = () => trackScan(runEngineScanInner);
    runEngineScanRef.current = runEngineScan;

    // Even/Odd Find Market: deep history for every market, then the whole Precision Parity tool reads each one. Only a market
    // Parity marks READY can be picked. When Parity has no READY market for the parity, nothing is selected and the closest
    // developing market is shown for information only.
    const handleFindMarketParity = async () => {
        if (analysisStarted) {
            scanRunIdRef.current = Date.now(); // stop: a newer id makes the running scan abandon its result
            setAnalysisStarted(false);
            return;
        }
        await runParityScan();
    };

    // Returns Parity's pick, or null (stopped, no market returned enough ticks, or Parity has no READY market).
    const runParityScanInner = async () => {
        const side = tradeType; // 'EVEN' or 'ODD'
        const scanRunId = Date.now();
        scanRunIdRef.current = scanRunId;
        const cancelled = () => scanRunIdRef.current !== scanRunId;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage(
            smartContract
                ? '🚀 Parity scan: Precision Parity picks market and side...'
                : `🚀 Parity scan for ${side === 'EVEN' ? 'Even' : 'Odd'}...`
        );

        const fetched = await fetchHistories(SCAN_WS_URL, volatilityList, {
            cancelled,
            onResult: r => {
                if (cancelled()) return;
                const read = r.series ? legacyParityPct(r.series.digits, side) : null;
                setScannedHistory(prev => [
                    ...prev.filter(item => item.id !== r.symbol),
                    { id: r.symbol, name: symbolNames[r.symbol], percentage: read, status: r.status },
                ]);
            },
        });
        if (cancelled()) return null;

        const series = {};
        fetched.forEach(r => {
            if (r.series) series[r.symbol] = r.series;
        });
        await new Promise(resolve => setTimeout(resolve, 0)); // let the progress card paint before the CPU-heavy part
        if (cancelled()) return null;

        // The markets are watched live for a few seconds and Parity is re-run every refresh before any market is shown.
        logMessage(
            `👀 Watching ${Object.keys(series).length} markets live for ${Math.round(PARITY_ASSESS_MS / 1000)}s...`
        );
        setAssessInfo({ elapsedMs: 0, assessMs: PARITY_ASSESS_MS, ticks: 0, rounds: 0, leader: null, flagged: 0 });
        let assessed;
        try {
            assessed = await assessParity({
                series,
                symbols: volatilityList,
                side: smartContract ? null : side,
                names: symbolNames,
                url: SCAN_WS_URL,
                cancelled,
                onProgress: p => {
                    if (!cancelled()) setAssessInfo(p);
                },
            });
        } finally {
            setAssessInfo(null);
        }
        if (cancelled() || assessed.cancelled) return null;
        if (!assessed.liveTicks)
            logMessage('Live ticks were not available, so the answer comes from the history only.');
        const scan = assessed.scan;

        const best = scan.best;
        if (best) {
            // Refs are set directly as well: Run may start in the same tick, before the effects copy state into refs.
            symbolRef.current = best.symbol;
            contractTypeRef.current = best.side;
            lastEnginePickRef.current = Date.now();
            setSymbol(best.symbol);
            if (smartContract) setTradeType(best.side);
            setContractType(best.side);
            setStrongestSignal({
                id: best.symbol,
                name: symbolNames[best.symbol],
                confidence: Number(best.legacyPct ?? 0).toFixed(1),
                engine: best,
                legacyOnly: scan.legacyOnly,
            });
            logMessage(
                best.thin
                    ? `✅ ${symbolNames[best.symbol]} ${best.label} (basic scan: too few ticks for Precision Parity)`
                    : `✅ ${best.tier}: ${symbolNames[best.symbol]} ${best.label}, Precision Parity READY at ${best.score}%`
            );
            try {
                alertSound.play().catch(() => {});
            } catch {}
        } else if (scan.evaluated > 0) {
            // Parity has no READY market. Nothing is selected and nothing changes on screen except this note.
            const watch = scan.watch;
            if (watch) {
                setStrongestSignal({
                    id: watch.symbol,
                    name: symbolNames[watch.symbol],
                    confidence: Number(watch.legacyPct ?? 0).toFixed(1),
                    engine: watch,
                    legacyOnly: false,
                    watchOnly: true,
                });
            }
            const wanted = smartContract ? 'Even or Odd' : side === 'EVEN' ? 'Even' : 'Odd';
            const other = scan.opposite
                ? ` It does see ${scan.opposite.label} on ${symbolNames[scan.opposite.symbol]} (${scan.opposite.score}%).`
                : '';
            logMessage(`⏸ Precision Parity has no READY market for ${wanted} right now.${other} Try again shortly.`);
        } else {
            logMessage('Scan incomplete: no market returned enough ticks. Try again.');
        }
        setAnalysisStarted(false);
        return best ?? null;
    };
    const runParityScan = () => trackScan(runParityScanInner);
    runParityScanRef.current = runParityScan;

    const handleFindMarket = () => {
        if (tradeType === 'OVER' || tradeType === 'UNDER') return handleFindMarketEngine();
        if (tradeType === 'EVEN' || tradeType === 'ODD') return handleFindMarketParity();
        return handleFetchSignalGuaranteed();
    };

    const handleReset = () => {
        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        totalProfitRef.current = 0;
        logMessage('🔄 Stats reset.');
    };

    const isOuTrade = tradeType === 'OVER' || tradeType === 'UNDER';
    const isParityTrade = tradeType === 'EVEN' || tradeType === 'ODD';
    const autoMarket = anyMarket && (isOuTrade || isParityTrade);
    const currentScanningId = volatilityList.find(id => !scannedHistory.some(item => item.id === id));
    const isAllComplete = scannedHistory.length === volatilityList.length;
    const fifoQueue = scannedHistory.slice(-4);

    // ------------------ SIGNAL EXPIRATION LOGIC ------------------
    useEffect(() => {
        let expirationTimer;

        if (strongestSignal) {
            // Set timer to clear signal after 2 minutes (120,000 ms)
            expirationTimer = setTimeout(() => {
                setStrongestSignal(null);
                logMessage('⏳ Signal expired (2-minute limit reached)');
            }, 60000);
        }

        // Cleanup: Clear the timer if a new signal is fetched or component unmounts
        return () => {
            if (expirationTimer) clearTimeout(expirationTimer);
        };
    }, [strongestSignal]);

    return (
        <div className='sh-main-container'>
            <div className='sh-container'>
                <div className='ovl-header-context'>
                    <div className='ovl-header-inner'>
                        <h2 className='ovl-main-branding'>
                            <span className='ovl-brand-text'>OVERLORD</span>
                            <span className='ovl-brand-year'>PRO</span>
                            <div className='ovl-status-container'>
                                <span className='ovl-live-pulse'>V2.3</span>
                            </div>
                        </h2>
                        <div className='ovl-brand-divider'></div>
                    </div>
                </div>

                <div className='sh-controls-box'>
                    <div className='sh-input-wrapper'>
                        <div className='sh-input-field'>
                            <label>⚙️ Contract Type</label>
                            <select
                                value={tradeType}
                                onChange={e => setTradeType(e.target.value)}
                                className='st-instrument-select'
                            >
                                {['EVEN', 'ODD', 'OVER', 'UNDER', 'RISE', 'FALL', 'MATCHES', 'DIFFERS'].map(t => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {['OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(tradeType) && (
                            <div className='sh-input-field digit-width'>
                                <label>PREDICTION:</label>
                                <input
                                    type='number'
                                    min='0'
                                    max='9'
                                    value={predictionDigit}
                                    onChange={e => setPredictionDigit(e.target.value)}
                                />
                            </div>
                        )}

                        <div className='sh-input-field market-width'>
                            <label>MARKET</label>
                            <select
                                value={autoMarket ? marketMode : symbol}
                                onChange={e => {
                                    const v = e.target.value;
                                    if (v === 'any' || v === 'all') {
                                        setMarketMode(v);
                                    } else {
                                        setMarketMode('one');
                                        setSymbol(v);
                                    }
                                }}
                                disabled={isRunning || analysisStarted}
                                className='st-instrument-select'
                            >
                                {(isOuTrade || isParityTrade) && <option value='any'>Any market (engine picks)</option>}
                                {(isOuTrade || isParityTrade) && (
                                    <option value='all'>
                                        {isOuTrade ? 'Any market, side and barrier' : 'Any market and side'}
                                    </option>
                                )}
                                {volatilityList.map(id => (
                                    <option key={id} value={id}>
                                        {symbolNames[id]}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className='ovl-find-market'>
                        <button
                            type='button'
                            className={analysisStarted ? 'ovl-find-btn is-scanning' : 'ovl-find-btn'}
                            onClick={handleFindMarket}
                            disabled={isRunning}
                        >
                            {analysisStarted ? 'SCANNING… TAP TO STOP' : 'FIND MARKET'}
                        </button>
                    </div>
                    {/* RECOVERY MODE UI SECTION */}
                    <div className='st-recovery-dashboard-row'>
                        {/* TOGGLE GROUP */}
                        <div className='st-recovery-cell toggle-cell'>
                            <label className='st-switch'>
                                <input
                                    type='checkbox'
                                    checked={useRecovery}
                                    onChange={e => setUseRecovery(e.target.checked)}
                                />
                                <span className='st-slider'></span>
                            </label>
                            <span className='st-cell-title'>RECOVERY MODE</span>
                        </div>

                        {useRecovery && (
                            <div className='st-recovery-controls'>
                                {/* CONTRACT SELECT GROUP */}
                                <div className='st-control-group'>
                                    <label className='st-micro-label'>CONTRACT TYPE</label>
                                    <select
                                        value={recoveryType}
                                        onChange={e => setRecoveryType(e.target.value)}
                                        className='st-instrument-select'
                                    >
                                        {['EVEN', 'ODD', 'OVER', 'UNDER', 'RISE', 'FALL', 'MATCHES', 'DIFFERS'].map(
                                            t => (
                                                <option key={t} value={t}>
                                                    {t}
                                                </option>
                                            )
                                        )}
                                    </select>
                                </div>

                                {/* PREDICTION INPUT GROUP */}
                                {['OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(recoveryType) && (
                                    <div className='st-control-group'>
                                        <label className='st-micro-label'>PREDICTION</label>
                                        <input
                                            type='number'
                                            min='0'
                                            max='9'
                                            value={recoveryPrediction}
                                            onChange={e => setRecoveryPrediction(e.target.value)}
                                            className='st-instrument-input'
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {DIGIT_TYPES.includes(tradeType) && (
                        <div className='st-recovery-dashboard-row ovl-vh-row'>
                            <div className='st-recovery-cell toggle-cell'>
                                <label className='st-switch'>
                                    <input
                                        type='checkbox'
                                        aria-label='Virtual hook'
                                        checked={useVirtualHook}
                                        onChange={e => setUseVirtualHook(e.target.checked)}
                                    />
                                    <span className='st-slider'></span>
                                </label>
                                <span className='st-cell-title'>VIRTUAL HOOK</span>
                            </div>

                            {useVirtualHook && (
                                <div className='st-recovery-controls'>
                                    <div className='st-control-group'>
                                        <label className='st-micro-label'>MODE</label>
                                        <select
                                            value={vhMode}
                                            onChange={e => setVhMode(e.target.value)}
                                            className='st-instrument-select'
                                        >
                                            <option value='STREAK'>UNTIL PAPER WINS</option>
                                            <option value='FIXED'>FIXED PAPER TRADES</option>
                                        </select>
                                    </div>
                                    <div className='st-control-group'>
                                        <label className='st-micro-label'>GO VIRTUAL AFTER LOSSES</label>
                                        <input
                                            type='number'
                                            min='1'
                                            max='10'
                                            value={vhEnterLosses}
                                            onChange={e => setVhEnterLosses(e.target.value)}
                                            className='st-instrument-input'
                                        />
                                    </div>
                                    {vhMode === 'STREAK' ? (
                                        <div className='st-control-group'>
                                            <label className='st-micro-label'>BACK TO REAL AFTER WINS</label>
                                            <input
                                                type='number'
                                                min='1'
                                                max='10'
                                                value={vhReturnWins}
                                                onChange={e => setVhReturnWins(e.target.value)}
                                                className='st-instrument-input'
                                            />
                                        </div>
                                    ) : (
                                        <div className='st-control-group'>
                                            <label className='st-micro-label'>PAPER TRADES</label>
                                            <input
                                                type='number'
                                                min='1'
                                                max='20'
                                                value={vhFixedCount}
                                                onChange={e => setVhFixedCount(e.target.value)}
                                                className='st-instrument-input'
                                            />
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {useVirtualHook && DIGIT_TYPES.includes(tradeType) && (isRunning || paperStats.trades > 0) && (
                        <span className={`ovl-paper ${paperStats.active ? 'is-on' : ''}`}>
                            {paperStats.active ? 'Trading on paper now' : 'Trading real money'} · paper{' '}
                            {paperStats.wins}/{paperStats.trades} won
                        </span>
                    )}

                    <div className='sh-button-group'>
                        <button className={isRunning ? 'sh-bot-stop' : 'sh-bot-run'} onClick={handleStart}>
                            {isRunning ? '⏹ STOP BOT' : '▶ RUN BOT'}
                        </button>
                    </div>
                </div>

                <div className='sh-display-area'>
                    {analysisStarted ? (
                        <div className='scanner-view'>
                            <div className='dynamic-scanner-zone'>
                                {!isAllComplete && currentScanningId ? (
                                    <div className='active-scan-card' key={currentScanningId}>
                                        <span className='live-tag'>ANALYZING:</span>
                                        <h3 className='active-symbol-name'>
                                            {symbolNames[currentScanningId] || currentScanningId}
                                        </h3>
                                        <div className='loading-bar-container'>
                                            <div className='loading-bar-fill'></div>
                                        </div>
                                    </div>
                                ) : assessInfo ? (
                                    <div className='active-scan-card'>
                                        <span className='live-tag'>ASSESSING LIVE</span>
                                        <h3 className='active-symbol-name'>
                                            {Math.round(assessInfo.elapsedMs / 1000)}s /{' '}
                                            {Math.round(assessInfo.assessMs / 1000)}s
                                        </h3>
                                        <div className='loading-bar-container'>
                                            <div
                                                className='ovl-assess-fill'
                                                style={{
                                                    width: `${Math.min(100, (assessInfo.elapsedMs / assessInfo.assessMs) * 100)}%`,
                                                }}
                                            ></div>
                                        </div>
                                        <div className='ovl-assess-line'>
                                            {assessInfo.rounds > 0
                                                ? `${assessInfo.flagged} flagged · leading: ${
                                                      assessInfo.leader
                                                          ? `${symbolNames[assessInfo.leader.symbol] || assessInfo.leader.symbol}`
                                                          : 'none clear'
                                                  }`
                                                : 'Watching live ticks'}
                                            {assessInfo.ticks > 0 ? ` · ${assessInfo.ticks} live ticks in` : ''}
                                        </div>
                                    </div>
                                ) : (
                                    <div className='active-scan-card complete'>
                                        <span className='live-tag'>READY</span>
                                        <h3 className='active-symbol-name'>Scan Finished</h3>
                                    </div>
                                )}
                                <div className='history-ticker'>
                                    {fifoQueue.map((item, index) => (
                                        <div key={`${item.id}-${index}`} className='ticker-item'>
                                            <div className='ticker-content'>
                                                <span className='ticker-check'>✓</span>
                                                <span className='ticker-name'>{symbolNames[item.id] || item.id}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : strongestSignal?.engine ? (
                        <div className='sh-result-ui'>
                            <div className='sh-result-main'>
                                <div className='sh-result-info'>
                                    <span className='sh-res-label'>
                                        {
                                            {
                                                STRONG: 'PERFECT MARKET FOUND',
                                                BEST: 'BEST MARKET AVAILABLE',
                                                CAUTION: 'NO MARKET CLEARED, LEAST RISKY SHOWN',
                                                LEGACY: 'MARKET FOUND (BASIC SCAN)',
                                                WATCH: 'NO READY MARKET, CLOSEST SHOWN (NOT SELECTED)',
                                            }[strongestSignal.watchOnly ? 'WATCH' : strongestSignal.engine.tier]
                                        }
                                    </span>
                                    <h3 className='sh-res-vol'>
                                        {strongestSignal.name} · {strongestSignal.engine.label}
                                    </h3>
                                </div>
                                <div className='sh-res-stat'>
                                    <span className='sh-res-perc'>⚡ {strongestSignal.engine.score}</span>
                                    <span className='sh-res-type'>
                                        {strongestSignal.engine.agree}/{strongestSignal.engine.applied} CHECKS AGREE
                                    </span>
                                </div>
                            </div>
                            {strongestSignal.engine.apexNotes && (
                                <div className='ovl-eng-notes'>
                                    {strongestSignal.engine.live && (
                                        <span>
                                            Live ticks: {strongestSignal.engine.live.wins} of{' '}
                                            {strongestSignal.engine.live.n} won (about{' '}
                                            {strongestSignal.engine.live.expected.toFixed(1)} expected)
                                        </span>
                                    )}
                                    {strongestSignal.engine.steady && (
                                        <span>
                                            Clear in {Math.round(strongestSignal.engine.steady.clearShare * 100)}% of{' '}
                                            {strongestSignal.engine.steady.rounds} live checks
                                        </span>
                                    )}
                                    <span>Engines {strongestSignal.engine.apexNotes.agreement}</span>
                                    <span>Psychology {strongestSignal.engine.apexNotes.psychology}</span>
                                    <span>Stability {strongestSignal.engine.apexNotes.instability}</span>
                                    <span>Direction {strongestSignal.engine.apexNotes.direction}</span>
                                    <span>Fluctuation {strongestSignal.engine.apexNotes.fluctuation}</span>
                                </div>
                            )}
                            {strongestSignal.engine.parity && (
                                <div className='ovl-eng-notes'>
                                    {strongestSignal.engine.steady && (
                                        <span>
                                            Ready in {Math.round(strongestSignal.engine.steady.clearShare * 100)}% of{' '}
                                            {strongestSignal.engine.steady.rounds} live checks
                                        </span>
                                    )}
                                    <span>Parity {strongestSignal.engine.parity.state.toLowerCase()}</span>
                                    {strongestSignal.engine.parity.grade && (
                                        <span>Grade {strongestSignal.engine.parity.grade}</span>
                                    )}
                                    <span>Regime {strongestSignal.engine.parity.regime}</span>
                                    {strongestSignal.engine.parity.stability && (
                                        <span>Stability {strongestSignal.engine.parity.stability}</span>
                                    )}
                                    {strongestSignal.engine.parity.chief && (
                                        <span>Chief {strongestSignal.engine.parity.chief}</span>
                                    )}
                                    {strongestSignal.engine.parity.contrarian && (
                                        <span>Contrarian {strongestSignal.engine.parity.contrarian}</span>
                                    )}
                                    {strongestSignal.engine.parity.survival && (
                                        <span>DBot {strongestSignal.engine.parity.survival}</span>
                                    )}
                                    {strongestSignal.engine.parity.recommendedRuns !== null && (
                                        <span>Runs {strongestSignal.engine.parity.recommendedRuns}</span>
                                    )}
                                </div>
                            )}
                            <ul className='ovl-eng-reasons'>
                                {strongestSignal.engine.reasons.map((reason, i) => (
                                    <li key={i}>{reason}</li>
                                ))}
                            </ul>
                            <div className='sh-res-footer'>
                                <span className='sh-res-status'>
                                    {strongestSignal.engine.vetoed
                                        ? '⚠️ A SAFETY CHECK OBJECTS'
                                        : '🛡️ NO SAFETY CHECK OBJECTS'}
                                </span>
                                <span className='sh-res-timestamp'>
                                    {strongestSignal.confidence}% OF LAST 50 TICKS WON
                                </span>
                            </div>
                        </div>
                    ) : strongestSignal ? (
                        <div className='sh-result-ui'>
                            <div className='sh-result-main'>
                                <div className='sh-result-info'>
                                    <span className='sh-res-label'>PERFECT MARKET FOUND</span>
                                    <h3 className='sh-res-vol'>{strongestSignal.name}</h3>
                                </div>
                                <div className='sh-res-stat'>
                                    <span className='sh-res-perc'>⚡ {strongestSignal.confidence}%</span>
                                    <span className='sh-res-type'>SEEN IN SAMPLED TICKS</span>
                                </div>
                            </div>
                            <div className='sh-res-footer'>
                                <span className='sh-res-status'>🛡️ SIGNAL VERIFIED</span>
                                <span className='sh-res-timestamp'>⚖️ ACCURACY CHECKED</span>
                            </div>
                        </div>
                    ) : (
                        <div className='sh-standby-ui'>
                            <p>
                                {autoMarket ? (
                                    'The best market is picked when you run.'
                                ) : (
                                    <>
                                        Trading on{' '}
                                        <span style={{ fontWeight: 800 }}>{symbolNames[symbol] || symbol}</span>.
                                    </>
                                )}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div className='st-container'>
                <div className='st-top-row'>
                    <div className='st-input-box'>
                        <label>Initial Stake</label>
                        <input type='number' value={initialStake} onChange={handleInitialStakeChange} />
                    </div>
                    <div className='st-input-box'>
                        <label>Target Profit</label>
                        <input type='number' value={targetProfit} onChange={handleTargetProfitChange} />
                    </div>
                    <div className='st-input-box'>
                        <label>Stop Loss</label>
                        <input type='number' value={stopLoss} onChange={handleStopLossChange} />
                    </div>
                </div>

                <div className='st-bot-footer'>
                    <div className='st-toggle-wrap'>
                        <label className='st-switch'>
                            <input
                                type='checkbox'
                                checked={useMartingale}
                                onChange={e => setUseMartingale(e.target.checked)}
                            />
                            <span className='st-slider'></span>
                        </label>
                        <span className='st-toggle-label'>Enable Martingale</span>
                    </div>
                    {useMartingale && (
                        <div className='st-mult-input'>
                            <label>Multiplier</label>
                            <input
                                type='number'
                                step='0.1'
                                value={martingaleMultiplier}
                                onChange={e => setMartingaleMultiplier(e.target.value)}
                            />
                        </div>
                    )}
                </div>
            </div>

            {proposalError && (
                <div className='bot-errors'>
                    <strong>Error:</strong> {proposalError}
                </div>
            )}
        </div>
    );
};

export default Overlord;
