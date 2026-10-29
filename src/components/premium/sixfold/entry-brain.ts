// SIXFOLD ENTRY BRAIN: every trade gets an entry plan.
//
// The old Entry Lab was a referee: it only allowed a rule that had already beaten "enter immediately", and on random digits
// that almost never happens, so the trade simply entered on the next tick: no entry at all. The Brain turns that around.
// Every trade is bought on a named PLAN (a digit set, a learned two-digit pattern, a run or form condition, or the AI
// model's own read), and the plan is chosen by learning, never by hard-coding.
//
// How it works, per market and contract:
//   1. ARMS. A library of entry triggers: fixed digits, learned digit sets, learned two-digit patterns, run / form rules,
//      and an online logistic model that scores every tick. Each arm answers "does it fire on this tick?".
//   2. REPLAY. Every arm is replayed over the market's recent ticks as a shadow trade. Everything that learns (digit
//      table, pattern table, the model) learns an outcome only once that outcome has printed, so nothing looks ahead.
//   3. POSTERIOR. Each arm's results are weighted by recency into a Beta posterior that starts at the contract's
//      theoretical rate, so an arm with little evidence stays near it.
//   4. PLAN. Thompson sampling: one draw per arm, the best draw wins. When nothing separates, the draw rotates the plan
//      (varied entries), and when an arm really has been doing better it is chosen more and more. After a loss the plan is
//      chosen conservatively (lower confidence bound) and the AI model must also agree: a double lock.
//   5. LEDGER. Every trade is scored against what entering on a random tick of the same market would have won, so the
//      page reports whether plan-timed entries are actually doing better, instead of assuming it.
//
// Deriv digits on synthetic indices are generated randomly. No entry plan can create an edge there, and this module does not
// claim one. What it does is make sure no trade is entered blindly, follow whatever local structure the ticks do show, stop
// repeating a plan that has been losing, and measure the result honestly.
import { type Contract, contractKey, contractLabel, winningDigits, winProbability } from './bot';
import { LAB_RULE_BY_ID } from './entry-lab';
import { normalCdf } from './stats';

export type ArmId =
    | 'SETUP_DIGIT'
    | 'LAST_WIN'
    | 'QUIET_3'
    | 'RUN_4'
    | 'EXHAUSTION_5'
    | 'SEVEN_OF_10'
    | 'SEQUENCE'
    | 'PRESSURE'
    | 'COLD_3'
    | 'BOUNCE_2'
    | 'BOUNCE_3'
    | 'LEARNED_DIGITS'
    | 'PAIR_PATTERN'
    | 'AI_MODEL';

export type ArmKind = 'DIGIT' | 'PATTERN' | 'FORM' | 'AI';
export type Arm = { id: ArmId; kind: ArmKind; label: string; blurb: string };

export const ARMS: Arm[] = [
    { id: 'SETUP_DIGIT', kind: 'DIGIT', label: 'Setup digit', blurb: 'Enter after a digit that would have lost the contract.' },
    { id: 'LAST_WIN', kind: 'DIGIT', label: 'Last tick won', blurb: 'Enter after a digit that would have won the contract.' },
    { id: 'LEARNED_DIGITS', kind: 'DIGIT', label: 'Learned digit set', blurb: 'Enter on the three digits that have been followed by the most wins on this market.' },
    { id: 'PAIR_PATTERN', kind: 'PATTERN', label: 'Learned pattern', blurb: 'Enter when the last two digits form a pattern that has been followed by wins here.' },
    { id: 'QUIET_3', kind: 'FORM', label: 'Quiet for 3', blurb: 'The last 3 digits would all have won.' },
    { id: 'RUN_4', kind: 'FORM', label: 'Run of 4', blurb: 'The last 4 digits would all have won.' },
    { id: 'EXHAUSTION_5', kind: 'FORM', label: 'Losses dried up', blurb: 'No losing digit for the last 5 ticks.' },
    { id: 'SEVEN_OF_10', kind: 'FORM', label: '7 of last 10', blurb: 'At least 7 of the last 10 digits would have won.' },
    { id: 'SEQUENCE', kind: 'FORM', label: 'Clean sequence', blurb: 'A run of 3 winning digits and no losing digit repeated within the last 8.' },
    { id: 'PRESSURE', kind: 'FORM', label: 'Winning pressure', blurb: 'The last 20 digits won clearly more than normal and the latest one won.' },
    { id: 'COLD_3', kind: 'FORM', label: 'After 3 losses', blurb: 'The last 3 digits would all have lost.' },
    { id: 'BOUNCE_2', kind: 'FORM', label: '2 losses, then a win', blurb: 'At least 2 losses in a row, then a winning digit.' },
    { id: 'BOUNCE_3', kind: 'FORM', label: '3 losses, then a win', blurb: 'At least 3 losses in a row, then a winning digit.' },
    { id: 'AI_MODEL', kind: 'AI', label: 'AI model', blurb: 'An online model scores every tick; enter when its win probability is clearly above its own recent average.' },
];
export const ARM_BY_ID = Object.fromEntries(ARMS.map(a => [a.id, a])) as Record<ArmId, Arm>;

