// Sixfold Entry Lab: which way of entering, if any, has beaten entering immediately.
//
// Modelled on Sentinel's entry-condition discovery. For every market and contract, each entry rule is replayed over that
// market's ticks as a shadow trade: the rule may only look at ticks up to the trigger tick, the trade resolves on the
// real settlement digit, and "enter immediately" (every tick) is the control that every rule has to beat.
//
// A rule is only called VALIDATED when it clears several bars at once, because with ten markets, two contracts and ten
// rules, something always looks good by chance:
//   - it beat the ticks where it did NOT fire, with a false-discovery-corrected q <= 0.10 across every rule tested,
//   - it did better in BOTH the earlier 60% and the later 40% of the history,
//   - it has at least 100 shadow trades.
// Otherwise the answer is the honest one: nothing has beaten entering immediately.
import { type Contract, contractKey, contractLabel, winningDigits, winProbability } from './bot';
import { bhAdjust, normalCdf } from './stats';

export type LabRuleId =
    | 'IMMEDIATE'
    | 'SETUP_DIGIT'
    | 'QUIET_3'
    | 'RUN_4'
    | 'SEVEN_OF_10'
    | 'SEQUENCE'
    | 'EXHAUSTION_5'
    | 'PRESSURE'
    | 'COLD_3'
    | 'BOUNCE_2'
    | 'BOUNCE_3';

export type LabState = 'CONTROL' | 'TESTING' | 'NO_EDGE' | 'PROMISING' | 'VALIDATED' | 'WORSE';

type RuleFn = (d: readonly number[], i: number, win: ReadonlySet<number>, p: number) => boolean;

const wins = (d: readonly number[], i: number, n: number, win: ReadonlySet<number>) => {
    if (i < n - 1) return false;
    for (let k = 0; k < n; k++) if (!win.has(d[i - k])) return false;
    return true;
};
const lossesBefore = (d: readonly number[], i: number, win: ReadonlySet<number>) => {
    let n = 0;
    for (let k = i - 1; k >= 0 && !win.has(d[k]); k--) n += 1;
    return n;
};

export type LabRule = { id: LabRuleId; label: string; description: string; fn: RuleFn };

export const LAB_RULES: LabRule[] = [
    { id: 'IMMEDIATE', label: 'Enter immediately', description: 'The control: buy on the next tick, whatever it looks like.', fn: () => true },
    { id: 'SETUP_DIGIT', label: 'Setup digit', description: 'The latest digit would have lost the contract (the old fixed entry).', fn: (d, i, w) => i >= 0 && !w.has(d[i]) },
    { id: 'QUIET_3', label: 'Quiet for 3', description: 'The last 3 digits would all have won.', fn: (d, i, w) => wins(d, i, 3, w) },
    { id: 'RUN_4', label: 'Run of 4', description: 'The last 4 digits would all have won.', fn: (d, i, w) => wins(d, i, 4, w) },
    {
        id: 'SEVEN_OF_10',
        label: '7 of last 10',
        description: 'At least 7 of the last 10 digits would have won.',
        fn: (d, i, w) => {
            if (i < 9) return false;
            let c = 0;
            for (let k = 0; k < 10; k++) if (w.has(d[i - k])) c += 1;
            return c >= 7;
        },
    },
    {
        id: 'SEQUENCE',
        label: 'Clean sequence',
        description: 'A run of 3 winning digits and no losing digit repeated within the last 8.',
        fn: (d, i, w) => {
            if (i < 7 || !wins(d, i, 3, w)) return false;
            const seen = new Set<number>();
            for (let k = 0; k < 8; k++) {
                const x = d[i - k];
                if (w.has(x)) continue;
                if (seen.has(x)) return false;
                seen.add(x);
            }
            return true;
        },
    },
    { id: 'EXHAUSTION_5', label: 'Losses dried up', description: 'No losing digit for the last 5 ticks.', fn: (d, i, w) => wins(d, i, 5, w) },
    {
        id: 'PRESSURE',
        label: 'Winning pressure',
        description: 'The last 20 digits won clearly more often than normal and the latest one would have won.',
        fn: (d, i, w, p) => {
            if (i < 19 || !w.has(d[i])) return false;
            let c = 0;
            for (let k = 0; k < 20; k++) if (w.has(d[i - k])) c += 1;
            return c >= Math.round(20 * p) + 3;
        },
    },
    {
        id: 'COLD_3',
        label: 'After 3 losses',
        description: 'The last 3 digits would all have lost.',
        fn: (d, i, w) => i >= 2 && !w.has(d[i]) && !w.has(d[i - 1]) && !w.has(d[i - 2]),
    },
    { id: 'BOUNCE_2', label: '2 losses, then a win', description: 'At least 2 losses in a row, then a winning digit.', fn: (d, i, w) => i >= 2 && w.has(d[i]) && lossesBefore(d, i, w) >= 2 },
    { id: 'BOUNCE_3', label: '3 losses, then a win', description: 'At least 3 losses in a row, then a winning digit.', fn: (d, i, w) => i >= 3 && w.has(d[i]) && lossesBefore(d, i, w) >= 3 },
];
export const LAB_RULE_BY_ID = Object.fromEntries(LAB_RULES.map(r => [r.id, r])) as Record<LabRuleId, LabRule>;

