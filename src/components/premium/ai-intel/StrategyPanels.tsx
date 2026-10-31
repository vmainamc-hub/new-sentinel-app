// APEX INTEL: Strategy Lab and Strategy Library screens. Everything shown is real lab output or registry state.
import { useState, useSyncExternalStore } from 'react';
import { marketName } from '@/components/premium/sixfold/feed';
import { useFeed } from '@/components/premium/sixfold/use-feed';
import { MIN_TRADES } from './analysis';
import { DEFAULT_LAB, type LabCandidate, type LabConfig } from './lab';
import { labRunner, strategyRegistry } from './registry-instance';
import { STATUS_LABEL, type Strategy, type StrategyStatus } from './registry';

const pct = (x: number | null, d = 1) => (x === null ? '–' : `${(x * 100).toFixed(d)}%`);
const useLab = () => useSyncExternalStore(labRunner.subscribe, labRunner.getSnapshot, labRunner.getSnapshot);
export const useStrategies = () => useSyncExternalStore(strategyRegistry.subscribe, strategyRegistry.getSnapshot, strategyRegistry.getSnapshot);

function Num({ label, value, min, max, step = 1, disabled, onChange }: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (n: number) => void }) {
    return (
        <label className='ai-field'>
            {label}
            <input type='number' value={value} min={min} max={max} step={step} disabled={disabled} onChange={e => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
        </label>
    );
}

function ResultRow({ r }: { r: LabCandidate }) {
    return (
        <div className={`ai-lab-row ${r.passed ? 'pass' : 'fail'}`}>
            <div>
                <b>{r.description}</b>
                <small>{r.passed ? 'Held up on unseen ticks' : r.reasons.join(' · ')}</small>
            </div>
            <div className='ai-kv'>
                <span>Train</span>
                <b>
                    {r.train.trades} trades · {pct(r.train.rate)}
                </b>
            </div>
            <div className='ai-kv'>
                <span>Unseen</span>
                <b>
                    {r.validation.trades} trades · {pct(r.validation.rate)} ({pct(r.validation.lo, 0)}–{pct(r.validation.hi, 0)})
                </b>
            </div>
            <div className='ai-kv'>
                <span>q / chance</span>
                <b>
                    {r.q === null ? '–' : r.q.toFixed(3)} / {pct(r.validation.baseline, 0)}
                </b>
            </div>
        </div>
    );
}

export function StrategyLabPanel() {
    const lab = useLab();
    const feed = useFeed();
    const strategies = useStrategies();
    const [cfg, setCfg] = useState<LabConfig>({ ...DEFAULT_LAB });
    const busy = lab.state === 'running' || lab.state === 'paused';
    const set = (p: Partial<LabConfig>) => setCfg(c => ({ ...c, ...p }));
    const ready = Object.values(feed.series).filter(s => s.length >= 200).length;
    const toggleMarket = (m: string) => set({ markets: cfg.markets.includes(m) ? cfg.markets.filter(x => x !== m) : [...cfg.markets, m] });
    const marketList = Object.keys(feed.series);
    const experimental = strategies.filter(s => s.status === 'UNDER_VALIDATION').length;

    return (
        <section className='ai-exec'>
            <div className='ai-info'>
                The lab searches for entry rules on the <b>first {Math.round(cfg.trainFraction * 100)}%</b> of each market's ticks, then tests the best ones once on the{' '}
                <b>held-back rest</b>, which the search never saw. A rule only passes with {MIN_TRADES}+ unseen trades, a significant result after false-discovery control, and no collapse from train to unseen. On random
                digits the usual honest result is that nothing passes.
            </div>
            <div className='ai-grid'>
                <div className='ai-card'>
                    <h3>Study</h3>
                    <label className='ai-field'>
                        Direction
                        <select value={cfg.direction} disabled={busy} onChange={e => set({ direction: e.target.value as LabConfig['direction'] })}>
                            <option value='BOTH'>OVER 2 and UNDER 7</option>
                            <option value='OVER_2'>OVER 2 only</option>
                            <option value='UNDER_7'>UNDER 7 only</option>
                        </select>
                    </label>
                    <Num label='Contract length (ticks)' value={cfg.duration} min={1} max={10} disabled={busy} onChange={n => set({ duration: n })} />
                    <Num label='Most recent ticks per market (0 = all)' value={cfg.sampleTicks} min={0} max={100000} step={100} disabled={busy} onChange={n => set({ sampleTicks: n })} />
                    <Num label='Train share of ticks' value={cfg.trainFraction} min={0.4} max={0.8} step={0.05} disabled={busy} onChange={n => set({ trainFraction: n })} />
                    <small>{ready} markets have 200+ ticks.</small>
                </div>
                <div className='ai-card'>
                    <h3>Search</h3>
                    <Num label='Candidates per generation' value={cfg.population} min={10} max={400} step={10} disabled={busy} onChange={n => set({ population: n })} />
                    <Num label='Generations' value={cfg.generations} min={1} max={60} disabled={busy} onChange={n => set({ generations: n })} />
                    <Num label='Finalists tested on unseen ticks' value={cfg.keep} min={1} max={30} disabled={busy} onChange={n => set({ keep: n })} />
                    <Num label='Minimum train trades' value={cfg.minTrainTrades} min={10} max={1000} step={10} disabled={busy} onChange={n => set({ minTrainTrades: n })} />
                    <Num label='Random seed' value={cfg.seed} min={1} max={2147483647} disabled={busy} onChange={n => set({ seed: n })} />
                </div>
                <div className='ai-card'>
                    <h3>Markets</h3>
                    <small>None ticked = every market with enough data.</small>
                    <div className='ai-chips'>
                        {marketList.map(m => (
                            <button key={m} className={`ai-chip-btn ${cfg.markets.includes(m) ? 'on' : ''}`} disabled={busy} onClick={() => toggleMarket(m)}>
                                {marketName(m)}
                            </button>
                        ))}
                        {marketList.length === 0 && <small>No market data yet. Connect the feed.</small>}
                    </div>
                </div>
            </div>

            <div className='ai-toolbar'>
                {!busy ? (
                    <button className='ai-btn primary' onClick={() => labRunner.start(cfg)}>
                        Start experiment
                    </button>
                ) : lab.state === 'running' ? (
                    <button className='ai-btn' onClick={() => labRunner.pause()}>
                        Pause
                    </button>
                ) : (
                    <button className='ai-btn primary' onClick={() => labRunner.resume()}>
                        Resume
                    </button>
                )}
                <button className='ai-btn' disabled={!busy} onClick={() => labRunner.stop()}>
                    Stop
                </button>
                <small>
                    {lab.state === 'idle' ? 'Idle' : lab.state[0].toUpperCase() + lab.state.slice(1)}
                    {lab.state !== 'idle' ? ` · generation ${lab.generation}/${lab.generations} · ${lab.evaluated} candidates tested` : ''}
                    {lab.ticks ? ` · ${lab.ticks.train} train / ${lab.ticks.validation} unseen ticks` : ''}
                </small>
            </div>
            {busy && lab.best && (
                <div className='ai-card'>
                    <h3>Best on train so far</h3>
                    <strong>{lab.best.key.split('|')[0] === 'UNDER_7' ? 'Under 7' : 'Over 2'}</strong>
                    <small>
                        {lab.best.train.trades} train trades · {pct(lab.best.train.rate)} · interval floor {pct(lab.best.train.lo)} vs chance {pct(lab.best.train.baseline, 0)}. Not validated yet: this number is optimistic by construction.
                    </small>
                </div>
            )}
            {lab.note && <div className={lab.results.some(r => r.passed) ? 'ai-info' : 'ai-info warn'}>{lab.note}</div>}
            {lab.results.length > 0 && (
                <div className='ai-lab-results'>
                    <h3>Finalists on unseen ticks</h3>
                    {lab.results.map((r, i) => (
                        <ResultRow key={i} r={r} />
                    ))}
                    <small>
                        Saved to the Strategy Library: passed ones as "Under validation" (waiting for your approval), the rest as "Retired" with the reason. {experimental} waiting for approval now.
                    </small>
                </div>
            )}
        </section>
    );
}

const ACTIONS: Record<StrategyStatus, Array<{ to: StrategyStatus; label: string }>> = {
    EXPERIMENTAL: [{ to: 'RETIRED', label: 'Retire' }],
    UNDER_VALIDATION: [
        { to: 'APPROVED', label: 'Approve' },
        { to: 'RETIRED', label: 'Retire' },
    ],
    APPROVED: [
        { to: 'ACTIVE', label: 'Activate' },
        { to: 'SUSPENDED', label: 'Suspend' },
        { to: 'RETIRED', label: 'Retire' },
    ],
    ACTIVE: [
        { to: 'APPROVED', label: 'Deactivate' },
        { to: 'SUSPENDED', label: 'Suspend' },
        { to: 'RETIRED', label: 'Retire' },
    ],
    SUSPENDED: [
        { to: 'APPROVED', label: 'Re-approve' },
        { to: 'RETIRED', label: 'Retire' },
    ],
    RETIRED: [],
};

function StrategyCard({ s, versions }: { s: Strategy; versions: number }) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const act = (to: StrategyStatus) => {
        let override = false;
        if (to === 'APPROVED' && s.status === 'UNDER_VALIDATION' && !s.passedValidation) {
            if (!window.confirm('This strategy did NOT pass validation on unseen ticks. Approve anyway? The override is logged.')) return;
            override = true;
        }
        setError(strategyRegistry.setStatus(s.id, to, 'user', `${STATUS_LABEL[to]} by you`, { override }));
    };
    const older = strategyRegistry.versions(s.familyId).some(v => v.version < s.version && v.status !== 'RETIRED');
    return (
        <article className={`ai-strat st-${s.status.toLowerCase()}`}>
            <div className='ai-strat-h'>
                <div>
                    <b>{s.description}</b>
                    <small>
                        {s.name} · v{s.version}
                        {versions > 1 ? ` of ${versions}` : ''} · {s.duration} tick{s.duration > 1 ? 's' : ''} · {s.markets.length ? s.markets.map(marketName).join(', ') : 'all markets studied'}
                    </small>
                </div>
                <span className={`ai-chip st-${s.status.toLowerCase()}`}>{STATUS_LABEL[s.status]}</span>
            </div>
            <div className='ai-kv'>
                <span>Train</span>
                <b>
                    {s.trainPeriod.trades} trades · {pct(s.trainPeriod.rate)}
                </b>
            </div>
            <div className='ai-kv'>
                <span>Unseen ticks</span>
                <b>
                    {s.validationPeriod.trades} trades · {pct(s.validationPeriod.rate)} · q {s.validationPeriod.q === null ? '–' : s.validationPeriod.q.toFixed(3)}
                </b>
            </div>
            {!s.passedValidation && s.validationNotes.length > 0 && <small>{s.validationNotes.join(' · ')}</small>}
            <div className='ai-strat-actions'>
                {ACTIONS[s.status].map(a => (
                    <button key={a.to} className={`ai-btn ${a.to === 'ACTIVE' || a.to === 'APPROVED' ? 'primary' : ''}`} onClick={() => act(a.to)}>
                        {a.label}
                    </button>
                ))}
                {older && s.status !== 'RETIRED' && (
                    <button className='ai-btn' onClick={() => setError(strategyRegistry.rollback(s.id))}>
                        Roll back to this version
                    </button>
                )}
                <button className='ai-btn' onClick={() => setOpen(!open)}>
                    {open ? 'Hide history' : 'History'}
                </button>
            </div>
            {error && <div className='ai-error'>{error}</div>}
            {open && (
                <ol className='ai-history'>
                    {s.history.map((h, i) => (
                        <li key={i}>
                            {new Date(h.at).toLocaleString()} · {h.from ? `${STATUS_LABEL[h.from]} → ` : ''}
                            {STATUS_LABEL[h.to]} ({h.by}): {h.note}
                        </li>
                    ))}
                </ol>
            )}
        </article>
    );
}