/** Ticks of history replayed per market and contract. */
export const BRAIN_HISTORY = 1200;
/** An outcome this many ticks old counts half as much as the newest one. */
const HALF_LIFE = 300;
/** Pseudo-trades at the theoretical rate that every posterior starts with. */
const PRIOR_TRADES = 40;
const FEATURES = 21;
const WARMUP = 150;
const MODEL_LR = 0.02;
const MODEL_L2 = 0.001;
/** The AI arm fires when its score is this many standard deviations above its recent average. */
const AI_SIGMAS = 0.35;
const MIN_ARM_TRADES = 40;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// ---------- the fitted state: tables and a model that only ever learn outcomes that have printed ----------

/** Features of the tick at index i, read only from ticks up to and including i. Needs i >= 19. */
function features(d: readonly number[], i: number, win: ReadonlySet<number>, out: Float64Array) {
    let k = 0;
    for (let j = 0; j < 5; j++) out[k++] = win.has(d[i - j]) ? 1 : 0;
    for (let x = 0; x < 10; x++) out[k++] = d[i] === x ? 1 : 0;
    let c10 = 0;
    for (let j = 0; j < 10; j++) if (win.has(d[i - j])) c10 += 1;
    let c20 = c10;
    for (let j = 10; j < 20; j++) if (win.has(d[i - j])) c20 += 1;
    out[k++] = c10 / 10;
    out[k++] = c20 / 20;
    let lossRun = 0;
    while (lossRun < 6 && i - lossRun >= 0 && !win.has(d[i - lossRun])) lossRun += 1;
    let winRun = 0;
    while (winRun < 8 && i - winRun >= 0 && win.has(d[i - winRun])) winRun += 1;
    out[k++] = lossRun / 6;
    out[k++] = winRun / 8;
    out[k++] = d[i] === d[i - 1] ? 1 : 0;
    out[k++] = 1;
}

export class Fit {
    readonly win: ReadonlySet<number>;
    readonly p: number;
    readonly len: number;
    private digitN = new Array<number>(10).fill(0);
    private digitW = new Array<number>(10).fill(0);
    private pairN = new Array<number>(100).fill(0);
    private pairW = new Array<number>(100).fill(0);
    private weights = new Float64Array(FEATURES);
    private x = new Float64Array(FEATURES);
    private preds: Float32Array;
    private top3: number[] | null = null;
    learned = 0;
    private predMean: number;
    private predVar = 1e-4;
    /** Running (model - constant guess) log-loss gain per prediction, measured on predictions made BEFORE they were learned. */
    private gain = 0;
    private gainN = 0;

    constructor(win: ReadonlySet<number>, p: number, len: number, size: number) {
        this.win = win;
        this.p = p;
        this.len = len;
        this.preds = new Float32Array(Math.max(1, size));
        this.predMean = p;
        const pc = clamp(p, 0.01, 0.99);
        this.weights[FEATURES - 1] = Math.log(pc / (1 - pc));
    }

    private score(d: readonly number[], i: number): number {
        features(d, i, this.win, this.x);
        let z = 0;
        for (let k = 0; k < FEATURES; k++) z += this.weights[k] * this.x[k];
        return sigmoid(z);
    }

