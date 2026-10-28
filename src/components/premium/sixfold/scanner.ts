// Sixfold scanner: scores every contract on every market, controls for the fact that scanning hundreds of cells always
// turns up some that look good by luck, and decides which cells are eligible to be traded.
//
// Honest framing: Deriv digits are generated randomly, so a contract that has run hot is no more likely to keep doing
// so. The score ranks how HEALTHY a contract has recently been for a DBot-style trader; the significance flag says
// whether that health is distinguishable from the luck expected when scanning this many cells. Neither is a forecast.
import {
    type BotConfig,
    type BotRun,
    type Contract,
    contractKey,
    contractLabel,
    OVER_LADDER,
    simulateBot,
    UNDER_LADDER,
    winProbability,
} from './bot';
import { entryDigitsFor } from './bot';
import { isExecutable, type Selectivity } from './money';
import { bhAdjust, binomialUpperP, breakEvenRate, clamp } from './stats';
import { type Assessment, assessRun } from './viability';

export const SCAN_CONTRACTS: Contract[] = [
    ...OVER_LADDER,
    ...UNDER_LADDER,
    { side: 'EVEN', param: 0 },
    { side: 'ODD', param: 0 },
];

/** False-discovery rate used for the "significant" flag. */
export const FDR_Q = 0.1;
/** A cell needs at least this many simulated trades in its window to be tested at all. */
export const MIN_TESTED_TRADES = 20;

export type Cell = {
    symbol: string;
    contract: Contract;
    key: string;
    label: string;
    assessment: Assessment;
    /** Trades in the scoring window (last 50, or all when fewer than 20 of those exist). */
    windowTrades: number;
    windowWins: number;
    windowRate: number | null;
    /** Win rate in the window minus break-even, in percentage points. */
    edgePts: number | null;
    /** Distance of the window rate above break-even, in standard errors. */
    zEdge: number | null;
    /** One-sided p: chance of a window at least this good if the digits were purely random. */
    pValue: number | null;
    /** Benjamini-Hochberg adjusted p across every tested cell of the scan. */
    qValue: number | null;
    /** Above break-even AND still unlikely after adjusting for the number of cells scanned. */
    significant: boolean;
    /** 0-100 health score. */
    score: number;
    executable: boolean;
};

export type ScanSummary = {
    cells: number;
    tested: number;
    viable: number;
    significant: number;
    /** Cells with p < 0.05 and how many chance alone predicts among the tested ones. */
    hotAtFivePct: number;
    expectedByChance: number;
};

export type ScanResult = {
    at: number;
    cells: Cell[];
    bySymbol: Record<string, Cell[]>;
    summary: ScanSummary;
};

export function scoreCell(a: Assessment): { score: number; zEdge: number | null } {
    const w = a.last50.n >= MIN_TESTED_TRADES ? a.last50 : a.all;
    if (w.rate === null || w.n === 0) return { score: 0, zEdge: null };
    const be = a.breakEven;
    const se = Math.sqrt((be * (1 - be)) / w.n);
    const zEdge = (w.rate - be) / se;
    const s1 = clamp((zEdge + 1) / 3); // -1 sigma -> 0, +2 sigma -> 1
    // Short and long window agree: compare the win RATES (z-scores grow with sample size, so they would unfairly penalise
    // a contract merely for having a lower normal win rate). A 25-point gap counts as fully disagreeing.
    const s2 = a.last20.rate === null || a.last50.rate === null ? 0.5 : 1 - clamp(Math.abs(a.last20.rate - a.last50.rate) / 0.25);
    const s3 = clamp(w.n / 50); // sample depth
    const s4 = a.state === 'TRAP' || a.state === 'HOSTILE' ? 0 : a.state === 'VIABLE' ? 1 : 0.6;
    return { score: Math.round(100 * (0.55 * s1 + 0.2 * s2 + 0.1 * s3 + 0.15 * s4)), zEdge };
}

