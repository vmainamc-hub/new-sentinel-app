// Pure, framework-free logic for the Apex Sentinel AI Bots and Digits Analysis pages.

export type Contract = 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'CALL' | 'PUT';
export type Signal = { contract: Contract; barrier?: string; label: string };
export type RuleId = 'evenodd' | 'range45' | 'over2' | 'under7' | 'risefall';
export type Phase = 'primary' | 'recovery';

export const digitFromPrice = (price: number, decimals: number): number =>
    Number(Number(price).toFixed(Math.max(0, decimals)).slice(-1));

export const digitsFromPrices = (prices: number[], decimals: number): number[] =>
    prices.filter(Number.isFinite).map(price => digitFromPrice(price, decimals));

// ---------------------------------------------------------------------------
// AI Bots
// ---------------------------------------------------------------------------

export type SignalContext = { digits: number[]; prices: number[] };

export const RULES: Record<RuleId, (ctx: SignalContext) => Signal | null> = {
    // Even digit triggers Odd, odd digit triggers Even.
    evenodd: ({ digits }) => {
        if (!digits.length) return null;
        const last = digits[digits.length - 1];
        return last % 2 === 0 ? { contract: 'DIGITODD', label: 'Odd' } : { contract: 'DIGITEVEN', label: 'Even' };
    },
    // Digits below 4 trigger Over 4; digits above 5 trigger Under 5.
    range45: ({ digits }) => {
        if (!digits.length) return null;
        const last = digits[digits.length - 1];
        if (last < 4) return { contract: 'DIGITOVER', barrier: '4', label: 'Over 4' };
        if (last > 5) return { contract: 'DIGITUNDER', barrier: '5', label: 'Under 5' };
        return null;
    },
    // Digits below 2 trigger Over 2.
    over2: ({ digits }) => {
        if (!digits.length) return null;
        return digits[digits.length - 1] < 2 ? { contract: 'DIGITOVER', barrier: '2', label: 'Over 2' } : null;
    },
    // Digits above 7 trigger Under 7.
    under7: ({ digits }) => {
        if (!digits.length) return null;
        return digits[digits.length - 1] > 7 ? { contract: 'DIGITUNDER', barrier: '7', label: 'Under 7' } : null;
    },
    // A rising run triggers Fall; a falling run triggers Rise.
    risefall: ({ prices }) => {
        if (prices.length < 3) return null;
        const [a, b, c] = prices.slice(-3);
        if (c > b && b > a) return { contract: 'PUT', label: 'Fall' };
        if (c < b && b < a) return { contract: 'CALL', label: 'Rise' };
        return null;
    },
};

export type AIBot = {
    id: string;
    index: number;
    title: string;
    description: string;
    accent: 'blue' | 'teal' | 'purple' | 'orange' | 'amber' | 'pink' | 'red';
    primary: RuleId;
    recovery?: RuleId;
};

export const AI_BOTS: AIBot[] = [
    { id: 'even-odd-ai', index: 1, title: 'Even–Odd AI', accent: 'blue', primary: 'evenodd',
        description: 'All Even digits trigger Odd. All Odd digits trigger Even.' },
    { id: 'over4-under5-ai', index: 2, title: 'Over 4–Under 5 AI', accent: 'teal', primary: 'range45',
        description: 'Digits below 4 trigger Over 4. Digits above 5 trigger Under 5.' },
    { id: 'rise-fall-ai', index: 3, title: 'Rise–Fall AI', accent: 'purple', primary: 'risefall',
        description: 'A rising run triggers Fall. A falling run triggers Rise.' },
    { id: 'over2-recovery-evenodd', index: 4, title: 'Over 2 Recovery → Even–Odd', accent: 'orange', primary: 'over2', recovery: 'evenodd',
        description: 'Digits below 2 trigger Over 2, followed by Even–Odd recovery after a loss.' },
    { id: 'over2-recovery-range', index: 5, title: 'Over 2 Recovery → Over 4–Under 5', accent: 'amber', primary: 'over2', recovery: 'range45',
        description: 'Digits below 2 trigger Over 2, followed by range recovery after a loss.' },
    { id: 'under7-recovery-evenodd', index: 6, title: 'Under 7 Recovery → Even–Odd', accent: 'pink', primary: 'under7', recovery: 'evenodd',
        description: 'Digits above 7 trigger Under 7, followed by Even–Odd recovery after a loss.' },
    { id: 'under7-recovery-range', index: 7, title: 'Under 7 Recovery → Over 4–Under 5', accent: 'red', primary: 'under7', recovery: 'range45',
        description: 'Digits above 7 trigger Under 7, followed by range recovery after a loss.' },
];

export type RiskParams = {
    stake: number;
    multiplier: number;
    maxStake: number;
    takeProfit: number;
    stopLoss: number;
    maxConsecutiveLosses: number;
};

export const DEFAULT_RISK: RiskParams = {
    stake: 1, multiplier: 2, maxStake: 20, takeProfit: 10, stopLoss: 10, maxConsecutiveLosses: 5,
};

export const sanitizeRisk = (input: Partial<RiskParams>): RiskParams => {
    const n = (value: unknown, fallback: number, min: number, max: number) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    };
    const stake = n(input.stake, DEFAULT_RISK.stake, 0.35, 1000);
    return {
        stake,
        multiplier: n(input.multiplier, DEFAULT_RISK.multiplier, 1, 10),
        maxStake: Math.max(stake, n(input.maxStake, DEFAULT_RISK.maxStake, 0.35, 10000)),
        takeProfit: n(input.takeProfit, DEFAULT_RISK.takeProfit, 0.01, 100000),
        stopLoss: n(input.stopLoss, DEFAULT_RISK.stopLoss, 0.01, 100000),
        maxConsecutiveLosses: Math.trunc(n(input.maxConsecutiveLosses, DEFAULT_RISK.maxConsecutiveLosses, 1, 50)),
    };
};