    /** Record the model's score for tick i (made before any outcome after i is known). */
    observe(d: readonly number[], i: number) {
        if (i < 19 || i >= this.preds.length) return;
        const q = this.score(d, i);
        this.preds[i] = q;
        const a = 0.02;
        const diff = q - this.predMean;
        this.predMean += a * diff;
        this.predVar = (1 - a) * (this.predVar + a * diff * diff);
    }

    /** Learn the outcome of the trigger at index j. Only call once d[j + len] has printed. */
    learn(d: readonly number[], j: number) {
        if (j < 0 || j + this.len >= d.length) return;
        const y = this.win.has(d[j + this.len]) ? 1 : 0;
        this.digitN[d[j]] += 1;
        this.digitW[d[j]] += y;
        this.top3 = null;
        if (j >= 1) {
            const idx = d[j - 1] * 10 + d[j];
            this.pairN[idx] += 1;
            this.pairW[idx] += y;
        }
        if (j < 19) return;
        // Prequential check first: how did the score made at time j do, against just guessing the base rate?
        const q = clamp(this.preds[j], 0.001, 0.999);
        const base = clamp(this.p, 0.001, 0.999);
        const modelLoss = -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
        const baseLoss = -(y * Math.log(base) + (1 - y) * Math.log(1 - base));
        const a = 0.01;
        this.gain = this.gainN === 0 ? baseLoss - modelLoss : (1 - a) * this.gain + a * (baseLoss - modelLoss);
        this.gainN += 1;
        // Then learn from it.
        features(d, j, this.win, this.x);
        let z = 0;
        for (let k = 0; k < FEATURES; k++) z += this.weights[k] * this.x[k];
        const g = sigmoid(z) - y;
        for (let k = 0; k < FEATURES; k++) this.weights[k] -= MODEL_LR * (g * this.x[k] + MODEL_L2 * this.weights[k]);
        this.learned += 1;
    }

    /** The three digits that have been followed by the most wins (shrunk toward the base rate). */
    learnedDigits(): number[] {
        if (this.top3) return this.top3;
        const k = 25;
        const ranked = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
            .map(x => ({ x, r: (this.digitW[x] + k * this.p) / (this.digitN[x] + k) }))
            .sort((a, b) => b.r - a.r || a.x - b.x);
        this.top3 = ranked.slice(0, 3).map(r => r.x);
        return this.top3;
    }

    /** Patterns (previous digit, this digit) that have been followed by wins, best first. */
    topPairs(count = 3): Array<{ pair: string; rate: number; n: number }> {
        const k = 12;
        const out: Array<{ pair: string; rate: number; n: number }> = [];
        for (let idx = 0; idx < 100; idx++) {
            if (this.pairN[idx] < 5) continue;
            out.push({ pair: `${Math.floor(idx / 10)}${idx % 10}`, rate: (this.pairW[idx] + k * this.p) / (this.pairN[idx] + k), n: this.pairN[idx] });
        }
        return out.sort((a, b) => b.rate - a.rate || a.pair.localeCompare(b.pair)).slice(0, count);
    }

    aiReady(): boolean {
        return this.learned >= WARMUP;
    }

    /** Model gain over a constant guess, as a share of the constant guess's own loss. Null until it has learned enough. */
    aiSkill(): number | null {
        if (!this.aiReady()) return null;
        const base = clamp(this.p, 0.001, 0.999);
        const entropy = -(base * Math.log(base) + (1 - base) * Math.log(1 - base));
        return entropy > 0 ? this.gain / entropy : 0;
    }

    /** Does `arm` fire on tick i of `d`? Uses only d[0..i]. */
    fires(arm: ArmId, d: readonly number[], i: number): boolean {
        if (i < 0 || i >= d.length) return false;
        switch (arm) {
            case 'LAST_WIN':
                return this.win.has(d[i]);
            case 'LEARNED_DIGITS':
                return this.learnedDigits().includes(d[i]);
            case 'PAIR_PATTERN': {
                if (i < 1) return false;
                const idx = d[i - 1] * 10 + d[i];
                const n = this.pairN[idx];
                return n >= 5 && (this.pairW[idx] + 12 * this.p) / (n + 12) >= this.p + 0.04;
            }
            case 'AI_MODEL': {
                if (!this.aiReady() || i < 19) return false;
                return this.score(d, i) >= this.predMean + AI_SIGMAS * Math.sqrt(this.predVar);
            }
            default:
                return LAB_RULE_BY_ID[arm].fn(d, i, this.win, this.p);
        }
    }

