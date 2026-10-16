// Everything about one contract on one market, in one object.
import {
    type BotConfig,
    type BotRun,
    complementOf,
    type Contract,
    contractKey,
    contractLabel,
    DEFAULT_BOT,
    OVER_LADDER,
    simulateBot,
    streaks,
    UNDER_LADDER,
    winProbability,
} from './bot';
import { type CrowdConfig, type CrowdMap, crowdMap, DEFAULT_CROWD } from './crowd';
import { type EdgeResult, edgeTest } from './edge';
import { breakEvenRate } from './stats';
import { type Assessment, assessRun } from './viability';

export type LadderRow = {
    contract: Contract;
    key: string;
    label: string;
    assessment: Assessment;
    score: number | null;
};

/** Score = last-50 win rate minus break-even in points (falls back to all trades). Higher = healthier recently. */
export function ladder(digits: readonly number[], side: 'OVER' | 'UNDER', bot: BotConfig = DEFAULT_BOT): LadderRow[] {
    return (side === 'OVER' ? OVER_LADDER : UNDER_LADDER).map(contract => {
        const assessment = assessRun(simulateBot(digits, contract, bot));
        const w = assessment.last50.n >= 20 ? assessment.last50 : assessment.all;
        return {
            contract,
            key: contractKey(contract),
            label: contractLabel(contract),
            assessment,
            score: w.rate === null ? null : (w.rate - assessment.breakEven) * 100,
        };
    });
}

export type Dossier = {
    contract: Contract;
    label: string;
    opposite: Contract;
    run: BotRun;
    assessment: Assessment;
    last20: { won: boolean; entryDigit: number; exitDigit: number }[];
    streak: ReturnType<typeof streaks>;
    digitShare: number[]; // share of each digit over the last 100 ticks
    ladder: LadderRow[] | null;
    bestRung: LadderRow | null;
    crowd: CrowdMap;
    crowdConfig: CrowdConfig;
    edge: EdgeResult | null;
    edgeFor: string | null;
    verdict: string;
};

export function buildDossier(
    digits: readonly number[],
    contract: Contract,
    bot: BotConfig = DEFAULT_BOT,
    crowdCfg: CrowdConfig = DEFAULT_CROWD,
    permutations = 150
): Dossier {
    const run = simulateBot(digits, contract, bot);
    const assessment = assessRun(run);
    const cfg: CrowdConfig = { ...crowdCfg };
    if (contract.side === 'OVER') cfg.overBarrier = contract.param;
    if (contract.side === 'UNDER') cfg.underBarrier = contract.param;
    const crowd = crowdMap(digits, cfg);
    const tail = digits.slice(-100),
        digitShare = Array(10).fill(0) as number[];
    tail.forEach(d => digitShare[d]++);
    const lad = contract.side === 'OVER' || contract.side === 'UNDER' ? ladder(digits, contract.side, bot) : null;
    const here = lad?.find(r => r.key === contractKey(contract)) ?? null;
    const ranked =
        lad?.filter(r => r.score !== null && r.assessment.trades >= 20).sort((a, b) => b.score! - a.score!) ?? [];
    const bestRung =
        ranked[0] && ranked[0].key !== here?.key && (here?.score ?? -99) + 1 < ranked[0].score! ? ranked[0] : null;

    // Edge test for the crowd side that matches this contract's own family, or the lead trapped crowd.
    const target = crowd.trapped.find(p => p.opposite.side === contract.side) ?? crowd.trapped[0] ?? null;
    const edge = target ? edgeTest(digits, target.archetype, cfg, bot, permutations) : null;

    const lab = contractLabel(contract);
    const parts = [`${lab}: ${assessment.state}.`];
    if (bestRung) parts.push(`${bestRung.label} has been healthier recently.`);
    parts.push(crowd.headline);
    parts.push(edge ? edge.summary : 'No trapped crowd right now, so there is no opposite-side setup to test.');
    return {
        contract,
        label: lab,
        opposite: complementOf(contract),
        run,
        assessment,
        last20: run.trades.slice(-20).map(t => ({ won: t.won, entryDigit: t.entryDigit, exitDigit: t.exitDigit })),
        streak: streaks(run.trades),
        digitShare,
        ladder: lad,
        bestRung,
        crowd,
        crowdConfig: cfg,
        edge,
        edgeFor: target?.archetype ?? null,
        verdict: parts.join(' '),
    };
}

export { breakEvenRate, winProbability };
