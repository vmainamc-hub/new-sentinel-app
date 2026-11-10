import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getHub360AuthContext, getHub360AuthenticatedUrl } from './auth360';
import { useHub360Module } from './use-hub360-module';
import Swal from "sweetalert2";
import { WS_SERVERS, isProduction } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { readExecutionSpeed, SLOW_DELAY_MS } from '../execution-speed';
import { isEngineKind, oracleScanner } from './oracle/oracle-engine';
import {
  RECOVERY_TYPES, barrierRange, clampBarrier, defaultRecoveryBarrier, digitOfQuote, freshVh, needsBarrier,
  nextTrade, normalizeVh, tradeWins, vhAfterReal, vhAfterVirtual,
} from './oracle/trade-plan';

import { FaPlay, FaStop } from "react-icons/fa";

const TRADE_TYPE_TABS = [
  { id: 'EVEN/ODD', label: 'Even / Odd' },
  { id: 'OVER/UNDER', label: 'Over / Under' },
  { id: 'RISE/FALL', label: 'Rise / Fall' },
  { id: 'DIFFERS', label: 'Differs' },
];


const volatilityList = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  '1HZ10V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ100V',
];

const symbolNames = {
  'R_10': 'Volatility 10', 'R_25': 'Volatility 25', 'R_50': 'Volatility 50',
  'R_75': 'Volatility 75', 'R_100': 'Volatility 100', '1HZ10V': 'Vol 10 (1s)',
  '1HZ25V': 'Vol 25 (1s)', '1HZ30V': 'Vol 30 (1s)', '1HZ50V': 'Vol 50 (1s)',
  '1HZ75V': 'Vol 75 (1s)', '1HZ100V': 'Vol 100 (1s)',
};

const CONTRACT_TYPE_MAP = Object.freeze({
  RISE: 'CALL',
  FALL: 'PUT',
  EVEN: 'DIGITEVEN',
  ODD: 'DIGITODD',
  OVER: 'DIGITOVER',
  UNDER: 'DIGITUNDER',
  MATCHES: 'DIGITMATCH',
  DIFFERS: 'DIGITDIFF',
});

const BARRIER_CONTRACT_TYPES = ['OVER', 'UNDER', 'MATCHES', 'DIFFERS'];
const getDerivContractType = type => CONTRACT_TYPE_MAP[type] || type;

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SCAN_WS_URL = DERIV_PUBLIC_WS_URL;
const SCAN_HISTORY_COUNT = 100;
const SCAN_TIMEOUT_MS = 15000;
const SCAN_STEP_DELAY_MS = 180;
const SCAN_SYMBOL_TIMEOUT_MS = 1200;
// Deriv reports pip_size as a decimal count (3); some feeds give the pip step (0.001). Both mean three decimals.
const pipDecimals = (pip) => {
  const n = Number(pip);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.min(20, Math.max(0, n > 0 && n < 1 ? Math.round(-Math.log10(n)) : Math.trunc(n)));
};
const VIRTUAL_ID_BASE = 9_000_000_000_000; // paper trades never share an id with a real contract
const VIRTUAL_TIMEOUT_MS = 120_000;
const alertSound = new Audio('/assets/media/announcement.mp3');

const formatContractSpot = value => {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  return String(value);
};

