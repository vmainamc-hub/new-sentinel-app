// The app-wide feed of ALL the markets (the ten Volatility indices Sixfold always tracked, the other Volatility indices and the Jump
// indices) on one socket. The fused Sixfold and Apex Intel read it; Sentinel AI keeps `sixfoldFeed` (ten markets).
import { SixfoldFeed } from './feed';
import { ALL_SYMBOLS } from './markets';

export const allMarketsFeed = new SixfoldFeed(undefined, undefined, ALL_SYMBOLS);
