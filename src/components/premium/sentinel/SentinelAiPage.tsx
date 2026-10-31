// SENTINEL AI: a self-running trading tool in Sixfold's form, driven by the Pulse signal engine.
// The scanner keeps going round the markets, Pulse says which contracts have been winning above their fair share and how strongly,
// and the tool buys by itself. Every trade shows in the Run Panel and Transactions. All the work is Sixfold's runner with the Pulse
// overlay (see overlay.ts and pulse.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import SixfoldPage, { Panel, Seg } from '../sixfold/SixfoldPage';
import { describeFunnel, FunnelTally } from './funnel';
import { sentinelOverlay, sentinelRunner } from './runner-instance';
import {
    contractsFor,
    ENGINE_MODES,
    type EngineMode,
    type EngineSettings,
    PRESETS,
    PROPOSITION_KEYS,
} from './settings';
import { useSentinel } from './use-sentinel';

const MODE_TEXT: Record<EngineMode, string> = {
    careful: 'Only strong Pulse signals: all four time windows are above the fair rate. Fewest trades.',
    balanced:
        'Strong and steady Pulse signals (at least three windows above fair). A good rate of signals with a sensible bar.',
    active: 'Also watch signals, and the scanner may trade with no signal at a higher bar. Most trades, most variance.',
};

