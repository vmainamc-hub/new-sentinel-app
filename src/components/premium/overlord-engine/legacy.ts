// OVERLORD LEGACY CONDITION. This is the scanning condition Overlord has always used for Over / Under, kept exactly:
// over the last 50 ticks of a market, what share of last digits would have won the selected contract. Find Market used to
// pick the market where that share was LOWEST. It stays in the harmonised engine as its own layer, and it is the
// fallback when a market does not have enough history for the deeper engines.
export type OuSide = 'OVER' | 'UNDER';

/** Ticks Overlord's original scan looked at. */
export const LEGACY_WINDOW = 50;

/** Decimal places Overlord has always assumed per market. Used only when Deriv does not send pip_size. */
export const fallbackDecimals = (symbol: string): number =>
    symbol.startsWith('1HZ') || symbol === 'R_100' ? 2 : symbol === 'R_75' || symbol === 'R_50' ? 4 : 3;

/** Last digit of a price at the market's own precision. */
export const lastDigit = (price: number, decimals: number): number => {
    const fixed = Number(price).toFixed(decimals);
    const d = parseInt(fixed.slice(-1), 10);
    return Number.isFinite(d) ? d : 0;
};

/** Share (0-100) of the last 50 digits that would have won the contract; null when there are no digits. */
export const legacyPercentage = (digits: readonly number[], side: OuSide, barrier: number): number | null => {
    const window = digits.slice(-LEGACY_WINDOW);
    if (window.length === 0) return null;
    const hits = window.filter(d => (side === 'OVER' ? d > barrier : d < barrier)).length;
    return (hits / window.length) * 100;
};

/** Win probability of a fair market for the contract. */
export const fairShare = (side: OuSide, barrier: number): number => (side === 'OVER' ? 9 - barrier : barrier) / 10;
