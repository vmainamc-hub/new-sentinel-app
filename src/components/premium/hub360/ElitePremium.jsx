import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getHub360AuthContext, getHub360AuthenticatedUrl } from './auth360';
import { useHub360Module } from './use-hub360-module';
import { createPortal } from 'react-dom';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';


const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const JOURNAL_SLOT_ID = 'db-journal-custom-slot';
const MAX_STRATEGIES = 5;
const MONITOR_WINDOW = 5;
const CONDITION_TYPES = ['EVEN', 'ODD', 'OVER', 'UNDER', 'RISE', 'FALL'];
// Contracts a strategy (or the recovery trade) can place. "Only Ups / Only Downs" are Deriv's RUNHIGH / RUNLOW (2-5 ticks).
const TRADE_TYPES = ['EVEN', 'ODD', 'OVER', 'UNDER', 'MATCHES', 'DIFFERS', 'RISE', 'FALL', 'ONLY_UPS', 'ONLY_DOWNS'];
const TRADE_LABELS = { ONLY_UPS: 'Only Ups', ONLY_DOWNS: 'Only Downs' };
const isRunTrade = type => type === 'ONLY_UPS' || type === 'ONLY_DOWNS';
const ONE_S_SYMBOLS = ['1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V'];
const PLAIN_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
const ALL_SYMBOLS = [...ONE_S_SYMBOLS, ...PLAIN_SYMBOLS];
const MARKET_PRESETS = [
    { id: 'one_s', label: '1s Markets', symbols: ONE_S_SYMBOLS },
    { id: 'plain', label: 'Plain Indices', symbols: PLAIN_SYMBOLS },
    { id: 'all', label: 'All Markets', symbols: ALL_SYMBOLS },
    { id: 'choose', label: 'Choose Market', symbols: null },
];
const MAX_EXTRA_CONDITIONS = 3;
const RECOVERY_SETTINGS = [
    { id: 'until_win', label: 'Returns after recovery' },
    { id: 'once', label: 'One recovery trade, then back' },
];

const CONTRACT_TYPE_MAP = {
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
    OVER: 'DIGITOVER',
    UNDER: 'DIGITUNDER',
    RISE: 'CALL',
    FALL: 'PUT',
    MATCHES: 'DIGITMATCH',
    DIFFERS: 'DIGITDIFF',
    ONLY_UPS: 'RUNHIGH',
    ONLY_DOWNS: 'RUNLOW',
};

