// Sixfold Entry Lab: does an entry rule actually beat entering at random? Pure functions, no I/O.
//
// The runner can enter a market three ways (SMART learned digits, SETUP losing digits, ANY immediately) and, while
// recovering, can add a form gate (MOMENTUM / REVERSION / BOUNCE). A good session says nothing about whether the rule
// helped, because on a fair digit stream a short run of wins is what chance produces.
//
// This module replays a tick history the way the live bot would have traded it, WALK-FORWARD: every decision (which
// digits SMART arms on, whether a gate passes) uses only ticks that had already printed. It then compares each rule with
// ANY (buy as soon as the bot is free) on the same ticks, against the contract's normal win rate and the payout break-even.
// On random digits the honest answer is almost always "no difference"; the lab exists to say so with numbers, and to show
// the day a rule really does separate from chance.
import { type Contract, losingDigits, winProbability } from './bot';
import { ENTRY_WINDOW, formGateOk, type RecoveryEntry, smartEntryDigits } from './entry';
import { outcome } from './engine';
import { breakEvenRate, evPerTrade, normalCdf, wilson } from './stats';

export type EntryRuleId = 'ANY' | 'SETUP' | 'SMART';

export type LabTrade = {
    entryIndex: number;
    entryDigit: number;
    won: boolean;
    /** True when the bot was recovering (the trade before it was a loss) at the moment it armed. */
    recovering: boolean;
};

export type WalkConfig = {
    duration: number;
    /** Ticks skipped at the start so the first decision has history to learn from. */
    warmup: number;
    /** Recovery form gate, applied only while recovering. */
    gate: { mode: RecoveryEntry; k: number };
    /**
     * Extra gate applied to every entry: it sees only the ticks up to and including the arming tick (at most the last
     * `GUARD_HISTORY`), exactly what the live runner would have. Used to test the pressure and multi-window gates.
     */
    guard?: (seen: readonly number[]) => boolean;
};

/** Ticks of history a guard is given. Enough for the 480-tick health windows. */
export const GUARD_HISTORY = 600;

export const DEFAULT_WALK: WalkConfig = { duration: 1, warmup: ENTRY_WINDOW, gate: { mode: 'OFF', k: 3 } };

/**
 * One walk-forward replay. Mirrors the live bot: one contract at a time, the exit tick is not reused as an entry, and a
 * contract settles `duration` ticks after the entry digit. `series[0..i]` is all that is visible when tick `i` arms.
 */
export function walkForward(
    series: readonly number[],
    contract: Contract,
    rule: EntryRuleId,
    cfg: Partial<WalkConfig> = {}
): LabTrade[] {
    const c: WalkConfig = { ...DEFAULT_WALK, ...cfg, gate: { ...DEFAULT_WALK.gate, ...(cfg.gate ?? {}) } };
    const duration = Math.max(1, Math.min(10, Math.trunc(c.duration) || 1));
    const setup = new Set(losingDigits(contract));
    const trades: LabTrade[] = [];
    let recovering = false;
    let lastLossEntry: number | null = null;
    let i = Math.max(1, c.warmup);
    while (i + duration < series.length) {
        const digit = series[i];
        let entries: ReadonlySet<number>;
        if (rule === 'ANY') entries = ANY_DIGITS;
        else if (rule === 'SETUP') entries = setup;
        else {
            // Only the window the live bot would look at: the last ENTRY_WINDOW ticks up to and including tick i.
            const seen = series.slice(Math.max(0, i + 1 - ENTRY_WINDOW - duration - 1), i + 1);
            const avoid = new Set<number>(lastLossEntry === null ? [] : [lastLossEntry]);
            entries = new Set(smartEntryDigits(seen, contract, duration, avoid).digits);
        }
        const gateOk =
            !recovering || c.gate.mode === 'OFF' || formGateOk(c.gate.mode, c.gate.k, series.slice(0, i + 1), contract);
        const guardOk = !c.guard || c.guard(series.slice(Math.max(0, i + 1 - GUARD_HISTORY), i + 1));
        if (entries.has(digit) && gateOk && guardOk) {
            const exit = i + duration;
            const won = outcome(contract.side, series[exit], contract.param);
            trades.push({ entryIndex: i, entryDigit: digit, won, recovering });
            recovering = !won;
            lastLossEntry = won ? null : digit;
            i = exit + 1;
        } else i++;
    }
    return trades;
}

