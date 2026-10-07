export type DigitStrategyId = 'OVER_2_MARKET' | 'UNDER_7_MARKET';

export type DigitStrategy = {
    alertLabel: string;
    contractType: 'DIGITOVER' | 'DIGITUNDER';
    entryLabel: string;
    winBarrier: string;
};

export const SUPPORTED_VOLATILITY_MARKETS = [
    { symbol: 'R_10', label: 'Volatility 10 Index', pip: 3 },
    { symbol: 'R_25', label: 'Volatility 25 Index', pip: 3 },
    { symbol: 'R_50', label: 'Volatility 50 Index', pip: 4 },
    { symbol: 'R_75', label: 'Volatility 75 Index', pip: 4 },
    { symbol: 'R_100', label: 'Volatility 100 Index', pip: 2 },
    { symbol: '1HZ10V', label: 'Volatility 10 (1s) Index', pip: 2 },
    { symbol: '1HZ15V', label: 'Volatility 15 (1s) Index', pip: 2 },
    { symbol: '1HZ25V', label: 'Volatility 25 (1s) Index', pip: 2 },
    { symbol: '1HZ30V', label: 'Volatility 30 (1s) Index', pip: 2 },
    { symbol: '1HZ50V', label: 'Volatility 50 (1s) Index', pip: 2 },
    { symbol: '1HZ75V', label: 'Volatility 75 (1s) Index', pip: 2 },
    { symbol: '1HZ90V', label: 'Volatility 90 (1s) Index', pip: 2 },
    { symbol: '1HZ100V', label: 'Volatility 100 (1s) Index', pip: 2 },
];

export const DIGIT_STRATEGIES: Record<DigitStrategyId, DigitStrategy> = {
    OVER_2_MARKET: {
        alertLabel: 'Over 2 market',
        contractType: 'DIGITOVER',
        entryLabel: 'Over 2 entry',
        winBarrier: '2',
    },
    UNDER_7_MARKET: {
        alertLabel: 'Under 7 market',
        contractType: 'DIGITUNDER',
        entryLabel: 'Under 7 entry',
        winBarrier: '7',
    },
};

export const calculateDigitPercentagesFromDigits = (digits: number[]) => {
    const counts = Array.from({ length: 10 }, () => 0);
    digits.forEach(digit => {
        if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit] += 1;
    });

    const total = digits.length || 1;
    return counts.reduce<Record<number, number>>((percentages, count, digit) => {
        percentages[digit] = (count / total) * 100;
        return percentages;
    }, {});
};

export const evaluateDigitStrategy = (
    strategyId: DigitStrategyId,
    percentages: Record<number, number>,
    recentDigits: number[]
) => {
    const strategy = DIGIT_STRATEGIES[strategyId];
    const barrier = Number(strategy.winBarrier);
    const qualifyingWinningDigits =
        strategyId === 'OVER_2_MARKET'
            ? [3, 4, 5, 6, 7, 8, 9]
            : [0, 1, 2, 3, 4, 5, 6];
    const qualifyingPercentage = qualifyingWinningDigits.reduce((sum, digit) => sum + (percentages[digit] ?? 0), 0);
    const trailingTriggerCount = [...recentDigits]
        .reverse()
        .findIndex(digit => (strategyId === 'OVER_2_MARKET' ? digit <= barrier : digit >= barrier));
    const normalizedTrailingCount = trailingTriggerCount === -1 ? recentDigits.length : trailingTriggerCount;
    const isQualified = qualifyingPercentage >= 55;

    return {
        alertLabel: strategy.alertLabel,
        confidence: qualifyingPercentage,
        entryLabel: strategy.entryLabel,
        entryReady: normalizedTrailingCount >= 3,
        isQualified,
        qualifyingWinningDigits,
        trailingTriggerCount: normalizedTrailingCount,
    };
};
