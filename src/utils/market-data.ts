const SYMBOL_PIPS: Record<string, number> = {
    R_10: 3,
    R_25: 3,
    R_50: 4,
    R_75: 4,
    R_100: 2,
};

export const getMarketPipSize = (symbol: string, fallback = 2) => SYMBOL_PIPS[symbol] ?? fallback;

export const getLastDigitFromQuote = (quote: number, symbol = '', pip = getMarketPipSize(symbol)) => {
    if (!Number.isFinite(quote)) return 0;
    const fixed = Math.abs(quote).toFixed(pip);
    const digit = Number(fixed.replace('.', '').slice(-1));
    return Number.isInteger(digit) ? digit : 0;
};

export const isExpectedStreamInterruption = (error: unknown) => {
    const message =
        typeof error === 'string'
            ? error
            : error && typeof error === 'object' && 'message' in error
              ? String((error as { message?: unknown }).message ?? '')
              : '';

    return /disconnect|forget|cancel|abort|closed|timeout/i.test(message);
};