export const LAB_HISTORY = 2000;
const MIN_TESTS = 30;
export const MIN_VALIDATED_TRADES = 100;
export const LAB_Q = 0.1;

export type LabRuleStats = {
    rule: LabRuleId;
    n: number;
    wins: number;
    rate: number | null;
    /** Win rate of the ticks where the rule did not fire. */
    restRate: number | null;
    /** Rule minus not-rule, in points. */
    edgePts: number | null;
    p: number | null;
    q: number | null;
    /** Edge in the earlier 60% and the later 40% of the history, in points. */
    earlyEdge: number | null;
    lateEdge: number | null;
    state: LabState;
};

export type LabCell = {
    symbol: string;
    key: string;
    label: string;
    ticks: number;
    rules: LabRuleStats[];
};

type Counts = { n: number; w: number };
const empty = (): Counts => ({ n: 0, w: 0 });
const edgeOf = (a: Counts, b: Counts) => (a.n && b.n ? (a.w / a.n - b.w / b.n) * 100 : null);

function pValue(a: Counts, b: Counts): number | null {
    if (a.n < MIN_TESTS || b.n < MIN_TESTS) return null;
    const pool = (a.w + b.w) / (a.n + b.n);
    const se = Math.sqrt(pool * (1 - pool) * (1 / a.n + 1 / b.n));
    if (!(se > 0)) return 1;
    return 2 * (1 - normalCdf(Math.abs((a.w / a.n - b.w / b.n) / se)));
}

type Raw = { rule: LabRuleId; all: Counts; rest: Counts; early: Counts; earlyRest: Counts; late: Counts; lateRest: Counts };

function replay(digits: readonly number[], contract: Contract, duration: number): { raws: Raw[]; ticks: number } {
    const d = digits.slice(-LAB_HISTORY);
    const win = new Set(winningDigits(contract));
    const p = winProbability(contract);
    const len = Math.max(1, Math.min(10, Math.trunc(duration) || 1));
    const split = Math.floor(d.length * 0.6);
    const raws: Raw[] = LAB_RULES.map(r => ({ rule: r.id, all: empty(), rest: empty(), early: empty(), earlyRest: empty(), late: empty(), lateRest: empty() }));
    const free = new Array<number>(LAB_RULES.length).fill(0); // a rule cannot re-enter while its trade is still open
    for (let i = 0; i + len < d.length; i++) {
        const won = win.has(d[i + len]) ? 1 : 0;
        const earlyHalf = i < split;
        LAB_RULES.forEach((rule, r) => {
            const raw = raws[r];
            const fires = i >= free[r] && rule.fn(d, i, win, p);
            if (rule.id === 'IMMEDIATE') {
                if (!fires) return;
                raw.all.n += 1;
                raw.all.w += won;
                free[r] = i + len;
                return;
            }
            if (fires) {
                raw.all.n += 1;
                raw.all.w += won;
                const h = earlyHalf ? raw.early : raw.late;
                h.n += 1;
                h.w += won;
                free[r] = i + len;
            } else {
                raw.rest.n += 1;
                raw.rest.w += won;
                const h = earlyHalf ? raw.earlyRest : raw.lateRest;
                h.n += 1;
                h.w += won;
            }
        });
    }
    return { raws, ticks: d.length };
}

