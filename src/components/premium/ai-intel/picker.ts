// APEX INTEL market picker: from the live ticks of every market, choose which market, direction and entry to trade next.
// Pure and deterministic (no I/O, no AI call per tick). It measures each candidate with the Sixfold-compatible simulator
// on the ticks already seen and ranks them by the LOWER bound of the win-rate interval, so a lucky small sample cannot win.
//
// Two honesty modes:
//   evidenceOnly = true : only candidates that beat chance after false-discovery control (and have enough trades) qualify.
//                         On fair random digits that usually means "no pick", and the runner waits.
//   evidenceOnly = false: the best-ranked fresh, non-unstable candidate is picked even without proven edge. It is a
//                         ranking by past behaviour, not a promise: digits are random and a pick can lose.
import { bhAdjust } from '@/components/premium/sixfold/stats';
import { classifyRegime, entryStats, FDR_Q, MIN_TICKS_FOR_REGIME, MIN_TRADES, type Regime } from './analysis';
import { type Contract } from '@/components/premium/sixfold/bot';
import { compileRule, type RuleSpec } from './rules';
import { OVER_2, simulate, tally, ticksFromDigits, UNDER_7 } from './sim';

export type RecoveryDirection = 'OVER_3' | 'UNDER_6';
export const OVER_3: Contract = { side: 'OVER', param: 3 };
export const UNDER_6: Contract = { side: 'UNDER', param: 6 };
export const recoveryContract = (d: RecoveryDirection): Contract => (d === 'UNDER_6' ? UNDER_6 : OVER_3);

export type PickDirection = 'OVER_2' | 'UNDER_7';
export type PickEntry = 'SETUP' | 'ANY' | 'CUSTOM' | 'SMART';

export type Candidate = {
    direction: PickDirection;
    entry: PickEntry;
    /** CUSTOM only. */
    digits?: readonly number[];
    /** SMART only: a generated rule from the strategy registry. */
    rule?: RuleSpec;
    /** Contract length the strategy was validated for; skipped when the run uses another. */
    duration?: number;
    /** Set when the candidate comes from an approved strategy in the registry. */
    strategyId?: string;
    strategyLabel?: string;
    /** Markets the candidate applies to (default: all). */
    markets?: readonly string[];
};

/** Baseline candidates when no strategy is supplied: both directions, SETUP and ANY entries. */
export const BASELINE_CANDIDATES: Candidate[] = (['OVER_2', 'UNDER_7'] as const).flatMap(direction => [
    { direction, entry: 'SETUP' as const },
    { direction, entry: 'ANY' as const },
]);

export type PickOptions = {
    duration: number;
    evidenceOnly: boolean;
    directions: 'BOTH' | PickDirection;
    candidates?: readonly Candidate[];
    /** Only these entry kinds (default: all). */
    entries?: readonly PickEntry[];
    minTicks?: number;
    freshMs?: number;
};

export type Pick = {
    key: string;
    market: string;
    direction: PickDirection;
    entry: PickEntry;
    customDigits: number[];
    rule: RuleSpec | null;
    strategyId: string | null;
    label: string;
    /** Lower bound of the 95% win-rate interval minus the contract's chance level (fraction, may be negative). */
    score: number;
    trades: number;
    rate: number | null;
    significant: boolean;
    q: number | null;
    regime: Regime;
    reason: string;
};

export const contractOf = (d: PickDirection): Contract => (d === 'UNDER_7' ? UNDER_7 : OVER_2);
export const pickKey = (market: string, direction: PickDirection, entry: PickEntry, strategyId: string | null, digits: readonly number[] = []) =>
    `${market}|${direction}|${entry}|${strategyId ?? ''}|${digits.join('')}`;