const createStrategyId = () => `elite-premium-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isDigitCondition = type => ['EVEN', 'ODD', 'OVER', 'UNDER'].includes(type);
const isMoveCondition = type => ['RISE', 'FALL'].includes(type);
const requiresBarrier = type => type === 'OVER' || type === 'UNDER' || type === 'MATCHES' || type === 'DIFFERS';
const getBarrierRange = type => (type === 'OVER' ? [0, 8] : type === 'UNDER' ? [1, 9] : [0, 9]);

const getDefaultBarrier = tradeType => {
    if (tradeType === 'OVER') return '4';
    if (tradeType === 'UNDER') return '5';
    if (tradeType === 'MATCHES' || tradeType === 'DIFFERS') return '5';
    return '';
};

const createStrategy = (overrides = {}) => ({
    id: createStrategyId(),
    lookback: '5',
    condition: 'ODD',
    trade: 'EVEN',
    barrier: '',
    conditionBarrier: '',
    duration: '1',
    extras: [],
    ...overrides,
});

const normalizeDuration = (value, tradeType) => {
    const parsed = Number.parseInt(value, 10);
    const ticks = Number.isInteger(parsed) ? Math.min(10, Math.max(1, parsed)) : 1;
    return isRunTrade(tradeType) ? Math.min(5, Math.max(2, ticks)) : ticks;
};

// A strategy fires when its main condition and every extra "+ condition" hold at the same time.
const getStrategyConditions = strategy => [
    { lookback: strategy.lookback, condition: strategy.condition, conditionBarrier: strategy.conditionBarrier },
    ...(Array.isArray(strategy.extras) ? strategy.extras : []),
];

const normalizeLookback = value => {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed)) return 1;
    return Math.min(10, Math.max(1, parsed));
};

const normalizeMoney = (value, fallback = 1) => {
    const parsed = Number.parseFloat(value);

    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Number(parsed.toFixed(2));
};

const clampBarrierValue = (tradeType, rawValue) => {
    const parsed = Number.parseInt(String(rawValue).replace(/[^\d]/g, ''), 10);

    if (!Number.isInteger(parsed)) return '';
    if (tradeType === 'OVER') return String(Math.min(8, Math.max(0, parsed)));
    if (tradeType === 'UNDER') return String(Math.min(9, Math.max(1, parsed)));
    if (tradeType === 'MATCHES' || tradeType === 'DIFFERS') return String(Math.min(9, Math.max(0, parsed)));
    return '';
};

const matchesDigitCondition = (digit, condition, conditionBarrier = '') => {
    const threshold = Number.parseInt(conditionBarrier, 10);
    if (condition === 'EVEN') return digit % 2 === 0;
    if (condition === 'ODD') return digit % 2 !== 0;
    if (condition === 'OVER') return digit > (Number.isInteger(threshold) ? threshold : 4);
    if (condition === 'UNDER') return digit < (Number.isInteger(threshold) ? threshold : 5);
    return false;
};

const CONDITION_LABELS = { OVER: '> (OVER)', UNDER: '< (UNDER)' };
const getDefaultConditionBarrier = condition => (condition === 'OVER' ? '4' : condition === 'UNDER' ? '5' : '');
const formatCondition = strategy =>
    requiresBarrier(strategy.condition) && strategy.conditionBarrier
        ? `${strategy.condition} ${strategy.conditionBarrier}`
        : strategy.condition;

const TRADING_MODES = [
    { id: 'signal', label: 'Analyze before every trade' },
    { id: 'continuous_loss', label: 'Trade continuously when there is a loss' },
];

const getRecentMoves = (prices, limit = MONITOR_WINDOW) => {
    const relevantPrices = prices.slice(-(limit + 1));
    const moves = [];

    for (let index = 1; index < relevantPrices.length; index += 1) {
        const currentPrice = Number(relevantPrices[index]);
        const previousPrice = Number(relevantPrices[index - 1]);

        if (currentPrice > previousPrice) moves.push('RISE');
        else if (currentPrice < previousPrice) moves.push('FALL');
        else moves.push('FLAT');
    }

    return moves;
};

const getMaxDigitHistory = strategies => {
    const digitWindows = strategies
        .flatMap(getStrategyConditions)
        .filter(item => isDigitCondition(item.condition))
        .map(item => normalizeLookback(item.lookback));

    return Math.max(MONITOR_WINDOW, ...digitWindows, 1);
};

const getMaxPriceHistory = strategies => {
    const moveWindows = strategies
        .flatMap(getStrategyConditions)
        .filter(item => isMoveCondition(item.condition))
        .map(item => normalizeLookback(item.lookback) + 1);

    return Math.max(MONITOR_WINDOW + 1, ...moveWindows, 2);
};

const formatTradeLabel = (tradeType, barrier) => {
    if (!requiresBarrier(tradeType)) return TRADE_LABELS[tradeType] || tradeType;
    return `${tradeType} ${barrier}`;
};

const formatStrategySummary = strategy => {
    const clauses = getStrategyConditions(strategy).map(item => {
        const subject = isMoveCondition(item.condition) ? 'market moves' : 'digits';
        return `the last ${normalizeLookback(item.lookback)} ${subject} are ${formatCondition(item)}`;
    });
    const ticks = normalizeDuration(strategy.duration, strategy.trade);
    return `If ${clauses.join(' and ')}, trade ${formatTradeLabel(strategy.trade, strategy.barrier)} for ${ticks} ticks.`;
};

const formatTokenMove = move => {
    if (move === 'RISE') return 'R';
    if (move === 'FALL') return 'F';
    return '-';
};

const formatSymbolDisplay = symbol => {
    if (!symbol) return '';
    if (symbol.startsWith('1HZ')) return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
    if (symbol.startsWith('R_')) return symbol.replace('R_', 'V');
    return symbol;
};

const getTradeBarrier = (tradeType, barrier) => {
    if (!requiresBarrier(tradeType)) return null;
    return clampBarrierValue(tradeType, barrier);
};

const ElitePremium = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};

    const [isRunning, setIsRunning] = useState(false);
    const [results, setResults] = useState([]);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [totalRuns, setTotalRuns] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [liveDigits, setLiveDigits] = useState({});
    const [liveMoves, setLiveMoves] = useState({});
    const [lastTriggeredSymbol, setLastTriggeredSymbol] = useState(null);
    const [journalMonitorTarget, setJournalMonitorTarget] = useState(null);
    const [statusMessage, setStatusMessage] = useState('Set your strategies, then start the scanner.');
    const [lastSignalLabel, setLastSignalLabel] = useState(transactions?.last_signal_label || 'No signal yet');
    const [nextStakeDisplay, setNextStakeDisplay] = useState(1);
    const [strategies, setStrategies] = useState([
        createStrategy({
            lookback: '3',
            condition: 'UNDER',
            conditionBarrier: '4',
            trade: 'OVER',
            barrier: '2',
        }),
    ]);

    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [mFactor, setMFactor] = useState('2.1');
    const [tradingMode, setTradingMode] = useState('signal');
    const [useRecovery, setUseRecovery] = useState(false);
    const [recoveryType, setRecoveryType] = useState('OVER');
    const [recoveryBarrier, setRecoveryBarrier] = useState('4');
    const [marketMode, setMarketMode] = useState('all');
    const [recoverySetting, setRecoverySetting] = useState('until_win');
    const recoverySettingRef = useRef('until_win');
    const [selectedSymbols, setSelectedSymbols] = useState(ALL_SYMBOLS);
    const tradingModeRef = useRef('signal');
    const useRecoveryRef = useRef(false);
    const recoveryTypeRef = useRef('OVER');
    const recoveryBarrierRef = useRef('4');
    const selectedSymbolsRef = useRef(ALL_SYMBOLS);
    const lastTradeWasLossRef = useRef(false);
    const continuationRef = useRef(null);

    const stakeRef = useRef('1');
    const targetProfitRef = useRef('100');
    const stopLossRef = useRef('100');
    const mFactorRef = useRef('2.1');
    const strategiesRef = useRef(strategies);
    const wsRef = useRef(null);
    const totalProfitRef = useRef(0);
    const isRunningRef = useRef(false);
    const pendingProposalRef = useRef(false);
    const pendingTradeContextRef = useRef(null);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const socketRequiresAuthRef = useRef(false);
    const activeContractsRef = useRef(new Set());
    const isProcessingRef = useRef(false);
    const digitHistoryRef = useRef({});
    const priceHistoryRef = useRef({});
    const contractMetaRef = useRef({});
    const reconnectTimeoutRef = useRef(null);
    const highlightTimeoutRef = useRef(null);
    const nextStakeRef = useRef(1);

    useEffect(() => {
        tradingModeRef.current = tradingMode;
        useRecoveryRef.current = useRecovery;
        recoveryTypeRef.current = recoveryType;
        recoveryBarrierRef.current = recoveryBarrier;
        selectedSymbolsRef.current = selectedSymbols;
        recoverySettingRef.current = recoverySetting;
    }, [tradingMode, useRecovery, recoveryType, recoveryBarrier, selectedSymbols, recoverySetting]);

    useEffect(() => {
        stakeRef.current = stake;
    }, [stake]);

    useEffect(() => {
        targetProfitRef.current = targetProfit;
    }, [targetProfit]);

    useEffect(() => {
        stopLossRef.current = stopLoss;
    }, [stopLoss]);

    useEffect(() => {
        mFactorRef.current = mFactor;
    }, [mFactor]);

    useEffect(() => {
        isRunningRef.current = isRunning;
    }, [isRunning]);

    useEffect(() => {
        run_panel?.setIsRunning?.(isRunning);
        if (!isRunning && activeContractsRef.current.size === 0) {
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [isRunning, run_panel]);
    useHub360Module('hub360-elite-prime', isRunning);

    useEffect(() => {
        strategiesRef.current = strategies;

        const digitLimit = getMaxDigitHistory(strategies);
        const priceLimit = getMaxPriceHistory(strategies);
        const trimmedDigits = {};
        const trimmedMoves = {};

        Object.keys(digitHistoryRef.current).forEach(symbol => {
            digitHistoryRef.current[symbol] = (digitHistoryRef.current[symbol] || []).slice(-digitLimit);
            trimmedDigits[symbol] = digitHistoryRef.current[symbol].slice(-MONITOR_WINDOW);
        });

        Object.keys(priceHistoryRef.current).forEach(symbol => {
            priceHistoryRef.current[symbol] = (priceHistoryRef.current[symbol] || []).slice(-priceLimit);
            trimmedMoves[symbol] = getRecentMoves(priceHistoryRef.current[symbol], MONITOR_WINDOW);
        });

        setLiveDigits(previous => ({ ...previous, ...trimmedDigits }));
        setLiveMoves(previous => ({ ...previous, ...trimmedMoves }));
    }, [strategies]);

    useEffect(() => {
        if (!isRunning) {
            const baseStake = normalizeMoney(stakeRef.current);
            nextStakeRef.current = baseStake;
            setNextStakeDisplay(baseStake);
        }
    }, [stake, isRunning]);

    const updateLastSignalLabel = useCallback(
        label => {
            setLastSignalLabel(label);
            transactions?.setLastSignalLabel?.(label);
        },
        [transactions]
    );

    const getStoredAuthContext = useCallback(() => getHub360AuthContext(), []);
    const getAuthenticatedUrl = useCallback(async () => {
        try {
            return await getHub360AuthenticatedUrl();
        } catch (error) {
            console.error('[Hub360] Auth error:', error);
            return null;
        }
    }, []);

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
            const isWon = contractData.result ? contractData.result === 'won' : Number(contractData.profit) > 0;
            const normalizedCurrency = contractData?.currency || client?.currency || 'USD';
            const normalizedProfit = Number.isFinite(Number(contractData?.profit)) ? Number(contractData.profit) : 0;

            if (journal?.onLogSuccess) {
                journal.onLogSuccess({
                    log_type: isWon ? 'profit' : 'lost',
                    extra: {
                        currency: normalizedCurrency,
                        profit: normalizedProfit,
                    },
                });
            }
        },
        [client?.currency, journal]
    );

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const { preserveOpenContract = activeContractsRef.current.size > 0 } = options;

            setIsRunning(false);
            isRunningRef.current = false;
            isProcessingRef.current = false;
            pendingProposalRef.current = false;
            pendingTradeContextRef.current = null;
            setStatusMessage(reason);

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserveOpenContract) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }

            run_panel?.setIsRunning?.(false);
            run_panel?.toggleDrawer?.(true);
            run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

            if (preserveOpenContract) {
                run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
            } else {
                activeContractsRef.current.clear();
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        },
        [run_panel]
    );

    const handleStop = useCallback(() => {
        stopTradingBot('Bot stopped.');
    }, [stopTradingBot]);

    const handleProposal = useCallback(
        data => {
            if (!isRunningRef.current || !pendingProposalRef.current || activeContractsRef.current.size > 0) {
                return;
            }

            const proposalId = data?.proposal?.id;
            const askPrice = data?.proposal?.ask_price;
            if (!proposalId || typeof askPrice === 'undefined') {
                pendingProposalRef.current = false;
                isProcessingRef.current = false;
                setStatusMessage('Proposal response was incomplete. Waiting for next trade signal.');
                return;
            }

            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            wsRef.current?.send(
                JSON.stringify({
                    buy: proposalId,
                    price: askPrice,
                    passthrough: data.echo_req?.passthrough || pendingTradeContextRef.current,
                })
            );
        },
        [run_panel]
    );

    const handleBuy = useCallback(
        data => {
            if (data.error) {
                isProcessingRef.current = false;
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(
                    isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                );
                publishNativeError(data.error.message);
                setStatusMessage(data.error.message);
                return;
            }

            const { contract_id, transaction_id, buy_price, longcode } = data.buy || {};
            const contractKey = String(contract_id ?? '');
            const passthrough = data.echo_req?.passthrough || pendingTradeContextRef.current || {};
            const { symbol, custom_type, sent_stake, strategy_id, strategy_label, trigger_type, lookback, barrier, is_recovery } =
                passthrough;
            const normalizedSymbol = symbol || '';
            const normalizedStake = Number(
                Number.isFinite(Number(sent_stake)) ? Number(sent_stake) : Number(nextStakeRef.current)
            );

            if (!contractKey) {
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;
                isProcessingRef.current = false;
                return;
            }

            activeContractsRef.current.add(contractKey);
            pendingProposalRef.current = false;
            pendingTradeContextRef.current = null;

            const transactionPayload = {
                id: contractKey,
                contract_id: contractKey,
                transaction_ids: { buy: transaction_id },
                buy_price: buy_price ?? normalizedStake,
                currency: client?.currency || 'USD',
                display_name: formatSymbolDisplay(normalizedSymbol) || 'Contract',
                underlying: normalizedSymbol,
                contract_type: custom_type,
                longcode,
                date_start: Math.floor(Date.now() / 1000),
                strategy_id,
                strategy_label,
                trigger_type,
                lookback,
                barrier,
                is_recovery,
            };

            contractMetaRef.current[contractKey] = transactionPayload;
            publishNativeContract(transactionPayload);

            run_panel?.setHasOpenContract?.(true);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
            setStatusMessage(
                `Trade is live on ${formatSymbolDisplay(normalizedSymbol) || 'selected market'} using ${strategy_label || 'active strategy'}.`
            );

            setResults(previous =>
                [
                    {
                        id: contractKey,
                        contract_id: contractKey,
                        symbol: normalizedSymbol,
                        contract_type: custom_type,
                        strategy_label,
                        trigger_type,
                        lookback,
                        barrier,
                        entry_spot: '-',
                        exit_spot: '-',
                        profit: 0,
                        stake: normalizedStake.toFixed(2),
                        status: 'RUNNING',
                    },
                    ...previous,
                ].slice(0, 14)
            );

            wsRef.current?.send(JSON.stringify({ proposal_open_contract: 1, contract_id: Number(contract_id), subscribe: 1 }));
        },
        [client?.currency, publishNativeContract, publishNativeError, run_panel]
    );

    const handleContractCompletion = useCallback(
        contract => {
            const profit = Number.parseFloat(contract.profit);
            const contractId = String(contract.contract_id ?? '');
            if (!contractId) return;
            const factor = normalizeMoney(mFactorRef.current, 1);
            const baseStake = normalizeMoney(stakeRef.current);
            const meta = contractMetaRef.current[contractId] || {};

            totalProfitRef.current += Number.isFinite(profit) ? profit : 0;
            activeContractsRef.current.delete(contractId);

            if (profit < 0) {
                nextStakeRef.current = Number((nextStakeRef.current * factor).toFixed(2));
            } else {
                nextStakeRef.current = baseStake;
            }

            // "One recovery trade, then back": a recovery trade (win or loss) hands control back to the main strategy.
            lastTradeWasLossRef.current = profit < 0 && !(meta.is_recovery && recoverySettingRef.current === 'once');
            if (!(profit < 0 && tradingModeRef.current === 'continuous_loss')) continuationRef.current = null;

            setNextStakeDisplay(nextStakeRef.current);

            const nativeContract = {
                ...meta,
                ...contract,
                id: contractId,
                contract_id: contractId,
                buy_price: contract.buy_price ?? meta.buy_price ?? 0,
                currency: contract.currency || client?.currency || 'USD',
                display_name: contract.display_name || formatSymbolDisplay(meta.underlying || contract.underlying),
                underlying: contract.underlying || meta.underlying,
                transaction_ids: meta.transaction_ids || contract.transaction_ids,
                result: profit > 0 ? 'won' : 'lost',
                status: profit > 0 ? 'won' : 'lost',
            };

            publishNativeContract(nativeContract);
            publishNativeResult(nativeContract);

            setResults(previous =>
                previous.map(item =>
                    String(item.contract_id) === contractId
                        ? {
                              ...item,
                              entry_spot: contract.entry_spot_display_value ?? '-',
                              exit_spot: contract.exit_tick_display_value ?? '-',
                              profit: Number.isFinite(profit) ? profit : 0,
                              status: profit > 0 ? 'WIN' : 'LOSS',
                          }
                        : item
                )
            );

            setTotalProfit(Number(totalProfitRef.current.toFixed(2)));
            if (profit > 0) setWins(previous => previous + 1);
            else setLosses(previous => previous + 1);
            setTotalRuns(previous => previous + 1);

            if (activeContractsRef.current.size === 0) {
                isProcessingRef.current = false;

                const limitHit =
                    totalProfitRef.current >= normalizeMoney(targetProfitRef.current, 100) ||
                    totalProfitRef.current <= -normalizeMoney(stopLossRef.current, 100);

                if (limitHit) {
                    stopTradingBot('Session ended by target/stop loss.', { preserveOpenContract: false });
                    Swal.fire(
                        'Session Ended',
                        `Final P/L: ${totalProfitRef.current.toFixed(2)} ${client?.currency || 'USD'}`,
                        'info'
                    );
                } else {
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(
                        isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                    );
                    setStatusMessage(
                        profit > 0
                            ? `Trade won on ${nativeContract.display_name}. Scanner is waiting for the next strategy match.`
                            : `Trade lost on ${nativeContract.display_name}. Scanner is waiting for the next strategy match.`
                    );
                }
            }
        },
        [client?.currency, publishNativeContract, publishNativeResult, run_panel, stopTradingBot]
    );

    const findMatchedStrategy = useCallback(symbol => {
        const digitHistory = digitHistoryRef.current[symbol] || [];
        const priceHistory = priceHistoryRef.current[symbol] || [];

        // Returns the sampled digits / moves when the condition holds right now, otherwise null.
        const checkCondition = item => {
            const lookback = normalizeLookback(item.lookback);

            if (isDigitCondition(item.condition)) {
                const relevantDigits = digitHistory.slice(-lookback);
                return relevantDigits.length === lookback &&
                    relevantDigits.every(digit => matchesDigitCondition(digit, item.condition, item.conditionBarrier))
                    ? relevantDigits
                    : null;
            }

            const recentMoves = getRecentMoves(priceHistory, lookback);
            return recentMoves.length === lookback && recentMoves.every(move => move === item.condition) ? recentMoves : null;
        };

        for (let index = 0; index < strategiesRef.current.length; index += 1) {
            const strategy = strategiesRef.current[index];
            const samples = getStrategyConditions(strategy).map(checkCondition);

            if (samples.every(Boolean)) return { strategy, index, sample: samples[0] };
        }

        return null;
    }, []);

    const executeStrategyTrade = useCallback(
        (symbol, matchedStrategy) => {
            const ws = wsRef.current;

            if (!ws || ws.readyState !== WebSocket.OPEN) {
                isProcessingRef.current = false;
                setStatusMessage('WebSocket is not ready yet. Waiting to reconnect.');
                return;
            }

            if (!isAuthorizedRef.current) {
                isProcessingRef.current = false;
                setStatusMessage('Trading session is not authorized yet. Waiting for secure connection.');
                return;
            }

            if (pendingProposalRef.current || activeContractsRef.current.size > 0) {
                return;
            }

            const { strategy, index } = matchedStrategy;
            const isRecovering = useRecoveryRef.current && lastTradeWasLossRef.current;
            const tradeType = isRecovering ? recoveryTypeRef.current : strategy.trade;
            const tradeBarrier = getTradeBarrier(tradeType, isRecovering ? recoveryBarrierRef.current : strategy.barrier);
            const currentStake = Number(nextStakeRef.current.toFixed(2));
            const strategyLabel = `Strategy ${index + 1}`;
            const conditionLabel = isMoveCondition(strategy.condition) ? 'market moves' : 'digits';
            const summaryLabel = formatStrategySummary(strategy);
            const payload = {
                proposal: 1,
                basis: 'stake',
                currency: client?.currency || 'USD',
                underlying_symbol: symbol,
                duration: normalizeDuration(strategy.duration, tradeType),
                duration_unit: 't',
                amount: currentStake,
                contract_type: CONTRACT_TYPE_MAP[tradeType],
                passthrough: {
                    symbol,
                    custom_type: tradeType,
                    sent_stake: currentStake,
                    strategy_id: strategy.id,
                    strategy_label: strategyLabel,
                    trigger_type: strategy.condition,
                    lookback: normalizeLookback(strategy.lookback),
                    barrier: tradeBarrier,
                    summary_label: summaryLabel,
                    is_recovery: isRecovering,
                },
            };

            if (tradeBarrier !== null) {
                payload.barrier = tradeBarrier;
            }

            pendingTradeContextRef.current = payload.passthrough;
            pendingProposalRef.current = true;
            continuationRef.current = { symbol, matched: matchedStrategy };
            ws.send(JSON.stringify(payload));
            updateLastSignalLabel(
                `${strategyLabel} on ${formatSymbolDisplay(symbol)}: last ${normalizeLookback(strategy.lookback)} ${conditionLabel} were ${formatCondition(strategy)}${strategy.extras?.length ? ` (+${strategy.extras.length} more)` : ''}.${isRecovering ? ' (recovery trade)' : ''}`
            );
            setStatusMessage(
                `Matched ${strategyLabel} on ${formatSymbolDisplay(symbol)}. Sending ${formatTradeLabel(tradeType, tradeBarrier)} proposal.`
            );
        },
        [client?.currency, updateLastSignalLabel]
    );

    const handleTick = useCallback(
        tick => {
            const { symbol, quote } = tick || {};

            if (!symbol || typeof quote === 'undefined') return;

            const currentDigit = Number.parseInt(String(quote).slice(-1), 10);
            const digitLimit = getMaxDigitHistory(strategiesRef.current);
            const priceLimit = getMaxPriceHistory(strategiesRef.current);

            if (!digitHistoryRef.current[symbol]) digitHistoryRef.current[symbol] = [];
            digitHistoryRef.current[symbol].push(currentDigit);
            if (digitHistoryRef.current[symbol].length > digitLimit) {
                digitHistoryRef.current[symbol].shift();
            }

            if (!priceHistoryRef.current[symbol]) priceHistoryRef.current[symbol] = [];
            priceHistoryRef.current[symbol].push(Number(quote));
            if (priceHistoryRef.current[symbol].length > priceLimit) {
                priceHistoryRef.current[symbol].shift();
            }

            setLiveDigits(previous => ({
                ...previous,
                [symbol]: [...digitHistoryRef.current[symbol]].slice(-MONITOR_WINDOW),
            }));
            setLiveMoves(previous => ({
                ...previous,
                [symbol]: getRecentMoves(priceHistoryRef.current[symbol], MONITOR_WINDOW),
            }));

            if (!selectedSymbolsRef.current.includes(symbol)) return;
            if (!isRunningRef.current || activeContractsRef.current.size > 0 || isProcessingRef.current) return;

            // "Trade continuously when there is a loss": after a loss keep trading the same strategy on the same market
            // (no new pattern needed) until a trade wins.
            const continuation = continuationRef.current;
            if (continuation && tradingModeRef.current === 'continuous_loss') {
                if (continuation.symbol !== symbol) return;
                isProcessingRef.current = true;
                executeStrategyTrade(symbol, continuation.matched);
                return;
            }

            const matchedStrategy = findMatchedStrategy(symbol);
            if (!matchedStrategy) return;

            isProcessingRef.current = true;
            setLastTriggeredSymbol(symbol);

            if (highlightTimeoutRef.current) {
                window.clearTimeout(highlightTimeoutRef.current);
            }

            highlightTimeoutRef.current = window.setTimeout(() => {
                setLastTriggeredSymbol(null);
            }, 1800);

            executeStrategyTrade(symbol, matchedStrategy);
        },
        [executeStrategyTrade, findMatchedStrategy]
    );

    const subscribeToTicks = useCallback(socket => {
        ALL_SYMBOLS.forEach(symbol => socket.send(JSON.stringify({ ticks: symbol, subscribe: 1 })));
    }, []);

    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);

            if (data.msg_type === 'authorize') {
                if (!isAuthorizedRef.current) {
                    isAuthorizedRef.current = true;
                    setStatusMessage(previous =>
                        previous.startsWith('Matched') || previous.startsWith('Trade')
                            ? previous
                            : 'Authorized trading session ready.'
                    );
                }
                return;
            }

            if (data.error) {
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

                publishNativeError(errorMessage);
                setStatusMessage(errorMessage);
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;

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
                    return;
                }

                if (activeContractsRef.current.size === 0) {
                    isProcessingRef.current = false;
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(
                        isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                    );
                }
                return;
            }

            if (data.msg_type === 'tick') handleTick(data.tick);

            if (data.msg_type === 'proposal_open_contract') {
                const openContract = data.proposal_open_contract;
                const contractKey = String(openContract?.contract_id ?? '');
                const normalizedStatus = String(openContract?.status || '').toLowerCase();
                const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
                const isExpired =
                    openContract?.is_expired === 1 ||
                    openContract?.is_expired === true ||
                    openContract?.is_expired === '1';
                const isSettleable =
                    openContract?.is_settleable === 1 ||
                    openContract?.is_settleable === true ||
                    openContract?.is_settleable === '1';
                const isSold =
                    openContract?.is_sold === 1 ||
                    openContract?.is_sold === true ||
                    openContract?.is_sold === '1' ||
                    hasClosedStatus ||
                    isExpired ||
                    isSettleable;

                if (isSold && contractKey && activeContractsRef.current.has(contractKey)) {
                    handleContractCompletion(openContract);
                }
            }

            if (isRunningRef.current) {
                if (data.msg_type === 'proposal' && data.proposal) handleProposal(data);
                if (data.msg_type === 'buy') handleBuy(data);
            }
        },
        [handleBuy, handleContractCompletion, handleProposal, handleTick, publishNativeError, run_panel, stopTradingBot]
    );

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
                    console.error('[ElitePremium] Failed to close existing socket:', error);
                }
            }

            isConnectingRef.current = true;
            socketRequiresAuthRef.current = requireAuth;

            try {
                const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

                if (requireAuth && !authenticatedUrl) {
                    setStatusMessage('Unable to create an authenticated Deriv session.');
                    return false;
                }

                const socketUrl = authenticatedUrl || DERIV_PUBLIC_WS_URL;
                const isAuthenticatedSocket = Boolean(authenticatedUrl);

                const socket = new WebSocket(socketUrl);
                wsRef.current = socket;

                socket.onopen = () => {
                    if (wsRef.current !== socket) return;

                    subscribeToTicks(socket);
                    isAuthorizedRef.current = isAuthenticatedSocket;

                    if (!isAuthenticatedSocket) {
                        setStatusMessage(previous =>
                            previous.startsWith('Matched') || previous.startsWith('Trade')
                                ? previous
                                : 'Scanner connected. Waiting for authenticated trading session.'
                        );
                    }
                };

                socket.onmessage = handleSocketMessage;

                socket.onerror = () => {
                    setStatusMessage('Connection error. Attempting to reconnect...');
                };

                socket.onclose = () => {
                    if (wsRef.current === socket) {
                        wsRef.current = null;
                    }
                    isAuthorizedRef.current = false;

                    const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
                    skipReconnectRef.current = false;

                    if (shouldReconnect) {
                        reconnectTimeoutRef.current = window.setTimeout(() => {
                            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
                        }, 700);
                    }
                };

                return true;
            } catch (error) {
                setStatusMessage(`Trading connection failed: ${error.message}`);
                return false;
            } finally {
                isConnectingRef.current = false;
            }
        },
        [getAuthenticatedUrl, handleSocketMessage, subscribeToTicks]
    );

    useEffect(() => {
        shouldReconnectRef.current = true;
        const shouldRequireAuth = Boolean(getStoredAuthContext());
        connectTradingSocket({ requireAuth: shouldRequireAuth });

        const watchdogId = window.setInterval(() => {
            if (!shouldReconnectRef.current) return;
            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
        }, 1500);

        return () => {
            shouldReconnectRef.current = false;
            window.clearInterval(watchdogId);

            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }

            if (highlightTimeoutRef.current) {
                window.clearTimeout(highlightTimeoutRef.current);
                highlightTimeoutRef.current = null;
            }

            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connectTradingSocket, getStoredAuthContext]);

    const validateBeforeStart = useCallback(() => {
        if (normalizeMoney(stakeRef.current, 0) <= 0) return 'Enter a valid stake.';
        if (normalizeMoney(targetProfitRef.current, 0) <= 0) return 'Enter a valid target profit.';
        if (normalizeMoney(stopLossRef.current, 0) <= 0) return 'Enter a valid stop loss.';
        if (!selectedSymbolsRef.current.length) return 'Select at least one market.';
        if (useRecoveryRef.current && requiresBarrier(recoveryTypeRef.current)) {
            const recoveryValue = Number.parseInt(recoveryBarrierRef.current, 10);
            const [minValue, maxValue] = getBarrierRange(recoveryTypeRef.current);
            if (!Number.isInteger(recoveryValue) || recoveryValue < minValue || recoveryValue > maxValue) {
                return `Recovery ${recoveryTypeRef.current} needs a prediction between ${minValue} and ${maxValue}.`;
            }
        }

        for (let index = 0; index < strategiesRef.current.length; index += 1) {
            const strategy = strategiesRef.current[index];
            const strategyNumber = index + 1;
            const lookbackValue = Number.parseInt(strategy.lookback, 10);

            if (!Number.isInteger(lookbackValue) || lookbackValue < 1 || lookbackValue > 10) {
                return `Strategy ${strategyNumber} needs a lookback between 1 and 10.`;
            }

            if (requiresBarrier(strategy.trade)) {
                const barrier = Number.parseInt(strategy.barrier, 10);
                const [minBarrier, maxBarrier] = getBarrierRange(strategy.trade);

                if (!Number.isInteger(barrier) || barrier < minBarrier || barrier > maxBarrier) {
                    return `Strategy ${strategyNumber} needs a valid ${strategy.trade} barrier between ${minBarrier} and ${maxBarrier}.`;
                }
            }
        }

        return '';
    }, []);

    const handleStart = useCallback(async () => {
        if (!getStoredAuthContext()) {
            Swal.fire('Error', 'Login Required', 'error');
            return;
        }

        if (isRunning) {
            handleStop();
            return;
        }

        const validationMessage = validateBeforeStart();
        if (validationMessage) {
            Swal.fire('Check Settings', validationMessage, 'warning');
            return;
        }

        const baseStake = normalizeMoney(stakeRef.current);

        totalProfitRef.current = 0;
        nextStakeRef.current = baseStake;
        lastTradeWasLossRef.current = false;
        continuationRef.current = null;
        contractMetaRef.current = {};
        activeContractsRef.current.clear();
        isProcessingRef.current = false;
        pendingProposalRef.current = false;
        pendingTradeContextRef.current = null;
        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        setNextStakeDisplay(baseStake);

        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();

        updateLastSignalLabel('Scanning ...');
        setStatusMessage(`Scanning ${strategiesRef.current.length} strategies across ${selectedSymbolsRef.current.length} selected market(s).`);

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `elite-premium-${Date.now()}`;
        }
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        setIsRunning(true);
        isRunningRef.current = true;

        const wsReady = wsRef.current?.readyState;
        if (wsRef.current && wsReady === WebSocket.OPEN && isAuthorizedRef.current) {
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
        connectTradingSocket,
        getStoredAuthContext,
        handleStop,
        isRunning,
        run_panel,
        summary_card,
        transactions,
        updateLastSignalLabel,
        validateBeforeStart,
    ]);

    useEffect(() => {
        const handleExternalStop = () => {
            if (!isRunningRef.current && activeContractsRef.current.size === 0) return;

            stopTradingBot('Bot stopped from the Deriv run panel.', {
                preserveOpenContract: activeContractsRef.current.size > 0,
            });
        };

        observer.register('bot.click_stop', handleExternalStop);
        observer.register('hub360.stop', handleExternalStop);
        observer.register('hub360.stop.hub360-elite-prime', handleExternalStop);

        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', handleExternalStop);
                observer.unregister('hub360.stop', handleExternalStop);
                observer.unregister('hub360.stop.hub360-elite-prime', handleExternalStop);
            }
        };
    }, [stopTradingBot]);

    useEffect(() => {
        observer.register('signalhub.start', handleStart);
        observer.register('signalhub.stop', handleStop);
        observer.register('elitepremium.start', handleStart);
        observer.register('elitepremium.stop', handleStop);

        return () => {
            if (observer.isRegistered('signalhub.start')) {
                observer.unregister('signalhub.start', handleStart);
            }
            if (observer.isRegistered('signalhub.stop')) {
                observer.unregister('signalhub.stop', handleStop);
            }
            if (observer.isRegistered('elitepremium.start')) {
                observer.unregister('elitepremium.start', handleStart);
            }
            if (observer.isRegistered('elitepremium.stop')) {
                observer.unregister('elitepremium.stop', handleStop);
            }
        };
    }, [handleStart, handleStop]);

    useEffect(() => {
        if (typeof document === 'undefined') return;

        if (run_panel?.active_index !== run_panel_tabs.JOURNAL) {
            setJournalMonitorTarget(null);
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            const target = document.getElementById(JOURNAL_SLOT_ID);
            setJournalMonitorTarget(target || null);
        });

        return () => {
            window.cancelAnimationFrame(frameId);
        };
    }, [run_panel?.active_index]);

    const addStrategy = () => {
        if (strategies.length >= MAX_STRATEGIES) return;
        setStrategies(previous => [...previous, createStrategy()]);
    };

    const removeStrategy = strategyId => {
        setStrategies(previous => {
            if (previous.length === 1) return previous;
            return previous.filter(strategy => strategy.id !== strategyId);
        });
    };

    const updateStrategy = (strategyId, field, value) => {
        setStrategies(previous =>
            previous.map(strategy => {
                if (strategy.id !== strategyId) return strategy;

                if (field === 'trade') {
                    return {
                        ...strategy,
                        trade: value,
                        barrier: requiresBarrier(value)
                            ? clampBarrierValue(value, strategy.barrier || getDefaultBarrier(value)) ||
                              getDefaultBarrier(value)
                            : '',
                    };
                }

                if (field === 'condition') {
                    return {
                        ...strategy,
                        condition: value,
                        conditionBarrier: requiresBarrier(value) ? strategy.conditionBarrier || getDefaultConditionBarrier(value) : '',
                    };
                }

                if (field === 'conditionBarrier') {
                    return {
                        ...strategy,
                        conditionBarrier: value === '' ? '' : clampBarrierValue(strategy.condition, value),
                    };
                }

                if (field === 'barrier') {
                    return {
                        ...strategy,
                        barrier: value === '' ? '' : clampBarrierValue(strategy.trade, value),
                    };
                }

                return {
                    ...strategy,
                    [field]: value,
                };
            })
        );
    };

    const addExtraCondition = strategyId => {
        setStrategies(previous =>
            previous.map(strategy =>
                strategy.id !== strategyId || (strategy.extras || []).length >= MAX_EXTRA_CONDITIONS
                    ? strategy
                    : {
                          ...strategy,
                          extras: [
                              ...(strategy.extras || []),
                              { id: createStrategyId(), lookback: '3', condition: 'EVEN', conditionBarrier: '' },
                          ],
                      }
            )
        );
    };

    const removeExtraCondition = (strategyId, extraId) => {
        setStrategies(previous =>
            previous.map(strategy =>
                strategy.id !== strategyId
                    ? strategy
                    : { ...strategy, extras: (strategy.extras || []).filter(extra => extra.id !== extraId) }
            )
        );
    };

    const updateExtraCondition = (strategyId, extraId, field, value) => {
        setStrategies(previous =>
            previous.map(strategy => {
                if (strategy.id !== strategyId) return strategy;
                return {
                    ...strategy,
                    extras: (strategy.extras || []).map(extra => {
                        if (extra.id !== extraId) return extra;
                        if (field === 'condition') {
                            return {
                                ...extra,
                                condition: value,
                                conditionBarrier: requiresBarrier(value) ? getDefaultConditionBarrier(value) : '',
                            };
                        }
                        if (field === 'conditionBarrier') {
                            return { ...extra, conditionBarrier: value === '' ? '' : clampBarrierValue(extra.condition, value) };
                        }
                        return { ...extra, [field]: value };
                    }),
                };
            })
        );
    };

    const applyMarketMode = modeId => {
        const preset = MARKET_PRESETS.find(item => item.id === modeId);
        setMarketMode(modeId);
        if (preset?.symbols) setSelectedSymbols(preset.symbols);
    };

    const renderCompactMonitor = (variant = 'main') => (
        <div className={`epf-monitor-grid epf-monitor-grid--${variant}`}>
            {selectedSymbols.map(symbol => {
                const digits = Array.isArray(liveDigits[symbol]) ? liveDigits[symbol] : [];
                const moves = Array.isArray(liveMoves[symbol]) ? liveMoves[symbol] : [];

                return (
                    <div
                        key={symbol}
                        className={`epf-monitor-card epf-monitor-card--${variant} ${
                            lastTriggeredSymbol === symbol ? 'epf-monitor-card--active' : ''
                        }`}
                    >
                        <div className='epf-monitor-card__top'>
                            <span className='epf-monitor-card__symbol'>{formatSymbolDisplay(symbol)}</span>
                            <span className='epf-monitor-card__tag'>
                                {lastTriggeredSymbol === symbol ? 'LIVE' : 'SCAN'}
                            </span>
                        </div>

                        <div className='epf-monitor-card__row'>
                            <span className='epf-monitor-card__label'>Digits</span>
                            <div className='epf-token-stream'>
                                {digits.length ? (
                                    digits.map((digit, index) => (
                                        <span
                                            key={`${symbol}-digit-${index}`}
                                            className={`epf-token ${digit > 4 ? 'epf-token--digit-high' : 'epf-token--digit-low'}`}
                                        >
                                            {digit}
                                        </span>
                                    ))
                                ) : (
                                    <span className='epf-token epf-token--empty'>--</span>
                                )}
                            </div>
                        </div>

                        <div className='epf-monitor-card__row'>
                            <span className='epf-monitor-card__label'>Moves</span>
                            <div className='epf-token-stream'>
                                {moves.length ? (
                                    moves.map((move, index) => (
                                        <span
                                            key={`${symbol}-move-${index}`}
                                            className={`epf-token ${
                                                move === 'RISE'
                                                    ? 'epf-token--rise'
                                                    : move === 'FALL'
                                                      ? 'epf-token--fall'
                                                      : 'epf-token--flat'
                                            }`}
                                        >
                                            {formatTokenMove(move)}
                                        </span>
                                    ))
                                ) : (
                                    <span className='epf-token epf-token--empty'>--</span>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className='epf-shell'>
            {journalMonitorTarget ? createPortal(renderCompactMonitor('journal'), journalMonitorTarget) : null}

            <div className='epf-hero'>
                <h1 className='epf-hero__title'>
                    ELITE PRIME <span className='epf-hero__accent'>PRO</span>
                </h1>
                <p className='epf-hero__description'>
                    A Multi-Strategy Trading Bot that allows you to execute upto 5 Strategies at Once. Example:{' '}
                    <strong>If the last 4 digits are ODD, trade EVEN</strong>. Rise/Fall uses market moves, while other
                    contracts uses Last Digits Analysis.
                </p>
            </div>

            <div className='epf-settings-grid'>
                <div className='epf-field'>
                    <label className='epf-field__label'>Stake ({client?.currency || 'USD'})</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        step='0.01'
                        value={stake}
                        onChange={event => setStake(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Target Profit</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        value={targetProfit}
                        onChange={event => setTargetProfit(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Stop Loss</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        value={stopLoss}
                        onChange={event => setStopLoss(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Martingale</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        step='0.1'
                        value={mFactor}
                        onChange={event => setMFactor(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Trading Mode</label>
                    <select
                        className='epf-field__control epf-field__control--mode'
                        value={tradingMode}
                        onChange={event => setTradingMode(event.target.value)}
                        disabled={isRunning}
                    >
                        {TRADING_MODES.map(mode => (
                            <option key={mode.id} value={mode.id}>
                                {mode.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className='epf-panel'>
                <div className='epf-panel__header'>
                    <h2 className='epf-panel__title'>
                        Strategy <span>Builder</span>
                    </h2>
                    <button
                        type='button'
                        className='epf-button epf-button--secondary'
                        onClick={addStrategy}
                        disabled={isRunning || strategies.length >= MAX_STRATEGIES}
                    >
                        ADD STRATEGY
                    </button>
                </div>

                <div className='epf-strategy-list'>
                    {strategies.map((strategy, index) => (
                        <div key={strategy.id} className='epf-strategy-card'>
                            <div className='epf-strategy-card__head'>
                                <div className='epf-strategy-card__meta'>
                                    <strong className='epf-strategy-card__name'>Strategy {index + 1}</strong>
                                    <span
                                        className={`epf-strategy-card__type ${isMoveCondition(strategy.condition) ? 'type--market' : 'type--digit'}`}
                                    >
                                        {isMoveCondition(strategy.condition) ? 'Uses Chart Move' : 'Checks Last Digits'}
                                    </span>
                                </div>

                                <button
                                    type='button'
                                    className='epf-button epf-button--danger'
                                    onClick={() => removeStrategy(strategy.id)}
                                    disabled={isRunning || strategies.length === 1}
                                >
                                    REMOVE
                                </button>
                            </div>

                            <div className='epf-strategy-rule'>
                                <span className='epf-strategy-rule__text'>If the last</span>
                                <input
                                    aria-label={`Strategy ${index + 1} lookback`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--lookback'
                                    type='number'
                                    min='1'
                                    max='10'
                                    value={strategy.lookback}
                                    onChange={event => updateStrategy(strategy.id, 'lookback', event.target.value)}
                                    disabled={isRunning}
                                />
                                <span className='epf-strategy-rule__text'>digits / moves are</span>
                                <select
                                    aria-label={`Strategy ${index + 1} condition`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--condition'
                                    value={strategy.condition}
                                    onChange={event => updateStrategy(strategy.id, 'condition', event.target.value)}
                                    disabled={isRunning}
                                >
                                    {CONDITION_TYPES.map(type => (
                                        <option key={type} value={type}>
                                            {CONDITION_LABELS[type] || type}
                                        </option>
                                    ))}
                                </select>
                                {requiresBarrier(strategy.condition) && (
                                    <input
                                        aria-label={`Strategy ${index + 1} ${strategy.condition} digit`}
                                        className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--barrier'
                                        type='number'
                                        min={strategy.condition === 'OVER' ? '0' : '1'}
                                        max={strategy.condition === 'OVER' ? '8' : '9'}
                                        value={strategy.conditionBarrier}
                                        onChange={event => updateStrategy(strategy.id, 'conditionBarrier', event.target.value)}
                                        disabled={isRunning}
                                    />
                                )}
                                <span className='epf-strategy-rule__text'>then trade</span>
                                <select
                                    aria-label={`Strategy ${index + 1} trade`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--trade'
                                    value={strategy.trade}
                                    onChange={event => updateStrategy(strategy.id, 'trade', event.target.value)}
                                    disabled={isRunning}
                                >
                                    {TRADE_TYPES.map(type => (
                                        <option key={`${strategy.id}-${type}`} value={type}>
                                            {TRADE_LABELS[type] || type}
                                        </option>
                                    ))}
                                </select>

                                {requiresBarrier(strategy.trade) && (
                                    <>
                                        <span className='epf-strategy-rule__text'></span>
                                        <input
                                            aria-label={`Strategy ${index + 1} ${strategy.trade} barrier`}
                                            className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--barrier'
                                            type='number'
                                            min={getBarrierRange(strategy.trade)[0]}
                                            max={getBarrierRange(strategy.trade)[1]}
                                            value={strategy.barrier}
                                            onChange={event =>
                                                updateStrategy(strategy.id, 'barrier', event.target.value)
                                            }
                                            disabled={isRunning}
                                        />
                                    </>
                                )}
                                <span className='epf-strategy-rule__text'>for</span>
                                <input
                                    aria-label={`Strategy ${index + 1} duration`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--lookback'
                                    type='number'
                                    min={isRunTrade(strategy.trade) ? '2' : '1'}
                                    max={isRunTrade(strategy.trade) ? '5' : '10'}
                                    value={strategy.duration}
                                    onChange={event => updateStrategy(strategy.id, 'duration', event.target.value)}
                                    disabled={isRunning}
                                />
                                <span className='epf-strategy-rule__text'>ticks</span>
                            </div>

                            {(strategy.extras || []).map(extra => (
                                <div key={extra.id} className='epf-strategy-rule epf-strategy-rule--extra'>
                                    <span className='epf-strategy-rule__text'>and the last</span>
                                    <input
                                        aria-label={`Strategy ${index + 1} extra lookback`}
                                        className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--lookback'
                                        type='number'
                                        min='1'
                                        max='10'
                                        value={extra.lookback}
                                        onChange={event => updateExtraCondition(strategy.id, extra.id, 'lookback', event.target.value)}
                                        disabled={isRunning}
                                    />
                                    <span className='epf-strategy-rule__text'>digits / moves are</span>
                                    <select
                                        aria-label={`Strategy ${index + 1} extra condition`}
                                        className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--condition'
                                        value={extra.condition}
                                        onChange={event => updateExtraCondition(strategy.id, extra.id, 'condition', event.target.value)}
                                        disabled={isRunning}
                                    >
                                        {CONDITION_TYPES.map(type => (
                                            <option key={type} value={type}>
                                                {CONDITION_LABELS[type] || type}
                                            </option>
                                        ))}
                                    </select>
                                    {requiresBarrier(extra.condition) && (
                                        <input
                                            aria-label={`Strategy ${index + 1} extra ${extra.condition} digit`}
                                            className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--barrier'
                                            type='number'
                                            min={getBarrierRange(extra.condition)[0]}
                                            max={getBarrierRange(extra.condition)[1]}
                                            value={extra.conditionBarrier}
                                            onChange={event =>
                                                updateExtraCondition(strategy.id, extra.id, 'conditionBarrier', event.target.value)
                                            }
                                            disabled={isRunning}
                                        />
                                    )}
                                    <button
                                        type='button'
                                        className='epf-button epf-button--danger'
                                        onClick={() => removeExtraCondition(strategy.id, extra.id)}
                                        disabled={isRunning}
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            <button
                                type='button'
                                className='epf-button epf-button--secondary epf-strategy-add-condition'
                                onClick={() => addExtraCondition(strategy.id)}
                                disabled={isRunning || (strategy.extras || []).length >= MAX_EXTRA_CONDITIONS}
                            >
                                + CONDITION
                            </button>
                            <p className='epf-strategy-preview'>{formatStrategySummary(strategy)}</p>
                        </div>
                    ))}
                </div>
            </div>

            <div className={`epf-recovery ${useRecovery ? 'is-on' : ''}`}>
                <div className='epf-recovery__head'>
                    <div>
                        <strong className='epf-recovery__title'>RECOVERY MODE</strong>
                        <p className='epf-recovery__hint'>This contract will be used after a loss.</p>
                    </div>
                    <label className='epf-switch'>
                        <input
                            type='checkbox'
                            aria-label='Recovery mode'
                            checked={useRecovery}
                            onChange={event => setUseRecovery(event.target.checked)}
                            disabled={isRunning}
                        />
                        <span className='epf-switch__track' />
                    </label>
                </div>
                <div className='epf-recovery__controls'>
                    <div className='epf-recovery__field'>
                        <span className='epf-field__label'>Contract</span>
                        <select
                            aria-label='Recovery contract'
                            className='epf-field__control'
                            value={recoveryType}
                            onChange={event => {
                                setRecoveryType(event.target.value);
                                setRecoveryBarrier(getDefaultBarrier(event.target.value) || '4');
                            }}
                            disabled={isRunning || !useRecovery}
                        >
                            {TRADE_TYPES.map(type => (
                                <option key={`recovery-${type}`} value={type}>
                                    {TRADE_LABELS[type] || type}
                                </option>
                            ))}
                        </select>
                        {requiresBarrier(recoveryType) && (
                            <input
                                aria-label='Recovery prediction'
                                className='epf-field__control epf-recovery__barrier'
                                type='number'
                                min={getBarrierRange(recoveryType)[0]}
                                max={getBarrierRange(recoveryType)[1]}
                                value={recoveryBarrier}
                                onChange={event => setRecoveryBarrier(clampBarrierValue(recoveryType, event.target.value))}
                                disabled={isRunning || !useRecovery}
                            />
                        )}
                    </div>
                    <div className='epf-recovery__field'>
                        <span className='epf-field__label'>Recovery setting</span>
                        <select
                            aria-label='Recovery setting'
                            className='epf-field__control'
                            value={recoverySetting}
                            onChange={event => setRecoverySetting(event.target.value)}
                            disabled={isRunning || !useRecovery}
                        >
                            {RECOVERY_SETTINGS.map(option => (
                                <option key={option.id} value={option.id}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            <div className='epf-panel epf-markets'>
                <div className='epf-panel__header'>
                    <h2 className='epf-panel__title'>Markets</h2>
                    <span className='epf-markets__count'>{selectedSymbols.length} selected</span>
                </div>
                <p className='epf-markets__hint'>Select market(s) to execute your strategies on.</p>
                <div className='epf-markets__presets' role='group' aria-label='Market selection'>
                    {MARKET_PRESETS.map(preset => (
                        <button
                            key={preset.id}
                            type='button'
                            aria-pressed={marketMode === preset.id}
                            className={`epf-markets__preset ${marketMode === preset.id ? 'is-active' : ''}`}
                            disabled={isRunning}
                            onClick={() => applyMarketMode(preset.id)}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
                {marketMode === 'choose' && (
                    <div className='epf-markets__chips'>
                        {ALL_SYMBOLS.map(symbol => {
                            const isSelected = selectedSymbols.includes(symbol);
                            return (
                                <button
                                    key={symbol}
                                    type='button'
                                    aria-pressed={isSelected}
                                    className={`epf-chip ${isSelected ? 'is-selected' : ''}`}
                                    disabled={isRunning}
                                    onClick={() =>
                                        setSelectedSymbols(previous =>
                                            previous.includes(symbol)
                                                ? previous.filter(item => item !== symbol)
                                                : ALL_SYMBOLS.filter(item => item === symbol || previous.includes(item))
                                        )
                                    }
                                >
                                    {formatSymbolDisplay(symbol)}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className='epf-cta-row'>
                <button
                    onClick={handleStart}
                    className={`epf-button epf-button--primary ${isRunning ? 'epf-button--stop' : ''}`}
                >
                    {isRunning ? <FaStop /> : <FaPlay />}
                    {isRunning ? ' STOP BOT' : ' EXECUTE STRATEGIES'}
                </button>
            </div>

            <div className='epf-status-grid'>
                <div className='epf-status-card'>
                    <span className='epf-status-card__label'>Status</span>
                    <strong className='epf-status-card__value'>{statusMessage}</strong>
                </div>
                <div className='epf-status-card'>
                    <span className='epf-status-card__label'>Last Signal</span>
                    <strong className='epf-status-card__value'>{lastSignalLabel}</strong>
                </div>
            </div>

            {renderCompactMonitor('main')}
        </div>
    );
};

export default ElitePremium;
