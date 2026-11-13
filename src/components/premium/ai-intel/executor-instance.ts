// APEX INTEL: the app-wide executor, wired to the real Deriv purchase helpers and the shared live market feed.
import { contract_stages } from '@/constants/contract-stage';
import { api_base } from '@/external/bot-skeleton';
import { apexFeed, apexSeries } from './feed-source';
import { describeTradeFailure } from '@/utils/trade-errors';
import { buyContractForUi, streamContractUntilSettled } from '@/utils/trade-purchase';
import { rankPicks, rankRecovery } from './picker';
import { getCandidates } from './candidates';
import './registry-instance'; // sets the candidate provider (baseline + ACTIVE strategies)
import { createEntryDigitSource } from './entry-digit';
import { createOverlordReader } from './overlord-select';
import { AiIntelExecutor, type ExecConfig, type ExecTrade } from './executor';
import { assess } from './guard';
import { createApexGates } from '@/components/premium/edge-gates/apex-gates';
import { readSpecialDigits } from '@/components/premium/sentinel/special-digits';
import { forwardMonitor } from './registry-instance';

const CONFIG_KEY = 'apex_intel_exec_v1';
const TRADES_KEY = 'apex_intel_trades_v1';

const read = <T>(key: string): T | null => {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
};
const write = (key: string, value: unknown) => {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* storage may be unavailable (private mode, full) */
    }
};

// The edge gates (Kalman health, cross-market danger + frequency, arbiter) added on top of the AI guard below. Console: `apexIntelEdge`.
const apexGates = createApexGates({ series: () => apexFeed.getLiveSeries() });

// The "Entry digit" mode: the Entry Digit Lab. It takes every live tick of every market (below), re-scores all ten digits on each one
// and weighs the newest data most; the executor reads it on the tick it trades on. Console: `apexEntryLab.view('R_10', {side:'OVER',param:2}, 1)`.
const entryDigits = createEntryDigitSource({ series: symbol => apexFeed.getLiveSeries()[symbol] });
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).apexEntryLab = entryDigits;

// The "Overlord" selection modes: Overlord's over/under engines read the live markets (quotes and digits from the same shared feed,
// no second socket) and take part in choosing the market and contract. Idle in STANDARD mode: nothing is read until a run asks for it.
const overlordReader = createOverlordReader({ series: () => apexSeries(), prices: () => apexFeed.getLivePrices() });

export const aiIntelExecutor = new AiIntelExecutor({
    buy: ({ parameters, price }) => buyContractForUi({ parameters, price, source: 'Apex Intel' }),
    settle: ({ contractId, fallback, onUpdate, signal }) =>
        streamContractUntilSettled({ contractId, fallback, onUpdate, signal, source: 'Apex Intel' }),
    isAuthorized: () => Boolean((api_base as { is_authorized?: boolean }).is_authorized),
    now: () => Date.now(),
    lastTickAt: symbol => apexFeed.getLastTickAt(symbol),
    isFeedLive: () => apexFeed.isLive(),
    connectFeed: () => apexFeed.connect(),
    history: symbol => apexFeed.getLiveSeries()[symbol],
    pick: opts =>
        rankPicks(apexSeries(), symbol => apexFeed.getLastTickAt(symbol), Date.now(), {
            ...opts,
            candidates: getCandidates(),
        }),
    pickRecovery: opts => rankRecovery(apexSeries(), symbol => apexFeed.getLastTickAt(symbol), Date.now(), opts),
    review: req => {
        const series = apexFeed.getLiveSeries()[req.market] ?? [];
        const verdict = assess(req, { series, forward: forwardMonitor.getSnapshot() });
        if (!verdict.allow) return verdict; // the AI guard's own rules come first and are unchanged
        const gates = apexGates.review({ market: req.market, contract: req.contract, recovery: req.recovery, series });
        return gates.allow ? verdict : gates;
    },
    // Sentinel AI's mandatory digit 1 / digit 8 rule: no switch, and not tied to the AI guard mode above.
    special: req => {
        const read = readSpecialDigits(apexFeed.getLiveSeries()[req.market], req.contract.side);
        return { allow: read.ok, reason: read.note };
    },
    entryDigit: (market, contract, duration) => entryDigits.get(market, contract, duration),
    entryResult: r => entryDigits.record(r.market, r.contract, r.duration, r.digit, r.won),
    entryView: (market, contract, duration) => entryDigits.view(market, contract, duration),
    overlordView: (market, contract, now) => overlordReader.get(market, contract, now),
    overlordRefresh: (now, priority) => {
        overlordReader.refresh(now, priority);
    },
    overlordReset: () => overlordReader.reset(),
    onBoard: (ranked, recovery, now) => apexGates.onBoard(ranked, recovery, now),
    onBought: n => apexGates.onBought(n),
    onSettled: n => apexGates.onSettled(n),
    describeFailure: error => describeTradeFailure(error),
    afterStop: () => {
        const base = api_base as { is_stopping?: boolean; setIsRunning?: (value: boolean) => void };
        base.is_stopping = false;
        base.setIsRunning?.(false);
    },
    load: () => read<Partial<ExecConfig>>(CONFIG_KEY),
    save: config => write(CONFIG_KEY, config),
    loadTrades: () => read<ExecTrade[]>(TRADES_KEY) ?? [],
    saveTrades: trades => write(TRADES_KEY, trades),
    runningStage: contract_stages.RUNNING,
    notRunningStage: contract_stages.NOT_RUNNING,
});

apexFeed.onTick((symbol, digit) => {
    entryDigits.observe(symbol, digit); // first, so the trade below is decided on the newest tick
    apexGates.onTick(symbol, digit);
    aiIntelExecutor.handleTick(symbol, digit);
});
