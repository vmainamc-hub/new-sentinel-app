// Does "trade the opposite of the trapped crowd" actually beat the normal rate on THIS history?
//
// The bot trades the complement of the trapped archetype's contract, but only on ticks where that archetype is TRAPPED
// (decided from past ticks only). Its win rate is compared with the contract's normal rate and the payout break-even,
// with a Wilson interval, a chronological split, and a permutation p-value (digits shuffled = the "no pattern" world).
// On random digits the honest answer is usually NO EDGE; this module exists to say so plainly when that is the case.

import { type BotConfig, type Contract, contractLabel, DEFAULT_BOT, simulateBot, winProbability } from './bot';
import { type CrowdConfig, DEFAULT_CROWD, trapSeries } from './crowd';
import type { ContractSide } from './engine';
import { breakEvenRate, mulberry32, shuffled, wilson, zScore } from './stats';

export type EdgeVerdict = 'TOO_FEW' | 'NO_EDGE' | 'LEANS_EDGE' | 'EDGE';

export type EdgeResult = {
    archetype: ContractSide;
    trade: Contract;
    trades: number;
    wins: number;
    rate: number | null;
    ci: { lo: number; hi: number };
    baseline: number;
    breakEven: number;
    z: number;
    pValue: number | null;
    halves: [number | null, number | null];
    verdict: EdgeVerdict;
    summary: string;
};

export const MIN_EDGE_TRADES = 30;

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

export function edgeTest(
    digits: readonly number[],
    archetype: ContractSide,
    cfg: CrowdConfig = DEFAULT_CROWD,
    bot: BotConfig = DEFAULT_BOT,
    permutations = 200,
    seed = 7
): EdgeResult {
    const s = trapSeries(digits, archetype, cfg);
    const trade = s.opposite;
    const baseline = winProbability(trade),
        be = breakEvenRate(baseline, bot.margin);
    const run = (d: readonly number[], trig: Uint8Array) => simulateBot(d, trade, bot, { gate: i => trig[i] === 1 });
    const r = run(digits, s.trigger);
    const wins = r.trades.filter(t => t.won).length,
        n = r.trades.length;
    const rate = n ? wins / n : null;
    const z = zScore(wins, n, baseline);
    const mid = Math.floor(digits.length / 2);
    const half = (lo: boolean) => {
        const ts = r.trades.filter(t => t.entryIndex < mid === lo);
        return ts.length >= 10 ? ts.filter(t => t.won).length / ts.length : null;
    };
    const halves: [number | null, number | null] = [half(true), half(false)];

    let pValue: number | null = null;
    if (n >= MIN_EDGE_TRADES) {
        const rand = mulberry32(seed);
        let ge = 0;
        for (let k = 0; k < permutations; k++) {
            const sh = shuffled(digits, rand);
            const ps = trapSeries(sh, archetype, cfg);
            const pr = run(sh, ps.trigger);
            const pn = pr.trades.length;
            if (pn && zScore(pr.trades.filter(t => t.won).length, pn, baseline) >= z) ge++;
        }
        pValue = (ge + 1) / (permutations + 1);
    }

    const ci = wilson(wins, n);
    let verdict: EdgeVerdict;
    if (n < MIN_EDGE_TRADES || pValue === null) verdict = 'TOO_FEW';
    else if (ci.lo > be && pValue < 0.01 && halves.every(h => h !== null && h > be)) verdict = 'EDGE';
    else if ((rate ?? 0) > be && pValue < 0.1) verdict = 'LEANS_EDGE';
    else verdict = 'NO_EDGE';

    const lab = contractLabel(trade);
    const summary =
        verdict === 'TOO_FEW'
            ? `Only ${n} trapped-crowd trades in this history (need ${MIN_EDGE_TRADES}); no verdict yet.`
            : `Trading ${lab} when the ${archetype.toLowerCase()} crowd was trapped: ${wins}/${n} won (${pct(rate)}, 95% range ${pct(ci.lo)}–${pct(ci.hi)}) vs normal ${pct(baseline)} and break-even ${pct(be)}. ` +
              (verdict === 'NO_EDGE'
                  ? 'That is what chance alone produces: no edge shown.'
                  : verdict === 'LEANS_EDGE'
                    ? 'Above break-even and unlikely by chance, but not yet confirmed in both halves. Treat as a lead, not a result.'
                    : 'Above break-even, unlikely by chance, and holds in both halves of the history.');
    return {
        archetype,
        trade,
        trades: n,
        wins,
        rate,
        ci,
        baseline,
        breakEven: be,
        z,
        pValue,
        halves,
        verdict,
        summary,
    };
}
