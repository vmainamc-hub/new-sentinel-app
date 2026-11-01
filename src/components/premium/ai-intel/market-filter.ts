// Pure market filter for Apex Intel (no feed import, so it is unit-testable).
// Volatility Indices only (R_* and 1HZ*V). A market is dropped only when Deriv's `contracts_for` said OVER or UNDER digits
// are NOT offered on it; unknown (not yet asked) stays allowed, and a refused purchase would still stop a run.
import { VOLATILITY_SYMBOL } from './discovery';

export type OfferSource = { isOffered: (symbol: string, contractType: string) => boolean | null };

export const isApexMarket = (symbol: string, feed: OfferSource): boolean =>
    VOLATILITY_SYMBOL.test(symbol) && feed.isOffered(symbol, 'DIGITOVER') !== false && feed.isOffered(symbol, 'DIGITUNDER') !== false;

export function filterSeries<T>(series: Readonly<Record<string, T>>, feed: OfferSource): Record<string, T> {
    const out: Record<string, T> = {};
    for (const k of Object.keys(series)) if (isApexMarket(k, feed)) out[k] = series[k];
    return out;
}
