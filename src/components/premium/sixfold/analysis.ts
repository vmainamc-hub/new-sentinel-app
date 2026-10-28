// Sixfold Lab: the deeper analysis. Every function here tests whether anything beyond chance is present, and is built
// so that "nothing found" is a normal, clearly stated answer on Deriv's randomly generated digits.
import { type BotConfig, type BotRun, type Contract, DEFAULT_BOT, simulateBot, winningDigits, winProbability } from './bot';
import { outcome } from './engine';
import { applyResult, applyWriteOff, freshSession, type SixfoldSettings, stakeFor, stopReason, tradeContract } from './money';
import { bhAdjust, breakEvenRate, chiSquareSf, mulberry32, normalCdf, profitMultiple, quantile } from './stats';
import { assessRun, type ViabilityState } from './viability';

// ---------- digit uniformity ----------

export type Uniformity = {
    n: number;
    counts: number[];
    chi2: number;
    /** P(this much unevenness by chance) for fair digits. */
    p: number | null;
    /** Digit furthest from its expected count, with its z-score. */
    worst: { digit: number; z: number } | null;
};

export function uniformityTest(digits: readonly number[], window = 500): Uniformity {
    const tail = digits.slice(-window);
    const counts = Array(10).fill(0) as number[];
    tail.forEach(d => counts[d]++);
    const n = tail.length;
    if (n < 100) return { n, counts, chi2: 0, p: null, worst: null };
    const exp = n / 10;
    const chi2 = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    let worst = { digit: 0, z: 0 };
    counts.forEach((c, digit) => {
        const z = (c - exp) / Math.sqrt(n * 0.1 * 0.9);
        if (Math.abs(z) > Math.abs(worst.z)) worst = { digit, z };
    });
    return { n, counts, chi2, p: chiSquareSf(chi2, 9), worst };
}

// ---------- runs test ----------

export type RunsResult = { n: number; runs: number; z: number; p: number | null };

/** Wald-Wolfowitz runs test on a win/loss sequence: too few runs = streaky, too many = alternating. Two-sided. */
export function runsTest(bits: readonly boolean[]): RunsResult {
    const n = bits.length;
    const n1 = bits.filter(Boolean).length,
        n2 = n - n1;
    if (n < 30 || n1 === 0 || n2 === 0) return { n, runs: 0, z: 0, p: null };
    let runs = 1;
    for (let i = 1; i < n; i++) if (bits[i] !== bits[i - 1]) runs++;
    const mean = (2 * n1 * n2) / n + 1;
    const variance = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
    const z = variance > 0 ? (runs - mean) / Math.sqrt(variance) : 0;
    return { n, runs, z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Runs test on whether each tick would have won `contract`. */
export const contractRuns = (digits: readonly number[], c: Contract, window = 1000): RunsResult =>
    runsTest(digits.slice(-window).map(d => outcome(c.side, d, c.param)));

// ---------- digit -> next digit ----------

export type Transition = {
    n: number;
    counts: number[][];
    /** Standardised residual of each cell: how far the count is from independence, in sigmas. */
    z: number[][];
    chi2: number;
    df: number;
    p: number | null;
    /** The most extreme cell. */
    hottest: { from: number; to: number; z: number } | null;
};

/** Does the previous digit tell you anything about the next one? Chi-square test of independence. */
export function transitionTest(digits: readonly number[], window = 1500): Transition {
    const tail = digits.slice(-window);
    const counts = Array.from({ length: 10 }, () => Array(10).fill(0) as number[]);
    for (let i = 1; i < tail.length; i++) counts[tail[i - 1]][tail[i]]++;
    const n = Math.max(0, tail.length - 1);
    const z = Array.from({ length: 10 }, () => Array(10).fill(0) as number[]);
    if (n < 300) return { n, counts, z, chi2: 0, df: 81, p: null, hottest: null };
    const rows = counts.map(r => r.reduce((a, b) => a + b, 0));
    const cols = Array.from({ length: 10 }, (_, j) => counts.reduce((a, r) => a + r[j], 0));
    let chi2 = 0;
    let hottest: Transition['hottest'] = null;
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 10; j++) {
            const e = (rows[i] * cols[j]) / n;
            if (e <= 0) continue;
            chi2 += (counts[i][j] - e) ** 2 / e;
            z[i][j] = (counts[i][j] - e) / Math.sqrt(e);
            if (!hottest || Math.abs(z[i][j]) > Math.abs(hottest.z)) hottest = { from: i, to: j, z: z[i][j] };
        }
    }
    return { n, counts, z, chi2, df: 81, p: chiSquareSf(chi2, 81), hottest };
}

// ---------- market-level structure table (with false-discovery control) ----------

