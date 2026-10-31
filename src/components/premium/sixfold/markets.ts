// Market lists. Sixfold keeps the ten Volatility indices it has always tracked; Vanguard (its own tool) tracks all of them plus the
// extra Volatility indices and the Jump indices.
//
// Not every market offers every digit contract. Deriv documents that each symbol supports only certain trade types, so the feed asks
// Deriv what each market offers (`contracts_for`) and the scanner only treats a contract as executable where it is offered. A market
// Deriv does not know at all is simply left out; nothing here is assumed to be tradable.
type MarketList = ReadonlyArray<readonly [string, string]>;

/** The ten markets Sixfold tracks. */
export const SIXFOLD_MARKETS: MarketList = [
    ['1HZ10V', 'Volatility 10 (1s)'],
    ['1HZ25V', 'Volatility 25 (1s)'],
    ['1HZ50V', 'Volatility 50 (1s)'],
    ['1HZ75V', 'Volatility 75 (1s)'],
    ['1HZ100V', 'Volatility 100 (1s)'],
    ['R_10', 'Volatility 10'],
    ['R_25', 'Volatility 25'],
    ['R_50', 'Volatility 50'],
    ['R_75', 'Volatility 75'],
    ['R_100', 'Volatility 100'],
];

/** Every market Vanguard scans: the ten above, the other Volatility indices, and the Jump indices. */
export const ALL_MARKETS: MarketList = [
    ['1HZ10V', 'Volatility 10 (1s)'],
    ['1HZ15V', 'Volatility 15 (1s)'],
    ['1HZ25V', 'Volatility 25 (1s)'],
    ['1HZ30V', 'Volatility 30 (1s)'],
    ['1HZ50V', 'Volatility 50 (1s)'],
    ['1HZ75V', 'Volatility 75 (1s)'],
    ['1HZ90V', 'Volatility 90 (1s)'],
    ['1HZ100V', 'Volatility 100 (1s)'],
    ['1HZ150V', 'Volatility 150 (1s)'],
    ['1HZ250V', 'Volatility 250 (1s)'],
    ['R_10', 'Volatility 10'],
    ['R_25', 'Volatility 25'],
    ['R_50', 'Volatility 50'],
    ['R_75', 'Volatility 75'],
    ['R_100', 'Volatility 100'],
    ['JD10', 'Jump 10'],
    ['JD25', 'Jump 25'],
    ['JD50', 'Jump 50'],
    ['JD75', 'Jump 75'],
    ['JD100', 'Jump 100'],
];

export const SIXFOLD_SYMBOLS: string[] = SIXFOLD_MARKETS.map(m => m[0]);
export const ALL_SYMBOLS: string[] = ALL_MARKETS.map(m => m[0]);
