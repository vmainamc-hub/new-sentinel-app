// APEX INTEL: the autopilot controls and status. Research and promotion run in the background; this only shows and sets them.
import { useSyncExternalStore } from 'react';
import { Num, Seg, Switch } from '@/components/premium/sixfold/SixfoldPage';
import { type PromoteLevel } from './autopilot';
import { autopilot } from './autopilot-instance';
import { forwardMonitor, labRunner } from './registry-instance';
import { useStrategies } from './StrategyPanels';

const useAutopilot = () => useSyncExternalStore(autopilot.subscribe, autopilot.getSnapshot, autopilot.getSnapshot);
const useLabState = () => useSyncExternalStore(labRunner.subscribe, labRunner.getSnapshot, labRunner.getSnapshot);
const useForward = () => useSyncExternalStore(forwardMonitor.subscribe, forwardMonitor.getSnapshot, forwardMonitor.getSnapshot);

const LEVEL_HELP: Record<PromoteLevel, string> = {
    OFF: 'Nothing moves by itself: you approve and activate strategies in the Strategy Library.',
    STRICT: 'Validated strategies run only after 60+ forward trades with the interval floor above chance.',
    BALANCED: 'Validated strategies run after 30+ forward trades at or above chance.',
    FAST: 'Validated strategies run as soon as they pass validation (no forward test first).',
};

export function AutopilotPanel() {
    const a = useAutopilot();
    const lab = useLabState();
    const forward = useForward();
    const strategies = useStrategies();
    const c = a.config;
    const active = strategies.filter(s => s.status === 'ACTIVE');
    const waiting = strategies.filter(s => s.status === 'APPROVED' || (s.status === 'UNDER_VALIDATION' && s.passedValidation));
    const nextIn = a.nextResearchAt === null ? null : Math.max(0, Math.round((a.nextResearchAt - Date.now()) / 60000));
    const labLine =
        lab.state === 'running' || lab.state === 'paused'
            ? `Lab researching: generation ${lab.generation}/${lab.generations}`
            : !c.research
              ? 'Background research is off'
              : nextIn === null
                ? 'Lab waits for markets with 1000+ ticks'
                : `Lab idle, next research in about ${nextIn} min`;
    return (
        <div className='sn-sub ai-autopilot'>
            <Switch on={c.research} onChange={v => autopilot.configure({ research: v })} title='Keep researching' sub='The Strategy Lab runs in the background and looks for entries that hold on unseen ticks' />
            <div className='sn-label'>Run what the lab validates</div>
            <Seg<PromoteLevel>
                label='Promotion level'
                value={c.promote}
                onChange={v => autopilot.configure({ promote: v })}
                options={[
                    ['OFF', 'Off'],
                    ['STRICT', 'Strict'],
                    ['BALANCED', 'Balanced'],
                    ['FAST', 'Fast'],
                ]}
            />
            <div className='sn-reason'>{LEVEL_HELP[c.promote]}</div>
            <div className='sf-grid2 sn-nums'>
                <Num label='Max strategies running' value={c.maxActive} onCommit={n => autopilot.configure({ maxActive: n })} />
                <Num label='Research every (min)' value={c.everyMin} onCommit={n => autopilot.configure({ everyMin: n })} />
            </div>
            <div className='sn-reason'>
                {labLine}. {active.length} running{waiting.length ? `, ${waiting.length} waiting for the forward test` : ''}.
            </div>
            {active.length > 0 && (
                <ul className='sf-trades ai-best'>
                    {active.map(s => {
                        const f = forward.find(x => x.strategyId === s.id);
                        return (
                            <li key={s.id}>
                                <b>{s.name}</b>
                                <span>{s.description}</span>
                                <span>{f ? `${f.trades} fwd` : 'no fwd yet'}</span>
                                <em>{f && f.rate !== null ? `${(f.rate * 100).toFixed(0)}%` : '–'}</em>
                            </li>
                        );
                    })}
                </ul>
            )}
            {a.moves.length > 0 && (
                <ul className='ai-log'>
                    {a.moves.slice(0, 5).map((m, i) => (
                        <li key={`${m.at}-${i}`} className={m.ok ? 'info' : 'warn'}>
                            <time>{new Date(m.at).toLocaleTimeString()}</time> {m.id} → {m.to.toLowerCase()}: {m.note}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
