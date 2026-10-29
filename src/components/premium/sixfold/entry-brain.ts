// SIXFOLD ENTRY BRAIN: every market trades on its own TRIGGER DIGITS.
//
// The rule: no trade is entered blindly. For every market and contract the Brain studies the market's last 1000 ticks and
// finds the digits which, when touched, have been followed by a win on that contract (Over 2, Under 7, Over 3, Under 6, or
// whichever contract is being traded). Those digits are the entry: when the market prints one of them, the bot buys.
//
// How the study works, per market and contract:
//   1. TOUCHES. Every time a digit d prints, look `duration` ticks ahead: did the contract win? That is one touch of d.
//   2. WINDOWS. The history is cut into WINDOWS slices, oldest to newest, and every digit is scored in every slice, so a
//      digit that only worked early in the history (and has since stopped) is told apart from one that keeps working.
//   3. QUALIFY. A digit is PROVEN when it beat the contract's base win rate in all but one window, including every one of
//      the newest RECENT_MUST windows, and had enough touches in each. The newest windows also weigh more in the ranking.
//   4. PICK. The best TRIGGER_COUNT digits are the market's entry digits. A market always has them: when fewer than
//      TRIGGER_COUNT digits are proven, the best-ranked remaining digits fill in and are labelled BEST AVAILABLE.
//   5. REFRESH. The study is re-run every few seconds, so the entry digits follow the most recent windows.
//
// Ledger: every trade is still scored against what entering on a random tick of the same market would have won, so the page
// shows whether a digit that worked in the past keeps working on ticks it has not seen.
import { type Contract, contractKey, contractLabel, winningDigits, winProbability } from './bot';
import { normalCdf } from './stats';

export type ArmId = 'TRIGGER_DIGITS';
export type ArmKind = 'DIGIT';
export type Arm = { id: ArmId; kind: ArmKind; label: string; blurb: string };

export const ARMS: Arm[] = [
    {
        id: 'TRIGGER_DIGITS',
        kind: 'DIGIT',
        label: 'Trigger digits',
        blurb: 'Enter when the market prints a digit that has been followed by wins on this contract, window after window, up to the most recent one.',
    },
];
export const ARM_BY_ID = Object.fromEntries(ARMS.map(a => [a.id, a])) as Record<ArmId, Arm>;

/** Ticks of history studied per market and contract. */
export const BRAIN_HISTORY = 1000;
/** The history is cut into this many windows, oldest to newest. */
export const WINDOWS = 5;
/** A proven digit must pass every one of the newest this-many windows. */
export const RECENT_MUST = 2;
/** A proven digit may miss at most this many windows. */
const WINDOWS_MAY_MISS = 1;
/** Window win rate must beat the contract's base rate by this much. */
const MARGIN = 0.02;
/** Entry digits per market and contract. */
export const TRIGGER_COUNT = 3;
/** Fewest ticks needed before a market is studied. */
const MIN_TICKS = 200;

export type Evidence = 'LEARNING' | 'PROVEN' | 'BEST';

export type WindowStat = { n: number; wins: number; rate: number | null };

export type TriggerDigit = {
    digit: number;
    touches: number;
    wins: number;
    rate: number | null;
    /** Oldest window first. */
    windows: WindowStat[];
    /** How many windows beat the base rate with enough touches. */
    passed: number;
    /** Did every one of the newest windows pass? */
    recentOk: boolean;
    /** Recency-weighted win rate above the contract's base rate (newest windows count most). */
    score: number;
    evidence: Exclude<Evidence, 'LEARNING'>;
};

export type BrainCell = {
    symbol: string;
    key: string;
    label: string;
    ticks: number;
    theoretical: number;
    /** Win rate of entering on every tick of this history: what a blind entry would have done. */
    immediateRate: number;
    /** The market's entry digits, best first. Never empty for a studied market. */
    triggers: TriggerDigit[];
    /** Every digit's study, best first (for the Lab table). */
    all: TriggerDigit[];
    /** Share of ticks that are an entry digit, and the typical wait in ticks. */
    fireRate: number;
    waitTicks: number;
    windowSize: number;
};