function toStats(raw: Raw): LabRuleStats {
    if (raw.rule === 'IMMEDIATE') {
        return {
            rule: raw.rule,
            n: raw.all.n,
            wins: raw.all.w,
            rate: raw.all.n ? raw.all.w / raw.all.n : null,
            restRate: null,
            edgePts: null,
            p: null,
            q: null,
            earlyEdge: null,
            lateEdge: null,
            state: 'CONTROL',
        };
    }
    return {
        rule: raw.rule,
        n: raw.all.n,
        wins: raw.all.w,
        rate: raw.all.n ? raw.all.w / raw.all.n : null,
        restRate: raw.rest.n ? raw.rest.w / raw.rest.n : null,
        edgePts: edgeOf(raw.all, raw.rest),
        p: pValue(raw.all, raw.rest),
        q: null,
        earlyEdge: edgeOf(raw.early, raw.earlyRest),
        lateEdge: edgeOf(raw.late, raw.lateRest),
        state: 'TESTING',
    };
}

function classify(s: LabRuleStats): LabState {
    if (s.state === 'CONTROL') return 'CONTROL';
    if (s.p === null || s.edgePts === null || s.n < MIN_TESTS) return 'TESTING';
    if (s.edgePts < 0 && s.p < 0.05) return 'WORSE';
    const held = (s.earlyEdge ?? -1) > 0 && (s.lateEdge ?? -1) > 0;
    if (s.q !== null && s.q <= LAB_Q && s.edgePts > 0 && held && s.n >= MIN_VALIDATED_TRADES) return 'VALIDATED';
    if (s.edgePts > 0 && s.p < 0.05) return 'PROMISING';
    return 'NO_EDGE';
}

export type LabReport = {
    cells: LabCell[];
    /** Rule tests run (excluding the control) and how many are expected to look good by chance alone at p < 0.05. */
    tests: number;
    expectedByChance: number;
    promising: number;
    validated: number;
};

/** Replays every entry rule on every market and contract, and applies the false-discovery correction across all of them. */
export function entryLabReport(
    series: Record<string, readonly number[]>,
    symbols: readonly string[],
    contracts: readonly Contract[],
    duration = 1
): LabReport {
    const cells: LabCell[] = [];
    for (const symbol of symbols) {
        const digits = series[symbol];
        if (!digits || digits.length < 200) continue;
        for (const contract of contracts) {
            const { raws, ticks } = replay(digits, contract, duration);
            cells.push({ symbol, key: contractKey(contract), label: contractLabel(contract), ticks, rules: raws.map(toStats) });
        }
    }
    const flat = cells.flatMap(c => c.rules.filter(r => r.rule !== 'IMMEDIATE'));
    const q = bhAdjust(flat.map(r => r.p));
    flat.forEach((r, i) => (r.q = q[i]));
    let tests = 0;
    let promising = 0;
    let validated = 0;
    for (const cell of cells) {
        for (const r of cell.rules) {
            r.state = classify(r);
            if (r.rule === 'IMMEDIATE') continue;
            if (r.p !== null) tests += 1;
            if (r.state === 'PROMISING') promising += 1;
            if (r.state === 'VALIDATED') validated += 1;
        }
    }
    return { cells, tests, expectedByChance: Math.round(tests * 0.05 * 10) / 10, promising, validated };
}

/** The validated rule with the biggest edge for this market and contract, or null: then entering immediately is the answer. */
export function bestValidatedRule(report: LabReport, symbol: string, contract: Contract): LabRuleId | null {
    const cell = report.cells.find(c => c.symbol === symbol && c.key === contractKey(contract));
    if (!cell) return null;
    const best = cell.rules.filter(r => r.state === 'VALIDATED').sort((a, b) => (b.edgePts ?? 0) - (a.edgePts ?? 0))[0];
    return best ? best.rule : null;
}

/** Does `rule` fire on the latest tick of `digits`? Uses only ticks up to and including the latest one. */
export function ruleFiresNow(rule: LabRuleId, digits: readonly number[], contract: Contract): boolean {
    if (!digits.length) return false;
    const win = new Set(winningDigits(contract));
    return LAB_RULE_BY_ID[rule].fn(digits, digits.length - 1, win, winProbability(contract));
}
