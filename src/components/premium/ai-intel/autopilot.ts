// APEX INTEL autopilot: closes the loop from "the lab found something" to "the executor trades it", under fixed, audited rules.
//   1. Research: while enabled it re-runs the Strategy Lab in the background (new seed each time) on markets with enough ticks.
//   2. Promotion: a strategy that PASSED validation on unseen ticks is approved; an approved one is activated (the executor
//      then trades it as a SMART entry) once its forward test, paper-trading ticks that arrived AFTER approval, clears the
//      chosen bar. The monitor still suspends any strategy that fails forward.
// Levels:  OFF no automatic moves | STRICT 60+ forward trades and the interval's lower end above chance
//          BALANCED 30+ forward trades and win rate at or above chance | FAST activate as soon as validation is passed.
// Every move is written to the strategy's audit history as `auto`. It cannot edit a rule, and it never touches stakes or limits.
// On random digits almost nothing passes validation, so expect it to find little; that is reported, not hidden.
import { MIN_TRADES } from './analysis';
import type { LabConfig, LabSnapshot } from './lab';
import type { Forward } from './monitor';
import type { Strategy, StrategyStatus } from './registry';

export type PromoteLevel = 'OFF' | 'STRICT' | 'BALANCED' | 'FAST';
export type AutopilotConfig = { research: boolean; promote: PromoteLevel; maxActive: number; everyMin: number };
export const DEFAULT_AUTOPILOT: AutopilotConfig = { research: true, promote: 'BALANCED', maxActive: 3, everyMin: 10 };

export const normalizeAutopilot = (c: Partial<AutopilotConfig> | null | undefined): AutopilotConfig => {
    const r = c ?? {};
    const n = (x: unknown, lo: number, hi: number, f: number) => (Number.isFinite(Number(x)) ? Math.max(lo, Math.min(hi, Math.trunc(Number(x)))) : f);
    return {
        research: r.research ?? DEFAULT_AUTOPILOT.research,
        promote: r.promote === 'OFF' || r.promote === 'STRICT' || r.promote === 'FAST' ? r.promote : r.promote === 'BALANCED' ? 'BALANCED' : DEFAULT_AUTOPILOT.promote,
        maxActive: n(r.maxActive, 1, 10, DEFAULT_AUTOPILOT.maxActive),
        everyMin: n(r.everyMin, 2, 240, DEFAULT_AUTOPILOT.everyMin),
    };
};

export type Move = { id: string; to: 'APPROVED' | 'ACTIVE'; note: string };

const BALANCED_MIN = 30;

function clears(level: PromoteLevel, f: Forward | undefined): string | null {
    if (level === 'FAST') return 'fast mode: activated on validation alone';
    if (!f || f.suspended) return null;
    if (level === 'BALANCED' && f.trades >= BALANCED_MIN && f.rate !== null && f.rate >= f.baseline) return `forward test ${f.wins}/${f.trades} (${(f.rate * 100).toFixed(1)}%) at or above chance ${(f.baseline * 100).toFixed(0)}%`;
    if (level === 'STRICT' && f.trades >= MIN_TRADES && f.lo >= f.baseline) return `forward test ${f.wins}/${f.trades}: interval floor ${(f.lo * 100).toFixed(1)}% above chance ${(f.baseline * 100).toFixed(0)}%`;
    return null;
}

/** Pure: which strategies move forward right now. */
export function decidePromotions(strategies: readonly Strategy[], forward: readonly Forward[], cfg: AutopilotConfig): Move[] {
    if (cfg.promote === 'OFF') return [];
    const moves: Move[] = [];
    const pending = strategies.filter(s => s.status === 'UNDER_VALIDATION' && s.passedValidation);
    for (const s of pending) moves.push({ id: s.id, to: 'APPROVED', note: `Auto: passed validation on unseen ticks (q=${s.validationPeriod.q === null ? 'n/a' : s.validationPeriod.q.toFixed(3)})` });
    let active = strategies.filter(s => s.status === 'ACTIVE').length;
    const queue = [...strategies.filter(s => s.status === 'APPROVED'), ...pending].sort((a, b) => (b.validationPeriod.rate ?? 0) - (a.validationPeriod.rate ?? 0));
    for (const s of queue) {
        if (active >= cfg.maxActive) break;
        const why = clears(cfg.promote, forward.find(f => f.strategyId === s.id));
        if (why) {
            moves.push({ id: s.id, to: 'ACTIVE', note: `Auto: ${why}` });
            active += 1;
        }
    }
    return moves;
}