/** Every eligible candidate, best first. Empty when nothing qualifies. */
export function rankPicks(
    series: Readonly<Record<string, readonly number[]>>,
    lastTickAt: (market: string) => number | null,
    now: number,
    opts: PickOptions
): Pick[] {
    const minTicks = opts.minTicks ?? MIN_TICKS_FOR_REGIME;
    const freshMs = opts.freshMs ?? 5000;
    const candidates = opts.candidates?.length ? opts.candidates : BASELINE_CANDIDATES;
    type Row = { pick: Pick; p: number | null };
    const rows: Row[] = [];
    for (const market of Object.keys(series)) {
        const digits = series[market];
        const at = lastTickAt(market);
        if (digits.length < minTicks || at === null || now - at > freshMs) continue;
        for (const cand of candidates) {
            if (opts.directions !== 'BOTH' && cand.direction !== opts.directions) continue;
            if (opts.entries && !opts.entries.includes(cand.entry)) continue;
            if (cand.markets && !cand.markets.includes(market)) continue;
            if (cand.duration !== undefined && cand.duration !== opts.duration) continue;
            if (cand.entry === 'SMART' && !cand.rule) continue;
            const contract = contractOf(cand.direction);
            const regime = classifyRegime(digits, contract).regime;
            if (regime === 'UNSTABLE' || regime === 'INSUFFICIENT_DATA') continue;
            const custom = cand.entry === 'CUSTOM' ? [...(cand.digits ?? [])] : [];
            if (cand.entry === 'CUSTOM' && custom.length === 0) continue;
            let trades: number;
            let wins: number;
            let lo: number | null;
            let pValue: number | null;
            let baseline: number;
            if (cand.entry === 'SMART') {
                const sim = simulate(ticksFromDigits(digits), contract, { method: 'SMART', trigger: compileRule(cand.rule as RuleSpec, contract) }, opts.duration);
                const t = tally(sim.trades);
                baseline = entryStats(digits, contract, 'ANY', opts.duration).baseline;
                trades = t.trades;
                wins = t.wins;
                lo = trades ? wilsonLo(wins, trades) : null;
                pValue = trades ? binomP(wins, trades, baseline) : null;
            } else if (cand.entry === 'CUSTOM') {
                const sim = simulate(ticksFromDigits(digits), contract, { method: 'CUSTOM', digits: custom }, opts.duration);
                const t = tally(sim.trades);
                const s = entryStats(digits, contract, 'ANY', opts.duration); // baseline + same CI/p machinery
                baseline = s.baseline;
                trades = t.trades;
                wins = t.wins;
                const w = wilsonLo(wins, trades);
                lo = trades ? w : null;
                pValue = trades ? binomP(wins, trades, baseline) : null;
            } else {
                const s = entryStats(digits, contract, cand.entry, opts.duration);
                baseline = s.baseline;
                trades = s.trades;
                wins = s.wins;
                lo = s.ci ? s.ci.lo : null;
                pValue = s.pValue;
            }
            const enough = trades >= MIN_TRADES;
            const score = lo === null ? -1 : lo - baseline;
            const labelDir = cand.direction === 'UNDER_7' ? 'Under 7' : 'Over 2';
            rows.push({
                p: enough ? pValue : null,
                pick: {
                    key: pickKey(market, cand.direction, cand.entry, cand.strategyId ?? null, custom),
                    market,
                    direction: cand.direction,
                    entry: cand.entry,
                    customDigits: custom,
                    rule: cand.entry === 'SMART' ? (cand.rule as RuleSpec) : null,
                    strategyId: cand.strategyId ?? null,
                    label: `${labelDir} · ${cand.strategyLabel ?? cand.entry}`,
                    score: enough ? score : score - 0.5,
                    trades,
                    rate: trades ? wins / trades : null,
                    significant: false,
                    q: null,
                    regime,
                    reason: '',
                },
            });
        }
    }
    const q = bhAdjust(rows.map(r => r.p));
    rows.forEach((r, i) => {
        r.pick.q = q[i];
        r.pick.significant = r.p !== null && q[i] !== null && (q[i] as number) <= FDR_Q && r.pick.score > 0;
        r.pick.reason = r.pick.significant
            ? `beats chance after false-discovery control (q=${(q[i] as number).toFixed(3)}, ${r.pick.trades} trades)`
            : r.pick.trades >= MIN_TRADES
              ? `best available by conservative edge (${r.pick.trades} trades); no proven edge over chance`
              : `only ${r.pick.trades} trades so far; ranked low`;
    });
    let out = rows.map(r => r.pick);
    if (opts.evidenceOnly) out = out.filter(p => p.significant);
    return out.sort((a, b) => Number(b.significant) - Number(a.significant) || b.score - a.score || b.trades - a.trades);
}

