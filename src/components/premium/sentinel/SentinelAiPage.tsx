// SENTINEL AI (unified): Signal Zone + Sentinel AI + Insight Fusion as one self-running trading tool, in Sixfold's form.
// The scanner keeps going round the markets; the engines back, veto or ease each contract; the tool buys by itself and every trade
// shows in the Run Panel and Transactions. All the work is Sixfold's runner with the engine overlay (see overlay.ts).
import { useMemo } from 'react';
import SixfoldPage, { Num, Panel, Seg, Switch } from '../sixfold/SixfoldPage';
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
    careful: 'Both engines (Sentinel AI and Insight Fusion) must back a contract. Fewest trades.',
    balanced: 'Either engine can back a contract. Both agreeing makes the bar easier.',
    active: 'The scanner may trade alone, at a higher bar. Most trades, most variance.',
};

const sourceText = (s: string) => (s === 'both' ? 'Both agree' : s === 'sentinel' ? 'Sentinel AI' : 'Insight Fusion');

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
            <Panel eyebrow='ENGINES' title='How Sentinel AI decides'>
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
                    <span>Agreement</span>
                    <Seg<EngineMode>
                        label='Agreement'
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
                <div className='sf-grid2'>
                    <Num
                        label='Min score'
                        value={engine.minScore}
                        onCommit={n => update({ minScore: n })}
                        hint='Sentinel score, 0 = off'
                    />
                    <Num
                        label='Max danger'
                        value={engine.maxDanger}
                        onCommit={n => update({ maxDanger: n })}
                        hint='0 = off'
                    />
                </div>
                <Switch
                    on={engine.requireMomentum}
                    onChange={v => update({ requireMomentum: v })}
                    title='Require momentum'
                    sub='Skip signals the recent digits do not favour'
                />
                <Switch
                    on={engine.skipBlocked}
                    onChange={v => update({ skipBlocked: v })}
                    title='Skip blocked signals'
                    sub='Never trade what the engine itself blocked'
                />
            </Panel>
            <Panel eyebrow='ENGINE BOARD' title={`Backed right now (${board.length})`}>
                {board.length === 0 ? (
                    <p className='sf-note'>
                        No contract is backed at the moment. The scanner keeps going round and the engines are re-read
                        on every scan.
                    </p>
                ) : (
                    <table className='sf-table'>
                        <thead>
                            <tr>
                                <th>Market</th>
                                <th>Contract</th>
                                <th>Backed by</th>
                                <th>Entry digit</th>
                                <th>Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {board.slice(0, 12).map(c => (
                                <tr key={c.key}>
                                    <td>{c.market}</td>
                                    <td>{c.label}</td>
                                    <td>{sourceText(c.source)}</td>
                                    <td>{c.entryDigit ?? 'learned'}</td>
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

const ContractNote = () => (
    <div className='sf-field sf-first'>
        <span>Contracts</span>
        <small>
            Chosen by the engines (see above): the six Over 1/2/3 and Under 8/7/6 propositions, on the market the
            scanner finds best.
        </small>
    </div>
);

const FOOTER =
    'Sentinel AI combines a digit scanner with two analysis engines. They describe recent digit behaviour; Deriv digits are generated randomly, so they cannot create an edge, and every contract carries a payout margin: over many trades the expected result is a loss, whatever is picked. Martingale-style recovery makes each loss bigger. Test on a demo account first. Not financial advice.';

const SentinelAiPage = () => {
    const { engine } = useSentinel();
    const contracts = useMemo(() => () => contractsFor(engine), [engine]);
    return (
        <SixfoldPage
            runner={sentinelRunner}
            brand='SENTINEL'
            brandSub='AI'
            contracts={contracts}
            topSlot={<EnginePanel />}
            contractControls={<ContractNote />}
            footerText={FOOTER}
            className='sentinel-ai-auto'
        />
    );
};

export default SentinelAiPage;