export type AutopilotSnapshot = { config: AutopilotConfig; lastCycleAt: number | null; nextResearchAt: number | null; researchRuns: number; moves: Array<{ at: number; id: string; to: StrategyStatus; ok: boolean; note: string }> };

export type AutopilotDeps = {
    strategies: () => readonly Strategy[];
    forward: () => readonly Forward[];
    setStatus: (id: string, to: StrategyStatus, by: 'auto', note: string) => string | null;
    lab: { getSnapshot: () => LabSnapshot; start: (c: Partial<LabConfig>) => void };
    series: () => Record<string, readonly number[]>;
    duration: () => number;
    now: () => number;
    load?: () => Partial<AutopilotConfig> | null;
    save?: (c: AutopilotConfig) => void;
};

/** Ticks a market needs before the lab studies it (train + unseen validation). */
export const RESEARCH_MIN_TICKS = 1000;

export class Autopilot {
    private cfg: AutopilotConfig;
    private lastCycleAt: number | null = null;
    private nextResearchAt: number | null = null;
    private researchRuns = 0;
    private seed: number;
    private moves: AutopilotSnapshot['moves'] = [];
    private listeners = new Set<() => void>();
    private snap: AutopilotSnapshot;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(private d: AutopilotDeps) {
        this.cfg = normalizeAutopilot(d.load?.());
        this.seed = (Math.floor(d.now() / 1000) % 1_000_000) + 1;
        this.snap = this.build();
    }

    subscribe = (l: () => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    };
    getSnapshot = () => this.snap;

    private build(): AutopilotSnapshot {
        return { config: this.cfg, lastCycleAt: this.lastCycleAt, nextResearchAt: this.nextResearchAt, researchRuns: this.researchRuns, moves: this.moves };
    }
    private emit() {
        this.snap = this.build();
        this.listeners.forEach(l => l());
    }

    configure(patch: Partial<AutopilotConfig>) {
        this.cfg = normalizeAutopilot({ ...this.cfg, ...patch });
        this.d.save?.(this.cfg);
        if (patch.research === true) this.nextResearchAt = null;
        this.emit();
    }

    /** One pass: promotions, then research scheduling. Safe to call at any time. */
    cycle() {
        const now = this.d.now();
        this.lastCycleAt = now;
        for (const m of decidePromotions(this.d.strategies(), this.d.forward(), this.cfg)) {
            const err = this.d.setStatus(m.id, m.to, 'auto', m.note);
            this.moves = [{ at: now, id: m.id, to: m.to, ok: err === null, note: err ?? m.note }, ...this.moves].slice(0, 30);
        }
        if (this.cfg.research) {
            const lab = this.d.lab.getSnapshot();
            const idle = lab.state !== 'running' && lab.state !== 'paused';
            if (idle && (this.nextResearchAt === null || now >= this.nextResearchAt)) {
                const series = this.d.series();
                const markets = Object.keys(series).filter(m => series[m].length >= RESEARCH_MIN_TICKS);
                if (markets.length) {
                    this.d.lab.start({ markets, direction: 'BOTH', duration: this.d.duration(), seed: this.seed++ });
                    this.researchRuns += 1;
                    this.nextResearchAt = now + this.cfg.everyMin * 60_000;
                }
            }
        }
        this.emit();
    }

    /** Run in the background. Returns the stop function. */
    start(everyMs = 15_000): () => void {
        if (!this.timer) this.timer = setInterval(() => this.cycle(), everyMs);
        this.cycle();
        return () => {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
        };
    }
}