export type StructureRow = {
    symbol: string;
    uniformity: Uniformity;
    transition: Transition;
    uniformityQ: number | null;
    transitionQ: number | null;
};

export function structureTable(series: Record<string, readonly number[]>, symbols: readonly string[]): StructureRow[] {
    const rows = symbols.map(symbol => ({
        symbol,
        uniformity: uniformityTest(series[symbol] ?? []),
        transition: transitionTest(series[symbol] ?? []),
    }));
    const qu = bhAdjust(rows.map(r => r.uniformity.p));
    const qt = bhAdjust(rows.map(r => r.transition.p));
    return rows.map((r, i) => ({ ...r, uniformityQ: qu[i], transitionQ: qt[i] }));
}

// ---------- calibration: do Sixfold's own labels mean anything? ----------

export type CalibrationRow = {
    state: ViabilityState;
    /** How many checkpoints carried this label. */
    checkpoints: number;
    /** Simulated trades taken in the horizon after those checkpoints. */
    trades: number;
    wins: number;
    rate: number | null;
    normal: number;
    breakEven: number;
    /** Rate minus the contract's normal win rate, in points. Near zero means the label carried no information. */
    liftPts: number | null;
};

/**
 * Walks through the history. At each checkpoint it labels the contract using ONLY trades settled by then, then records
 * how the trades in the following `horizon` ticks went. If "VIABLE" is informative, its forward win rate should sit
 * above the contract's normal rate. On random digits it does not.
 */
export function calibrateLabels(
    digits: readonly number[],
    contract: Contract,
    bot: BotConfig = DEFAULT_BOT,
    horizon = 150,
    step = 25,
    warmup = 300
): CalibrationRow[] {
    const full = simulateBot(digits, contract, bot);
    const normal = winProbability(contract),
        be = breakEvenRate(normal, bot.margin);
    const agg = new Map<ViabilityState, { cp: number; trades: number; wins: number }>();
    let upto = 0;
    for (let t = warmup; t + horizon < digits.length; t += step) {
        while (upto < full.trades.length && full.trades[upto].exitIndex <= t) upto++;
        const prefix: BotRun = { ...full, n: t + 1, trades: full.trades.slice(0, upto), open: null };
        const state = assessRun(prefix).state;
        const fwd = full.trades.filter(x => x.entryIndex > t && x.exitIndex <= t + horizon);
        const a = agg.get(state) ?? { cp: 0, trades: 0, wins: 0 };
        a.cp++;
        a.trades += fwd.length;
        a.wins += fwd.filter(x => x.won).length;
        agg.set(state, a);
    }
    return [...agg.entries()]
        .map(([state, a]) => {
            const rate = a.trades ? a.wins / a.trades : null;
            return {
                state,
                checkpoints: a.cp,
                trades: a.trades,
                wins: a.wins,
                rate,
                normal,
                breakEven: be,
                liftPts: rate === null ? null : (rate - normal) * 100,
            };
        })
        .sort((x, y) => y.trades - x.trades);
}

// ---------- bankroll Monte Carlo ----------

export type BankrollResult = {
    runs: number;
    /** Share of sessions that ended by hitting take profit / stop loss / the consecutive-loss limit / the trade cap. */
    hitTakeProfit: number;
    hitStopLoss: number;
    hitLossStreak: number;
    hitTradeCap: number;
    /** Largest stake placed in any session (5th-95th percentile band not needed: median and worst). */
    medianPnl: number;
    p5Pnl: number;
    p95Pnl: number;
    meanPnl: number;
    medianTrades: number;
    medianDrawdown: number;
    worstStake: number;
    /** Expected profit per unit staked on ONE trade of the base contract. Negative = the payout margin at work. */
    evPerUnit: number;
};

/**
 * Simulates `runs` sessions of the runner's own money rules (stake, martingale, recovery barrier, stops) on fair random
 * digits. Uses true win probabilities and the estimated payout, so it shows what the MONEY MANAGEMENT does to the
 * outcomes, independent of any pattern claim.
 */
