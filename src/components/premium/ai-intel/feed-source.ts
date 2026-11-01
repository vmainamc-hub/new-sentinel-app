// APEX INTEL market source: the app's shared all-markets feed (the one Vanguard uses), narrowed to what Apex Intel trades
// (see market-filter.ts). One socket serves both tools; if someone else reconnects it, Apex Intel's history restarts and
// the picker simply waits for enough fresh ticks again.
import { vanguardFeed } from '../vanguard/vanguard-instance';
import { filterSeries as filter, isApexMarket as isMarket } from './market-filter';

export const apexFeed = vanguardFeed;
export const isApexMarket = (symbol: string): boolean => isMarket(symbol, apexFeed);
export const filterSeries = <T,>(series: Readonly<Record<string, T>>): Record<string, T> => filter(series, apexFeed);
export const apexSeries = (): Record<string, number[]> => filterSeries(apexFeed.getLiveSeries());
export const apexSymbols = (): string[] => apexFeed.getSymbols().filter(isApexMarket);