export type BrainReport = {
    cells: BrainCell[];
    /** Entry digits that are PROVEN across all cells vs all entry digits. */
    proven: number;
    total: number;
    builtAt: number;
};

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Study one market for one contract. Uses only ticks that have printed. */
export function replayCell(symbol: string, digits: readonly number[], contract: Contract, duration: number): BrainCell | null {
    const d = digits.slice(-BRAIN_HISTORY);
    const len = Math.max(1, Math.min(10, Math.trunc(duration) || 1));
    if (d.length < MIN_TICKS + len) return null;
    const win = new Set(winningDigits(contract));
    const p = winProbability(contract);
    // Trigger index j has its outcome at d[j + len]; the newest window ends at the last trigger whose outcome has printed.
    const usable = d.length - len;
    const size = Math.floor(usable / WINDOWS);
    const first = usable - size * WINDOWS;
    const minTouches = Math.max(5, Math.floor(size / 25));
    const weights = Array.from({ length: WINDOWS }, (_, k) => k + 1);
    const wSum = weights.reduce((a, b) => a + b, 0);

    let immediateW = 0;
    for (let j = 0; j < usable; j++) if (win.has(d[j + len])) immediateW += 1;

    const all: TriggerDigit[] = [];
    for (let digit = 0; digit <= 9; digit++) {
        const windows: WindowStat[] = [];
        for (let k = 0; k < WINDOWS; k++) {
            const start = first + k * size;
            let n = 0;
            let w = 0;
            for (let j = start; j < start + size; j++) {
                if (d[j] !== digit) continue;
                n += 1;
                if (win.has(d[j + len])) w += 1;
            }
            windows.push({ n, wins: w, rate: n ? w / n : null });
        }
        const ok = windows.map(w => w.n >= minTouches && w.rate !== null && w.rate >= p + MARGIN);
        const passed = ok.filter(Boolean).length;
        const recentOk = ok.slice(-RECENT_MUST).every(Boolean);
        // Small windows are shrunk toward the base rate so a 3-for-3 window does not outrank a 40-for-50 one.
        const SHRINK = 6;
        const score = windows.reduce((s, w, k) => s + (((w.wins + SHRINK * p) / (w.n + SHRINK)) - p) * weights[k], 0) / wSum;
        const touches = windows.reduce((s, w) => s + w.n, 0);
        const wins = windows.reduce((s, w) => s + w.wins, 0);
        const proven = passed >= WINDOWS - WINDOWS_MAY_MISS && recentOk;
        all.push({ digit, touches, wins, rate: touches ? wins / touches : null, windows, passed, recentOk, score, evidence: proven ? 'PROVEN' : 'BEST' });
    }
    // Proven digits first, then by recency-weighted score. A market never ends up without entry digits.
    all.sort((a, b) => Number(b.evidence === 'PROVEN') - Number(a.evidence === 'PROVEN') || b.score - a.score || a.digit - b.digit);
    const triggers = all.slice(0, TRIGGER_COUNT);
    const tickShare = triggers.reduce((s, t) => s + t.touches, 0) / Math.max(1, usable);
    const fireRate = Math.max(tickShare, 0.01);
    return {
        symbol,
        key: contractKey(contract),
        label: contractLabel(contract),
        ticks: d.length,
        theoretical: p,
        immediateRate: usable ? immediateW / usable : p,
        triggers,
        all,
        fireRate,
        waitTicks: 1 / fireRate,
        windowSize: size,
    };
}

export function brainReport(
    series: Record<string, readonly number[]>,
    symbols: readonly string[],
    contracts: readonly Contract[],
    duration: number,
    now: number
): BrainReport {
    const cells: BrainCell[] = [];
    for (const symbol of symbols) {
        const digits = series[symbol];
        if (!digits) continue;
        for (const contract of contracts) {
            const cell = replayCell(symbol, digits, contract, duration);
            if (cell) cells.push(cell);
        }
    }
    const total = cells.reduce((s, c) => s + c.triggers.length, 0);
    const proven = cells.reduce((s, c) => s + c.triggers.filter(t => t.evidence === 'PROVEN').length, 0);
    return { cells, proven, total, builtAt: now };
}

export const findCell = (report: BrainReport | null, symbol: string, contract: Contract): BrainCell | null =>
    report?.cells.find(c => c.symbol === symbol && c.key === contractKey(contract)) ?? null;

// ---------- plan ----------

export type Plan = {
    arm: ArmId;
    label: string;
    kind: ArmKind;
    /** One plain sentence on why these digits were chosen. */
    why: string;
    evidence: Evidence;
    /** Typical wait for an entry digit, in ticks, or null when unknown. */
    waitTicks: number | null;
    /** The digits that trigger the entry when this plan was made (the live study may have refreshed them since). */
    digits: number[];
    /** Recovery: only digits that are PROVEN in every recent window are used when there are any. */
    strict: boolean;
};

export type PlanOptions = {
    rng?: () => number;
    exclude?: readonly ArmId[];
    maxWaitTicks?: number;
    strict: boolean;
};