export function bankrollSim(
    contract: Contract,
    settings: SixfoldSettings,
    runs = 1000,
    maxTicks = 3000,
    seed = 17
): BankrollResult {
    const rand = mulberry32(seed);
    const pnls: number[] = [],
        trades: number[] = [],
        dds: number[] = [];
    let tp = 0,
        sl = 0,
        streak = 0,
        cap = 0,
        worstStake = 0;
    const evBase = (() => {
        const p = winProbability(contract);
        const win = profitMultiple(p, settings.margin);
        return p * win - (1 - p);
    })();
    for (let r = 0; r < runs; r++) {
        let s = freshSession(settings);
        let ended: 'tp' | 'sl' | 'streak' | 'cap' | null = null;
        for (let i = 0; i < maxTicks && !ended; i++) {
            const t = tradeContract(contract, s.consecutiveLosses, settings);
            const p = winProbability(t.contract);
            const sized = stakeFor(s, t.contract, settings);
            if (sized.writeOff) s = applyWriteOff(s, settings);
            const stake = sized.stake;
            worstStake = Math.max(worstStake, stake);
            const won = rand() < p;
            const profit = won ? stake * profitMultiple(p, settings.margin) : -stake;
            s = applyResult(s, Math.round(profit * 100) / 100, settings);
            const why = stopReason(s, settings);
            if (why) {
                ended = /Take profit/.test(why) ? 'tp' : /Stop loss/.test(why) ? 'sl' : /consecutive/.test(why) ? 'streak' : 'cap';
            }
        }
        if (ended === 'tp') tp++;
        else if (ended === 'sl') sl++;
        else if (ended === 'streak') streak++;
        else cap++;
        pnls.push(s.pnl);
        trades.push(s.trades);
        dds.push(s.maxDrawdown);
    }
    return {
        runs,
        hitTakeProfit: tp / runs,
        hitStopLoss: sl / runs,
        hitLossStreak: streak / runs,
        hitTradeCap: cap / runs,
        medianPnl: quantile(pnls, 0.5),
        p5Pnl: quantile(pnls, 0.05),
        p95Pnl: quantile(pnls, 0.95),
        meanPnl: pnls.reduce((a, b) => a + b, 0) / runs,
        medianTrades: quantile(trades, 0.5),
        medianDrawdown: quantile(dds, 0.5),
        worstStake,
        evPerUnit: evBase,
    };
}

// ---------- small series helpers for the charts ----------

/** Rolling win rate over the last `window` outcomes (null until the window has at least `min` outcomes). */
export function rollingRate(wins: readonly boolean[], window = 30, min = 10): Array<number | null> {
    const out: Array<number | null> = [];
    let sum = 0;
    for (let i = 0; i < wins.length; i++) {
        sum += wins[i] ? 1 : 0;
        if (i >= window) sum -= wins[i - window] ? 1 : 0;
        const n = Math.min(i + 1, window);
        out.push(n >= min ? sum / n : null);
    }
    return out;
}

// ---------- does waiting for a run of wins / losses change the next result? ----------

export type EntryTestRow = { n: number; wins: number; rate: number | null; edgePts: number | null; p: number | null };
export type EntryTestResult = {
    k: number;
    markets: number;
    baseline: EntryTestRow;
    afterWins: EntryTestRow;
    afterLosses: EntryTestRow;
};

/**
 * Pools every market's ticks and compares the win rate of `contract` on the next trade with the win rate after `k` wins
 * in a row and after `k` losses in a row (each tick judged as if a contract had been bought on it). Two-sided z-test of
 * each against the baseline. If a run-based entry mattered, one of the rows would sit clearly away from the baseline.
 */
export function entryTest(series: Record<string, readonly number[]>, contract: Contract, k: number, duration = 1): EntryTestResult {
    const win = new Set(winningDigits(contract));
    const len = Math.max(1, Math.min(10, Math.trunc(duration) || 1));
    const acc = { all: [0, 0], w: [0, 0], l: [0, 0] };
    let markets = 0;
    for (const digits of Object.values(series)) {
        if (digits.length < 100) continue;
        markets += 1;
        let runW = 0;
        let runL = 0;
        for (let i = 0; i + len < digits.length; i++) {
            const here = win.has(digits[i]);
            runW = here ? runW + 1 : 0;
            runL = here ? 0 : runL + 1;
            const next = win.has(digits[i + len]) ? 1 : 0;
            acc.all[0] += 1;
            acc.all[1] += next;
            if (runW >= k) {
                acc.w[0] += 1;
                acc.w[1] += next;
            }
            if (runL >= k) {
                acc.l[0] += 1;
                acc.l[1] += next;
            }
        }
    }
    const p0 = acc.all[0] ? acc.all[1] / acc.all[0] : winProbability(contract);
    const row = (a: number[]): EntryTestRow => {
        const [n, wins] = a;
        if (!n) return { n: 0, wins: 0, rate: null, edgePts: null, p: null };
        const rate = wins / n;
        const se = Math.sqrt((p0 * (1 - p0)) / n);
        const z = se > 0 ? (rate - p0) / se : 0;
        return { n, wins, rate, edgePts: (rate - p0) * 100, p: n >= 30 ? 2 * (1 - normalCdf(Math.abs(z))) : null };
    };
    return { k, markets, baseline: row(acc.all), afterWins: row(acc.w), afterLosses: row(acc.l) };
}