const EnginePanel = () => {
    const { sx, engine, update } = useSentinel();
    const board = sentinelOverlay.board();
    const toggle = (key: string) =>
        update({
            propositions: engine.propositions.includes(key)
                ? engine.propositions.filter(p => p !== key)
                : [...engine.propositions, key],
        });
    const applyPreset = (id: string) => {
        const preset = PRESETS.find(p => p.id === id);
        if (!preset) return;
        update(preset.engine as Partial<EngineSettings>);
        sentinelRunner.updateSettings(preset.trading);
    };
    return (
        <>
            <Panel eyebrow='PULSE' title='How Pulse decides'>
                <p className='sf-note'>
                    Pulse reads each market's last 1000, 300, 100 and 30 ticks and asks, for each contract, in how many
                    of those windows it has been winning more than its fair share. More windows agreeing means a
                    stronger signal. It decides when to look; it cannot make a random digit more likely.
                </p>
                <div className='sf-field sf-first'>
                    <span>Style</span>
                    <div className='sf-presets'>
                        {PRESETS.map(p => (
                            <button
                                key={p.id}
                                type='button'
                                className={engine.mode === p.id ? 'on' : ''}
                                onClick={() => applyPreset(p.id)}
                                disabled={sx.running}
                            >
                                <b>{p.name}</b>
                                <small>{p.blurb}</small>
                            </button>
                        ))}
                    </div>
                </div>
                <div className='sf-field'>
                    <span>Signal strength</span>
                    <Seg<EngineMode>
                        label='Signal strength'
                        value={engine.mode}
                        onChange={mode => update({ mode })}
                        options={ENGINE_MODES.map(m => [m, m[0].toUpperCase() + m.slice(1)] as const)}
                    />
                    <small>{MODE_TEXT[engine.mode]}</small>
                </div>
                <div className='sf-field'>
                    <span>Contracts it may trade</span>
                    <div className='sf-chips'>
                        {PROPOSITION_KEYS.map(k => (
                            <button
                                key={k}
                                type='button'
                                className={engine.propositions.includes(k) ? 'on' : ''}
                                onClick={() => toggle(k)}
                                disabled={sx.running}
                            >
                                {k.replace(':', ' ').replace('OVER', 'Over').replace('UNDER', 'Under')}
                            </button>
                        ))}
                    </div>
                    <small>After a loss, recovery trades use the recovery barriers in the settings below.</small>
                </div>
            </Panel>
            <Panel eyebrow='PULSE BOARD' title={`Signals right now (${board.length})`}>
                {board.length === 0 ? (
                    <p className='sf-note'>
                        No contract has a signal the {engine.mode} mode accepts at the moment. The scanner keeps going
                        round and Pulse is re-read on every scan.
                    </p>
                ) : (
                    <table className='sf-table'>
                        <thead>
                            <tr>
                                <th>Market</th>
                                <th>Contract</th>
                                <th>Signal</th>
                                <th>Windows above fair</th>
                                <th>Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {board.slice(0, 12).map(c => (
                                <tr key={c.key}>
                                    <td>{c.symbol}</td>
                                    <td>{c.label}</td>
                                    <td>{c.tier}</td>
                                    <td>{c.agree} of 4</td>
                                    <td>{c.score}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Panel>
        </>
    );
};

const FunnelPanel = () => {
    const { sx } = useSentinel();
    const tally = useRef(new FunnelTally());
    const [, force] = useState(0);
    const engineFunnel = sentinelOverlay.funnel();
    const view = useMemo(
        () => describeFunnel(engineFunnel, sx.funnel, Boolean(sx.armed)),
        [engineFunnel, sx.funnel, sx.armed]
    );
    // One point per scan; the 10-minute summary is re-read every few seconds.
    useEffect(() => {
        tally.current.add(sx.funnel, engineFunnel, Date.now());
    }, [sx.funnel, engineFunnel]);
    useEffect(() => {
        const id = window.setInterval(() => force(n => n + 1), 5000);
        return () => window.clearInterval(id);
    }, []);
    const sum = tally.current.summary(Date.now());
    return (
        <Panel eyebrow='DIAGNOSIS' title='Where is the signal being blocked?'>
            <p className={`sf-note ${view.blockedAt ? 'bad' : ''}`}>
                <b>{view.verdict}</b>
            </p>
            <table className='sf-table sf-funnel'>
                <thead>
                    <tr>
                        <th>Step</th>
                        <th>Alive</th>
                        <th>What it removed</th>
                    </tr>
                </thead>
                <tbody>
                    {view.steps.map(step => (
                        <tr key={step.key} className={view.blockedAt === step.key ? 'blocked' : ''}>
                            <td>
                                <small>{step.side === 'engine' ? 'PULSE' : 'SCANNER'}</small> {step.label}
                            </td>
                            <td>
                                <b>{step.alive ?? '—'}</b>
                            </td>
                            <td>{step.note}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className='sf-note'>
                Last 10 minutes: {sum.scans} scans, {sum.scansWithBoard} had a Pulse signal the mode accepts,{' '}
                {sum.scansWithEligible} had a contract that cleared every check.
            </p>
            {sum.scans > 0 && (
                <table className='sf-table'>
                    <thead>
                        <tr>
                            <th>Stopped most often by</th>
                            <th>Contracts stopped</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sum.stoppedBy.map(row => (
                            <tr key={row.key}>
                                <td>{row.label}</td>
                                <td>{row.count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {sum.reasons.length > 0 && (
                <details open>
                    <summary>Exact reasons (last 10 minutes)</summary>
                    <ul>
                        {sum.reasons.map(r => (
                            <li key={r.reason}>
                                {r.count} × {r.reason}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </Panel>
    );
};

const ContractNote = () => (
    <div className='sf-field sf-first'>
        <span>Contracts</span>
        <small>
            Chosen by Pulse (see above): the six Over 1/2/3 and Under 8/7/6 contracts, on the market the scanner finds
            best.
        </small>
    </div>
);

const FOOTER =
    'Pulse reads recent digit behaviour. Deriv digits are generated randomly, so a contract that has been winning is not more likely to win next, and every contract carries a payout margin: over many trades the expected result is a loss, whatever is picked. Martingale-style recovery makes each loss bigger. Test on a demo account first. Not financial advice.';

const SentinelAiPage = () => {
    const { engine } = useSentinel();
    const contracts = useMemo(() => () => contractsFor(engine), [engine]);
    return (
        <SixfoldPage
            runner={sentinelRunner}
            brand='SENTINEL'
            brandSub='AI'
            contracts={contracts}
            topSlot={
                <>
                    <FunnelPanel />
                    <EnginePanel />
                </>
            }
            contractControls={<ContractNote />}
            footerText={FOOTER}
            className='sentinel-ai-auto'
        />
    );
};

export default SentinelAiPage;