const ANY_DIGITS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

export type RuleStats = {
    trades: number;
    wins: number;
    rate: number | null;
    ci: { lo: number; hi: number };
    /** Win rate minus the payout break-even, in percentage points. Positive = beating the payout. */
    edgePts: number | null;
    /** Expected profit per 1.00 staked, at the observed win rate and the estimated payout. */
    evPerUnit: number | null;
};

export function summarize(trades: readonly LabTrade[], contract: Contract, margin: number): RuleStats {
    const wins = trades.filter(t => t.won).length;
    const n = trades.length;
    const p = winProbability(contract);
    const rate = n ? wins / n : null;
    return {
        trades: n,
        wins,
        rate,
        ci: wilson(wins, n),
        edgePts: rate === null ? null : (rate - breakEvenRate(p, margin)) * 100,
        evPerUnit: rate === null ? null : evPerTrade(rate, p, margin),
    };
}

export type LabVerdict =
    | 'TOO_FEW'
    | 'NO_DIFFERENCE'
    /** Reliably better than the control but still under the payout break-even: it avoids bad stretches, it does not make the contract profitable. */
    | 'LESS_BAD'
    | 'LEANS_BETTER'
    | 'BETTER'
    | 'WORSE';

export const MIN_LAB_TRADES = 60;