    /** The model's second opinion: is its score at least its own recent average? Passes while the model is still learning. */
    aiAgrees(d: readonly number[], i: number): boolean {
        if (!this.aiReady() || i < 19) return true;
        return this.score(d, i) >= this.predMean;
    }
}

// ---------- replay ----------

export type Evidence = 'LEARNING' | 'FLAT' | 'LEAD' | 'AGAINST';

export type ArmStat = {
    arm: ArmId;
    /** Shadow trades (an arm cannot re-enter while its own trade is open). */
    n: number;
    wins: number;
    rate: number | null;
    restRate: number | null;
    /** Arm minus not-arm, in points. */
    edgePts: number | null;
    z: number | null;
    /** Recency-weighted posterior mean win rate and its standard deviation. */
    post: number;
    sd: number;
    /** Share of ticks it fires on, and the typical wait in ticks. */
    fireRate: number;
    waitTicks: number;
    evidence: Evidence;
    /** Raw counts for pooling across markets. */
    restN: number;
    restW: number;
};

export type BrainCell = {
    symbol: string;
    key: string;
    label: string;
    ticks: number;
    theoretical: number;
    /** Win rate of entering on every tick of this history: what a blind entry would have done. */
    immediateRate: number;
    arms: ArmStat[];
    learnedDigits: number[];
    topPairs: Array<{ pair: string; rate: number; n: number }>;
    aiSkill: number | null;
    fit: Fit;
};

type Acc = { n: number; w: number; dn: number; dw: number; restN: number; restW: number; fires: number; free: number };

function evidenceOf(n: number, z: number | null): Evidence {
    if (z === null || n < MIN_ARM_TRADES) return 'LEARNING';
    if (z >= 2.58) return 'LEAD';
    if (z <= -2) return 'AGAINST';
    return 'FLAT';
}

export function replayCell(symbol: string, digits: readonly number[], contract: Contract, duration: number): BrainCell | null {
    const d = digits.slice(-BRAIN_HISTORY);
    const len = Math.max(1, Math.min(10, Math.trunc(duration) || 1));
    if (d.length < 150 + len) return null;
    const win = new Set(winningDigits(contract));
    const p = winProbability(contract);
    const fit = new Fit(win, p, len, d.length);
    const acc: Acc[] = ARMS.map(() => ({ n: 0, w: 0, dn: 0, dw: 0, restN: 0, restW: 0, fires: 0, free: 0 }));
    const lastI = d.length - len - 1;
    const decay = Math.pow(0.5, 1 / HALF_LIFE);
    let immediateN = 0;
    let immediateW = 0;
    for (let i = 0; i <= lastI; i++) {
        fit.learn(d, i - len); // the outcome of the trigger len ticks ago has just printed
        fit.observe(d, i);
        const won = win.has(d[i + len]) ? 1 : 0;
        const wt = Math.pow(decay, lastI - i);
        immediateN += 1;
        immediateW += won;
        for (let a = 0; a < ARMS.length; a++) {
            const s = acc[a];
            const fired = fit.fires(ARMS[a].id, d, i);
            if (fired) s.fires += 1;
            else {
                s.restN += 1;
                s.restW += won;
            }
            if (fired && i >= s.free) {
                s.n += 1;
                s.w += won;
                s.dn += wt;
                s.dw += wt * won;
                s.free = i + len;
            }
        }
    }
    // The last triggers' outcomes have printed too: learn them so the state matches the live tape.
    for (let j = Math.max(0, lastI - len + 1); j <= lastI; j++) fit.learn(d, j);

    const arms: ArmStat[] = ARMS.map((arm, a) => {
        const s = acc[a];
        const alpha = s.dw + PRIOR_TRADES * p;
        const beta = s.dn - s.dw + PRIOR_TRADES * (1 - p);
        const post = alpha / (alpha + beta);
        const sd = Math.sqrt((post * (1 - post)) / (alpha + beta + 1));
        const rate = s.n ? s.w / s.n : null;
        const restRate = s.restN ? s.restW / s.restN : null;
        let z: number | null = null;
        if (s.n >= 10 && s.restN >= 10 && rate !== null && restRate !== null) {
            const pool = (s.w + s.restW) / (s.n + s.restN);
            const se = Math.sqrt(pool * (1 - pool) * (1 / s.n + 1 / s.restN));
            z = se > 0 ? (rate - restRate) / se : 0;
        }
        const fireRate = s.fires / (lastI + 1);
        return {
            arm: arm.id,
            n: s.n,
            wins: s.w,
            rate,
            restRate,
            edgePts: rate !== null && restRate !== null ? (rate - restRate) * 100 : null,
            z,
            post,
            sd,
            fireRate,
            waitTicks: fireRate > 0 ? 1 / fireRate : Infinity,
            evidence: evidenceOf(s.n, z),
            restN: s.restN,
            restW: s.restW,
        };
    });
    return {
        symbol,
        key: contractKey(contract),
        label: contractLabel(contract),
        ticks: d.length,
        theoretical: p,
        immediateRate: immediateN ? immediateW / immediateN : p,
        arms,
        learnedDigits: fit.learnedDigits(),
        topPairs: fit.topPairs(),
        aiSkill: fit.aiSkill(),
        fit,
    };
}

