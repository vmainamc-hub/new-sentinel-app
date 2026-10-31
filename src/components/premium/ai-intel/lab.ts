// APEX INTEL Strategy Lab: evolutionary search for entry rules, with an honest hold-out.
//
// 1. Each market's ticks are cut in time order: the first `trainFraction` is TRAIN, the rest is VALIDATION. The split is
//    fixed when the run starts, so ticks that arrive later cannot leak in.
// 2. Candidates (a trigger-digit set + an optional condition on the preceding ticks) are scored on TRAIN ONLY with the
//    Sixfold-compatible simulator, by the lower bound of the win-rate interval so lucky small samples rank low.
// 3. The best survive, are mutated and recombined for several generations (evolutionary search).
// 4. Only the final top candidates are tested ONCE on VALIDATION, which selection never saw. Their p-values are exact
//    binomial tails, corrected for the number of survivors tested (Benjamini-Hochberg). A candidate passes only with
//    enough validation trades, q <= 0.05, a win rate above chance, and no collapse from train to validation.
// On fair random digits the expected outcome is that nothing passes. The lab reports that rather than hiding it.
import { winProbability } from '@/components/premium/sixfold/bot';
import { bhAdjust, binomialUpperP, mulberry32, wilson } from '@/components/premium/sixfold/stats';
import { FDR_Q, MIN_TRADES } from './analysis';
import { type PickDirection, contractOf } from './picker';
import { compileRule, describeRule, normalizeRule, type PrevKind, type RuleSpec, ruleKey } from './rules';
import { simulate, ticksFromDigits } from './sim';

export type LabConfig = {
    markets: string[];
    direction: 'BOTH' | PickDirection;
    duration: number;
    population: number;
    generations: number;
    seed: number;
    trainFraction: number;
    minTrainTrades: number;
    keep: number;
    /** Use only the most recent N ticks of each market (0 = all available). */
    sampleTicks: number;
};

export const DEFAULT_LAB: LabConfig = { markets: [], direction: 'BOTH', duration: 1, population: 60, generations: 12, seed: 1, trainFraction: 0.6, minTrainTrades: 40, keep: 8, sampleTicks: 0 };

export const normalizeLab = (c: Partial<LabConfig>): LabConfig => {
    const d = DEFAULT_LAB;
    const n = (x: unknown, lo: number, hi: number, f: number) => (Number.isFinite(Number(x)) ? Math.max(lo, Math.min(hi, Number(x))) : f);
    return {
        markets: Array.isArray(c.markets) ? c.markets.map(String) : d.markets,
        direction: c.direction === 'OVER_2' || c.direction === 'UNDER_7' ? c.direction : 'BOTH',
        duration: Math.trunc(n(c.duration, 1, 10, d.duration)),
        population: Math.trunc(n(c.population, 10, 400, d.population)),
        generations: Math.trunc(n(c.generations, 1, 60, d.generations)),
        seed: Math.trunc(n(c.seed, 1, 2 ** 31 - 1, d.seed)),
        trainFraction: n(c.trainFraction, 0.4, 0.8, d.trainFraction),
        minTrainTrades: Math.trunc(n(c.minTrainTrades, 10, 1000, d.minTrainTrades)),
        keep: Math.trunc(n(c.keep, 1, 30, d.keep)),
        sampleTicks: Math.trunc(n(c.sampleTicks, 0, 100000, d.sampleTicks)),
    };
};

export type Stats = { trades: number; wins: number; rate: number | null; lo: number; hi: number; p: number | null; baseline: number };
export type Scored = { direction: PickDirection; rule: RuleSpec; key: string; train: Stats; score: number };
export type LabCandidate = {
    direction: PickDirection;
    rule: RuleSpec;
    description: string;
    train: Stats;
    validation: Stats;
    q: number | null;
    /** Train win rate minus validation win rate, points (positive = it got worse on unseen ticks). */
    degradationPts: number | null;
    passed: boolean;
    reasons: string[];
};

type Segments = Record<string, { train: number[]; valid: number[] }>;

function evaluate(digitsByMarket: ReadonlyArray<readonly number[]>, direction: PickDirection, rule: RuleSpec, duration: number): Stats {
    const contract = contractOf(direction);
    const trigger = compileRule(rule, contract);
    let trades = 0;
    let wins = 0;
    for (const digits of digitsByMarket) {
        for (const t of simulate(ticksFromDigits(digits), contract, { method: 'SMART', trigger }, duration).trades) {
            trades += 1;
            if (t.won) wins += 1;
        }
    }
    const baseline = winProbability(contract);
    const w = trades ? wilson(wins, trades) : { lo: 0, hi: 1 };
    return { trades, wins, rate: trades ? wins / trades : null, lo: w.lo, hi: w.hi, p: trades ? binomialUpperP(wins, trades, baseline) : null, baseline };
}

