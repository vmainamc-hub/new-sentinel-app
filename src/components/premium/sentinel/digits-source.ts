// SENTINEL AI: Digits Analysis as the signal source.
//
// Digits Analysis (pages/DigitsAnalysisPage.tsx, apex-logic.ts) ranks every market, for an Over/Under pair, by the share of the last
// 1000 ticks the better side of the pair would have won. This turns that same ranking into the Sentinel board: for each pair
// (Over 1 / Under 8, Over 2 / Under 7, Over 3 / Under 6) the #1 market's better side is a strong signal, #2 steady, #3 watch.
// The careful / balanced / active styles then decide how many ranks may trade, exactly as they do for Pulse tiers.
//
// It reads the app-wide tick feed that Sentinel already uses (no second socket). Honest limit: a past win rate does not make a
// random digit more likely, so this decides WHERE to look, it cannot create an edge.
import { candidateTrades, DIGIT_PAIRS, winPercent } from '../apex-logic';
import { type Contract, winProbability } from '../sixfold/bot';
import { type PulseRead, type PulseSnapshot, type PulseTier, PULSE_MIN_TICKS, readContract } from './pulse';

/** Digits Analysis's default "analysis ticks". */
export const DA_TICKS = 1000;

const RANK_TIER: readonly PulseTier[] = ['strong', 'steady', 'watch'];

const contractOf = (side: 'over' | 'under', barrier: number): Contract => ({
    side: side === 'over' ? 'OVER' : 'UNDER',
    param: barrier,
});

/** Same 0-100 scale Pulse uses: how far the window sits above the fair rate, in standard errors. */
const scoreOf = (rate: number, n: number, fair: number): number => {
    const z = (rate - fair) / Math.sqrt((fair * (1 - fair)) / n);
    return Math.round(Math.max(0, Math.min(100, 50 + 12 * z)) * 10) / 10;
};

/**
 * Ranks the markets for every pair and returns one read per market and contract. Only the better side of a pair on a top-3 market
 * carries a tier; everything else is a read with no signal. When only one side of a pair is switched on, the ranking uses that side.
 */
export const readDigitsAnalysis = (
    series: Readonly<Record<string, readonly number[]>>,
    symbols: readonly string[],
    contracts: readonly Contract[]
): PulseSnapshot => {
    const ready = symbols.filter(s => (series[s]?.length ?? 0) >= PULSE_MIN_TICKS);
    const on = new Set(contracts.map(c => `${c.side}:${c.param}`));
    const reads: PulseRead[] = [];

    for (const pair of DIGIT_PAIRS) {
        const trades = candidateTrades('over_under', pair).filter(t => on.has(`${t.side.toUpperCase()}:${t.barrier}`));
        if (trades.length === 0) continue;

        const ranked = ready
            .map(symbol => {
                const window = series[symbol].slice(-DA_TICKS);
                const best = trades
                    .map(trade => ({ trade, percent: winPercent(window, trade) }))
                    .sort((a, b) => b.percent - a.percent)[0];
                return { symbol, n: window.length, ...best };
            })
            .sort((a, b) => b.percent - a.percent);
        const rankOf = new Map(ranked.map((r, i) => [r.symbol, i]));

        for (const symbol of ready) {
            const rank = rankOf.get(symbol) ?? 99;
            const top = ranked[rank];
            for (const trade of trades) {
                const contract = contractOf(trade.side as 'over' | 'under', trade.barrier ?? 0);
                const base = readContract(symbol, series[symbol], contract);
                const isBest = top.trade === trade;
                const tier = isBest && rank < RANK_TIER.length ? RANK_TIER[rank] : null;
                reads.push({
                    ...base,
                    tier,
                    score: isBest ? scoreOf(top.percent / 100, top.n, winProbability(contract)) : base.score,
                });
            }
        }
    }
    return { markets: ready.length, reads };
};