export type LeaderRow = { arm: ArmId; n: number; wins: number; rate: number | null; restRate: number | null; edgePts: number | null; z: number | null; evidence: Evidence };

export type BrainReport = {
    cells: BrainCell[];
    /** Every arm pooled across all markets and contracts, best z first. */
    leaderboard: LeaderRow[];
    /** Average AI skill across cells where the model has learned enough, or null. */
    aiSkill: number | null;
    builtAt: number;
};

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
    const leaderboard: LeaderRow[] = ARMS.map(arm => {
        let n = 0;
        let w = 0;
        let rn = 0;
        let rw = 0;
        for (const c of cells) {
            const s = c.arms.find(x => x.arm === arm.id)!;
            n += s.n;
            w += s.wins;
            rn += s.restN;
            rw += s.restW;
        }
        const rate = n ? w / n : null;
        const restRate = rn ? rw / rn : null;
        let z: number | null = null;
        if (n >= 10 && rn >= 10 && rate !== null && restRate !== null) {
            const pool = (w + rw) / (n + rn);
            const se = Math.sqrt(pool * (1 - pool) * (1 / n + 1 / rn));
            z = se > 0 ? (rate - restRate) / se : 0;
        }
        return { arm: arm.id, n, wins: w, rate, restRate, edgePts: rate !== null && restRate !== null ? (rate - restRate) * 100 : null, z, evidence: evidenceOf(n, z) };
    }).sort((a, b) => (b.z ?? -99) - (a.z ?? -99));
    const skills = cells.map(c => c.aiSkill).filter((x): x is number => x !== null);
    return { cells, leaderboard, aiSkill: skills.length ? skills.reduce((a, b) => a + b, 0) / skills.length : null, builtAt: now };
}

export const findCell = (report: BrainReport | null, symbol: string, contract: Contract): BrainCell | null =>
    report?.cells.find(c => c.symbol === symbol && c.key === contractKey(contract)) ?? null;

// ---------- plan ----------

export type Plan = {
    arm: ArmId;
    label: string;
    kind: ArmKind;
    /** One plain sentence on why this entry was chosen. */
    why: string;
    evidence: Evidence;
    /** Typical wait for this plan to fire, in ticks, or null when unknown. */
    waitTicks: number | null;
    /** Recovery: the AI model must also agree before the trade is placed. */
    aiLock: boolean;
};

export type PlanOptions = {
    rng: () => number;
    exclude?: readonly ArmId[];
    /** Arms that would typically wait longer than this are not chosen unless nothing else is left. */
    maxWaitTicks: number;
    /** Recovery: pick by lower confidence bound (the most proven plan) instead of sampling, and add the AI lock. */
    strict: boolean;
};

/** A plan that exists even before the Brain has any history, so no trade is ever entered blindly. */
export const fallbackPlan = (strict: boolean): Plan => ({
    arm: 'LAST_WIN',
    label: ARM_BY_ID.LAST_WIN.label,
    kind: 'DIGIT',
    why: 'The Brain is still collecting ticks for this market, so it enters after a winning digit.',
    evidence: 'LEARNING',
    waitTicks: null,
    aiLock: strict,
});