export function scanMarkets(
    series: Record<string, readonly number[]>,
    symbols: readonly string[],
    bot: BotConfig,
    now = Date.now(),
    contracts: readonly Contract[] = SCAN_CONTRACTS
): ScanResult {
    const raw: Array<Omit<Cell, 'qValue' | 'significant'>> = [];
    for (const symbol of symbols) {
        const digits = series[symbol] ?? [];
        for (const contract of contracts) {
            const run = digits.length ? simulateBot(digits, contract, bot) : emptyRun(contract, bot);
            const assessment = assessRun(run);
            const w = assessment.last50.n >= MIN_TESTED_TRADES ? assessment.last50 : assessment.all;
            const { score, zEdge } = scoreCell(assessment);
            const tested = w.n >= MIN_TESTED_TRADES;
            raw.push({
                symbol,
                contract,
                key: contractKey(contract),
                label: contractLabel(contract),
                assessment,
                windowTrades: w.n,
                windowWins: w.wins,
                windowRate: w.rate,
                edgePts: w.rate === null ? null : (w.rate - assessment.breakEven) * 100,
                zEdge,
                pValue: tested ? binomialUpperP(w.wins, w.n, winProbability(contract)) : null,
                score,
                executable: isExecutable(contract),
            });
        }
    }
    const q = bhAdjust(raw.map(c => c.pValue));
    const cells: Cell[] = raw.map((c, i) => ({
        ...c,
        qValue: q[i],
        significant: q[i] !== null && q[i]! <= FDR_Q && (c.edgePts ?? -1) > 0,
    }));
    const bySymbol: Record<string, Cell[]> = {};
    for (const c of cells) (bySymbol[c.symbol] ??= []).push(c);
    const tested = cells.filter(c => c.pValue !== null);
    return {
        at: now,
        cells,
        bySymbol,
        summary: {
            cells: cells.length,
            tested: tested.length,
            viable: cells.filter(c => c.assessment.state === 'VIABLE').length,
            significant: cells.filter(c => c.significant).length,
            hotAtFivePct: tested.filter(c => c.pValue! < 0.05).length,
            expectedByChance: Math.round(tested.length * 0.05 * 10) / 10,
        },
    };
}

const emptyRun = (contract: Contract, config: BotConfig): BotRun => ({
    contract,
    config,
    n: 0,
    trades: [],
    open: null,
    ticksSinceTrade: null,
});

export type Eligibility = { ok: boolean; reason: string };

/** Which cells the runner may trade at each selectivity. Everything also has to be executable on Deriv. */
export function eligibility(cell: Cell, selectivity: Selectivity, bump = 0): Eligibility {
    const need = (base: number) => Math.min(95, base + Math.max(0, bump));
    const a = cell.assessment;
    if (!cell.executable) return { ok: false, reason: 'Sixfold cannot execute this contract type' };
    if (a.state === 'WARMING') return { ok: false, reason: 'Too few simulated trades yet' };
    if (a.state === 'TRAP') return { ok: false, reason: 'Trap: it looked good, then delivered the opposite' };
    if (a.state === 'HOSTILE') return { ok: false, reason: 'Hostile: running well below its normal rate' };
    if (selectivity === 'strict') {
        if (!cell.significant) return { ok: false, reason: 'Not significant after adjusting for scanned cells' };
        return cell.score >= need(70)
            ? { ok: true, reason: 'Significant and healthy' }
            : { ok: false, reason: `Score below ${need(70)}${bump > 0 ? ' (stricter after a loss)' : ''}` };
    }
    if (selectivity === 'balanced') {
        if (a.state !== 'VIABLE') return { ok: false, reason: `State is ${a.state.toLowerCase()}, not viable` };
        return cell.score >= need(62)
            ? { ok: true, reason: 'Viable and healthy' }
            : { ok: false, reason: `Score below ${need(62)}${bump > 0 ? ' (stricter after a loss)' : ''}` };
    }
    if ((cell.edgePts ?? -99) < -1) return { ok: false, reason: 'More than a point under break-even' };
    return cell.score >= need(50)
        ? { ok: true, reason: 'Best available' }
        : { ok: false, reason: `Score below ${need(50)}${bump > 0 ? ' (stricter after a loss)' : ''}` };
}

export type Pick = { cell: Cell; why: string; entryDigits: number[] };

/** Highest-scoring eligible cell, skipping markets / contracts the caller has taken out. */
export function pickBest(
    scan: ScanResult,
    selectivity: Selectivity,
    entry: { mode: 'SETUP' | 'ANY' },
    skip: { symbols?: ReadonlySet<string>; keys?: ReadonlySet<string> } = {},
    bump = 0
): Pick | null {
    let best: Pick | null = null;
    for (const cell of scan.cells) {
        if (skip.symbols?.has(cell.symbol) || skip.keys?.has(`${cell.symbol}|${cell.key}`)) continue;
        const e = eligibility(cell, selectivity, bump);
        if (!e.ok) continue;
        const better =
            !best ||
            cell.score > best.cell.score ||
            (cell.score === best.cell.score && (cell.edgePts ?? -99) > (best.cell.edgePts ?? -99));
        if (better) {
            best = {
                cell,
                why: e.reason,
                entryDigits: entry.mode === 'ANY' ? [] : [...entryDigitsFor(cell.contract, { mode: 'SETUP' })],
            };
        }
    }
    return best;
}

/** Best cell per market (any contract), for the radar and the board ordering. */
export function bestPerMarket(scan: ScanResult, symbols: readonly string[]): Record<string, Cell | undefined> {
    const out: Record<string, Cell | undefined> = {};
    for (const s of symbols) {
        out[s] = (scan.bySymbol[s] ?? []).filter(c => c.executable).sort((a, b) => b.score - a.score)[0];
    }
    return out;
}