const Oracle = () => {
  const store = useStore();
  const { transactions, journal, summary_card, run_panel, client } = store || {};

  const [tradeType, setTradeType] = useState('EVEN/ODD');
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [currentScanSymbol, setCurrentScanSymbol] = useState('');
  const [topScanResult, setTopScanResult] = useState(null);
  const [strongestSignal, setStrongestSignal] = useState(null);
  const [signalTimeLeft, setSignalTimeLeft] = useState(0);
  const [scannedMarketsCount, setScannedMarketsCount] = useState(0);
  // Result of the last engine scan (Even/Odd, Over/Under) and whether it ended without anything to trade.
  const [engineScan, setEngineScan] = useState(null);
  const [scanEmpty, setScanEmpty] = useState(false);
  const [scanInfo, setScanInfo] = useState(null);

  const scanSocketRef = useRef(null);
  const tickData = useRef({});
  const latestDataRef = useRef({});
  const scannedSymbolsRef = useRef(new Set());
  const tradeTypeRef = useRef(tradeType);
  const activeScanTypeRef = useRef(tradeType);
  const scanSessionRef = useRef(0);
  const scanFinalizedRef = useRef(false);
  const signalTimeout = useRef(null);
  const countdownInterval = useRef(null);
  const scanTimeoutRef = useRef(null);
  const scanStepTimerRef = useRef(null);
  const scanSymbolTimeoutRef = useRef(null);
  const scanQueueRef = useRef([]);
  const pendingScanSymbolRef = useRef(null);
  
  // ------------------ INPUTS ------------------
  const [symbol, setSymbol] = useState("");
  const [contractType, setContractType] = useState("");
  const [initialStake, setInitialStake] = useState("1");
  const [duration] = useState("1");
  const [targetProfit, setTargetProfit] = useState("100");
  const [stopLoss, setStopLoss] = useState("100");
  const [useMartingale, setUseMartingale] = useState(true);
  const [martingaleMultiplier, setMartingaleMultiplier] = useState("2.1");
  const [predictionDigit, setPredictionDigit] = useState("7");

  // Recovery contract after a loss (Over/Under) and Sentinel's Virtual Hook (Even/Odd, Over/Under)
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryType, setRecoveryType] = useState("OVER");
  const [recoveryBarrier, setRecoveryBarrier] = useState("3");
  const [useVirtualHook, setUseVirtualHook] = useState(false);
  const [vhMode, setVhMode] = useState("STREAK");
  const [vhEnterLosses, setVhEnterLosses] = useState("2");
  const [vhReturnWins, setVhReturnWins] = useState("2");
  const [vhFixedCount, setVhFixedCount] = useState("3");
  const [paperStats, setPaperStats] = useState({ trades: 0, wins: 0, active: false });

  // ------------------ BOT STATE ------------------
  const [isRunning, setIsRunning] = useState(false);
  const [, setLogs] = useState([]);
  const [, setResults] = useState([]);
  const [, setWins] = useState(0);
  const [, setLosses] = useState(0);
  const [, setTotalRuns] = useState(0);
  const [, setTotalProfit] = useState(0);
  const [proposalError, setProposalError] = useState("");

  // ------------------ REFS ------------------
  const wsRef = useRef(null);
  const totalProfitRef = useRef(0);
  const baseStakeRef = useRef(1);
  const currentStakeRef = useRef(1);
  const isRunningRef = useRef(false);
  const isAuthorizedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const reconnectTimeoutRef = useRef(null);
  const shouldReconnectRef = useRef(true);
  const skipReconnectRef = useRef(false);
  const socketRequiresAuthRef = useRef(false);
  const pendingProposalRef = useRef(false);
  const pendingTradeMetaRef = useRef(null);
  const contractMetaRef = useRef({});
  const activeContractsRef = useRef(new Set());
  const completedContractsRef = useRef(new Set());
  const lastProcessedContractIdRef = useRef(null);
  const transactionRecoveryTimeoutsRef = useRef(new Map());

  // Important: keep refs for *signal values* so proposals use them (avoids stale state issues)
  const symbolRef = useRef(symbol);           // tracks symbol to trade
  const contractTypeRef = useRef(contractType); // tracks contract type (EVEN/ODD/... etc)
  const useMartingaleRef = useRef(useMartingale);
  const predictionDigitRef = useRef(predictionDigit);
  const targetProfitRef = useRef(targetProfit);
  const stopLossRef = useRef(stopLoss);
  const martingaleMultiplierRef = useRef(martingaleMultiplier);
  const lastTradeWasLossRef = useRef(false);
  const recoveryRef = useRef({ enabled: false, type: "OVER", barrier: 3 });
  const vhOnRef = useRef(false);
  const vhConfigRef = useRef(normalizeVh({}));
  const vhStateRef = useRef(freshVh());
  const realLossStreakRef = useRef(0);   // real losses in a row; paper results never change it
  const virtualOpenRef = useRef(null);   // the paper trade waiting for its tick(s)
  const virtualTimerRef = useRef(null);
  const virtualCountRef = useRef(0);
  const speedGateRef = useRef(false);    // a Slow-mode wait before the next trade is already running
  const lastTickEpochRef = useRef(null);
  const requestProposalRef = useRef(null);
  const tickSubsRef = useRef({ ws: null, symbols: new Set() });

  // ------------------ SYNC REFS ------------------
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { tradeTypeRef.current = tradeType; }, [tradeType]);
  useEffect(() => { contractTypeRef.current = contractType; }, [contractType]);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]); // keep symbolRef in sync with state
  useEffect(() => { useMartingaleRef.current = useMartingale; }, [useMartingale]);
  useEffect(() => { predictionDigitRef.current = predictionDigit; }, [predictionDigit]);
  useEffect(() => { targetProfitRef.current = targetProfit; }, [targetProfit]);
  useEffect(() => { stopLossRef.current = stopLoss; }, [stopLoss]);
  useEffect(() => { martingaleMultiplierRef.current = martingaleMultiplier; }, [martingaleMultiplier]);
  useEffect(() => {
    recoveryRef.current = { enabled: useRecovery, type: recoveryType, barrier: clampBarrier(recoveryType, recoveryBarrier) };
  }, [useRecovery, recoveryType, recoveryBarrier]);
  useEffect(() => {
    vhOnRef.current = useVirtualHook;
    vhConfigRef.current = normalizeVh({ mode: vhMode, enterLosses: vhEnterLosses, returnWins: vhReturnWins, fixedCount: vhFixedCount });
    if (!useVirtualHook) {
      vhStateRef.current = freshVh();
      setPaperStats(p => (p.active ? { ...p, active: false } : p));
    }
  }, [useVirtualHook, vhMode, vhEnterLosses, vhReturnWins, vhFixedCount]);
  useEffect(() => {
    run_panel?.setIsRunning?.(isRunning);
    if (!isRunning && !run_panel?.has_open_contract) {
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }
  }, [isRunning, run_panel]);
  useHub360Module('hub360-oracle', isRunning);
  useEffect(() => () => { oracleScanner.stop(); }, []);

  const logMessage = (msg) => {
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

  const clearContractTracking = useCallback(() => {
    pendingProposalRef.current = false;
    pendingTradeMetaRef.current = null;
    contractMetaRef.current = {};
    lastProcessedContractIdRef.current = null;
    completedContractsRef.current.clear();
    activeContractsRef.current.clear();
    transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
    transactionRecoveryTimeoutsRef.current.clear();
  }, []);

  const parseLimitAmount = useCallback((value) => {
    const parsedValue = Number.parseFloat(value);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return null;
    }

    return Number(parsedValue.toFixed(2));
  }, []);

  const getTransactionsStatisticsTotals = useCallback(() => {
    const totalProfitLoss = Number(transactions?.statistics?.total_profit ?? 0);

    return {
      totalProfitLoss: Number.isFinite(totalProfitLoss) ? Number(totalProfitLoss.toFixed(2)) : 0,
    };
  }, [transactions]);

  const getTriggeredTradingLimit = useCallback(() => {
    const { totalProfitLoss } = getTransactionsStatisticsTotals();
    const targetProfitLimit = parseLimitAmount(targetProfitRef.current);

    if (targetProfitLimit !== null && totalProfitLoss >= targetProfitLimit) {
      return {
        alert: {
          title: "CONGRATULATIONS!",
          text: "Target profit hit...",
          icon: "success",
          draggable: false,
        },
        reason: "Target profit reached. Bot stopped.",
      };
    }

    const stopLossLimit = parseLimitAmount(stopLossRef.current);
    if (stopLossLimit !== null && totalProfitLoss <= -stopLossLimit) {
      return {
        alert: {
          title: "OOPS",
          text: "You have hit your stoploss",
          icon: "error",
          draggable: false,
        },
        reason: "Stop loss reached. Bot stopped.",
      };
    }

    return null;
  }, [getTransactionsStatisticsTotals, parseLimitAmount]);


    // ------------------ BOT FUNCTIONS ------------------
  const handleStart = () => {
    if (isRunning) {
      setIsRunning(false);
      isRunningRef.current = false;
      logMessage("🛑 Bot stopped.");
      return;
    }

    const token = localStorage.getItem("authToken");
    if (!token) {
      Swal.fire({ title: "Login Required!", icon: "error", draggable: false });
      return;
    }

    contractMetaRef.current = {};
    lastTradeWasLossRef.current = false;
    baseStakeRef.current = parseFloat(initialStake) || 0;
    currentStakeRef.current = parseFloat(initialStake) || 0;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      logMessage("♻️ Reusing existing WebSocket connection...");
      setIsRunning(true);
      requestProposal(); // will use refs for symbol & contract type
      return;
    }

    wsRef.current = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=70505");
    setIsRunning(true);

    wsRef.current.onopen = () => {
      logMessage("🔌 Connected to Deriv WebSocket");
      wsRef.current.send(JSON.stringify({ authorize: token }));
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.msg_type === "authorize") {
        logMessage(`✅ Authorized as ${data.authorize.loginid}`);
        requestProposal();
      }

      if (data.msg_type === "proposal" && data.proposal?.id) {
        if (!isRunningRef.current) return;
        const { id, display_name, ask_price } = data.proposal;
        logMessage(`📊 Proposal: ${display_name} | Buy for $${ask_price}`);
        wsRef.current.send(JSON.stringify({ buy: id, price: ask_price }));
      }

      if (data.msg_type === "buy") {
        const { contract_id, longcode, buy_price } = data.buy;
        logMessage(`🎯 Bought: ${longcode} for $${buy_price}`);

        setResults(prev => [
          {
            id: prev.length + 1,
            contract_type: contractTypeRef.current,
            entry_spot: "-",
            exit_spot: "-",
            stake: parseFloat(currentStakeRef.current).toFixed(2),
            profit: "-",
            status: "⏳",
            contract_id,
          },
          ...prev,
        ]);

        wsRef.current.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id,
          subscribe: 1,
        }));
      }

      if (data.msg_type === "proposal_open_contract") {
        const c = data.proposal_open_contract;
        if (!c) return;

        if (c.entry_spot_display_value && !c.is_sold) {
          setResults(prev =>
            prev.map(r =>
              r.contract_id === c.contract_id
                ? { ...r, entry_spot: c.entry_spot_display_value }
                : r
            )
          );
        }

        if (c.is_sold) {
          const profit = parseFloat(c.profit ?? 0);
          const result = profit > 0 ? "WIN " : "LOSS ";

          totalProfitRef.current += profit;
          setTotalProfit(totalProfitRef.current.toFixed(2));
          setTotalRuns(p => p + 1);
          if (profit > 0) setWins(p => p + 1);
          else setLosses(p => p + 1);

          logMessage(`💰 Contract ended: ${result} | Profit: $${profit.toFixed(2)}`);

          setResults(prev =>
            prev.map(r =>
              r.contract_id === c.contract_id
                ? {
                    ...r,
                    entry_spot: c.entry_spot_display_value ?? "-",
                    exit_spot: c.exit_spot_display_value ?? c.exit_tick_display_value ?? "-",
                    profit: profit.toFixed(2),
                    status: result,
                  }
                : r
            )
          );

          // Martingale
          if (useMartingaleRef.current) {
            if (profit <= 0) {
              currentStakeRef.current = parseFloat(
                (currentStakeRef.current * parseFloat(martingaleMultiplierRef.current)).toFixed(2)
              );
              logMessage(`🔁 Martingale applied (x${martingaleMultiplierRef.current}). Next stake: $${currentStakeRef.current}`);
            } else {
              currentStakeRef.current = baseStakeRef.current;
              logMessage(`✅ Win detected. Resetting stake to base: $${baseStakeRef.current}`);
            }
          }

          lastTradeWasLossRef.current = profit <= 0;

          // TP / SL logic
          const triggeredLimit = getTriggeredTradingLimit();
          if (triggeredLimit) {
            Swal.fire(triggeredLimit.alert);
            setIsRunning(false);
            isRunningRef.current = false;
            logMessage(triggeredLimit.reason);
            return;
          }

          // Continue next trade
          setTimeout(() => {
            if (isRunningRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
              logMessage("♻️ Starting next trade...");
              requestProposal();
            }
          }, 0);
        }
      }
    };

    wsRef.current.onclose = () => {
      logMessage("🔒 WebSocket closed");
      setIsRunning(false);
    };
  };

  void handleStart;

  
  // NOTE: requestProposal now uses symbolRef.current and contractTypeRef.current
  // What the next trade is: the scanned contract, or the recovery contract after a real loss (Over/Under tab).
  const chooseTrade = useCallback(() => {
    const kind = tradeTypeRef.current;
    const type = contractTypeRef.current;
    const primaryBarrier = BARRIER_CONTRACT_TYPES.includes(type) ? parseInt(predictionDigitRef.current, 10) : null;
    if (!isEngineKind(kind)) return { type, barrier: primaryBarrier, recovery: false };
    return nextTrade({ kind, type, barrier: primaryBarrier, recovery: recoveryRef.current, realLossStreak: realLossStreakRef.current });
  }, []);

  // Paper trades go to the Transactions panel only, flagged virtual: never counted in the real totals, Run Panel or limits.
  const pushPaper = useCallback((data) => {
    try {
      transactions?.pushTransaction?.({ ...data, is_virtual_hook: 1, run_id: run_panel?.run_id });
    } catch (error) {
      console.debug("Paper trade row skipped.", error);
    }
  }, [transactions, run_panel]);

  const releaseTicks = useCallback(() => {
    const subs = tickSubsRef.current;
    if (subs.ws && subs.ws.readyState === WebSocket.OPEN && subs.symbols.size) {
      subs.ws.send(JSON.stringify({ forget_all: "ticks" }));
    }
    tickSubsRef.current = { ws: null, symbols: new Set() };
  }, []);

  // A paper trade: the same pick as a real one, nothing bought. It settles on the market's real ticks.
  const startVirtualTrade = useCallback((plan) => {
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
    virtualOpenRef.current = {
      id,
      symbol: market,
      type: plan.type,
      barrier: plan.barrier,
      // Same rule as the bot builder's virtual trades: the first tick after the purchase is tick 1 (also for a one-tick
      // contract), and the trade settles on tick `duration`.
      remaining: Math.max(1, parseInt(duration, 10) || 1),
      entry: null,
      recovery: plan.recovery,
      row: null,
    };
    lastTickEpochRef.current = null;
    virtualOpenRef.current.row = {
      contract_id: id,
      display_name: symbolNames[market] || market,
      underlying_symbol: market,
      shortcode: `ORACLE_PAPER_${derivType}_${market}`,
      contract_type: derivType,
      currency: client?.currency || "USD",
      date_start: Math.floor(Date.now() / 1000),
      is_sold: 0,
      is_expired: 0,
      status: "open",
      buy_price: 0,
      sell_price: 0,
      payout: 0,
      bid_price: 0,
      profit: 0,
      barrier: plan.barrier !== null ? String(plan.barrier) : undefined,
      transaction_ids: { buy: id },
    };
    pushPaper(virtualOpenRef.current.row);
    logMessage(`Virtual ${plan.type}${plan.barrier !== null ? ` ${plan.barrier}` : ""}${plan.recovery ? " (recovery)" : ""} on ${symbolNames[market] || market}: paper trade, no money staked.`);

    if (virtualTimerRef.current) clearTimeout(virtualTimerRef.current);
    virtualTimerRef.current = window.setTimeout(() => {
      if (virtualOpenRef.current?.id !== id) return;
      virtualOpenRef.current = null;
      logMessage("A virtual trade never settled (no ticks arrived); it was dropped.");
      if (isRunningRef.current) requestProposalRef.current?.();
    }, VIRTUAL_TIMEOUT_MS);
  }, [client?.currency, duration, pushPaper]);

  const requestProposal = useCallback((opts) => {
    if (!isRunningRef.current) return;

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      logMessage("Trading socket not ready for proposal request");
      return;
    }

    if (!isAuthorizedRef.current) {
      logMessage("Trading session is not authorized yet");
      return;
    }

    if (pendingProposalRef.current) {
      logMessage("Waiting for pending proposal to resolve");
      return;
    }

    if (activeContractsRef.current.size > 0) {
      logMessage("Waiting for active contract to settle");
      return;
    }

    if (virtualOpenRef.current) return; // a paper trade is still waiting for its tick

    // The bottom bar's Execution switch: Fast buys at once, Slow waits before each purchase. Real and paper trades both obey it.
    if (!(opts && opts.skipDelay === true)) {
      const delay = readExecutionSpeed() === "slow" ? SLOW_DELAY_MS : 0;
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

    const plan = chooseTrade();
    if (vhOnRef.current && vhStateRef.current.virtual && isEngineKind(tradeTypeRef.current)) {
      startVirtualTrade(plan);
      return;
    }

    const activeType = plan.type;
    const derivContractType = getDerivContractType(activeType);
    const parsedDuration = Math.max(1, parseInt(duration, 10) || 1);
    const parsedStake = Number(currentStakeRef.current).toFixed(2);
    const barrier = plan.barrier !== null ? plan.barrier : undefined;
    const type = activeType;
    const proposal = {
      proposal: 1,
      amount: parsedStake,
      basis: "stake",
      contract_type: derivContractType,
      currency: client?.currency || "USD",
      underlying_symbol: symbolRef.current,
      duration: parsedDuration,
      duration_unit: "t",
      ...(barrier !== undefined ? { barrier } : {}),
    };
    Object.defineProperty(proposal, "symbol", { value: symbolRef.current, enumerable: false });

    pendingTradeMetaRef.current = {
      uiContractType: activeType,
      derivContractType,
      barrier,
      stake: parsedStake,
    };
    pendingProposalRef.current = true;
    setProposalError("");
    run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);

    logMessage(`📩 Requesting proposal for ${type}${barrier !== undefined ? ` | Prediction: ${barrier}` : ""} on ${proposal.symbol}`);
    wsRef.current.send(JSON.stringify(proposal));
  }, [chooseTrade, client?.currency, duration, run_panel, startVirtualTrade]);
  requestProposalRef.current = requestProposal;

  const publishNativeContract = useCallback((contractData) => {
    if (!transactions || !summary_card) return;
    transactions.onBotContractEvent(contractData);
    summary_card.onBotContractEvent(contractData);
  }, [summary_card, transactions]);

  const publishNativeError = useCallback((message) => {
    if (journal?.onError) {
      journal.onError(message);
    }
  }, [journal]);

  const publishNativeResult = useCallback((contractData) => {
    if (journal?.onLogSuccess) {
      journal.onLogSuccess({
        log_type: contractData.profit > 0 ? "profit" : "lost",
        extra: {
          currency: contractData.currency,
          profit: contractData.profit,
        },
      });
    }
  }, [journal]);

  const stopTradingBotNative = useCallback((reason = "Bot stopped.", options = {}) => {
    const preserveOpenContract =
      options.preserveOpenContract ?? Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract);

    setIsRunning(false);
    isRunningRef.current = false;
    pendingProposalRef.current = false;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ forget_all: "proposal" }));
      if (!preserveOpenContract) {
        wsRef.current.send(JSON.stringify({ forget_all: "proposal_open_contract" }));
      }
    }

    if (!preserveOpenContract) {
      clearContractTracking();
    }
    if (!virtualOpenRef.current) releaseTicks(); // a paper trade in flight still settles, then the ticks are released

    run_panel?.setIsRunning?.(false);
    run_panel?.toggleDrawer?.(true);
    run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

    if (preserveOpenContract) {
      run_panel?.setHasOpenContract?.(true);
      run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
    } else {
      run_panel?.setHasOpenContract?.(false);
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }

    logMessage(reason);
  }, [clearContractTracking, releaseTicks, run_panel]);

  const handleStop = useCallback(() => {
    const preserveOpenContract = activeContractsRef.current.size > 0;

    stopTradingBotNative(
      preserveOpenContract ? "Bot stopped. Waiting for active contract to finish..." : "Bot stopped.",
      { preserveOpenContract }
    );
  }, [stopTradingBotNative]);

  const onVirtualTick = useCallback((tick) => {
    const v = virtualOpenRef.current;
    if (!v || !tick || tick.symbol !== v.symbol) return;
    const digit = digitOfQuote(tick.quote, tick.pip_size);
    if (digit === null) return;
    if (tick.epoch && tick.epoch === lastTickEpochRef.current) return; // the same tick twice counts once
    lastTickEpochRef.current = tick.epoch;
    const spot = Number.isFinite(Number(tick.pip_size)) ? Number(tick.quote).toFixed(pipDecimals(tick.pip_size)) : String(tick.quote);
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
      status: won ? "won" : "lost",
      virtual_result: won ? "win" : "loss",
      exit_spot: spot,
      exit_tick_time: tick.epoch,
      transaction_ids: { buy: v.id, sell: v.id },
    });
    logMessage(`Virtual ${v.type}${v.barrier !== null ? ` ${v.barrier}` : ""} ${won ? "won" : "lost"} on paper (digit ${digit}). No money moved.`);

    const step = vhAfterVirtual(vhStateRef.current, won, vhConfigRef.current);
    const nextState = step.state;
    if (step.event === "returned") logMessage("Virtual Hook: the paper trades did it. Back to real money.");
    vhStateRef.current = nextState;
    setPaperStats(p => ({ trades: p.trades + 1, wins: p.wins + (won ? 1 : 0), active: nextState.virtual }));

    if (isRunningRef.current) {
      window.setTimeout(() => requestProposalRef.current?.(), 0);
    } else {
      releaseTicks();
    }
  }, [client?.currency, pushPaper, releaseTicks]);

  const handleTradeSequence = useCallback((profit) => {
    if (useMartingaleRef.current) {
      currentStakeRef.current =
        profit <= 0
          ? parseFloat((Number(currentStakeRef.current) * parseFloat(martingaleMultiplierRef.current || "1")).toFixed(2))
          : parseFloat(baseStakeRef.current);
    }

    lastTradeWasLossRef.current = profit <= 0;

    const realWin = profit > 0;
    realLossStreakRef.current = realWin ? 0 : realLossStreakRef.current + 1;
    if (vhOnRef.current && isEngineKind(tradeTypeRef.current)) {
      const step = vhAfterReal(vhStateRef.current, realWin, vhConfigRef.current);
      vhStateRef.current = step.state;
      if (step.event === "entered") {
        logMessage(`Virtual Hook: ${vhConfigRef.current.enterLosses} real loss(es) in a row. Trading on paper until it wins again.`);
        setPaperStats(p => ({ ...p, active: true }));
      }
    }

    if (!isRunningRef.current) {
      if (activeContractsRef.current.size === 0) {
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
      }
      return;
    }

    const triggeredLimit = getTriggeredTradingLimit();
    if (triggeredLimit) {
      Swal.fire(triggeredLimit.alert);
      stopTradingBotNative(triggeredLimit.reason, { preserveOpenContract: false });
      return;
    }

    window.setTimeout(() => {
      if (isRunningRef.current) {
        requestProposal();
      }
    }, 0);
  }, [getTriggeredTradingLimit, requestProposal, run_panel, stopTradingBotNative]);

  const handleTradingSocketMessage = useCallback((event) => {
    const data = JSON.parse(event.data);

    if (data.msg_type === "tick") {
      onVirtualTick(data.tick);
      return;
    }

    if (data.msg_type === "authorize") {
      isAuthorizedRef.current = true;
      logMessage("Trading session authorized");
      if (isRunningRef.current && activeContractsRef.current.size === 0) {
        requestProposal();
      }
      return;
    }

    if (data.msg_type === "proposal" && !data.error) {
      if (!isRunningRef.current) return;

      const proposalId = data.proposal?.id;
      const askPrice = data.proposal?.ask_price;

      if (!proposalId || askPrice === undefined) {
        logMessage("Proposal received without an id or ask price");
        pendingProposalRef.current = false;
        return;
      }

      wsRef.current.send(JSON.stringify({ buy: proposalId, price: askPrice }));
      return;
    }

    if (data.error) {
      const errorCode = data.error.code;
      const errorMessage = data.error.message;
      const openPositionLimitReached =
        /(cannot hold more than \d+ contracts|open positions of this asset and trade type|open position limit)/i.test(
          errorMessage || ""
        );
      const sessionTradingLimitReached =
        [
          "CompanyWideLimitExceeded",
          "DailyProfitLimitExceeded",
          "ProductSpecificTurnoverLimitExceeded",
          "MaxAggregateOpenStakeExceeded",
        ].includes(errorCode) ||
        /(no further trading is allowed|maximum daily stake|growth rate and instrument)/i.test(errorMessage || "");

      setProposalError(errorMessage);
      pendingProposalRef.current = false;
      logMessage(`Trade error: ${errorMessage}`);
      publishNativeError(errorMessage);

      if (openPositionLimitReached) {
        stopTradingBotNative("Open position limit reached. Bot stopped.", { preserveOpenContract: false });
        return;
      }

      if (sessionTradingLimitReached) {
        stopTradingBotNative("Trading is blocked for this contract type in the current session.", {
          preserveOpenContract: false,
        });
      }
      return;
    }

    if (data.msg_type === "transaction") {
      const action = data.transaction?.action;
      const sellContractId = data.transaction?.contract_id;
      const contractKey = String(sellContractId ?? "");

      if (action !== "sell" || !sellContractId || !activeContractsRef.current.has(contractKey)) {
        return;
      }

      if (completedContractsRef.current.has(contractKey)) {
        return;
      }

      if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
        clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
      }

      const timeoutId = window.setTimeout(() => {
        transactionRecoveryTimeoutsRef.current.delete(contractKey);

        if (
          !activeContractsRef.current.has(contractKey) ||
          completedContractsRef.current.has(contractKey) ||
          wsRef.current?.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: sellContractId }));
      }, 1500);

      transactionRecoveryTimeoutsRef.current.set(contractKey, timeoutId);
      return;
    }

    if (data.msg_type === "buy") {
      const { contract_id, transaction_id, buy_price, longcode } = data.buy || {};
      if (!contract_id) {
        pendingProposalRef.current = false;
        return;
      }

      const contractKey = String(contract_id);
      const market = symbolRef.current;
      const tradeMeta = pendingTradeMetaRef.current || {
        uiContractType: contractTypeRef.current,
        derivContractType: getDerivContractType(contractTypeRef.current),
        barrier: undefined,
        stake: Number(currentStakeRef.current).toFixed(2),
      };
      const transactionPayload = {
        id: contract_id,
        contract_id,
        transaction_ids: { buy: transaction_id },
        buy_price: buy_price ?? parseFloat(tradeMeta.stake),
        currency: client?.currency || "USD",
        display_name: symbolNames[market] || market,
        underlying: market,
        underlying_symbol: market,
        contract_type: tradeMeta.derivContractType,
        longcode,
        barrier: tradeMeta.barrier,
        tick_count: Math.max(1, parseInt(duration, 10) || 1),
        date_start: Math.floor(Date.now() / 1000),
      };

      contractMetaRef.current[contractKey] = transactionPayload;
      completedContractsRef.current.delete(contractKey);
      activeContractsRef.current.add(contractKey);
      pendingProposalRef.current = false;
      setProposalError("");

      publishNativeContract(transactionPayload);
      run_panel?.setHasOpenContract?.(true);
      run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

      setResults(prev => [
        {
          contract_id,
          contract_type: tradeMeta.uiContractType,
          entry_spot: "-",
          exit_spot: "-",
          stake: Number(buy_price ?? tradeMeta.stake).toFixed(2),
          profit: null,
          status: "PENDING",
        },
        ...prev,
      ]);

      wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
      return;
    }

    if (data.msg_type === "proposal_open_contract") {
      const contract = data.proposal_open_contract;
      if (!contract) return;

      const contractKey = String(contract.contract_id);
      const isTrackedContract = activeContractsRef.current.has(contractKey);

      if (!isRunningRef.current && !isTrackedContract) return;
      if (completedContractsRef.current.has(contractKey)) return;

      const normalizedStatus = String(contract.status || "").toLowerCase();
      const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== "open";
      const isExpired = contract.is_expired === 1 || contract.is_expired === true || contract.is_expired === "1";
      const isSettleable =
        contract.is_settleable === 1 || contract.is_settleable === true || contract.is_settleable === "1";
      const isSold =
        contract.is_sold === 1 ||
        contract.is_sold === true ||
        contract.is_sold === "1" ||
        hasClosedStatus ||
        isExpired ||
        isSettleable;

      const entrySpot = formatContractSpot(
        contract.entry_spot_display_value ??
          contract.entry_tick_display_value ??
          contract.entry_spot ??
          contract.entry_tick
      );
      const exitSpot = formatContractSpot(
        contract.exit_spot_display_value ??
          contract.exit_tick_display_value ??
          contract.exit_spot ??
          contract.exit_tick ??
          contract.current_spot_display_value ??
          contract.current_spot
      );
      const profit = parseFloat(contract.profit ?? 0);
      const resultStatus = profit > 0 ? "won" : "lost";
      const nativeContract = {
        ...(contractMetaRef.current[contractKey] || {}),
        ...contract,
        id: contract.contract_id,
        contract_id: contract.contract_id,
        contract_type:
          contract.contract_type ||
          contractMetaRef.current[contractKey]?.contract_type ||
          pendingTradeMetaRef.current?.derivContractType,
        display_name:
          contract.display_name ||
          contractMetaRef.current[contractKey]?.display_name ||
          symbolNames[contract.underlying_symbol || contract.underlying || symbolRef.current] ||
          symbolRef.current,
        underlying_symbol:
          contract.underlying_symbol ||
          contractMetaRef.current[contractKey]?.underlying_symbol ||
          contract.underlying ||
          symbolRef.current,
        underlying:
          contract.underlying ||
          contractMetaRef.current[contractKey]?.underlying ||
          contract.underlying_symbol ||
          symbolRef.current,
        buy_price:
          contract.buy_price ??
          contractMetaRef.current[contractKey]?.buy_price ??
          parseFloat(pendingTradeMetaRef.current?.stake || currentStakeRef.current),
        currency: contract.currency || client?.currency || "USD",
        transaction_ids:
          contract.transaction_ids || contractMetaRef.current[contractKey]?.transaction_ids || undefined,
        entry_spot: entrySpot,
        exit_spot: isSold ? exitSpot : undefined,
        is_sold: isSold,
        is_expired: isExpired || contract.is_expired,
        is_settleable: isSettleable || contract.is_settleable,
        result: isSold ? resultStatus : undefined,
        status: isSold ? normalizedStatus || resultStatus : contract.status || "open",
      };

      contractMetaRef.current[contractKey] = nativeContract;
      publishNativeContract(nativeContract);

      setResults(prev =>
        prev.map(result =>
          result.contract_id === contract.contract_id
            ? {
                ...result,
                entry_spot: entrySpot,
                ...(isSold
                  ? {
                      exit_spot: exitSpot,
                      profit: profit.toFixed(2),
                      status: profit >= 0 ? "WIN" : "LOSS",
                    }
                  : {}),
              }
            : result
        )
      );

      if (!isSold) return;
      if (lastProcessedContractIdRef.current === contractKey) return;

      if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
        clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
        transactionRecoveryTimeoutsRef.current.delete(contractKey);
      }

      completedContractsRef.current.add(contractKey);
      activeContractsRef.current.delete(contractKey);
      lastProcessedContractIdRef.current = contractKey;
      totalProfitRef.current += profit;

      setTotalProfit(totalProfitRef.current.toFixed(2));
      setTotalRuns(p => p + 1);
      if (profit > 0) setWins(p => p + 1);
      else setLosses(p => p + 1);

      run_panel?.setHasOpenContract?.(activeContractsRef.current.size > 0);
      run_panel?.setContractStage?.(
        activeContractsRef.current.size > 0
          ? contract_stages.PURCHASE_RECEIVED
          : isRunningRef.current
            ? contract_stages.CONTRACT_CLOSED
            : contract_stages.NOT_RUNNING
      );
      publishNativeResult(nativeContract);

      handleTradeSequence(profit);
    }
  }, [
    client?.currency,
    duration,
    handleTradeSequence,
    onVirtualTick,
    publishNativeContract,
    publishNativeError,
    publishNativeResult,
    requestProposal,
    run_panel,
    stopTradingBotNative,
  ]);

  const connectTradingSocket = useCallback(async (options = {}) => {
    const { requireAuth = false, forceReconnect = false } = options;
    const socketState = wsRef.current?.readyState;

    if (
      !forceReconnect &&
      (socketState === WebSocket.OPEN || socketState === WebSocket.CONNECTING || isConnectingRef.current)
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
        console.error("[Oracle] Failed to close existing socket:", error);
      }
    }

    isConnectingRef.current = true;
    socketRequiresAuthRef.current = requireAuth;

    try {
      const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

      if (requireAuth && !authenticatedUrl) {
        setProposalError("Unable to create an authenticated Deriv session.");
        return false;
      }

      const socketUrl = authenticatedUrl || DERIV_PUBLIC_WS_URL;
      const isAuthenticatedSocket = Boolean(authenticatedUrl);

      wsRef.current = new WebSocket(socketUrl);
      wsRef.current.onopen = () => {
        logMessage(isAuthenticatedSocket ? "Trading socket connected" : "Public socket connected");
        setProposalError("");
        isAuthorizedRef.current = isAuthenticatedSocket;

        if (isAuthenticatedSocket) {
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

          if (isRunningRef.current && activeContractsRef.current.size === 0) {
            requestProposal();
          }
        }
      };
      wsRef.current.onmessage = handleTradingSocketMessage;
      wsRef.current.onerror = error => {
        logMessage("Trading socket error");
        console.error(error);
      };
      wsRef.current.onclose = () => {
        logMessage("Trading socket closed");
        isAuthorizedRef.current = false;
        wsRef.current = null;
        transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
        transactionRecoveryTimeoutsRef.current.clear();

        const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
        skipReconnectRef.current = false;

        if (shouldReconnect) {
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
          }, 1000);
        }
      };

      return true;
    } catch (error) {
      logMessage(`Trading connection failed: ${error.message}`);
      setProposalError(error.message);
      return false;
    } finally {
      isConnectingRef.current = false;
    }
  }, [getAuthenticatedUrl, handleTradingSocketMessage, requestProposal]);

  const handleBotStart = useCallback(async () => {
    if (isRunningRef.current) {
      handleStop();
      return;
    }

    if (!symbolRef.current) {
      Swal.fire({ title: "No Signal", text: "Please scan first", icon: "warning", draggable: false });
      return;
    }

    if (!getStoredAuthContext()) {
      Swal.fire({ title: "Login Required!", icon: "error", draggable: false });
      return;
    }

    const triggeredLimit = getTriggeredTradingLimit();
    if (triggeredLimit) {
      Swal.fire(triggeredLimit.alert);
      logMessage(triggeredLimit.reason);
      return;
    }

    clearContractTracking();
    lastTradeWasLossRef.current = false;
    realLossStreakRef.current = 0;
    speedGateRef.current = false;
    // With the Virtual Hook on, every Run opens on paper (as the bot builder's Virtual Hook does) and goes real by the hook's own rule.
    const opensOnPaper = vhOnRef.current && isEngineKind(tradeTypeRef.current);
    vhStateRef.current = opensOnPaper ? { virtual: true, realLosses: 0, virtualWins: 0, virtualDone: 0 } : freshVh();
    virtualOpenRef.current = null;
    if (virtualTimerRef.current) {
      clearTimeout(virtualTimerRef.current);
      virtualTimerRef.current = null;
    }
    setPaperStats({ trades: 0, wins: 0, active: opensOnPaper });
    baseStakeRef.current = parseFloat(initialStake) || 0;
    currentStakeRef.current = parseFloat(initialStake) || 0;
    setProposalError("");

    if (summary_card?.clear) summary_card.clear();
    run_panel?.setIsRunning?.(true);
    run_panel?.setHasOpenContract?.(false);
    run_panel?.setContractStage?.(contract_stages.STARTING);
    if (run_panel) {
      run_panel.run_id = `signalhub-${Date.now()}`;
    }
    run_panel?.toggleDrawer?.(true);
    run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

    setIsRunning(true);
    isRunningRef.current = true;

    const socketState = wsRef.current?.readyState;
    if (wsRef.current && socketState === WebSocket.OPEN && isAuthorizedRef.current) {
      requestProposal();
      return;
    }

    const didConnect = await connectTradingSocket({
      requireAuth: true,
      forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current),
    });

    if (!didConnect) {
      setIsRunning(false);
      isRunningRef.current = false;
      run_panel?.setIsRunning?.(false);
      run_panel?.setHasOpenContract?.(false);
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }
  }, [
    clearContractTracking,
    connectTradingSocket,
    getStoredAuthContext,
    getTriggeredTradingLimit,
    handleStop,
    initialStake,
    requestProposal,
    run_panel,
    summary_card,
  ]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    const shouldRequireAuth = Boolean(getStoredAuthContext());
    connectTradingSocket({ requireAuth: shouldRequireAuth });

    const watchdogId = window.setInterval(() => {
      if (!shouldReconnectRef.current) return;
      connectTradingSocket({ requireAuth: socketRequiresAuthRef.current || shouldRequireAuth });
    }, 1500);

    return () => {
      shouldReconnectRef.current = false;
      window.clearInterval(watchdogId);
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        skipReconnectRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectTradingSocket, getStoredAuthContext]);

  useEffect(() => {
    const handleExternalStop = () => {
      if (!isRunningRef.current && activeContractsRef.current.size === 0 && !run_panel?.has_open_contract) return;

      stopTradingBotNative("Bot stopped from the Deriv run panel.", {
        preserveOpenContract: Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract),
      });
    };

    observer.register("bot.click_stop", handleExternalStop);
    observer.register("hub360.stop", handleExternalStop);
    observer.register("hub360.stop.hub360-oracle", handleExternalStop);
    observer.register("oracle.start", handleBotStart);
    observer.register("oracle.stop", handleStop);

    return () => {
      if (observer.isRegistered("bot.click_stop")) {
        observer.unregister("bot.click_stop", handleExternalStop);
        observer.unregister("hub360.stop", handleExternalStop);
        observer.unregister("hub360.stop.hub360-oracle", handleExternalStop);
      }
      if (observer.isRegistered("oracle.start")) {
        observer.unregister("oracle.start", handleBotStart);
      }
      if (observer.isRegistered("oracle.stop")) {
        observer.unregister("oracle.stop", handleStop);
      }
    };
  }, [handleBotStart, handleStop, run_panel?.has_open_contract, stopTradingBotNative]);

  const handleToggleAnalysis = () => {
    if (analysisStarted) {
      stopAll();
    } else {
      startScan();
    }
  };

  const closeScanSockets = () => {
    if (scanSocketRef.current) {
      scanSocketRef.current.close();
      scanSocketRef.current = null;
    }
  };

  const clearScanTimers = () => {
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    if (scanStepTimerRef.current) {
      clearTimeout(scanStepTimerRef.current);
      scanStepTimerRef.current = null;
    }
    if (scanSymbolTimeoutRef.current) {
      clearTimeout(scanSymbolTimeoutRef.current);
      scanSymbolTimeoutRef.current = null;
    }
    if (signalTimeout.current) {
      clearTimeout(signalTimeout.current);
      signalTimeout.current = null;
    }
    if (countdownInterval.current) {
      clearInterval(countdownInterval.current);
      countdownInterval.current = null;
    }
  };

  const getRankedSignals = useCallback(() => (
    Object.keys(latestDataRef.current)
      .map(key => ({
        symbol: key,
        name: symbolNames[key],
        ...latestDataRef.current[key],
      }))
      .sort((a, b) => b.deviation - a.deviation)
  ), []);

  const maybeFinalizeScan = (sessionId, { force = false } = {}) => {
    if (sessionId !== scanSessionRef.current || scanFinalizedRef.current) return;
    if (!force && scannedSymbolsRef.current.size < volatilityList.length) return;

    scanFinalizedRef.current = true;
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    if (scanStepTimerRef.current) {
      clearTimeout(scanStepTimerRef.current);
      scanStepTimerRef.current = null;
    }
    if (scanSymbolTimeoutRef.current) {
      clearTimeout(scanSymbolTimeoutRef.current);
      scanSymbolTimeoutRef.current = null;
    }
    pendingScanSymbolRef.current = null;
    finalizeBestSignal(sessionId);
  };

  const queueNextScan = (sessionId, scanType) => {
    if (sessionId !== scanSessionRef.current || scanFinalizedRef.current) return;

    if (!scanQueueRef.current.length) {
      maybeFinalizeScan(sessionId, { force: true });
      return;
    }

    if (!scanSocketRef.current || scanSocketRef.current.readyState !== WebSocket.OPEN) return;

    const symbol = scanQueueRef.current.shift();
    pendingScanSymbolRef.current = symbol;
    setCurrentScanSymbol(symbolNames[symbol] || symbol);
    scanSocketRef.current.send(JSON.stringify({
      ticks_history: symbol,
      style: 'ticks',
      count: SCAN_HISTORY_COUNT,
      end: 'latest',
    }));

    if (scanSymbolTimeoutRef.current) {
      clearTimeout(scanSymbolTimeoutRef.current);
    }
    scanSymbolTimeoutRef.current = window.setTimeout(() => {
      if (sessionId !== scanSessionRef.current || pendingScanSymbolRef.current !== symbol) return;
      pendingScanSymbolRef.current = null;
      queueNextScan(sessionId, scanType);
    }, SCAN_SYMBOL_TIMEOUT_MS);
  };

  const continueScanQueue = (sessionId, scanType) => {
    if (scanStepTimerRef.current) {
      clearTimeout(scanStepTimerRef.current);
    }
    scanStepTimerRef.current = window.setTimeout(() => {
      queueNextScan(sessionId, scanType);
    }, SCAN_STEP_DELAY_MS);
  };

  const startScan = () => {
    if (isEngineKind(tradeTypeRef.current)) {
      startEngineScan(tradeTypeRef.current);
      return;
    }
    setEngineScan(null);
    setScanEmpty(false);
    scanSessionRef.current += 1;
    const currentSession = scanSessionRef.current;
    const scanType = tradeTypeRef.current;
    activeScanTypeRef.current = scanType;
    scanFinalizedRef.current = false;

    closeScanSockets();
    clearScanTimers();

    setAnalysisStarted(true);
    setCurrentScanSymbol(symbolNames[volatilityList[0]] || volatilityList[0]);
    setTopScanResult(null);
    setScannedMarketsCount(0);
    scannedSymbolsRef.current = new Set();
    latestDataRef.current = {};
    setStrongestSignal(null);
    scanQueueRef.current = [...volatilityList];
    pendingScanSymbolRef.current = null;

    volatilityList.forEach(v => {
      tickData.current[v] = [];
    });
    connectWS(currentSession, scanType);
    scanTimeoutRef.current = window.setTimeout(
      () => maybeFinalizeScan(currentSession, { force: true }),
      SCAN_TIMEOUT_MS
    );
  };

  const stopAll = () => {
    scanSessionRef.current += 1;
    oracleScanner.stop();
    setEngineScan(null);
    setScanInfo(null);
    setScanEmpty(false);
    scanFinalizedRef.current = false;
    closeScanSockets();
    clearScanTimers();
    setAnalysisStarted(false);
    setCurrentScanSymbol('');
    setTopScanResult(null);
    setScannedMarketsCount(0);
    setStrongestSignal(null);
    setSignalTimeLeft(0);
    scannedSymbolsRef.current = new Set();
    latestDataRef.current = {};
    scanQueueRef.current = [];
    pendingScanSymbolRef.current = null;
    setPredictionDigit(null);
    predictionDigitRef.current = null;
  };

  const connectWS = (sessionId, scanType) => {
    const ws = new WebSocket(SCAN_WS_URL);
    scanSocketRef.current = ws;

    ws.onopen = () => {
      if (sessionId !== scanSessionRef.current) return;
      queueNextScan(sessionId, scanType);
    };

    ws.onmessage = (msg) => {
      if (sessionId !== scanSessionRef.current) return;
      const data = JSON.parse(msg.data);
      if (data.error) return;

      const symbol = data.echo_req?.ticks_history || data.echo_req?.ticks || data.tick?.symbol;
      if (!symbol || !data.history?.prices) return;

      tickData.current[symbol] = data.history.prices;

      const isPendingSymbol = pendingScanSymbolRef.current === symbol;
      if (isPendingSymbol) {
        pendingScanSymbolRef.current = null;
        if (scanSymbolTimeoutRef.current) {
          clearTimeout(scanSymbolTimeoutRef.current);
          scanSymbolTimeoutRef.current = null;
        }
      }

      if (!scannedSymbolsRef.current.has(symbol)) {
        scannedSymbolsRef.current.add(symbol);
        setScannedMarketsCount(scannedSymbolsRef.current.size);
      }

      updateUI(symbol, scanType);
      if (isPendingSymbol) {
        continueScanQueue(sessionId, scanType);
      }
      maybeFinalizeScan(sessionId);
    };

    ws.onclose = () => {
      if (sessionId === scanSessionRef.current && !scanFinalizedRef.current) {
        maybeFinalizeScan(sessionId, { force: true });
      }
    };
  };

  const extractDigit = (symbol, price) => {
    const dec = (symbol.startsWith('1HZ') || symbol === 'R_100') ? 2 : (symbol === 'R_75' || symbol === 'R_50') ? 4 : 3;
    const fixed = Number(price).toFixed(dec);
    return parseInt(fixed.split('.')[1]?.slice(-1) || fixed.slice(-1));
  };

  const updateUI = (symbol, scanType = activeScanTypeRef.current) => {
    const stats = calculateStats(symbol, scanType);
    latestDataRef.current[symbol] = stats;
    setTopScanResult(getRankedSignals()[0] || null);
  };

  const calculateStats = (symbol, scanType = activeScanTypeRef.current) => {
    const prices = tickData.current[symbol];
    if (!prices || prices.length < 10) return { contractType: '--', deviation: 0 };
    
    let contractType = '--', deviation = 0;
    const total = prices.length;

    if (scanType === 'EVEN/ODD') {
      const digits = prices.map(p => extractDigit(symbol, p));
      const even = digits.filter(d => d % 2 === 0).length;
      const odd = total - even;
      contractType = even > odd ? 'ODD' : 'EVEN';
      deviation = (Math.abs(even - odd) / total) * 100;
    } 
    
    else if (scanType === 'RISE/FALL') {
      let rise = 0, fall = 0;
      for (let i = 1; i < prices.length; i++) {
        if (Number(prices[i]) > Number(prices[i-1])) rise++;
        else if (Number(prices[i]) < Number(prices[i-1])) fall++;
      }
      contractType = rise > fall ? 'RISE' : 'FALL';
      deviation = (Math.abs(rise - fall) / (rise + fall || 1)) * 100;
    }

    else if (scanType === 'OVER/UNDER') {
      const digits = prices.map(p => extractDigit(symbol, p));
      const over = digits.filter(d => d >= 5).length;
      const under = total - over;
      contractType = over > under ? 'UNDER' : 'OVER';
      deviation = (Math.abs(over - under) / total) * 100;
    }

    else if (scanType === 'DIFFERS') {
      const digits = prices.map(p => extractDigit(symbol, p));
      const last = digits[digits.length - 1];
      const matches = digits.filter(d => d === last).length;
      // We assume deviation is how much it differs from expected 10% frequency
      contractType = matches > (total * 0.1) ? 'DIFFERS' : 'DIFFERS';
      deviation = (Math.abs(matches - (total * 0.1)) / total) * 100;
    }

    return { contractType, deviation };
  };


