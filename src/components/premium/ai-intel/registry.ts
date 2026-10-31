// APEX INTEL strategy registry: every strategy the lab (or a person) creates, with versions, a lifecycle and an audit trail.
//
// Rules this enforces:
//  - A strategy's rule is immutable. Changing a rule means a NEW version (version + 1); the old one stays recoverable.
//  - Status changes are explicit, validated against allowed transitions and logged with who/why/when. Nothing becomes
//    APPROVED or ACTIVE by itself: the lab can only create EXPERIMENTAL / UNDER_VALIDATION / RETIRED entries.
//  - A strategy can only be APPROVED if it passed the hold-out validation (or the person overrides, which is logged).
//  - Live losses never rewrite a rule. Deterioration can only SUSPEND (see agents.ts), and a person re-approves.
import type { LabCandidate, LabConfig } from './lab';
import type { PickDirection } from './picker';
import { type Candidate } from './picker';
import { describeRule, type RuleSpec, ruleKey } from './rules';

export type StrategyStatus = 'EXPERIMENTAL' | 'UNDER_VALIDATION' | 'APPROVED' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
export const STATUS_LABEL: Record<StrategyStatus, string> = {
    EXPERIMENTAL: 'Experimental',
    UNDER_VALIDATION: 'Under validation',
    APPROVED: 'Approved',
    ACTIVE: 'Active',
    SUSPENDED: 'Suspended',
    RETIRED: 'Retired',
};

const ALLOWED: Record<StrategyStatus, StrategyStatus[]> = {
    EXPERIMENTAL: ['UNDER_VALIDATION', 'RETIRED'],
    UNDER_VALIDATION: ['APPROVED', 'EXPERIMENTAL', 'RETIRED'],
    APPROVED: ['ACTIVE', 'SUSPENDED', 'RETIRED'],
    ACTIVE: ['APPROVED', 'SUSPENDED', 'RETIRED'],
    SUSPENDED: ['APPROVED', 'RETIRED'],
    RETIRED: [],
};

export type StatusChange = { at: number; from: StrategyStatus | null; to: StrategyStatus; by: 'lab' | 'user' | 'monitor'; note: string };

export type Strategy = {
    /** Same for every version of one strategy. */
    familyId: string;
    version: number;
    /** `${familyId}@v${version}` */
    id: string;
    name: string;
    description: string;
    direction: PickDirection;
    rule: RuleSpec;
    ruleKey: string;
    duration: number;
    /** Markets the lab studied (the strategy is only eligible there). */
    markets: string[];
    status: StrategyStatus;
    createdAt: number;
    trainPeriod: { ticks: number; trades: number; rate: number | null };
    validationPeriod: { ticks: number; trades: number; rate: number | null; q: number | null };
    passedValidation: boolean;
    validationNotes: string[];
    history: StatusChange[];
};

export type RegistryStorage = { load: () => Strategy[] | null; save: (s: Strategy[]) => void };

const MAX_STRATEGIES = 300;

export class StrategyRegistry {
    private items: Strategy[];
    private listeners = new Set<() => void>();
    private snap: readonly Strategy[];

    constructor(
        private storage: RegistryStorage,
        private now: () => number = () => Date.now()
    ) {
        this.items = (storage.load() ?? []).filter(s => s && s.id && s.rule);
        this.snap = this.items.slice();
    }

    subscribe = (l: () => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    };
    getSnapshot = (): readonly Strategy[] => this.snap;

    private commit() {
        if (this.items.length > MAX_STRATEGIES) {
            // Drop the oldest RETIRED entries first; never an approved/active one.
            const keep: Strategy[] = [];
            let excess = this.items.length - MAX_STRATEGIES;
            for (const s of [...this.items].sort((a, b) => a.createdAt - b.createdAt)) {
                if (excess > 0 && s.status === 'RETIRED') excess -= 1;
                else keep.push(s);
            }
            this.items = keep.sort((a, b) => b.createdAt - a.createdAt);
        }
        this.snap = this.items.slice();
        try {
            this.storage.save(this.items);
        } catch {
            /* storage unavailable: the registry still works in memory */
        }
        this.listeners.forEach(l => l());
    }

    get(id: string): Strategy | undefined {
        return this.items.find(s => s.id === id);
    }

    /** Every version of one strategy, newest first. */
    versions(familyId: string): Strategy[] {
        return this.items.filter(s => s.familyId === familyId).sort((a, b) => b.version - a.version);
    }