/** The market has not been studied yet, so it has no entry digit and no trade is placed on it. Never a blind entry. */
export const fallbackPlan = (strict: boolean): Plan => ({
    arm: 'TRIGGER_DIGITS',
    label: ARM_BY_ID.TRIGGER_DIGITS.label,
    kind: 'DIGIT',
    why: 'This market has fewer ticks than the study needs, so it has no entry digits yet and no trade is placed on it.',
    evidence: 'LEARNING',
    waitTicks: null,
    digits: [],
    strict,
});

/** The entry digits to use right now: in recovery the proven ones when there are any. */
export function entryDigitsOf(cell: BrainCell, strict: boolean): TriggerDigit[] {
    if (strict) {
        const proven = cell.triggers.filter(t => t.evidence === 'PROVEN');
        if (proven.length) return proven;
    }
    return cell.triggers;
}

function describe(cell: BrainCell, shown: TriggerDigit[], strict: boolean): string {
    const parts = shown.map(t => `${t.digit}: ${t.rate === null ? '-' : pct1(t.rate)} over ${t.touches} touches, ${t.passed}/${WINDOWS} windows`);
    return `Enter on digit ${shown.map(t => t.digit).join(', ')} (${parts.join('; ')}; base ${pct1(cell.theoretical)}).${strict ? ' Recovery: proven digits only.' : ''}`;
}

/** Choose the entry plan for a market and contract. Always returns a plan; a studied market always has entry digits. */
export function choosePlan(cell: BrainCell | null, opts: PlanOptions): Plan {
    if (!cell) return fallbackPlan(opts.strict);
    const shown = entryDigitsOf(cell, opts.strict);
    const proven = shown.every(t => t.evidence === 'PROVEN');
    return {
        arm: 'TRIGGER_DIGITS',
        label: ARM_BY_ID.TRIGGER_DIGITS.label,
        kind: 'DIGIT',
        why: describe(cell, shown, opts.strict),
        evidence: proven ? 'PROVEN' : 'BEST',
        waitTicks: cell.waitTicks,
        digits: shown.map(t => t.digit),
        strict: opts.strict,
    };
}

/** Is the latest tick one of the market's entry digits? */
export function planFires(plan: Plan, cell: BrainCell | null, digits: readonly number[], _contract: Contract): boolean {
    const last = digits[digits.length - 1];
    if (last === undefined) return false;
    if (cell) return entryDigitsOf(cell, plan.strict).some(t => t.digit === last);
    return plan.digits.includes(last);
}

// ---------- ledger ----------

export type LedgerTrade = { plan: string | null; baseRate: number | null; status: 'open' | 'won' | 'lost' | 'unconfirmed' };

export type Ledger = {
    n: number;
    wins: number;
    /** Wins a blind entry on the same markets and contracts would have been expected to get, and its spread. */
    expected: number;
    sd: number;
    z: number | null;
    verdict: string;
    byArm: Array<{ arm: ArmId; label: string; n: number; wins: number }>;
};

/** Did trigger-digit entries win more than entering on a random tick of the same markets would have? */
export function planLedger(trades: readonly LedgerTrade[]): Ledger {
    let n = 0;
    let wins = 0;
    let expected = 0;
    let variance = 0;
    const by = new Map<ArmId, { n: number; wins: number }>();
    for (const t of trades) {
        if (!t.plan || t.baseRate === null || (t.status !== 'won' && t.status !== 'lost')) continue;
        n += 1;
        const won = t.status === 'won' ? 1 : 0;
        wins += won;
        expected += t.baseRate;
        variance += t.baseRate * (1 - t.baseRate);
        const arm = t.plan as ArmId;
        const row = by.get(arm) ?? { n: 0, wins: 0 };
        row.n += 1;
        row.wins += won;
        by.set(arm, row);
    }
    const sd = Math.sqrt(variance);
    const z = n >= 30 && sd > 0 ? (wins - expected) / sd : null;
    const verdict =
        z === null
            ? 'Too few trigger-digit trades to judge yet.'
            : z >= 1.96
              ? 'Trigger-digit entries are winning clearly more than random-tick entries would have.'
              : z <= -1.96
                ? 'Trigger-digit entries are winning clearly LESS than random-tick entries would have. The digits are not holding up on new ticks.'
                : 'Trigger-digit entries are winning about what a random tick would have.';
    const byArm = [...by.entries()].map(([arm, r]) => ({ arm, label: ARM_BY_ID[arm]?.label ?? arm, ...r })).sort((a, b) => b.n - a.n);
    return { n, wins, expected, sd, z, verdict, byArm };
}

/** Two-sided p for a z score, for display. */
export const zToP = (z: number) => 2 * (1 - normalCdf(Math.abs(z)));