export type LabState = 'idle' | 'running' | 'paused' | 'done' | 'stopped';
export type LabSnapshot = {
    state: LabState;
    generation: number;
    generations: number;
    evaluated: number;
    best: Scored | null;
    results: LabCandidate[];
    note: string | null;
    config: LabConfig;
    /** Ticks in TRAIN and VALIDATION across all studied markets. */
    ticks: { train: number; validation: number } | null;
};

const PREV_KINDS: PrevKind[] = ['ANY', 'ALL_WIN', 'ALL_LOSE'];

export class LabRunner {
    private state: LabState = 'idle';
    private cfg: LabConfig = DEFAULT_LAB;
    private seg: Segments = {};
    private rand: () => number = Math.random;
    private pop: Array<{ direction: PickDirection; rule: RuleSpec }> = [];
    private cache = new Map<string, Scored>();
    private gen = 0;
    private evaluated = 0;
    private best: Scored | null = null;
    private results: LabCandidate[] = [];
    private note: string | null = null;
    private ticks: LabSnapshot['ticks'] = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private listeners = new Set<() => void>();
    private snap: LabSnapshot;

    constructor(
        private getSeries: () => Record<string, readonly number[]>,
        private onFinished?: (results: LabCandidate[], cfg: LabConfig) => void
    ) {
        this.snap = this.build();
    }

    subscribe = (l: () => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    };
    getSnapshot = () => this.snap;

    private build(): LabSnapshot {
        return { state: this.state, generation: this.gen, generations: this.cfg.generations, evaluated: this.evaluated, best: this.best, results: this.results, note: this.note, config: this.cfg, ticks: this.ticks };
    }
    private emit() {
        this.snap = this.build();
        this.listeners.forEach(l => l());
    }

    start(config: Partial<LabConfig>) {
        if (this.state === 'running' || this.state === 'paused') return;
        this.cfg = normalizeLab(config);
        const all = this.getSeries();
        const markets = (this.cfg.markets.length ? this.cfg.markets : Object.keys(all)).filter(m => (all[m]?.length ?? 0) >= 200);
        this.seg = {};
        let train = 0;
        let valid = 0;
        for (const m of markets) {
            const src = this.cfg.sampleTicks > 0 ? all[m].slice(-this.cfg.sampleTicks) : all[m].slice();
            const cut = Math.floor(src.length * this.cfg.trainFraction);
            this.seg[m] = { train: src.slice(0, cut), valid: src.slice(cut) };
            train += cut;
            valid += src.length - cut;
        }
        this.ticks = { train, validation: valid };
        this.gen = 0;
        this.evaluated = 0;
        this.best = null;
        this.results = [];
        this.cache = new Map();
        this.rand = mulberry32(this.cfg.seed);
        if (!markets.length) {
            this.state = 'stopped';
            this.note = 'No market has 200+ ticks yet. Connect the feed and wait.';
            return this.emit();
        }
        this.note = null;
        this.pop = Array.from({ length: this.cfg.population }, () => this.randomCandidate());
        this.state = 'running';
        this.emit();
        this.schedule();
    }

    pause() {
        if (this.state !== 'running') return;
        this.state = 'paused';
        this.clear();
        this.emit();
    }
    resume() {
        if (this.state !== 'paused') return;
        this.state = 'running';
        this.emit();
        this.schedule();
    }
    stop() {
        if (this.state !== 'running' && this.state !== 'paused') return;
        this.clear();
        this.state = 'stopped';
        this.note = 'Stopped before validation. Nothing was saved.';
        this.emit();
    }