export type RuleComparison = {
    rule: EntryRuleId | `GATE:${RecoveryEntry}` | 'GUARD';
    stats: RuleStats;
    /** The same ticks traded with ANY: the control. */
    control: RuleStats;
    baseline: number;
    breakEven: number;
    /** Win-rate difference versus the control, in percentage points. */
    diffPts: number | null;
    /** One-sided p that the rule's win rate is above the control's, from a two-proportion z-test. */
    pBetter: number | null;
    verdict: LabVerdict;
    summary: string;
};

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** One-sided two-proportion z-test: is (w1/n1) above (w2/n2)? Returns the p-value. */
export function twoProportionP(w1: number, n1: number, w2: number, n2: number): number | null {
    if (n1 < 1 || n2 < 1) return null;
    const pooled = (w1 + w2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    if (se === 0) return 1;
    const z = (w1 / n1 - w2 / n2) / se;
    return 1 - normalCdf(z);
}

function judge(stats: RuleStats, control: RuleStats, be: number): LabVerdict {
    if (stats.trades < MIN_LAB_TRADES || control.trades < MIN_LAB_TRADES || stats.rate === null || control.rate === null) {
        return 'TOO_FEW';
    }
    const p = twoProportionP(stats.wins, stats.trades, control.wins, control.trades);
    const pWorse = twoProportionP(control.wins, control.trades, stats.wins, stats.trades);
    if (pWorse !== null && pWorse < 0.05) return 'WORSE';
    // A rule is only "better" if it also clears the payout break-even: beating a losing control is not winning.
    const clears = stats.ci.lo > be;
    if (p !== null && p < 0.01 && clears) return 'BETTER';
    if (p !== null && p < 0.1 && stats.rate > be) return 'LEANS_BETTER';
    if (p !== null && p < 0.01 && stats.rate > control.rate) return 'LESS_BAD';
    return 'NO_DIFFERENCE';
}

function describe(rule: string, s: RuleStats, ctl: RuleStats, verdict: LabVerdict, baseline: number, be: number): string {
    if (verdict === 'TOO_FEW') {
        return `${rule}: only ${s.trades} trades in this history (need ${MIN_LAB_TRADES} for it and for the control); no verdict yet.`;
    }
    const head = `${rule}: ${s.wins}/${s.trades} won (${pct(s.rate)}, 95% range ${pct(s.ci.lo)}–${pct(s.ci.hi)}) vs ${pct(ctl.rate)} for buying immediately; normal ${pct(baseline)}, break-even ${pct(be)}. `;
    switch (verdict) {
        case 'NO_DIFFERENCE':
            return `${head}Same as chance: this rule did not change the win rate in a way chance could not.`;
        case 'WORSE':
            return `${head}Reliably worse than buying immediately on this history.`;
        case 'LESS_BAD':
            return `${head}Reliably better than buying immediately, but still under break-even: it steers clear of bad stretches without making the contract profitable.`;
        case 'LEANS_BETTER':
            return `${head}Above the control and break-even, but not confirmed. A lead, not a result.`;
        case 'BETTER':
            return `${head}Above the control and above break-even, unlikely by chance.`;
    }
}

/**
 * Compare SMART and SETUP entry with ANY on one market's tick history, walk-forward. `margin` is the platform margin used
 * for the break-even (the live payout comes from Deriv).
 */
export function compareEntryRules(
    series: readonly number[],
    contract: Contract,
    cfg: Partial<WalkConfig> = {},
    margin = 0.05
): RuleComparison[] {
    const baseline = winProbability(contract);
    const be = breakEvenRate(baseline, margin);
    const control = summarize(walkForward(series, contract, 'ANY', cfg), contract, margin);
    return (['SMART', 'SETUP'] as const).map(rule => {
        const stats = summarize(walkForward(series, contract, rule, cfg), contract, margin);
        return finish(rule, stats, control, baseline, be);
    });
}

/**
 * Compare recovery form gates with no gate. All of them buy immediately when free; the only difference is whether a
 * recovery trade waits for the gate. Only trades taken while recovering are compared, since that is all a gate touches.
 */
export function compareRecoveryGates(
    series: readonly number[],
    contract: Contract,
    k = 3,
    cfg: Partial<WalkConfig> = {},
    margin = 0.05
): RuleComparison[] {
    const baseline = winProbability(contract);
    const be = breakEvenRate(baseline, margin);
    const recoveryOnly = (t: readonly LabTrade[]) => t.filter(x => x.recovering);
    const control = summarize(recoveryOnly(walkForward(series, contract, 'ANY', { ...cfg, gate: { mode: 'OFF', k } })), contract, margin);
    return (['MOMENTUM', 'REVERSION', 'BOUNCE'] as const).map(mode => {
        const trades = walkForward(series, contract, 'ANY', { ...cfg, gate: { mode, k } });
        const stats = summarize(recoveryOnly(trades), contract, margin);
        return finish(`GATE:${mode}`, stats, control, baseline, be);
    });
}

/**
 * Does a guard (for example the losing-side pressure gate) change the win rate? Both runs buy immediately when free; the
 * guarded run also needs the guard to pass at the arming tick. The control is the same ticks with no guard.
 */
export function compareGuard(
    series: readonly number[],
    contract: Contract,
    guard: (seen: readonly number[]) => boolean,
    cfg: Partial<WalkConfig> = {},
    margin = 0.05
): RuleComparison {
    const baseline = winProbability(contract);
    const be = breakEvenRate(baseline, margin);
    const control = summarize(walkForward(series, contract, 'ANY', cfg), contract, margin);
    const stats = summarize(walkForward(series, contract, 'ANY', { ...cfg, guard }), contract, margin);
    return finish('GUARD', stats, control, baseline, be);
}

function finish(
    rule: RuleComparison['rule'],
    stats: RuleStats,
    control: RuleStats,
    baseline: number,
    be: number
): RuleComparison {
    const verdict = judge(stats, control, be);
    const diffPts = stats.rate === null || control.rate === null ? null : (stats.rate - control.rate) * 100;
    const pBetter = twoProportionP(stats.wins, stats.trades, control.wins, control.trades);
    return { rule, stats, control, baseline, breakEven: be, diffPts, pBetter, verdict, summary: describe(rule, stats, control, verdict, baseline, be) };
}

/**
 * Chance of at least one run of `k` losses somewhere in `trades` trades, each losing with probability `pLoss`. Used to tell
 * a rough patch from a broken strategy: six losses in a row is not rare over a few hundred trades.
 */
export function chanceOfLossRun(trades: number, k: number, pLoss: number): number {
    if (trades < k || k < 1) return 0;
    // P(no run of k) by the standard recurrence on the length of the current run.
    const q = 1 - pLoss;
    let state = new Array<number>(k).fill(0);
    state[0] = 1;
    for (let t = 0; t < trades; t++) {
        const next = new Array<number>(k).fill(0);
        for (let r = 0; r < k; r++) {
            if (!state[r]) continue;
            next[0] += state[r] * q;
            if (r + 1 < k) next[r + 1] += state[r] * pLoss;
        }
        state = next;
    }
    return 1 - state.reduce((a, b) => a + b, 0);
}