const syncSignalToBot = (signal) => {
  // Symbol
  setSymbol(signal.symbol);
  symbolRef.current = signal.symbol;

  // Contract type
  setContractType(signal.contractType);
  contractTypeRef.current = signal.contractType;

  // Prediction digit (only when needed)
 if (['OVER', 'UNDER', 'DIFFERS'].includes(signal.contractType)) {
  predictionDigitRef.current = signal.predictionDigit;
}

};

  void syncSignalToBot;

  // ===================== PRESENT A SIGNAL =====================
  // Shows the signal, syncs it to the bot and starts the 60 s validity clock. Used by every scan path.
  const presentSignal = (best, generatedDigit) => {
    closeScanSockets();
    setAnalysisStarted(false);
    setCurrentScanSymbol('');
    setStrongestSignal(best);
    setSignalTimeLeft(60);

    symbolRef.current = best.symbol;
    contractTypeRef.current = best.contractType;

    if (generatedDigit !== null && generatedDigit !== undefined) {
      predictionDigitRef.current = generatedDigit;
      setPredictionDigit(generatedDigit); // UI only
    } else {
      predictionDigitRef.current = null;
      setPredictionDigit(null);
    }

    setSymbol(best.symbol);
    setContractType(best.contractType);

    try {
      alertSound.play().catch(() => null);
    } catch (error) {
      console.debug("Signal alert playback skipped.", error);
    }

    if (countdownInterval.current) clearInterval(countdownInterval.current);
    countdownInterval.current = setInterval(
      () => setSignalTimeLeft(p => (p <= 1 ? 0 : p - 1)),
      1000
    );

    if (signalTimeout.current) clearTimeout(signalTimeout.current);
    signalTimeout.current = setTimeout(() => {
      setStrongestSignal(null);
      setPredictionDigit(null);
      predictionDigitRef.current = null;
      setAnalysisStarted(false);
      closeScanSockets();
      if (countdownInterval.current) {
        clearInterval(countdownInterval.current);
        countdownInterval.current = null;
      }
    }, 60000);
  };

  // ===================== ENGINE SCAN (Even/Odd, Over/Under) =====================
  // Served by the Oracle engine (./oracle): live digits of every market, the rule sets for each trade type, and the
  // barrier for Over/Under chosen by the engines instead of at random.
  const startEngineScan = (kind) => {
    scanSessionRef.current += 1;
    const session = scanSessionRef.current;
    scanFinalizedRef.current = false;
    closeScanSockets();
    clearScanTimers();
    oracleScanner.stop();

    setAnalysisStarted(true);
    setStrongestSignal(null);
    setTopScanResult(null);
    setEngineScan(null);
    setScanInfo(null);
    setScanEmpty(false);
    setScannedMarketsCount(0);
    setCurrentScanSymbol(symbolNames[volatilityList[0]] || '');
    setPredictionDigit(null);
    predictionDigitRef.current = null;

    oracleScanner.start(kind, {
      onProgress: (scan, current, info) => {
        if (session !== scanSessionRef.current) return;
        setEngineScan(scan);
        setScanInfo(info);
        setScannedMarketsCount(scan.ready);
        setCurrentScanSymbol(current);
        setTopScanResult({ deviation: scan.topScore });
      },
      onSignal: (signal, scan) => {
        if (session !== scanSessionRef.current) return;
        setEngineScan(scan);
        presentSignal(signal, signal.barrier);
      },
      onNone: (scan) => {
        if (session !== scanSessionRef.current) return;
        setEngineScan(scan);
        setAnalysisStarted(false);
        setCurrentScanSymbol('');
        setScanEmpty(true);
      },
    });
  };

  // ===================== FINALIZE BEST SIGNAL (Rise/Fall, Differs) =====================
  const finalizeBestSignal = (sessionId = scanSessionRef.current) => {
    if (sessionId !== scanSessionRef.current) return;

    const sorted = getRankedSignals();

    if (!sorted.length) {
      stopAll();
      return;
    }

    const best = sorted[0];

    let generatedDigit = null;
    if (best.contractType === 'OVER') {
      generatedDigit = Math.floor(Math.random() * 4) + 1; // 1–4
    } else if (best.contractType === 'UNDER') {
      generatedDigit = Math.floor(Math.random() * 4) + 5; // 5–8
    } else if (best.contractType === 'DIFFERS') {
      generatedDigit = Math.floor(Math.random() * 4) + 5; // 5–8
    }

    presentSignal(best, generatedDigit);
  };

  // The scan's own measured deviation, not a win probability (digit contracts have no 80%+ "confidence").
  const signalConfidence = strongestSignal
    ? Math.min(100, Math.max(0, Number(strongestSignal.deviation || 0)))
    : 0;
  const totalMarkets = engineScan?.total ?? volatilityList.length;
  const scanProgress = isEngineKind(tradeType) && scanInfo
    ? Math.min(100, (scanInfo.elapsedMs / scanInfo.assessMs) * 100)
    : Math.min(100, (scannedMarketsCount / totalMarkets) * 100);
  const topScanDeviation = topScanResult?.deviation ?? 0;
  const closest = engineScan?.closest || null;
  const isEngineTab = isEngineKind(tradeType);
  const isEvenOdd = tradeType === 'EVEN/ODD';
  const secondsLeft = scanInfo ? Math.max(0, Math.ceil((scanInfo.assessMs - scanInfo.elapsedMs) / 1000)) : 0;
  const waitingForData = Boolean(scanInfo) && scanInfo.elapsedMs >= scanInfo.assessMs;
  const marketCalls = engineScan?.markets || [];
  const flaggedMarkets = marketCalls.filter(m => m.level === 'FLAGGED');
  const watchMarkets = marketCalls.filter(m => m.level === 'WATCH');
  const clearMarkets = marketCalls.filter(m => m.level === 'CLEAR');
  const bestSoFar = engineScan ? engineScan.best || engineScan.fallback : null;
  const RISK_TEXT = { LOW: 'Low', ELEVATED: 'Elevated', HIGH: 'High' };

  const signalContractClass = strongestSignal
    ? `or-contract-${strongestSignal.contractType.toLowerCase()}`
    : '';
  const statusText = strongestSignal ? 'SIGNAL READY' : analysisStarted ? 'ASSESSING' : 'IDLE';
  const statusClass = strongestSignal ? 'or-status--ready' : analysisStarted ? 'or-status--active' : '';
  const weakBoard = strongestSignal?.rules && strongestSignal.tier === 'BEST' && strongestSignal.rules.passed < 4;

  const flaggedLines = (limit = 3) => flaggedMarkets.slice(0, limit).map(m => (
    <li key={m.symbol}><strong>{m.name}</strong> {m.contract}: {m.reason}</li>
  ));

  return (
    <div className="or-shell">
      <div className="or-panel">
        <div className="or-header">
          <div className="or-badge">OR</div>
          <div className="or-brand">
            <h2>THE <span>ORACLE</span></h2>
          </div>
          <div className={`or-status ${statusClass}`}>
            <i className="or-status-dot" />
            {statusText}
          </div>
        </div>

        <div className="or-tabs" role="tablist" aria-label="Trade type">
          {TRADE_TYPE_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tradeType === tab.id}
              className={`or-tab ${tradeType === tab.id ? 'or-tab--active' : ''}`}
              onClick={() => {
                tradeTypeRef.current = tab.id;
                setTradeType(tab.id);
                setEngineScan(null);
                setScanInfo(null);
                setScanEmpty(false);
                if (analysisStarted) stopAll();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="or-actions">
          <button
            type="button"
            className={`or-btn ${analysisStarted ? 'or-btn--scan-stop' : 'or-btn--scan'}`}
            onClick={handleToggleAnalysis}
          >
            {analysisStarted ? 'STOP SCAN' : 'SCAN MARKET'}
          </button>
          <button
            type="button"
            onClick={handleBotStart}
            className={`or-btn ${isRunning ? 'or-btn--run-stop' : 'or-btn--run'}`}
          >
            {isRunning ? <FaStop /> : <FaPlay />} {isRunning ? 'STOP BOT' : 'RUN BOT'}
          </button>
        </div>

        {strongestSignal ? (
          <div className="or-card or-signal or-pop">
            <div className="or-signal-head">
              <span className={`or-signal-tag ${strongestSignal.tier === 'BEST' ? 'or-signal-tag--best' : ''}`}>
                {strongestSignal.tier === 'BEST' ? 'Best available' : 'Signal found'}
              </span>
              <span className="or-valid">Valid {signalTimeLeft}s</span>
            </div>
            <div className="or-signal-main">
              <div className="or-signal-col">
                <span className="or-label">Market</span>
                <strong className="or-value">{symbolNames[strongestSignal.symbol]}</strong>
                <span className="or-label">Contract</span>
                <strong className={`or-value or-signal-type ${signalContractClass}`}>
                  {strongestSignal.contractType}{' '}
                  {predictionDigit !== null && predictionDigit !== undefined && (
                    <span className="or-signal-digit">{predictionDigit}</span>
                  )}
                </strong>
              </div>
              <div className="or-signal-col or-box">
                <span className="or-label">{isEvenOdd ? 'Match' : isEngineTab ? 'Strength' : 'Deviation'}</span>
                <span className="or-big">{signalConfidence.toFixed(isEngineTab ? 0 : 1)}%</span>
                <span className="or-bar"><span style={{ width: `${signalConfidence}%` }} /></span>
                {strongestSignal.rules && (
                  <span className="or-sub">{strongestSignal.rules.passed} of {strongestSignal.rules.total} rules</span>
                )}
                {strongestSignal.risk && (
                  <span className={`or-sub or-risk or-risk--${strongestSignal.risk.toLowerCase()}`}>
                    Losing-digit risk: {RISK_TEXT[strongestSignal.risk]}
                  </span>
                )}
              </div>
            </div>
            {weakBoard && (
              <p className="or-note or-note--warn">Weak board: only {strongestSignal.rules.passed} of {strongestSignal.rules.total} rules hold. Trade it with care or scan again.</p>
            )}
            {flaggedMarkets.length > 0 && (
              <p className="or-note">
                Flagged and skipped: {flaggedMarkets.slice(0, 3).map(m => m.name).join(', ')}
                {flaggedMarkets.length > 3 ? ` +${flaggedMarkets.length - 3}` : ''}
              </p>
            )}
            {strongestSignal.checks?.length > 0 && (
              <details className="or-why">
                <summary>Why this one</summary>
                <ul className="or-checks">
                  {strongestSignal.checks.map(c => (
                    <li key={c.label} className={c.ok ? 'is-ok' : 'is-fail'}>
                      <span className="or-check-mark">{c.ok ? '✓' : '✕'}</span>
                      <span className="or-check-text">
                        {c.label}
                        <small>{c.detail}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : isEngineTab ? (
          <div className="or-card or-assess or-pop">
            {analysisStarted ? (
              <>
                <div className="or-progress-head">
                  <span>{waitingForData ? 'Waiting for market data…' : isEvenOdd ? 'Reading the digit boards' : 'Assessing risk on every market'}</span>
                  <strong>{waitingForData ? '' : `${secondsLeft}s`}</strong>
                </div>
                <span className="or-bar or-bar--thick"><span style={{ width: `${scanProgress}%` }} /></span>
                <div className="or-row">
                  <span>Markets read</span>
                  <strong>{scannedMarketsCount}/{totalMarkets}</strong>
                </div>
                {isEvenOdd ? (
                  bestSoFar && (
                    <div className="or-row">
                      <span>Best so far</span>
                      <strong>{bestSoFar.name} {bestSoFar.contractType} · {bestSoFar.deviation.toFixed(0)}% ({bestSoFar.rules?.passed}/{bestSoFar.rules?.total})</strong>
                    </div>
                  )
                ) : (
                  <>
                    <div className="or-tally">
                      <span className="or-tally-clear">Clear {clearMarkets.length}</span>
                      <span className="or-tally-watch">Watch {watchMarkets.length}</span>
                      <span className="or-tally-flag">Flagged {flaggedMarkets.length}</span>
                    </div>
                    {flaggedMarkets.length > 0 && <ul className="or-flags">{flaggedLines()}</ul>}
                  </>
                )}
              </>
            ) : scanEmpty ? (
              <>
                <strong className="or-empty-title">
                  {isEvenOdd ? 'No market has a usable Even/Odd board right now.' : 'Every market is flagged or failed a check right now.'}
                </strong>
                {flaggedMarkets.length > 0 && <ul className="or-flags">{flaggedLines()}</ul>}
                {closest && !isEvenOdd && (
                  <span className="or-sub">Closest: {closest.name} · {closest.contract} ({closest.passed}/{closest.total} checks)</span>
                )}
                <span className="or-sub">Scan again in a moment.</span>
              </>
            ) : (
              <span className="or-sub or-idle">
                {isEvenOdd
                  ? 'Scan reads every market for about 15 seconds and gives the best Even/Odd board with its match percentage.'
                  : 'Scan assesses every market for about 18 seconds, flags the ones whose losing digits are running hot, then gives one contract.'}
              </span>
            )}
          </div>
        ) : (
          <div className="or-card or-ready or-pop">
            <div className="or-ready-left">
              <span className="or-ready-title">MARKET READINESS</span>
              <div className="or-row">
                <span>Markets scanned</span>
                <strong>{analysisStarted ? `${scannedMarketsCount}/${totalMarkets}` : '--'}</strong>
              </div>
              <div className="or-row">
                <span>Scanning now</span>
                <strong>{analysisStarted ? currentScanSymbol || '--' : '--'}</strong>
              </div>
              <div className="or-row">
                <span>Best deviation</span>
                <strong>{analysisStarted ? `${topScanDeviation.toFixed(1)}%` : '--'}</strong>
              </div>
            </div>
            <div className="or-ready-right">
              <div className="or-progress-head">
                <span>Progress</span>
                <strong>{Math.round(analysisStarted ? scanProgress : 0)}%</strong>
              </div>
              <span className="or-bar or-bar--thick"><span style={{ width: `${analysisStarted ? scanProgress : 0}%` }} /></span>
            </div>
          </div>
        )}

        <div className="or-card or-settings">
          <div className="or-settings-grid">
            <label>
              Stake
              <input type="number" value={initialStake} onChange={(e) => setInitialStake(e.target.value)} />
            </label>
            <label>
              Target Profit
              <input type="number" value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} />
            </label>
            <label>
              Stop Loss
              <input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
            </label>
          </div>

          <div className="or-martingale">
            <label className="or-toggle">
              <input type="checkbox" checked={useMartingale} onChange={(e) => setUseMartingale(e.target.checked)} />
              <span className="or-toggle-track" />
            </label>
            <label className={`or-multiplier ${useMartingale ? '' : 'or-multiplier--disabled'}`}>
              Martingale
              <input
                type="number"
                step="0.1"
                min="1"
                value={martingaleMultiplier}
                onChange={(e) => setMartingaleMultiplier(e.target.value)}
                disabled={!useMartingale}
              />
            </label>
          </div>

          {tradeType === 'OVER/UNDER' && (
            <div className="or-block">
              <label className="or-toggle">
                <input type="checkbox" aria-label="Recovery" checked={useRecovery} onChange={(e) => setUseRecovery(e.target.checked)} />
                <span className="or-toggle-track" />
              </label>
              <div className={`or-block-body ${useRecovery ? '' : 'or-block-body--off'}`}>
                <strong className="or-block-title">Recovery</strong>
                <span className="or-block-hint">After a loss, trade this instead until a trade wins (e.g. lose Over 2, recover Over 3).</span>
                <div className="or-block-fields">
                  <label>
                    Recovery contract
                    <select
                      value={recoveryType}
                      disabled={!useRecovery}
                      onChange={(e) => {
                        setRecoveryType(e.target.value);
                        setRecoveryBarrier(String(defaultRecoveryBarrier(e.target.value)));
                      }}
                    >
                      {RECOVERY_TYPES.map(type => (
                        <option key={type} value={type}>{type.charAt(0) + type.slice(1).toLowerCase()}</option>
                      ))}
                    </select>
                  </label>
                  {needsBarrier(recoveryType) && (
                    <label>
                      Digit
                      <input
                        type="number"
                        min={barrierRange(recoveryType)[0]}
                        max={barrierRange(recoveryType)[1]}
                        value={recoveryBarrier}
                        disabled={!useRecovery}
                        onChange={(e) => setRecoveryBarrier(e.target.value)}
                        onBlur={() => setRecoveryBarrier(String(clampBarrier(recoveryType, recoveryBarrier)))}
                      />
                    </label>
                  )}
                </div>
              </div>
            </div>
          )}

          {isEngineTab && (
            <div className="or-block">
              <label className="or-toggle">
                <input type="checkbox" aria-label="Virtual hook" checked={useVirtualHook} onChange={(e) => setUseVirtualHook(e.target.checked)} />
                <span className="or-toggle-track" />
              </label>
              <div className={`or-block-body ${useVirtualHook ? '' : 'or-block-body--off'}`}>
                <strong className="or-block-title">Virtual hook</strong>
                <span className="or-block-hint">After real losses, trade on paper (no stake) and go back to real money once it wins again.</span>
                <div className="or-block-fields">
                  <label>
                    Mode
                    <select value={vhMode} disabled={!useVirtualHook} onChange={(e) => setVhMode(e.target.value)}>
                      <option value="STREAK">Until paper wins</option>
                      <option value="FIXED">Fixed paper trades</option>
                    </select>
                  </label>
                  <label>
                    Go virtual after losses
                    <input type="number" min="1" max="10" value={vhEnterLosses} disabled={!useVirtualHook} onChange={(e) => setVhEnterLosses(e.target.value)} />
                  </label>
                  {vhMode === 'STREAK' ? (
                    <label>
                      Back to real after wins
                      <input type="number" min="1" max="10" value={vhReturnWins} disabled={!useVirtualHook} onChange={(e) => setVhReturnWins(e.target.value)} />
                    </label>
                  ) : (
                    <label>
                      Paper trades
                      <input type="number" min="1" max="20" value={vhFixedCount} disabled={!useVirtualHook} onChange={(e) => setVhFixedCount(e.target.value)} />
                    </label>
                  )}
                </div>
                {useVirtualHook && (isRunning || paperStats.trades > 0) && (
                  <span className={`or-paper ${paperStats.active ? 'or-paper--on' : ''}`}>
                    {paperStats.active ? 'Trading on paper now' : 'Trading real money'} · paper {paperStats.wins}/{paperStats.trades} won
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {proposalError && (
          <div className="or-error">
            <strong>Error:</strong> {proposalError}
          </div>
        )}
      </div>
    </div>
  );
};

export default Oracle;