    private clear() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
    private schedule() {
        this.clear();
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.state !== 'running') return;
            this.step();
            if (this.state === 'running') this.schedule();
        }, 0);
    }

    private pickDirection(): PickDirection {
        return this.cfg.direction === 'BOTH' ? (this.rand() < 0.5 ? 'OVER_2' : 'UNDER_7') : this.cfg.direction;
    }
    private randomCandidate() {
        const size = 1 + Math.floor(this.rand() * 3);
        const digits = new Set<number>();
        while (digits.size < size) digits.add(Math.floor(this.rand() * 10));
        const kind = PREV_KINDS[Math.floor(this.rand() * 3)];
        return { direction: this.pickDirection(), rule: normalizeRule({ digits: [...digits], prev: { kind, k: 1 + Math.floor(this.rand() * 3) } }) };
    }
    private mutate(c: { direction: PickDirection; rule: RuleSpec }) {
        const r = normalizeRule(c.rule);
        const digits = new Set(r.digits);
        let prev = { ...r.prev };
        if (this.rand() < 0.6) {
            const d = Math.floor(this.rand() * 10);
            if (digits.has(d)) {
                if (digits.size > 1) digits.delete(d);
            } else if (digits.size < 4) digits.add(d);
        } else {
            prev = { kind: PREV_KINDS[Math.floor(this.rand() * 3)], k: 1 + Math.floor(this.rand() * 3) };
        }
        return { direction: c.direction, rule: normalizeRule({ digits: [...digits], prev }) };
    }

    private score(c: { direction: PickDirection; rule: RuleSpec }): Scored {
        const key = `${c.direction}|${ruleKey(c.rule)}`;
        const hit = this.cache.get(key);
        if (hit) return hit;
        const train = evaluate(Object.values(this.seg).map(s => s.train), c.direction, c.rule, this.cfg.duration);
        // Too few trades is not evidence: it ranks below every candidate that has enough.
        const score = train.trades >= this.cfg.minTrainTrades ? train.lo - train.baseline : -1 + train.trades / 10000;
        const s: Scored = { direction: c.direction, rule: normalizeRule(c.rule), key, train, score };
        this.cache.set(key, s);
        this.evaluated += 1;
        return s;
    }

    /** One generation. Exposed so tests and callers can drive it synchronously. */
    step() {
        if (this.state !== 'running') return;
        const scored = this.pop.map(c => this.score(c)).sort((a, b) => b.score - a.score);
        if (!this.best || scored[0].score > this.best.score) this.best = scored[0];
        this.gen += 1;
        if (this.gen >= this.cfg.generations) {
            this.finish();
            return;
        }
        const elite = scored.slice(0, Math.max(2, Math.floor(this.cfg.population / 4)));
        const next: Array<{ direction: PickDirection; rule: RuleSpec }> = elite.map(e => ({ direction: e.direction, rule: e.rule }));
        while (next.length < this.cfg.population) {
            const roll = this.rand();
            if (roll < 0.15) next.push(this.randomCandidate());
            else if (roll < 0.35) {
                // crossover: digits of one elite, condition of another (same direction only)
                const a = elite[Math.floor(this.rand() * elite.length)];
                const peers = elite.filter(e => e.direction === a.direction);
                const b = peers[Math.floor(this.rand() * peers.length)];
                next.push({ direction: a.direction, rule: normalizeRule({ digits: a.rule.digits, prev: b.rule.prev }) });
            } else {
                const p = elite[Math.floor(this.rand() * elite.length)];
                next.push(this.mutate(p));
            }
        }
        this.pop = next;
        this.emit();
    }

    private finish() {
        const finalists = [...this.cache.values()]
            .filter(s => s.train.trades >= this.cfg.minTrainTrades)
            .sort((a, b) => b.score - a.score)
            .slice(0, this.cfg.keep);
        const validations = finalists.map(f => evaluate(Object.values(this.seg).map(s => s.valid), f.direction, f.rule, this.cfg.duration));
        const q = bhAdjust(validations.map(v => (v.trades >= MIN_TRADES ? v.p : null)));
        this.results = finalists.map((f, i) => {
            const v = validations[i];
            const reasons: string[] = [];
            const degradation = f.train.rate !== null && v.rate !== null ? (f.train.rate - v.rate) * 100 : null;
            if (v.trades < MIN_TRADES) reasons.push(`only ${v.trades} validation trades (needs ${MIN_TRADES})`);
            if (q[i] === null || (q[i] as number) > FDR_Q) reasons.push(`not significant on unseen ticks (q=${q[i] === null ? 'n/a' : (q[i] as number).toFixed(3)} > ${FDR_Q})`);
            if (v.rate === null || v.rate <= v.baseline) reasons.push('validation win rate is not above chance');
            if (degradation !== null && degradation > 5) reasons.push(`overfit: win rate fell ${degradation.toFixed(1)} pts from train to validation`);
            return {
                direction: f.direction,
                rule: f.rule,
                description: describeRule(f.rule, f.direction),
                train: f.train,
                validation: v,
                q: q[i],
                degradationPts: degradation,
                passed: reasons.length === 0,
                reasons,
            };
        });
        this.state = 'done';
        const passed = this.results.filter(r => r.passed).length;
        this.note = passed
            ? `${passed} of ${this.results.length} finalists held up on unseen ticks. Treat that as a lead to keep testing, not a guarantee.`
            : `None of the ${this.results.length} finalists beat chance on unseen ticks. On random digits that is the expected result.`;
        this.emit();
        try {
            this.onFinished?.(this.results, this.cfg);
        } catch {
            /* saving results must not break the lab */
        }
    }
}