    /**
     * Store the lab's finalists. Passed -> UNDER_VALIDATION (awaiting a person), failed -> RETIRED with the reasons.
     * A rule already stored for the same direction and markets is skipped, so re-running the lab never duplicates or
     * silently replaces an existing strategy.
     */
    addFromLab(results: readonly LabCandidate[], cfg: LabConfig, ticks: { train: number; validation: number } | null): Strategy[] {
        const added: Strategy[] = [];
        for (const r of results) {
            const key = ruleKey(r.rule);
            const mk = [...cfg.markets].sort().join(',');
            if (this.items.some(s => s.ruleKey === key && s.direction === r.direction && s.duration === cfg.duration && [...s.markets].sort().join(',') === mk)) continue;
            const at = this.now();
            const familyId = `S-${at.toString(36)}-${this.items.length + added.length}`;
            const status: StrategyStatus = r.passed ? 'UNDER_VALIDATION' : 'RETIRED';
            const s: Strategy = {
                familyId,
                version: 1,
                id: `${familyId}@v1`,
                name: `${r.direction === 'UNDER_7' ? 'U7' : 'O2'}·${r.rule.digits.join('')}·${r.rule.prev.kind === 'ANY' ? 'any' : `${r.rule.prev.kind === 'ALL_WIN' ? 'w' : 'l'}${r.rule.prev.k}`}`,
                description: describeRule(r.rule, r.direction),
                direction: r.direction,
                rule: r.rule,
                ruleKey: key,
                duration: cfg.duration,
                markets: [...cfg.markets],
                status,
                createdAt: at,
                trainPeriod: { ticks: ticks?.train ?? 0, trades: r.train.trades, rate: r.train.rate },
                validationPeriod: { ticks: ticks?.validation ?? 0, trades: r.validation.trades, rate: r.validation.rate, q: r.q },
                passedValidation: r.passed,
                validationNotes: r.reasons,
                history: [
                    { at, from: null, to: 'EXPERIMENTAL', by: 'lab', note: 'Generated by the Strategy Lab' },
                    { at, from: 'EXPERIMENTAL', to: status, by: 'lab', note: r.passed ? 'Held up on unseen ticks; needs your approval' : `Failed validation: ${r.reasons.join('; ')}` },
                ],
            };
            this.items.unshift(s);
            added.push(s);
        }
        if (added.length) this.commit();
        return added;
    }

    /** Move a strategy along the allowed lifecycle. Returns an error string, or null on success. */
    setStatus(id: string, to: StrategyStatus, by: StatusChange['by'], note: string, opts: { override?: boolean } = {}): string | null {
        const s = this.get(id);
        if (!s) return 'Unknown strategy.';
        if (s.status === to) return null;
        if (!ALLOWED[s.status].includes(to)) return `A ${STATUS_LABEL[s.status].toLowerCase()} strategy cannot become ${STATUS_LABEL[to].toLowerCase()}.`;
        if (to === 'APPROVED' && s.status === 'UNDER_VALIDATION' && !s.passedValidation && !opts.override) {
            return 'It did not pass validation on unseen ticks. Approving it anyway needs an explicit override.';
        }
        if (to === 'ACTIVE' && by === 'monitor') return 'Only a person can activate a strategy.';
        if (to === 'APPROVED' && by === 'monitor') return 'Only a person can approve a strategy.';
        const from = s.status;
        s.status = to;
        s.history = [...s.history, { at: this.now(), from, to, by, note: opts.override ? `${note} (override of failed validation)` : note }];
        this.commit();
        return null;
    }

    /** A new version of an existing strategy with a changed rule. The old version is untouched and stays recoverable. */
    newVersion(id: string, rule: RuleSpec, note: string): Strategy | string {
        const base = this.get(id);
        if (!base) return 'Unknown strategy.';
        const key = ruleKey(rule);
        if (this.versions(base.familyId).some(v => v.ruleKey === key)) return 'That rule already exists as a version of this strategy.';
        const at = this.now();
        const version = Math.max(...this.versions(base.familyId).map(v => v.version)) + 1;
        const s: Strategy = {
            ...base,
            version,
            id: `${base.familyId}@v${version}`,
            description: describeRule(rule, base.direction),
            rule,
            ruleKey: key,
            status: 'EXPERIMENTAL',
            createdAt: at,
            passedValidation: false,
            validationNotes: ['New version: validate it before approving'],
            validationPeriod: { ticks: 0, trades: 0, rate: null, q: null },
            history: [{ at, from: null, to: 'EXPERIMENTAL', by: 'user', note: `Version ${version} of ${base.familyId}: ${note}` }],
        };
        this.items.unshift(s);
        this.commit();
        return s;
    }

    /** Make an earlier version the active one again: the current active/approved version is suspended, the earlier one approved and activated. */
    rollback(id: string, note = 'Rolled back'): string | null {
        const target = this.get(id);
        if (!target) return 'Unknown strategy.';
        if (target.status === 'RETIRED') return 'A retired version cannot be restored.';
        for (const v of this.versions(target.familyId)) {
            if (v.id !== id && (v.status === 'ACTIVE' || v.status === 'APPROVED')) this.setStatus(v.id, 'SUSPENDED', 'user', `Replaced by rollback to v${target.version}`);
        }
        if (target.status === 'SUSPENDED') {
            const e = this.setStatus(id, 'APPROVED', 'user', note);
            if (e) return e;
        }
        return target.status === 'ACTIVE' ? null : this.setStatus(id, 'ACTIVE', 'user', note);
    }

    /** What the picker may trade: ACTIVE strategies only. */
    activeCandidates(): Candidate[] {
        return this.items
            .filter(s => s.status === 'ACTIVE')
            .map(s => ({ direction: s.direction, entry: 'SMART' as const, rule: s.rule, strategyId: s.id, strategyLabel: s.name, markets: s.markets, duration: s.duration }));
    }
}

export const localStorageRegistry = (key: string): RegistryStorage => ({
    load: () => {
        try {
            const raw = window.localStorage.getItem(key);
            return raw ? (JSON.parse(raw) as Strategy[]) : null;
        } catch {
            return null;
        }
    },
    save: s => {
        try {
            window.localStorage.setItem(key, JSON.stringify(s));
        } catch {
            /* storage unavailable or full */
        }
    },
});
