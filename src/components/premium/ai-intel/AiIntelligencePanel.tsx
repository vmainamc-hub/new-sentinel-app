// APEX INTEL: AI Intelligence screen. The ten agents, the Chief's decision with separate evidence blocks, rejected
// opportunities with reasons, the forward test of approved strategies, and the persistent decision log.
import { useEffect, useSyncExternalStore } from 'react';
import { marketName } from '@/components/premium/sixfold/feed';
import { MIN_TRADES } from './analysis';
import { intelService, forwardMonitor } from './intel-instance';
import { strategyRegistry } from './registry-instance';
import type { Decision } from './agents';

const pct = (x: number | null, d = 1) => (x === null ? '–' : `${(x * 100).toFixed(d)}%`);
const useIntel = () => useSyncExternalStore(intelService.subscribe, intelService.getSnapshot, intelService.getSnapshot);
const useForward = () => useSyncExternalStore(forwardMonitor.subscribe, forwardMonitor.getSnapshot, forwardMonitor.getSnapshot);

function DecisionBlock({ d }: { d: Decision }) {
    const ev = d.evidence;
    const enter = d.decision === 'ENTER';
    return (
        <div className={`ai-card wide ai-decision ${enter ? 'enter' : 'no'}`}>
            <h3>Chief Intelligence decision</h3>
            <strong>{enter ? `ENTER · ${marketName(d.market as string)} · ${d.direction === 'UNDER_7' ? 'Under 7' : 'Over 2'}` : 'NO TRADE'}</strong>
            <small>
                {d.market ? `Best candidate: ${marketName(d.market)} · ${d.direction === 'UNDER_7' ? 'Under 7' : 'Over 2'} (barrier ${d.barrier}) · ${d.strategy}${d.strategyVersion ? ` v${d.strategyVersion}` : ''} · entry: ${d.entryCondition} · entry met now: ${d.entryMetNow ? 'yes' : 'no'}` : 'No candidate'}
            </small>
            <ul className='ai-reasons'>
                {d.explanation.map((e, i) => (
                    <li key={i}>{e}</li>
                ))}
            </ul>
            {ev && (
                <div className='ai-evidence'>
                    <div>
                        <h4>Statistical</h4>
                        <p>{ev.statistical.significant ? `Significant (q=${ev.statistical.q?.toFixed(3)})` : 'Not significant after false-discovery control'}</p>
                        <p>Interval floor vs chance: {ev.statistical.intervalFloorOverChancePts === null ? `n/a (<${MIN_TRADES} trades)` : `${ev.statistical.intervalFloorOverChancePts.toFixed(1)} pts`}</p>
                        <p>P(rate above chance) ≈ {ev.statistical.probAboveChance === null ? 'n/a' : pct(ev.statistical.probAboveChance, 0)}</p>
                    </div>
                    <div>
                        <h4>Historical</h4>
                        <p>
                            {ev.historical.trades} trades · {pct(ev.historical.rate)} won
                        </p>
                        <p>Chance level {pct(ev.historical.chance, 0)}</p>
                    </div>
                    <div>
                        <h4>Out of sample</h4>
                        {ev.outOfSample ? (
                            <>
                                <p>
                                    Lab unseen ticks: {pct(ev.outOfSample.validationRate)} (q {ev.outOfSample.validationQ === null ? '–' : ev.outOfSample.validationQ.toFixed(3)})
                                </p>
                                <p>
                                    Forward test: {ev.outOfSample.forwardTrades} trades · {pct(ev.outOfSample.forwardRate)}
                                </p>
                            </>
                        ) : (
                            <p>None: this is a baseline entry, not a validated strategy.</p>
                        )}
                    </div>
                    <div>
                        <h4>Suitability</h4>
                        <p>Regime: {ev.suitability.regime.toLowerCase().replace('_', ' ')}</p>
                        <p>
                            {ev.suitability.ticks} ticks · last tick {ev.suitability.freshSeconds === null ? 'never' : `${ev.suitability.freshSeconds.toFixed(0)}s ago`}
                        </p>
                    </div>
                    <div>
                        <h4>Model</h4>
                        <p>{ev.model.version}</p>
                        <p>No learned model: rules and statistics only, so no model confidence is shown.</p>
                    </div>
                </div>
            )}
        </div>
    );
}

export function AiIntelligencePanel() {
    const snap = useIntel();
    const forward = useForward();
    useEffect(() => intelService.retain(), []);
    const r = snap.report;
    return (
        <section>
            <div className='ai-info'>
                Ten rule-based agents examine the live markets every few seconds; the Chief reconciles them and prefers NO TRADE whenever evidence is missing. This is advisory: real trades are placed only from the Live Execution tab, under its own limits. There is no language model
                in this loop, and nothing here predicts the next digit.
            </div>
            {!r ? (
                <div className='ai-empty'>Evaluating…</div>
            ) : (
                <>
                    <div className='ai-grid'>
                        <DecisionBlock d={r.decision} />
                        {r.agents.map(a => (
                            <div key={a.id} className={`ai-card ai-agent st-${a.state}`}>
                                <h3>{a.name}</h3>
                                <strong>{a.state === 'ok' ? '●' : a.state === 'warn' ? '▲' : '○'}</strong>
                                <small>{a.headline}</small>
                                {a.findings.map((f, i) => (
                                    <small key={i}>{f}</small>
                                ))}
                            </div>
                        ))}
                    </div>
                    <h3 className='ai-sub'>Rejected opportunities</h3>
                    {r.rejected.length === 0 ? (
                        <div className='ai-empty'>None.</div>
                    ) : (
                        <div className='ai-board'>
                            {r.rejected.map((x, i) => (
                                <div key={i} className='ai-row rej'>
                                    <span>{marketName(x.market)}</span>
                                    <span>{x.label}</span>
                                    <span>{x.reasons.join(' · ')}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <h3 className='ai-sub'>Forward test of approved strategies</h3>
                    {forward.length === 0 ? (
                        <div className='ai-empty'>No approved or active strategy yet. Forward paper trades start from the moment one is approved.</div>
                    ) : (
                        <div className='ai-board'>
                            {forward.map(f => {
                                const s = strategyRegistry.get(f.strategyId);
                                return (
                                    <div key={f.strategyId} className='ai-row rej'>
                                        <span>{s?.name ?? f.strategyId}</span>
                                        <span>
                                            {f.trades} trades · {pct(f.rate)} (floor {pct(f.lo, 0)}, chance {pct(f.baseline, 0)})
                                        </span>
                                        <span>{f.suspended ? 'Suspended by the monitor' : f.trades < MIN_TRADES ? `Needs ${MIN_TRADES}+ trades to judge` : 'Holding up'}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
            <h3 className='ai-sub'>Decision log ({snap.log.length})</h3>
            {snap.log.length === 0 ? (
                <div className='ai-empty'>Decisions appear here when they change.</div>
            ) : (
                <div className='ai-board'>
                    {snap.log.slice(0, 40).map((d, i) => (
                        <div key={i} className={`ai-row rej ${d.decision === 'ENTER' ? 'sig' : ''}`}>
                            <span>{new Date(d.at).toLocaleTimeString()}</span>
                            <span>{d.decision === 'ENTER' ? 'ENTER' : 'NO TRADE'}</span>
                            <span>
                                {d.market ? `${marketName(d.market)} · ${d.direction === 'UNDER_7' ? 'U7' : 'O2'} · ${d.strategy}` : '–'} · {d.explanation[0]}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