export type RunState = {
    phase: Phase;
    stake: number;
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
    consecutiveLosses: number;
};

export const initialRunState = (risk: RiskParams): RunState => ({
    phase: 'primary', stake: risk.stake, pnl: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0,
});

const round2 = (value: number) => Math.round(value * 100) / 100;

export const applyResult = (state: RunState, bot: AIBot, risk: RiskParams, profit: number): RunState => {
    const won = profit > 0;
    const next: RunState = {
        ...state,
        pnl: round2(state.pnl + profit),
        trades: state.trades + 1,
        wins: state.wins + (won ? 1 : 0),
        losses: state.losses + (won ? 0 : 1),
        consecutiveLosses: won ? 0 : state.consecutiveLosses + 1,
        stake: won ? risk.stake : round2(Math.min(state.stake * risk.multiplier, risk.maxStake)),
        phase: state.phase,
    };
    if (bot.recovery) next.phase = won ? 'primary' : 'recovery';
    return next;
};

export type StopReason = 'take_profit' | 'stop_loss' | 'max_losses' | null;

export const stopReason = (state: RunState, risk: RiskParams): StopReason => {
    if (state.pnl >= risk.takeProfit) return 'take_profit';
    if (state.pnl <= -risk.stopLoss) return 'stop_loss';
    if (state.consecutiveLosses >= risk.maxConsecutiveLosses) return 'max_losses';
    return null;
};

export const activeRule = (bot: AIBot, phase: Phase): RuleId => (phase === 'recovery' && bot.recovery ? bot.recovery : bot.primary);

// ---------------------------------------------------------------------------
// Digits Analysis
// ---------------------------------------------------------------------------

export type AnalysisMode = 'over_under' | 'even_odd';
export type DigitPair = { over: number; under: number };
export const DIGIT_PAIRS: DigitPair[] = [
    { over: 1, under: 8 }, { over: 2, under: 7 }, { over: 3, under: 6 }, { over: 4, under: 5 },
];

export type Trade = { side: 'over' | 'under' | 'even' | 'odd'; barrier?: number; label: string };

export const tradeWins = (trade: Trade, digit: number): boolean => {
    switch (trade.side) {
        case 'over': return digit > (trade.barrier ?? 0);
        case 'under': return digit < (trade.barrier ?? 9);
        case 'even': return digit % 2 === 0;
        default: return digit % 2 === 1;
    }
};

export const winPercent = (digits: number[], trade: Trade): number =>
    digits.length ? (digits.filter(digit => tradeWins(trade, digit)).length / digits.length) * 100 : 0;

export const candidateTrades = (mode: AnalysisMode, pair: DigitPair): Trade[] =>
    mode === 'over_under'
        ? [
            { side: 'over', barrier: pair.over, label: `Over ${pair.over}` },
            { side: 'under', barrier: pair.under, label: `Under ${pair.under}` },
        ]
        : [{ side: 'even', label: 'Even' }, { side: 'odd', label: 'Odd' }];

export type MarketDigits = { symbol: string; name: string; digits: number[] };
export type RankedMarket = {
    symbol: string; name: string; trade: Trade; percent: number; gap: number; latest: number | null; latestWins: boolean;
};

export const rankMarkets = (
    markets: MarketDigits[], mode: AnalysisMode, pair: DigitPair, analysisTicks: number
): RankedMarket[] =>
    markets
        .filter(market => market.digits.length > 0)
        .map(market => {
            const window = market.digits.slice(-Math.max(1, analysisTicks));
            const [a, b] = candidateTrades(mode, pair);
            const pa = winPercent(window, a);
            const pb = winPercent(window, b);
            const best = pa >= pb ? a : b;
            const latest = window.length ? window[window.length - 1] : null;
            return {
                symbol: market.symbol, name: market.name, trade: best,
                percent: Math.round(Math.max(pa, pb) * 10) / 10,
                gap: Math.round(Math.abs(pa - pb) * 10) / 10,
                latest, latestWins: latest !== null && tradeWins(best, latest),
            };
        })
        .sort((x, y) => y.percent - x.percent);

export type StreakStats = {
    wins: number; losses: number; cells: Array<{ digit: number; win: boolean }>;
    current: { type: 'Win' | 'Loss' | null; length: number };
    longestWin: number; latest: { digit: number | null; win: boolean };
};

export const streakStats = (digits: number[], trade: Trade, viewLast: number): StreakStats => {
    const view = digits.slice(-Math.max(1, viewLast));
    const cells = view.map(digit => ({ digit, win: tradeWins(trade, digit) }));
    let longest = 0; let run = 0;
    cells.forEach(cell => { run = cell.win ? run + 1 : 0; longest = Math.max(longest, run); });
    let length = 0;
    const lastWin = cells.length ? cells[cells.length - 1].win : null;
    for (let i = cells.length - 1; i >= 0 && cells[i].win === lastWin; i -= 1) length += 1;
    const wins = cells.filter(cell => cell.win).length;
    return {
        wins, losses: cells.length - wins, cells,
        current: { type: lastWin === null ? null : lastWin ? 'Win' : 'Loss', length },
        longestWin: longest,
        latest: { digit: cells.length ? cells[cells.length - 1].digit : null, win: Boolean(lastWin) },
    };
};