export function StrategyLibraryPanel() {
    const all = useStrategies();
    const [filter, setFilter] = useState<'ALL' | StrategyStatus>('ALL');
    const shown = all.filter(s => filter === 'ALL' || s.status === filter);
    const counts = (st: StrategyStatus) => all.filter(s => s.status === st).length;
    return (
        <section>
            <div className='ai-info'>
                Only <b>Active</b> strategies are traded by the AUTO market runner, and only after you approve and activate them. A strategy's rule never changes: a different rule is a new version and the old one stays here. If a live check
                finds an active strategy deteriorating it is suspended, never rewritten.
            </div>
            <div className='ai-toolbar'>
                <label className='ai-field'>
                    Show
                    <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}>
                        <option value='ALL'>All ({all.length})</option>
                        {(Object.keys(STATUS_LABEL) as StrategyStatus[]).map(st => (
                            <option key={st} value={st}>
                                {STATUS_LABEL[st]} ({counts(st)})
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {shown.length === 0 ? (
                <div className='ai-empty'>{all.length === 0 ? 'No strategies yet. Run an experiment in the Strategy Lab.' : 'Nothing with that status.'}</div>
            ) : (
                <div className='ai-strats'>
                    {shown.map(s => (
                        <StrategyCard key={s.id} s={s} versions={strategyRegistry.versions(s.familyId).length} />
                    ))}
                </div>
            )}
        </section>
    );
}