function randn(rng: () => number): number {
    const u = Math.max(1e-12, rng());
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

function describe(cell: BrainCell, s: ArmStat, strict: boolean): string {
    const arm = ARM_BY_ID[s.arm];
    const wait = Number.isFinite(s.waitTicks) ? `about every ${Math.max(1, Math.round(s.waitTicks))} ticks` : 'rarely';
    let detail = '';
    if (s.arm === 'LEARNED_DIGITS') detail = ` Digits ${cell.learnedDigits.join(', ')}.`;
    if (s.arm === 'PAIR_PATTERN' && cell.topPairs.length) detail = ` Best patterns ${cell.topPairs.map(t => t.pair.split('').join('→')).join(', ')}.`;
    const record = s.rate === null || s.n < 10 ? 'still learning here' : `${pct1(s.rate)} over ${s.n} shadow trades (base ${pct1(cell.theoretical)})`;
    return `${arm.label}: ${record}, fires ${wait}.${detail}${strict ? ' Recovery: most proven plan, AI must agree.' : ''}`;
}

/** Choose the entry plan for a market and contract. Always returns a plan. */
export function choosePlan(cell: BrainCell | null, opts: PlanOptions): Plan {
    if (!cell) return fallbackPlan(opts.strict);
    const excluded = new Set(opts.exclude ?? []);
    let pool = cell.arms.filter(a => !excluded.has(a.arm) && a.fireRate > 0 && a.waitTicks <= opts.maxWaitTicks);
    if (!pool.length) pool = cell.arms.filter(a => !excluded.has(a.arm) && a.fireRate > 0).sort((a, b) => b.fireRate - a.fireRate).slice(0, 3);
    if (!pool.length) pool = cell.arms.filter(a => !excluded.has(a.arm));
    if (!pool.length) pool = cell.arms;
    let best = pool[0];
    let bestScore = -Infinity;
    for (const a of pool) {
        const score = opts.strict ? a.post - a.sd : a.post + a.sd * randn(opts.rng);
        if (score > bestScore) {
            bestScore = score;
            best = a;
        }
    }
    const arm = ARM_BY_ID[best.arm];
    return {
        arm: best.arm,
        label: arm.label,
        kind: arm.kind,
        why: describe(cell, best, opts.strict),
        evidence: best.evidence,
        waitTicks: Number.isFinite(best.waitTicks) ? best.waitTicks : null,
        aiLock: opts.strict,
    };
}

/** Does the plan fire on the latest tick of `digits`? */
export function planFires(plan: Plan, cell: BrainCell | null, digits: readonly number[], contract: Contract): boolean {
    const i = digits.length - 1;
    if (i < 0) return false;
    if (cell) {
        if (!cell.fit.fires(plan.arm, digits, i)) return false;
        return plan.aiLock ? cell.fit.aiAgrees(digits, i) : true;
    }
    // No fitted state: only the arms that need none can fire.
    if (plan.arm === 'LEARNED_DIGITS' || plan.arm === 'PAIR_PATTERN' || plan.arm === 'AI_MODEL') return false;
    const win = new Set(winningDigits(contract));
    const probe = new Fit(win, winProbability(contract), 1, 1);
    return probe.fires(plan.arm, digits, i);
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

/** Did plan-timed entries win more than entering on a random tick of the same markets would have? */
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
            ? 'Too few plan-timed trades to judge yet.'
            : z >= 1.96
              ? 'Plan-timed entries are winning clearly more than random-tick entries would have.'
              : z <= -1.96
                ? 'Plan-timed entries are winning clearly LESS than random-tick entries would have. Treat the Brain as unproven.'
                : 'No measurable difference from entering on a random tick yet.';
    const byArm = [...by.entries()].map(([arm, r]) => ({ arm, label: ARM_BY_ID[arm]?.label ?? arm, ...r })).sort((a, b) => b.n - a.n);
    return { n, wins, expected, sd, z, verdict, byArm };
}

/** Two-sided p for a z score, for display. */
export const zToP = (z: number) => 2 * (1 - normalCdf(Math.abs(z)));