export type RecoveryPick = {
    key: string;
    market: string;
    direction: RecoveryDirection;
    entry: 'SETUP' | 'ANY';
    label: string;
    /** Lower bound of the 95% win-rate interval minus the contract's chance level (fraction, may be negative). */
    score: number;
    trades: number;
    rate: number | null;
    regime: Regime;
    reason: string;
};

/**
 * Which recovery contract is more viable on each market right now: Over 3 or Under 6 (each wins 60% of fair digits), each
 * with a SETUP or ANY entry, measured by the same simulator and the same conservative score as the main picks. Best first.
 */
export function rankRecovery(
    series: Readonly<Record<string, readonly number[]>>,
    lastTickAt: (market: string) => number | null,
    now: number,
    opts: { duration: number; entries?: readonly PickEntry[]; minTicks?: number; freshMs?: number }
): RecoveryPick[] {
    const minTicks = opts.minTicks ?? MIN_TICKS_FOR_REGIME;
    const freshMs = opts.freshMs ?? 5000;
    const out: RecoveryPick[] = [];
    for (const market of Object.keys(series)) {
        const digits = series[market];
        const at = lastTickAt(market);
        if (digits.length < minTicks || at === null || now - at > freshMs) continue;
        for (const direction of ['OVER_3', 'UNDER_6'] as const) {
            const contract = recoveryContract(direction);
            const regime = classifyRegime(digits, contract).regime;
            if (regime === 'UNSTABLE' || regime === 'INSUFFICIENT_DATA') continue;
            for (const entry of ['SETUP', 'ANY'] as const) {
                if (opts.entries && !opts.entries.includes(entry)) continue;
                const s = entryStats(digits, contract, entry, opts.duration);
                const lo = s.ci ? s.ci.lo : null;
                const score = lo === null ? -1 : lo - s.baseline;
                out.push({
                    key: `${market}|${direction}|${entry}`,
                    market,
                    direction,
                    entry,
                    label: `${direction === 'UNDER_6' ? 'Under 6' : 'Over 3'} · ${entry === 'SETUP' ? 'fixed digit' : 'any tick'}`,
                    score: s.enough ? score : score - 0.5,
                    trades: s.trades,
                    rate: s.rate,
                    regime,
                    reason: s.enough ? `${s.trades} trades, ${((s.rate ?? 0) * 100).toFixed(0)}% won` : `only ${s.trades} trades so far`,
                });
            }
        }
    }
    return out.sort((a, b) => b.score - a.score || b.trades - a.trades);
}

/** The first (best) row of each market from a best-first list. */
export const bestPerMarket = <T extends { market: string }>(ranked: readonly T[]): T[] => {
    const seen = new Set<string>();
    return ranked.filter(r => (seen.has(r.market) ? false : (seen.add(r.market), true)));
};

// Small local helpers so CUSTOM candidates use the same interval and exact tail as the rest of the layer.
import { binomialUpperP, wilson } from '@/components/premium/sixfold/stats';
const wilsonLo = (wins: number, n: number) => wilson(wins, n).lo;
const binomP = (wins: number, n: number, p: number) => binomialUpperP(wins, n, p);
