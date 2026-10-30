// SIXFOLD: autonomous digit scanner and trader.
//
// Scanner  : press Run and Sixfold scans every market, arms the best eligible contract, buys on its entry digit and
//            repeats, one trade at a time. Trades appear in the general Transactions panel.
// Board    : a heat map of every market x contract with false-discovery control.
// Contract : one contract on one market: charts, the six traders, the ladder and the edge test.
// Lab      : does anything beyond chance exist? Uniformity, dependence, label calibration and a bankroll simulation.
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react';
import { bankrollSim, calibrateLabels, contractRuns, entryTest, rollingRate, structureTable, transitionTest, uniformityTest } from './analysis';
import { sentinelAgreement } from './agree';
import { ARM_BY_ID, type BrainReport, type Evidence, planLedger, WINDOWS } from './entry-brain';
import { MeterStrip, MeterTab } from './meter-ui';
import { computeRegimeFromSnapshot } from './regime';
import type { RecoveryEntry } from './entry';
import type { VhMode } from './virtual-hook';
import { type BotConfig, type Contract, contractKey, contractLabel, DEFAULT_BOT, equityCurve, isValidContract, winProbability } from './bot';
import { bestPerMarket, type Cell, eligibility } from './scanner';
import { DigitBars, Hexagon, LineChart, Radar, Sparkline, TransitionHeat } from './charts';
import { ARCHETYPE_TEXT, type CrowdPosition, DEFAULT_CROWD, SENSITIVITY, type Sensitivity } from './crowd';
import { buildDossier } from './dossier';
import type { ContractSide } from './engine';
import { marketName, MARKETS, shortName, sixfoldFeed } from './feed';
import {
    DEFAULT_SETTINGS,
    type EntryRule,
    ladderPreview,
    previewContract,
    primaryContracts,
    type RecoverySizing,
    type Selectivity,
    type SixfoldSettings,
    streakChance,
} from './money';
import type { Phase, TradeRecord } from './runner';
import { sixfoldRunner } from './runner-instance';
import { STATE_TEXT, type ViabilityState } from './viability';
import { useFeed } from './use-feed';
import { useSixfold } from './use-sixfold';
import { useSentinelAi } from '@/pages/sentinel-ai/use-sentinel-ai';
import './sixfold.scss';

type Tab = 'scanner' | 'meter' | 'board' | 'contract' | 'lab';
const TABS: ReadonlyArray<readonly [Tab, string]> = [
    ['scanner', 'Scanner'],
    ['meter', 'Meter'],
    ['board', 'Board'],
    ['contract', 'Contract'],
    ['lab', 'Lab'],
];
const SIDES: ContractSide[] = ['OVER', 'UNDER', 'EVEN', 'ODD', 'MATCHES', 'DIFFERS'];

const pct = (x: number | null, d = 0) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`);
const pts = (x: number | null, d = 1) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
const money = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const pill = (s: ViabilityState) => <span className={`sf-state vs-${s.toLowerCase()}`}>{STATE_TEXT[s].label}</span>;

const PHASE_TEXT: Record<Phase, { title: string; sub: string; tone: 'idle' | 'scan' | 'armed' | 'trade' | 'warn' }> = {
    idle: { title: 'READY', sub: 'Press Run', tone: 'idle' },
    connecting: { title: 'CONNECTING', sub: 'Market feed', tone: 'warn' },
    scanning: { title: 'SCANNING', sub: 'All markets', tone: 'scan' },
    armed: { title: 'ARMED', sub: 'Waiting for entry', tone: 'armed' },
    buying: { title: 'BUYING', sub: 'Placing contract', tone: 'trade' },
    settling: { title: 'IN TRADE', sub: 'Awaiting result', tone: 'trade' },
    cooling: { title: 'NEXT', sub: 'Looking again', tone: 'scan' },
};

// ---------- small controls ----------

function Num({ label, value, onCommit, hint }: { label: string; value: number; onCommit: (n: number) => void; hint?: string }) {
    const [text, setText] = useState(String(value));
    useEffect(() => setText(String(value)), [value]);
    const commit = () => {
        const n = Number(text);
        if (text.trim() !== '' && Number.isFinite(n)) onCommit(n);
        else setText(String(value));
    };
    return (
        <label className='sf-fld'>
            <span>{label}</span>
            <input
                inputMode='decimal'
                value={text}
                onChange={e => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            {hint && <small>{hint}</small>}
        </label>
    );
}

function Switch({ on, onChange, title, sub }: { on: boolean; onChange: (v: boolean) => void; title: string; sub: string }) {
    return (
        <button type='button' className={`sf-switch ${on ? 'on' : ''}`} role='switch' aria-checked={on} onClick={() => onChange(!on)}>
            <span>
                <b>{title}</b>
                <small>{sub}</small>
            </span>
            <i aria-hidden='true' />
        </button>
    );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void; label: string }) {
    return (
        <div className='sf-seg' role='radiogroup' aria-label={label}>
            {options.map(([v, text]) => (
                <button key={v} type='button' role='radio' aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
                    {text}
                </button>
            ))}
        </div>
    );
}

const StreakCost = ({ s }: { s: SixfoldSettings }) => {
    const rows = ladderPreview(s, 5);
    const p = winProbability(previewContract(s));
    const last = rows[rows.length - 1];
    return (
        <div className='sf-streak' role='note'>
            <b>If you lose 5 in a row</b>
            <span className='mono'>{rows.map(r => (r.writeOff ? `↺${r.stake.toFixed(2)}` : r.stake.toFixed(2))).join(' → ')}</span>
            <span>
                {s.streakBudget > 0 ? 'Most owed at once' : 'Total staked'}: {last.total.toFixed(2)}.
                {s.recovery
                    ? ` Recovery trades win ${Math.round(p * 100)}% of the time, so 4 losses in a row happen ${(streakChance(p, 4) * 100).toFixed(1)}% of the time they start.`
                    : ''}
                {s.streakBudget > 0 ? ' ↺ = loss accepted, back to base stake.' : ''}
            </span>
        </div>
    );
};

function ContractCard({ side, on, barrier, onToggle, onBarrier }: { side: 'Over' | 'Under'; on: boolean; barrier: number; onToggle: () => void; onBarrier: (n: number) => void }) {
    return (
        <div className={`sf-ccard ${on ? 'on' : ''}`}>
            <button type='button' role='switch' aria-checked={on} onClick={onToggle} aria-label={`Trade ${side}`}>
                <b>
                    {side} {barrier}
                </b>
                <small>{on ? 'Trading' : 'Off'}</small>
            </button>
            <Num label='Barrier' value={barrier} onCommit={onBarrier} />
        </div>
    );
}

const Panel = ({ eyebrow, title, children, aside }: { eyebrow?: string; title?: string; children: ReactNode; aside?: ReactNode }) => (
    <section className='sf-panel'>
        {(eyebrow || title || aside) && (
            <header>
                <div>
                    {eyebrow && <div className='eyebrow'>{eyebrow}</div>}
                    {title && <h2>{title}</h2>}
                </div>
                {aside}
            </header>
        )}
        {children}
    </section>
);

const Stat = ({ label, value, tone }: { label: string; value: ReactNode; tone?: 'pos' | 'neg' }) => (
    <div className={`sf-stat ${tone ?? ''}`}>
        <small>{label}</small>
        <b>{value}</b>
    </div>
);

// ---------- page ----------

const SixfoldPage = () => {
    const feed = useFeed();
    const sx = useSixfold(true);
    const [tab, setTab] = useState<Tab>('scanner');
    // Read straight from the published ticks: a market's strip changes only when that market's own ticks arrive.
    const regime = useMemo(
        () => computeRegimeFromSnapshot(feed.series, sx.settings.markets, primaryContracts(sx.settings), Date.now()),
        [feed.series, sx.settings]
    );
    const [market, setMarket] = useState('1HZ10V');
    const [contract, setContract] = useState<Contract>({ side: 'OVER', param: 2 });
    const [importText, setImportText] = useState('');

    // Always start on the live Deriv feed; reconnecting after a manual stop is the button's job.
    useEffect(() => {
        if (sixfoldFeed.getMode() === 'live' && sixfoldFeed.getStatus() === 'offline') sixfoldFeed.connect();
    }, []);

    const open = (m: string, c?: Contract) => {
        setMarket(m);
        if (c) setContract(c);
        setTab('contract');
    };

    return (
        <div className='sixfold sf'>
            <header className='sf-top'>
                <b className='sf-brand'>
                    SIXFOLD<small>AUTO</small>
                </b>
                <nav aria-label='Sixfold sections'>
                    {TABS.map(([k, l]) => (
                        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                            {l}
                        </button>
                    ))}
                </nav>
                <span className={`sf-feed ${feed.mode === 'live' ? feed.status : 'warn'}`}>
                    {feed.mode === 'import' ? 'IMPORTED' : feed.status.toUpperCase()}
                </span>
            </header>

            <section className='sf-feedbar'>
                <button className='sf-btn primary' onClick={feed.connect} disabled={sx.running}>
                    Connect live
                </button>
                {feed.error && <span className='sf-msg bad'>{feed.error}</span>}
            </section>

            {tab === 'scanner' && <MeterStrip regime={regime} running={sx.running} onOpen={() => setTab('meter')} />}
            {tab === 'scanner' && <ScannerTab sx={sx} openContract={open} />}
            {tab === 'meter' && <MeterTab regime={regime} series={feed.series} settings={sx.settings} panel={Panel} />}
            {tab === 'board' && <BoardTab sx={sx} open={open} />}
            {tab === 'contract' && (
                <ContractTab
                    series={feed.series}
                    market={market}
                    setMarket={setMarket}
                    contract={contract}
                    setContract={setContract}
                    settings={sx.settings}
                    importText={importText}
                    setImportText={setImportText}
                    onImport={() => feed.importDigits(market, importText)}
                />
            )}
            {tab === 'lab' && <LabTab series={feed.series} market={market} setMarket={setMarket} contract={contract} setContract={setContract} settings={sx.settings} brain={sx.brain} trades={sx.trades} />}

            <footer className='sf-foot'>
                Sixfold reads patterns in past digits. Deriv digits are generated randomly, so “no edge” is a normal and honest result, and every contract
                carries a payout margin: over many trades the expected result is a loss, whatever the scanner picks. Martingale makes each loss bigger
                and cannot change that. Test on a demo account first. Not financial advice.
            </footer>
        </div>
    );
};

// ---------- scanner ----------

function ScannerTab({ sx, openContract }: { sx: ReturnType<typeof useSixfold>; openContract: (m: string, c?: Contract) => void }) {
    const set = (patch: Partial<SixfoldSettings>) => sixfoldRunner.updateSettings(patch);
    const s = sx.settings;
    const phase = PHASE_TEXT[sx.phase];
    const best = useMemo(() => (sx.scan ? bestPerMarket(sx.scan, s.markets) : {}), [sx.scan, s.markets]);
    const dial = s.markets.map(symbol => ({
        symbol,
        best: best[symbol],
        eligible: best[symbol] ? eligibility(best[symbol]!, s.selectivity).ok : false,
        significant: Boolean(best[symbol]?.significant),
        quarantined: sx.quarantined.includes(symbol),
    }));
    const centre = sx.armed ? sx.armed.label : phase.title;
    const sub = sx.armed ? shortName(sx.armed.symbol) : phase.sub;
    const toggleMarket = (symbol: string) =>
        set({ markets: s.markets.includes(symbol) ? s.markets.filter(m => m !== symbol) : [...s.markets, symbol] });
    const summary = sx.scan?.summary;

    return (
        <main className='sf-scanner'>
            <Panel eyebrow='SCANNER SETTINGS' title='Configure your trade'>
                <div className='sf-field sf-first'>
                    <span>Contracts</span>
                    <div className='sf-grid2'>
                        <ContractCard side='Over' on={s.useOver} barrier={s.primaryOver} onToggle={() => set({ useOver: !s.useOver })} onBarrier={n => set({ primaryOver: n })} />
                        <ContractCard side='Under' on={s.useUnder} barrier={s.primaryUnder} onToggle={() => set({ useUnder: !s.useUnder })} onBarrier={n => set({ primaryUnder: n })} />
                    </div>
                    <small>
                        Sixfold only trades these two, on the market it finds best.{' '}
                        {s.recovery ? `After a loss it switches to Over ${s.recoveryOver} / Under ${s.recoveryUnder}.` : 'Recovery barrier is off.'}
                    </small>
                </div>
                <div className='sf-grid3'>
                    <Num label='Stake' value={s.stake} onCommit={n => set({ stake: n })} />
                    <Num label='TP' value={s.takeProfit} onCommit={n => set({ takeProfit: n })} hint='0 = off' />
                    <Num label='SL' value={s.stopLoss} onCommit={n => set({ stopLoss: n })} hint='0 = off' />
                </div>
                <Switch on={s.martingale} onChange={v => set({ martingale: v })} title='Martingale' sub='Auto recovery after a loss' />
                {s.martingale && (
                    <div className='sf-sub'>
                        <div className='sf-field'>
                            <span>Recovery sizing</span>
                            <Seg<RecoverySizing>
                                label='Recovery sizing'
                                value={s.recoverySizing}
                                onChange={v => set({ recoverySizing: v })}
                                options={[
                                    ['PAYOUT', 'Payout-sized'],
                                    ['MULTIPLIER', 'Multiplier'],
                                ]}
                            />
                            <small>
                                {s.recoverySizing === 'PAYOUT'
                                    ? 'Each stake is sized so one win on the contract being bought pays back the share of the open loss you choose. Wins that only part-recover keep the rest owed.'
                                    : 'Each stake is the last stake times the multiplier.'}
                            </small>
                        </div>
                        <div className='sf-grid2'>
                            {s.recoverySizing === 'PAYOUT' ? (
                                <Num label='Win back (%)' value={s.recoverShare} onCommit={n => set({ recoverShare: n })} hint='of what is owed' />
                            ) : (
                                <Num label='Multiplier' value={s.multiplier} onCommit={n => set({ multiplier: n })} />
                            )}
                            <Num label='Max steps' value={s.maxSteps} onCommit={n => set({ maxSteps: n })} hint='0 = no limit' />
                        </div>
                        <div className='sf-grid2'>
                            <Num label='Streak budget (× stake)' value={s.streakBudget} onCommit={n => set({ streakBudget: n })} hint='0 = off' />
                            <Num label='Max stake' value={s.maxStake} onCommit={n => set({ maxStake: n })} hint='0 = no cap' />
                        </div>
                        <StreakCost s={s} />
                    </div>
                )}
                <Switch on={s.recovery} onChange={v => set({ recovery: v })} title='Recovery barrier' sub='After a loss, trade the recovery barrier' />
                {s.recovery && (
                    <div className='sf-sub sf-grid2'>
                        <Num label='Over' value={s.recoveryOver} onCommit={n => set({ recoveryOver: n })} />
                        <Num label='Under' value={s.recoveryUnder} onCommit={n => set({ recoveryUnder: n })} />
                        <small className='sf-wide'>
                            Over {s.recoveryOver} wins {(9 - s.recoveryOver) * 10}% of the time, Under {s.recoveryUnder} wins {s.recoveryUnder * 10}%. A higher win rate means fewer streaks but a smaller payout.
                        </small>
                    </div>
                )}
                <div className='sf-field'>
                    <span>Selectivity</span>
                    <Seg<Selectivity>
                        label='Selectivity'
                        value={s.selectivity}
                        onChange={v => set({ selectivity: v })}
                        options={[
                            ['strict', 'Strict'],
                            ['balanced', 'Balanced'],
                            ['active', 'Active'],
                        ]}
                    />
                    <small>
                        {s.selectivity === 'strict'
                            ? 'Only contracts that stay significant after correcting for every cell scanned.'
                            : s.selectivity === 'balanced'
                              ? 'Viable contracts with a healthy score.'
                              : 'Best available contract, as long as it is not clearly under water.'}
                    </small>
                </div>
                <div className='sf-field'>
                    <span>Entry</span>
                    <Seg<EntryRule>
                        label='Entry'
                        value={s.entry}
                        onChange={v => set({ entry: v })}
                        options={[
                            ['BRAIN', 'Entry Brain'],
                            ['SMART', 'Adaptive'],
                            ['SETUP', 'Fixed digit'],
                            ['ANY', 'Any tick'],
                        ]}
                    />
                    <small>
                        {s.entry === 'BRAIN'
                            ? 'Every market has its own entry digits and is never entered blindly. The last 1000 ticks of each market are studied in windows, oldest to newest, for the digits that were followed by wins on the contract; when the market prints one of them, the bot buys. The study is refreshed as new ticks arrive.'
                            : s.entry === 'SMART'
                            ? 'Learns the entry digits from each market’s recent ticks and changes them as the market moves. The digit that just lost is skipped next time.'
                            : s.entry === 'SETUP'
                              ? 'Always waits for the same losing digits of the contract.'
                              : 'Buys on the next tick after arming.'}
                    </small>
                </div>
                <div className='sf-field'>
                    <span>Recovery entry</span>
                    <Seg<RecoveryEntry>
                        label='Recovery entry'
                        value={s.recoveryEntry}
                        onChange={v => set({ recoveryEntry: v })}
                        options={[
                            ['OFF', 'Same'],
                            ['MOMENTUM', 'After wins'],
                            ['REVERSION', 'After losses'],
                            ['BOUNCE', 'Loss → win'],
                            ['BRAIN', 'Brain · proven digits'],
                        ]}
                    />
                    {s.recoveryEntry !== 'OFF' && s.recoveryEntry !== 'BRAIN' && (
                        <Num label='Ticks in a row' value={s.recoveryForm} onCommit={n => set({ recoveryForm: n })} hint='2–8' />
                    )}
                    <small>
                        {s.recoveryEntry === 'OFF'
                            ? 'Recovery trades enter exactly like normal ones. The Lab’s Entry test shows whether a run-based entry has ever helped on your live ticks.'
                            : s.recoveryEntry === 'BRAIN'
                              ? 'While recovering, enter only on the market’s proven trigger digits for the recovery contract (digits that won in all but one window, including the two newest). If none are proven yet, the best-ranked digits are used.'
                              : s.recoveryEntry === 'BOUNCE'
                              ? `While recovering, also wait for ${s.recoveryForm} or more losing ticks in a row followed by a winning tick, for the contract being bought.`
                              : `While recovering, also wait until the market’s last ${s.recoveryForm} ticks would all have ${s.recoveryEntry === 'MOMENTUM' ? 'won' : 'lost'} for the contract being bought.`}
                    </small>
                </div>
                <Switch on={s.lossShield} onChange={v => set({ lossShield: v })} title='Loss shield' sub='Rest a market after it loses' />
                {s.lossShield && (
                    <div className='sf-sub'>
                        <Num label='Rest for (trades)' value={s.restTrades} onCommit={n => set({ restTrades: n })} hint='doubles after 2 losses there' />
                    </div>
                )}
                <Switch
                    on={s.winStreakGate}
                    onChange={v => set({ winStreakGate: v })}
                    title='Win-streak guard'
                    sub='Buy only inside a run of wins, never while losses are appearing'
                />
                {s.winStreakGate && (
                    <div className='sf-sub'>
                        <div className='sf-grid3'>
                            <Num label='Wins in a row' value={s.winStreak} onCommit={n => set({ winStreak: n })} hint='2–10 · all must win for the contract bought' />
                            <Num label='Drop market at +losses' value={s.lossAbort} onCommit={n => set({ lossAbort: n })} hint='0–4 above expected losses in the last 10' />
                        </div>
                    </div>
                )}
                <Switch
                    on={s.virtualHook}
                    onChange={v => set({ virtualHook: v })}
                    title='Virtual hook'
                    sub='After real losses, trade on paper until the entries win again'
                />
                {s.virtualHook && (
                    <div className='sf-sub'>
                        <Seg<VhMode>
                            label='Virtual hook mode'
                            value={s.vhMode}
                            onChange={v => set({ vhMode: v })}
                            options={[
                                ['STREAK', 'Until paper wins'],
                                ['FIXED', 'Fixed paper trades'],
                            ]}
                        />
                        <div className='sf-grid3'>
                            <Num label='Go virtual after losses' value={s.vhEnterLosses} onCommit={n => set({ vhEnterLosses: n })} hint='real losses in a row' />
                            {s.vhMode === 'STREAK' ? (
                                <Num label='Back to real after wins' value={s.vhReturnWins} onCommit={n => set({ vhReturnWins: n })} hint='paper wins in a row' />
                            ) : (
                                <Num label='Paper trades' value={s.vhFixedCount} onCommit={n => set({ vhFixedCount: n })} hint='then back to real' />
                            )}
                        </div>
                        <small>
                            Paper trades use the same picks, entry rules and guards, are settled on the market’s real ticks, and move no money. Recovery stakes and loss counts wait
                            untouched. It cannot change the odds of a real trade: it only keeps real money out while the entries are losing.
                        </small>
                    </div>
                )}
                <Switch on={s.pickyAfterLoss} onChange={v => set({ pickyAfterLoss: v })} title='Pickier after a loss' sub='Ask for a higher score next' />
                <Switch
                    on={s.pressureGate}
                    onChange={v => set({ pressureGate: v })}
                    title='Losing-digit pressure gate'
                    sub='Skip a market while the digits that would lose are crowding in'
                />
                {s.pressureGate && (
                    <div className='sf-sub'>
                        <Num label='Max pressure' value={s.pressureMax} onCommit={n => set({ pressureMax: n })} hint='10–90, lower is stricter' />
                    </div>
                )}
                <Switch
                    on={s.multiWindowGate}
                    onChange={v => set({ multiWindowGate: v })}
                    title='Multi-window gate'
                    sub='Needs strength across 60 / 120 / 240 / 480 ticks, not only the latest'
                />
                <Switch
                    on={s.meterGuide}
                    onChange={v => set({ meterGuide: v })}
                    title='Meter guide'
                    sub='Buy only when the Meter is at or above the floor'
                />
                {s.meterGuide && (
                    <div className='sf-sub'>
                        <div className='sf-grid3'>
                            <Num label='Meter floor' value={s.meterFloor} onCommit={n => set({ meterFloor: n })} hint='0 = off · buy only at or above' />
                            <Num label='Recovery floor' value={s.meterFloorRecovery} onCommit={n => set({ meterFloorRecovery: n })} hint='0 = off · for recovery trades' />
                            <Num label='Patience (s)' value={s.meterPatience} onCommit={n => set({ meterPatience: n })} hint='extra score bar eases off' />
                        </div>
                    </div>
                )}
                <div className='sf-grid3'>
                    <Num label='Length (ticks)' value={s.duration} onCommit={n => set({ duration: n })} />
                    <Num label='Wait (s)' value={s.waitSeconds} onCommit={n => set({ waitSeconds: n })} hint='for entry' />
                    <Num label='Loss streak stop' value={s.maxConsecutiveLosses} onCommit={n => set({ maxConsecutiveLosses: n })} hint='0 = off' />
                </div>
                <div className='sf-field'>
                    <span>Markets ({s.markets.length})</span>
                    <div className='sf-chips'>
                        {MARKETS.map(([sym]) => (
                            <button
                                key={sym}
                                type='button'
                                className={s.markets.includes(sym) ? 'on' : ''}
                                aria-pressed={s.markets.includes(sym)}
                                onClick={() => toggleMarket(sym)}
                                title={marketName(sym)}
                            >
                                {shortName(sym)}
                            </button>
                        ))}
                    </div>
                </div>
                <button type='button' className='sf-btn subtle' onClick={() => set({ ...DEFAULT_SETTINGS })} disabled={sx.running}>
                    Reset to defaults
                </button>
            </Panel>

            <Panel eyebrow='LIVE MARKET SCAN'>
                <div className='sf-dial'>
                    <Radar markets={dial} armedSymbol={sx.armed?.symbol ?? null} running={sx.running} center={centre} sub={sub} tone={phase.tone} />
                    <div className='sf-dial-title'>{sx.armed ? `${marketName(sx.armed.symbol)}` : sx.running ? 'Scanning all markets' : 'All markets, one scanner'}</div>
                    {sx.running && (sx.resting.length > 0 || sx.pickyBump > 0) && (
                        <div className='sf-rest' role='status'>
                            {sx.resting.length > 0 && (
                                <span>
                                    Resting: {sx.resting.map(r => `${shortName(r.symbol)} (${r.tradesLeft})`).join(', ')}
                                </span>
                            )}
                            {sx.pickyBump > 0 && <span>Pickier: +{sx.pickyBump} score</span>}
                        </div>
                    )}
                    {sx.running && sx.meterGuide.on && sx.meterGuide.verdict !== 'LOADING' && (
                        <div
                            className='sf-rest'
                            role='status'
                            title='The Meter guide never buys a contract in a loss cluster. A poor Meter raises the score a trade needs (recovery most), and that extra bar eases off while Sixfold waits.'
                        >
                            <span>
                                Meter {sx.meterGuide.meter} · {sx.meterGuide.verdict === 'GO' ? 'good' : sx.meterGuide.verdict === 'AVOID' ? 'poor' : 'mixed'}
                                {sx.meterGuide.recovering ? ' · recovery' : ''}
                            </span>
                            <span>
                                {sx.meterGuide.underFloor
                                    ? `Waiting: the Meter must reach ${sx.meterGuide.floor}${sx.meterGuide.recovering ? ' for recovery' : ''}`
                                    : sx.meterGuide.bump > 0
                                      ? `Asking +${sx.meterGuide.bump} score${sx.meterGuide.easesInSec > 0 ? `, easing off over ${sx.meterGuide.easesInSec}s` : ''}`
                                      : sx.meterGuide.floor > 0
                                        ? `Meter at or above ${sx.meterGuide.floor}`
                                        : 'No extra bar'}
                            </span>
                        </div>
                    )}
                    {sx.running && sx.virtualHook.on && (
                        <div className='sf-rest' role='status'>
                            <span>
                                {sx.virtualHook.virtual
                                    ? `Virtual: paper trades only${sx.virtualHook.open ? ' · one open' : ''}`
                                    : `Real money · ${sx.virtualHook.realLosses}/${sx.virtualHook.enterLosses} losses to go virtual`}
                            </span>
                            {sx.virtualHook.virtual && (
                                <span>
                                    {sx.virtualHook.mode === 'STREAK'
                                        ? `${sx.virtualHook.virtualWins}/${sx.virtualHook.returnWins} paper wins to return`
                                        : `${sx.virtualHook.virtualDone}/${sx.virtualHook.fixedCount} paper trades`}
                                </span>
                            )}
                            {sx.virtualHook.paper.trades > 0 && (
                                <span>
                                    Paper: {sx.virtualHook.paper.wins}/{sx.virtualHook.paper.trades} won
                                </span>
                            )}
                        </div>
                    )}
                    {sx.running && sx.armed?.plan && (
                        <div className='sf-rest' role='status' title={sx.armed.plan.why}>
                            <span>Entry plan: {sx.armed.plan.label}</span>
                            {sx.armed.plan.strict && <span>Proven digits only</span>}
                            <span>{EVIDENCE_TEXT[sx.armed.plan.evidence]}</span>
                        </div>
                    )}
                    <div className={`sf-phase t-${phase.tone}`}>
                        {sx.armed
                            ? `${sx.armed.label} · score ${sx.armed.score} · ${s.winStreakGate ? `waiting for ${s.winStreak} wins in a row` : s.entry === 'ANY' ? 'buying now' : sx.armed.plan ? 'waiting for its entry plan' : `waiting for digit ${sx.armed.entryDigits.join(' / ')}`}`
                            : sx.running
                              ? sx.phase === 'connecting'
                                  ? 'Connecting to the market feed…'
                                  : 'Looking for an eligible contract…'
                              : sx.stopReason ?? `${sx.readyMarkets} of ${s.markets.length} markets ready`}
                    </div>
                    {sx.running ? (
                        <button className='sf-run stop' onClick={() => sixfoldRunner.stop('Stopped by you')}>
                            Stop
                        </button>
                    ) : (
                        <button className='sf-run' onClick={() => sixfoldRunner.start()}>
                            Run
                        </button>
                    )}
                    {sx.lastError && <div className='sf-msg bad'>{sx.lastError}</div>}
                    <div className='sf-stats'>
                        <Stat label='Trades' value={sx.session.trades} />
                        <Stat label='Won / lost' value={`${sx.session.wins} / ${sx.session.losses}`} />
                        <Stat label='Session P/L' value={money(sx.session.pnl)} tone={sx.session.pnl > 0 ? 'pos' : sx.session.pnl < 0 ? 'neg' : undefined} />
                        <Stat label='Next stake' value={sx.session.currentStake.toFixed(2)} />
                        <Stat label='Max drawdown' value={sx.session.maxDrawdown.toFixed(2)} />
                    </div>
                    <p className='sf-note'>Every contract Sixfold buys appears in the Transactions panel and the Run Panel summary, and Stop there ends the session too.</p>
                </div>
            </Panel>

            <div className='sf-stack'>
                <Panel eyebrow='SCAN HEALTH' title={summary ? `${summary.significant} significant of ${summary.tested} tested` : 'Waiting for data'}>
                    {summary ? (
                        <p className='sf-lede'>
                            {summary.hotAtFivePct} contracts look unusually good at the 5% level, but chance alone is expected to produce about{' '}
                            <b>{summary.expectedByChance}</b> of those across {summary.tested} tests. After correcting for that, <b>{summary.significant}</b> stay significant.{' '}
                            {summary.significant === 0 ? 'Nothing here stands out from luck, which is the usual result.' : 'Treat those as leads, not forecasts.'}
                        </p>
                    ) : (
                        <p className='sf-lede'>Waiting for the live Deriv feed to start scanning.</p>
                    )}
                </Panel>
                <Panel eyebrow='NEXT IN LINE' title='Top candidates'>
                    {sx.queue.length === 0 ? (
                        <p className='sf-muted'>No scanned contracts yet.</p>
                    ) : (
                        <div className='sf-queue' role='table' aria-label='Top candidates'>
                            {sx.queue.map(({ cell, ok, reason }) => (
                                <button
                                    key={`${cell.symbol}|${cell.key}`}
                                    className={`row ${ok ? 'ok' : ''} ${sx.armed?.symbol === cell.symbol && sx.armed.cellKey === cell.key ? 'armed' : ''}`}
                                    onClick={() => openContract(cell.symbol, cell.contract)}
                                    title={reason}
                                >
                                    <b>
                                        {shortName(cell.symbol)} · {cell.label}
                                    </b>
                                    <span className='bar'>
                                        <i style={{ width: `${cell.score}%` }} />
                                    </span>
                                    <span className='n'>{cell.score}</span>
                                    <span className='n'>{pts(cell.edgePts)}</span>
                                    {cell.significant ? <em>sig</em> : ok ? <em className='soft'>ok</em> : <small>{reason}</small>}
                                </button>
                            ))}
                        </div>
                    )}
                </Panel>
            </div>

            <EntryBrainPanel brain={sx.brain} trades={sx.trades} settings={s} compact />
            <Panel eyebrow='THIS SESSION' title='Trades'>
                {sx.trades.length === 0 ? (
                    <p className='sf-muted'>No trades yet.</p>
                ) : (
                    <ul className='sf-trades'>
                        {sx.trades.slice(0, 12).map(t => (
                            <li key={t.contractId} className={t.status}>
                                <b>{t.name}</b>
                                {t.virtual && <span title='Paper trade: no money was staked'>Virtual</span>}
                                <span title={t.plan ? `Entry plan: ${ARM_BY_ID[t.plan]?.label ?? t.plan}` : undefined}>
                                    {t.label}
                                    {t.recovery ? ' ↺' : ''}
                                </span>
                                <span className='dg' title='entry digit, then the digit the contract settled on'>
                                    <i>{t.entryDigit ?? '·'}</i>→<i className={t.status === 'won' ? 'w' : t.status === 'lost' ? 'l' : ''}>{t.exitDigit ?? '·'}</i>
                                </span>
                                <span>{t.virtual ? 'paper' : 'stake'} {t.stake.toFixed(2)}</span>
                                <em>{t.profit === null ? (t.status === 'open' ? 'open' : '?') : money(t.profit)}</em>
                            </li>
                        ))}
                    </ul>
                )}
            </Panel>
            <Panel eyebrow='ACTIVITY' title='What Sixfold is doing'>
                <ul className='sf-log'>
                    {sx.log.slice(0, 14).map(l => (
                        <li key={l.id} className={l.kind}>
                            <time>{new Date(l.at).toLocaleTimeString([], { hour12: false })}</time>
                            <span>{l.text}</span>
                        </li>
                    ))}
                    {sx.log.length === 0 && <li className='info'>Nothing yet. Press Run.</li>}
                </ul>
            </Panel>
        </main>
    );
}

// ---------- board ----------

function heatTier(c: Cell | undefined): string {
    if (!c || c.edgePts === null) return 'na';
    if (c.significant) return 'sig';
    if (c.edgePts >= 3) return 'hot';
    if (c.edgePts >= 0) return 'up';
    if (c.edgePts >= -3) return 'flat';
    return 'down';
}

function BoardTab({ sx, open }: { sx: ReturnType<typeof useSixfold>; open: (m: string, c?: Contract) => void }) {
    const scan = sx.scan;
    const contracts = primaryContracts(sx.settings);
    const rows = useMemo(() => {
        const symbols = MARKETS.map(m => m[0]);
        return symbols
            .map(sym => {
                const cells = scan?.bySymbol[sym] ?? [];
                const bestCell = cells.filter(c => c.executable).sort((a, b) => b.score - a.score)[0];
                return { sym, cells, best: bestCell };
            })
            .sort((a, b) => (b.best?.score ?? -1) - (a.best?.score ?? -1));
    }, [scan]);
    return (
        <main className='sf-board'>
            <Panel
                eyebrow='MARKET BOARD'
                title={`Every market, ${contracts.map(contractLabel).join(' and ') || 'no contract switched on'}`}
                aside={
                    <div className='sf-legend' aria-label='Legend'>
                        <i className='sig' /> significant <i className='hot' /> ≥ +3 pts <i className='up' /> above break-even <i className='flat' /> slightly under <i className='down' /> well under
                    </div>
                }
            >
                <p className='sf-lede'>
                    Colour = recent win rate minus break-even, in points, for a bot that trades the contract the way DBot does. A dot means it is still significant
                    after correcting for the {scan?.summary.tested ?? 0} contracts scanned. Click a tile to open it.
                </p>
                <div className='sf-heat' role='grid' aria-label='Heat map' style={{ '--n': contracts.length } as CSSProperties}>
                    <div className='hrow hhead'>
                        <span />
                        {contracts.map(c => (
                            <span key={contractKey(c)}>{contractLabel(c)}</span>
                        ))}
                        <span>best</span>
                    </div>
                    {rows.map(r => (
                        <div className='hrow' key={r.sym}>
                            <button className='name' onClick={() => open(r.sym)}>
                                {marketName(r.sym)}
                            </button>
                            {contracts.map(c => {
                                const cell = r.cells.find(x => x.key === contractKey(c));
                                return (
                                    <button
                                        key={contractKey(c)}
                                        className={`cell ${heatTier(cell)}`}
                                        disabled={!cell}
                                        onClick={() => open(r.sym, c)}
                                        title={cell ? `${marketName(r.sym)} · ${cell.label}: ${pts(cell.edgePts)} pts vs break-even, score ${cell.score}, ${cell.windowTrades} trades${cell.qValue !== null ? `, q=${cell.qValue.toFixed(2)}` : ''}` : 'No data yet'}
                                    >
                                        {cell ? (
                                            <>
                                                <b>
                                                    {cell.significant ? '● ' : ''}
                                                    {pts(cell.edgePts)} pts
                                                </b>
                                                <small>score {cell.score}</small>
                                            </>
                                        ) : (
                                            '–'
                                        )}
                                    </button>
                                );
                            })}
                            <span className='best'>{r.best ? `${r.best.label} · ${r.best.score}` : '–'}</span>
                        </div>
                    ))}
                </div>
            </Panel>
        </main>
    );
}

// ---------- contract ----------

function ContractPicker({ contract, setContract }: { contract: Contract; setContract: (c: Contract) => void }) {
    const range = contract.side === 'OVER' ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : contract.side === 'UNDER' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const hasParam = contract.side !== 'EVEN' && contract.side !== 'ODD';
    const dual = contract.side === 'MATCHES' || contract.side === 'DIFFERS';
    return (
        <>
            <label className='sf-fld'>
                <span>Contract</span>
                <select
                    aria-label='Contract type'
                    value={contract.side}
                    onChange={e => {
                        const side = e.target.value as ContractSide;
                        const c: Contract = { side, param: side === 'OVER' ? 2 : side === 'UNDER' ? 7 : 0 };
                        if (isValidContract(c)) setContract(c);
                    }}
                >
                    {SIDES.map(x => (
                        <option key={x} value={x}>
                            {x[0] + x.slice(1).toLowerCase()}
                        </option>
                    ))}
                </select>
            </label>
            {hasParam && (
                <label className='sf-fld'>
                    <span>{dual ? 'Digit' : 'Barrier'}</span>
                    <select
                        aria-label='Barrier or digit'
                        value={contract.dynamic ? 'L' : contract.param}
                        onChange={e => setContract(e.target.value === 'L' ? { side: contract.side, param: 0, dynamic: true } : { side: contract.side, param: Number(e.target.value) })}
                    >
                        {range.map(n => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                        {dual && <option value='L'>last digit</option>}
                    </select>
                </label>
            )}
        </>
    );
}

function MarketSelect({ market, setMarket }: { market: string; setMarket: (m: string) => void }) {
    return (
        <label className='sf-fld'>
            <span>Market</span>
            <select aria-label='Market' value={market} onChange={e => setMarket(e.target.value)}>
                {MARKETS.map(m => (
                    <option key={m[0]} value={m[0]}>
                        {m[1]}
                    </option>
                ))}
            </select>
        </label>
    );
}

function ContractTab(p: {
    series: Record<string, number[]>;
    market: string;
    setMarket: (m: string) => void;
    contract: Contract;
    setContract: (c: Contract) => void;
    settings: SixfoldSettings;
    importText: string;
    setImportText: (s: string) => void;
    onImport: () => void;
}) {
    const [sens, setSens] = useState<Sensitivity>('standard');
    const [bot, setBot] = useState<BotConfig>({ ...DEFAULT_BOT, duration: p.settings.duration, margin: p.settings.margin });
    const sentinel = useSentinelAi(false).signal;
    const cfg = useMemo(() => ({ ...DEFAULT_CROWD, ...SENSITIVITY[sens] }), [sens]);
    const digits = p.series[p.market] ?? [];
    const d = useMemo(() => (digits.length ? buildDossier(digits, p.contract, bot, cfg) : null), [digits, p.contract, bot, cfg]);
    const a = d?.assessment;
    const wins = useMemo(() => (d ? d.run.trades.map(t => t.won) : []), [d]);
    const equity = useMemo(() => (d ? equityCurve(d.run.trades, winProbability(p.contract), bot.margin) : []), [d, p.contract, bot.margin]);
    const rolling = useMemo(() => rollingRate(wins, 30, 10).map(v => (v === null ? null : v * 100)), [wins]);
    const agree = sentinelAgreement(sentinel, p.market, p.contract);

    return (
        <main className='sf-contract'>
            <div className='sf-controls'>
                <MarketSelect market={p.market} setMarket={p.setMarket} />
                <ContractPicker contract={p.contract} setContract={p.setContract} />
                <label className='sf-fld'>
                    <span>Length</span>
                    <select aria-label='Duration' value={bot.duration} onChange={e => setBot({ ...bot, duration: Number(e.target.value) })}>
                        {[1, 2, 3, 4, 5].map(n => (
                            <option key={n} value={n}>
                                {n} tick{n > 1 ? 's' : ''}
                            </option>
                        ))}
                    </select>
                </label>
                <label className='sf-fld'>
                    <span>Bot enters</span>
                    <select aria-label='Entry' value={bot.entry.mode} onChange={e => setBot({ ...bot, entry: { mode: e.target.value as 'SETUP' | 'ANY' } })}>
                        <option value='SETUP'>on a setup digit</option>
                        <option value='ANY'>on any tick</option>
                    </select>
                </label>
                <label className='sf-fld'>
                    <span>Payout margin</span>
                    <select aria-label='Margin' value={bot.margin} onChange={e => setBot({ ...bot, margin: Number(e.target.value) })}>
                        {[0.03, 0.05, 0.08].map(m => (
                            <option key={m} value={m}>
                                {Math.round(m * 100)}%
                            </option>
                        ))}
                    </select>
                </label>
                <label className='sf-fld'>
                    <span>Trap sensitivity</span>
                    <select aria-label='Sensitivity' value={sens} onChange={e => setSens(e.target.value as Sensitivity)}>
                        {Object.keys(SENSITIVITY).map(k => (
                            <option key={k}>{k}</option>
                        ))}
                    </select>
                </label>
            </div>

            {!d || !a ? (
                <p className='sf-msg warn'>No ticks for {marketName(p.market)} yet. Waiting for the live Deriv feed, or paste digits below.</p>
            ) : (
                <>
                    <Panel>
                        <div className='sf-hero'>
                            <div>
                                <div className='eyebrow'>
                                    {marketName(p.market).toUpperCase()} · {d.run.n} TICKS
                                </div>
                                <h1>
                                    {d.label} {pill(a.state)}
                                </h1>
                                <p className='sf-lede'>
                                    {STATE_TEXT[a.state].blurb} {a.reasons.join(' ')}
                                </p>
                                <p className={`sf-agree ${agree.kind.toLowerCase()}`}>{agree.text}</p>
                            </div>
                            <div className='sf-verdict'>
                                <b>Reading</b>
                                <p>{d.verdict}</p>
                            </div>
                        </div>
                        <div className='sf-stats'>
                            <Stat label='Last 20' value={`${a.last20.wins}/${a.last20.n} · ${pct(a.last20.rate)}`} />
                            <Stat label='Last 50' value={pct(a.last50.rate)} />
                            <Stat label='Normal / break-even' value={`${pct(a.p0)} / ${pct(a.breakEven, 1)}`} />
                            <Stat label='Streak · worst loss run' value={`${d.streak.kind ?? '–'}${d.streak.length} · ${d.streak.longestLoss}`} />
                        </div>
                    </Panel>

                    <div className='sf-two'>
                        <Panel eyebrow='FLAT 1-UNIT STAKE' title='Equity curve'>
                            <LineChart values={equity} area label='Cumulative profit at a flat stake' format={v => v.toFixed(1)} lines={[{ value: 0, label: 'start', tone: 'muted' }]} />
                            <p className='sf-note'>Uses the estimated payout. Over many trades this drifts down by the margin; a rise here is a stretch of luck until the Lab says otherwise.</p>
                        </Panel>
                        <Panel eyebrow='ROLLING 30 TRADES' title='Win rate against break-even'>
                            <LineChart
                                values={rolling}
                                label='Rolling win rate'
                                format={v => `${v.toFixed(0)}%`}
                                lines={[
                                    { value: a.breakEven * 100, label: 'break-even', tone: 'amber' },
                                    { value: a.p0 * 100, label: 'normal', tone: 'muted' },
                                ]}
                            />
                        </Panel>
                    </div>

                    <Panel eyebrow='LAST 20 TRADES, AS A BOT WOULD TAKE THEM' title='Wins and losses, not digits'>
                        <div className='sf-wl' role='list' aria-label='Last 20 trades'>
                            {d.last20.length === 0 ? (
                                <span className='sf-muted'>No simulated trades yet.</span>
                            ) : (
                                d.last20.map((t, i) => (
                                    <span key={i} role='listitem' className={t.won ? 'w' : 'l'} title={`entry ${t.entryDigit} → exit ${t.exitDigit}`}>
                                        {t.won ? 'W' : 'L'}
                                        <small>
                                            {t.entryDigit}→{t.exitDigit}
                                        </small>
                                    </span>
                                ))
                            )}
                        </div>
                        {d.run.open && <p className='sf-muted'>A contract is open and settles in {d.run.open.ticksLeft} tick(s).</p>}
                    </Panel>

                    <div className='sf-two'>
                        <Panel eyebrow='WHERE THE SIX TRADERS ARE' title={d.crowd.headline}>
                            <div className='sf-crowd'>
                                <Hexagon positions={d.crowd.positions} />
                                <div className='sf-crowd-rows'>
                                    {d.crowd.positions.map(c => (
                                        <CrowdRow key={c.archetype} c={c} />
                                    ))}
                                </div>
                            </div>
                            <p className='sf-note'>A model, not an observation: each trader type is a rule applied to the digits just printed. “Trapped” = the market showed their side, then delivered the opposite.</p>
                        </Panel>

                        {d.ladder && (
                            <Panel eyebrow={`THE ${p.contract.side} LADDER`} title='Is a different barrier better right now?'>
                                <div className='sf-ladder'>
                                    {d.ladder.map(r => (
                                        <button key={r.key} className={r.key === `${d.contract.side}:${d.contract.param}` ? 'sel' : ''} onClick={() => p.setContract(r.contract)}>
                                            <b>{r.label}</b>
                                            {pill(r.assessment.state)}
                                            <span className='bar'>
                                                <i className={(r.score ?? -1) >= 0 ? 'pos' : 'neg'} style={{ width: `${Math.max(2, Math.min(100, 50 + (r.score ?? -50)))}%` }} />
                                            </span>
                                            <small>{r.score === null ? '—' : `${pts(r.score)} pts`}</small>
                                        </button>
                                    ))}
                                </div>
                                <p className='sf-note'>
                                    Information only: Sixfold trades just the contracts you switch on in the Scanner. {d.bestRung
                                        ? `${d.bestRung.label} has been healthier lately (${pts(d.bestRung.score)} pts). On random digits a gap like this often fades.`
                                        : `No other barrier is clearly healthier than ${d.label} right now.`}
                                </p>
                            </Panel>
                        )}
                    </div>

                    <Panel
                        eyebrow='TRADE THE OPPOSITE: DOES IT HAVE AN EDGE?'
                        title={d.edge ? `${contractLabel(d.edge.trade)} against the ${d.edgeFor!.toLowerCase()} crowd` : 'No trapped crowd right now'}
                        aside={d.edge ? <span className={`sf-state ev-${d.edge.verdict.toLowerCase()}`}>{d.edge.verdict.replace('_', ' ')}</span> : undefined}
                    >
                        <p className='sf-lede'>
                            {d.edge
                                ? d.edge.summary
                                : 'When a trader type is trapped, Sixfold replays “trade their opposite” over this history and says whether it beat break-even or just matched chance.'}
                        </p>
                        {d.edge && d.edge.pValue !== null && (
                            <div className='sf-stats'>
                                <Stat label='Trades' value={d.edge.trades} />
                                <Stat label='Chance of this by luck' value={`${(d.edge.pValue * 100).toFixed(0)}%`} />
                                <Stat label='First / second half' value={`${pct(d.edge.halves[0])} / ${pct(d.edge.halves[1])}`} />
                                <Stat label='Break-even' value={pct(d.edge.breakEven, 1)} />
                            </div>
                        )}
                    </Panel>

                    <Panel eyebrow='LAST 100 TICKS' title='Digit shares' aside={<span className='sf-muted'>{d.contract.dynamic ? '' : `normal win rate ${pct(winProbability(d.contract))}`}</span>}>
                        <DigitBars counts={d.digitShare} expected={Math.min(100, digits.length) / 10} label='Digit counts over the last 100 ticks' />
                    </Panel>
                </>
            )}

            <Panel eyebrow='IMPORT' title={`Paste digits for ${marketName(p.market)}`}>
                <textarea className='sf-input' aria-label='Digits to import' value={p.importText} onChange={e => p.setImportText(e.target.value)} placeholder='1 4 7 2 4 …' />
                <div className='sf-right'>
                    <button className='sf-btn' onClick={p.onImport}>
                        Use these digits
                    </button>
                </div>
            </Panel>
        </main>
    );
}

function CrowdRow({ c }: { c: CrowdPosition }) {
    return (
        <div className={`sf-crow cs-${c.state.toLowerCase()}`}>
            <div className='who'>
                <b>{c.name}</b>
                <small>{ARCHETYPE_TEXT[c.archetype].rule}</small>
            </div>
            <span className='st'>{c.state}</span>
            <span className='bar'>
                <i style={{ width: `${c.conviction}%` }} />
            </span>
            <span className='opp'>
                opposite <b>{contractLabel(c.opposite)}</b>
            </span>
        </div>
    );
}

// ---------- lab ----------

function EntryTestPanel({ series, contract, settings }: { series: Record<string, number[]>; contract: Contract; settings: SixfoldSettings }) {
    const k = settings.recoveryForm;
    const res = useMemo(() => entryTest(series, contract, k, settings.duration), [series, contract, k, settings.duration]);
    const rows: Array<[string, typeof res.baseline]> = [
        ['Any tick (baseline)', res.baseline],
        [`After ${k} wins in a row`, res.afterWins],
        [`After ${k} losses in a row`, res.afterLosses],
        [`After ${k} losses, then a win`, res.afterBounce],
    ];
    const hit = [res.afterWins, res.afterLosses, res.afterBounce].filter(r => r.p !== null && r.p < 0.017 && (r.edgePts ?? 0) > 0);
    return (
        <Panel
            eyebrow='ENTRY TEST'
            title={res.baseline.n < 500 ? 'Not enough ticks yet' : hit.length ? 'A run-based entry shows a lead' : 'Waiting for a run does not change the next result'}
        >
            <div className='sf-table' role='table' aria-label='Entry test'>
                <div className='tr th'>
                    <span>When {contractLabel(contract)} is bought</span>
                    <span>Trades</span>
                    <span>Win rate</span>
                    <span>vs baseline</span>
                    <span>p</span>
                </div>
                {rows.map(([name, r]) => (
                    <div className='tr' key={name}>
                        <span>{name}</span>
                        <span>{r.n.toLocaleString()}</span>
                        <span>{r.rate === null ? '—' : pct(r.rate, 1)}</span>
                        <span className={(r.edgePts ?? 0) > 1 && r.p !== null && r.p < 0.05 ? 'pos' : ''}>{r.edgePts === null ? '—' : `${pts(r.edgePts)} pts`}</span>
                        <span>{r.p === null ? '—' : r.p.toFixed(3)}</span>
                    </div>
                ))}
            </div>
            <p className='sf-note'>
                Every tick of all {res.markets} markets with enough history, judged as if a contract had been bought on it. If waiting for a run of wins or losses
                helped, its win rate would sit clearly away from the baseline with a small p. Three rows are tested, so only p below about 0.017 is worth a look, and one lead
                on a short history is usually noise: check it again later. Deriv generates its digits randomly, so a gap near zero is the expected answer.
            </p>
        </Panel>
    );
}

const EVIDENCE_TEXT: Record<Evidence, string> = {
    LEARNING: 'Learning',
    PROVEN: 'Proven in recent windows',
    BEST: 'Best available',
};

function EntryBrainPanel({ brain, trades, settings, compact }: { brain: BrainReport | null; trades: TradeRecord[]; settings: SixfoldSettings; compact?: boolean }) {
    const ledger = useMemo(() => planLedger(trades), [trades]);
    const on = settings.entry === 'BRAIN' || settings.recoveryEntry === 'BRAIN';
    const ready = !!brain && brain.cells.length > 0;
    return (
        <Panel eyebrow='ENTRY LAB' title={!ready ? 'Collecting ticks' : on ? 'Every market enters on its own digits' : 'Entry Brain is off in Scanner settings'}>
            <p className='sf-lede'>
                {!ready
                    ? 'A market is studied once it has about 200 ticks. Until then it has no entry digit and no trade is placed on it. '
                    : `${brain!.proven} of ${brain!.total} entry digits held up in every recent window; the rest are the best-ranked digits available. `}
                {ledger.n === 0
                    ? 'No trigger-digit trades yet.'
                    : `Trigger-digit trades: ${ledger.wins} won of ${ledger.n}. A random tick on the same markets would be expected to win ${ledger.expected.toFixed(1)} (±${ledger.sd.toFixed(1)}). ${ledger.verdict}`}
            </p>
            {!compact && ready && (
                <>
                    <h3 className='sf-h3'>Entry digits for each market and contract</h3>
                    <div className='sf-table' role='table' aria-label='Entry digits by market'>
                        <div className='tr th'>
                            <span>Market · contract</span>
                            <span>Entry digits</span>
                            <span>Win rate when touched</span>
                            <span>Win rate by window (old → new)</span>
                            <span>Status</span>
                        </div>
                        {brain!.cells.flatMap(c =>
                            c.triggers.map(t => (
                                <div className='tr' key={`${c.symbol}${c.key}${t.digit}`}>
                                    <span>
                                        {marketName(c.symbol)} · {c.label}
                                    </span>
                                    <span title={ARM_BY_ID.TRIGGER_DIGITS.blurb}>Digit {t.digit}</span>
                                    <span>
                                        {pct(t.rate, 1)} <small className='sf-muted'>base {pct(c.theoretical)} · {t.touches} touches</small>
                                    </span>
                                    <span>{t.windows.map(w => (w.rate === null ? '—' : `${Math.round(w.rate * 100)}%`)).join(' · ')}</span>
                                    <span className={t.evidence === 'PROVEN' ? 'pos' : ''}>
                                        {t.passed}/{t.windows.length} windows · {EVIDENCE_TEXT[t.evidence]}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                    {ledger.byArm.length > 0 && <p className='sf-note'>Trades placed on entry digits so far: {ledger.byArm.map(a => `${a.wins}/${a.n}`).join(', ')}.</p>}
                </>
            )}
            <p className='sf-note'>
                Each market’s last {brain?.cells[0]?.ticks ?? 1000} ticks are cut into {WINDOWS} windows, oldest to newest. For every digit, each time it printed the Lab checks whether the contract won, and a digit only counts as proven when it beat the contract’s base
                rate in all but one window, including the two newest. The three best digits per market are its entry digits and the study is refreshed every few seconds. The trade record above compares them with entering on a random tick, so you
                can see whether a digit that won before keeps winning on new ticks.
            </p>
        </Panel>
    );
}

function LabTab(p: {
    series: Record<string, number[]>;
    market: string;
    setMarket: (m: string) => void;
    contract: Contract;
    setContract: (c: Contract) => void;
    settings: SixfoldSettings;
    brain: BrainReport | null;
    trades: TradeRecord[];
}) {
    const digits = p.series[p.market] ?? [];
    const symbols = useMemo(() => MARKETS.map(m => m[0]).filter(s => (p.series[s]?.length ?? 0) >= 100), [p.series]);
    const uni = useMemo(() => uniformityTest(digits), [digits]);
    const trans = useMemo(() => transitionTest(digits), [digits]);
    const runs = useMemo(() => contractRuns(digits, p.contract), [digits, p.contract]);
    const table = useMemo(() => structureTable(p.series, symbols), [p.series, symbols]);
    const [sim, setSim] = useState<{ cal: ReturnType<typeof calibrateLabels>; bank: ReturnType<typeof bankrollSim>; for: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const key = `${p.market}|${contractKey(p.contract)}|${digits.length}`;
    const run = () => {
        setBusy(true);
        window.setTimeout(() => {
            const bot: BotConfig = { duration: p.settings.duration, entry: { mode: p.settings.entry === 'ANY' ? 'ANY' : 'SETUP' }, margin: p.settings.margin };
            setSim({ cal: calibrateLabels(digits, p.contract, bot), bank: bankrollSim(p.contract, p.settings, 1000), for: key });
            setBusy(false);
        }, 30);
    };
    const fresh = sim && sim.for.startsWith(`${p.market}|${contractKey(p.contract)}|`);

    return (
        <main className='sf-lab'>
            <div className='sf-controls'>
                <MarketSelect market={p.market} setMarket={p.setMarket} />
                <ContractPicker contract={p.contract} setContract={p.setContract} />
            </div>

            <div className='sf-two'>
                <Panel eyebrow='DIGIT UNIFORMITY' title={uni.p === null ? 'Not enough ticks yet' : uni.p < 0.01 ? 'Unevenness is unlikely to be chance' : 'Consistent with fair digits'}>
                    <DigitBars counts={uni.counts} expected={uni.n / 10} label={`Digit counts over the last ${uni.n} ticks`} />
                    <p className='sf-note'>
                        {uni.p === null
                            ? 'Needs 100+ ticks.'
                            : `Chi-square ${uni.chi2.toFixed(1)} on 9 degrees of freedom, p = ${uni.p.toFixed(3)} over ${uni.n} ticks.${uni.worst ? ` Furthest from even: digit ${uni.worst.digit} (${uni.worst.z >= 0 ? '+' : ''}${uni.worst.z.toFixed(1)}σ).` : ''}`}
                    </p>
                </Panel>
                <Panel eyebrow='DOES THE LAST DIGIT PREDICT THE NEXT?' title={trans.p === null ? 'Not enough ticks yet' : trans.p < 0.01 ? 'Dependence between digits' : 'No dependence found'}>
                    <TransitionHeat z={trans.z} label='Digit to next-digit residuals' />
                    <p className='sf-note'>
                        {trans.p === null
                            ? 'Needs 300+ ticks.'
                            : `Independence test: chi-square ${trans.chi2.toFixed(0)} on ${trans.df} degrees of freedom, p = ${trans.p.toFixed(3)}. Bright cells are single-cell outliers; with 100 cells a few always appear.`}
                    </p>
                </Panel>
            </div>

            <Panel eyebrow={`STREAKINESS OF ${contractLabel(p.contract).toUpperCase()}`} title={runs.p === null ? 'Not enough ticks yet' : runs.p < 0.01 ? (runs.z < 0 ? 'Streakier than chance' : 'More alternating than chance') : 'Wins and losses arrive as randomly as chance'}>
                <p className='sf-lede'>{runs.p === null ? 'Needs 30+ outcomes.' : `${runs.runs} runs over ${runs.n} ticks, z = ${runs.z.toFixed(2)}, p = ${runs.p.toFixed(3)}.`}</p>
            </Panel>

            <EntryTestPanel series={p.series} contract={p.contract} settings={p.settings} />
            <EntryBrainPanel brain={p.brain} trades={p.trades} settings={p.settings} />

            <Panel
                eyebrow='SIMULATIONS'
                title='Do the labels mean anything, and what does your money plan do?'
                aside={
                    <button className='sf-btn primary' onClick={run} disabled={busy || digits.length < 500}>
                        {busy ? 'Running…' : fresh ? 'Run again' : 'Run simulations'}
                    </button>
                }
            >
                {!fresh ? (
                    <p className='sf-muted'>{digits.length < 500 ? 'Needs 500+ ticks on this market.' : 'Runs the label calibration and a 1,000-session bankroll simulation for this market, this contract and your Scanner settings.'}</p>
                ) : (
                    <>
                        <h3 className='sf-h3'>Calibration: what happened after each label</h3>
                        <div className='sf-table' role='table' aria-label='Label calibration'>
                            <div className='tr th'>
                                <span>Label</span>
                                <span>Checkpoints</span>
                                <span>Next trades</span>
                                <span>Win rate</span>
                                <span>Normal</span>
                                <span>Lift</span>
                            </div>
                            {sim.cal.map(r => (
                                <div className='tr' key={r.state}>
                                    <span>{pill(r.state)}</span>
                                    <span>{r.checkpoints}</span>
                                    <span>{r.trades}</span>
                                    <span>{pct(r.rate, 1)}</span>
                                    <span>{pct(r.normal, 1)}</span>
                                    <span className={(r.liftPts ?? 0) > 2 ? 'pos' : (r.liftPts ?? 0) < -2 ? 'neg' : ''}>{r.liftPts === null ? '—' : `${pts(r.liftPts)} pts`}</span>
                                </div>
                            ))}
                        </div>
                        <p className='sf-note'>Each label is computed from trades settled so far, then the next 150 ticks are scored. If VIABLE were informative its forward win rate would sit clearly above normal; a lift near zero means the label described the past and said nothing about what came next.</p>

                        <h3 className='sf-h3'>Bankroll: {sim.bank.runs.toLocaleString()} sessions with your settings</h3>
                        <div className='sf-stats'>
                            <Stat label='Hit take profit' value={pct(sim.bank.hitTakeProfit)} tone='pos' />
                            <Stat label='Hit stop loss' value={pct(sim.bank.hitStopLoss)} tone='neg' />
                            <Stat label='Loss-streak stop' value={pct(sim.bank.hitLossStreak)} />
                            <Stat label='Median session' value={money(sim.bank.medianPnl)} />
                            <Stat label='Bad day (5th pct)' value={money(sim.bank.p5Pnl)} tone='neg' />
                            <Stat label='Good day (95th pct)' value={money(sim.bank.p95Pnl)} tone='pos' />
                            <Stat label='Mean per session' value={money(sim.bank.meanPnl)} tone={sim.bank.meanPnl < 0 ? 'neg' : 'pos'} />
                            <Stat label='Largest stake placed' value={sim.bank.worstStake.toFixed(2)} />
                        </div>
                        <p className='sf-note'>
                            Fair random digits, estimated payout. Expected result per unit staked on one trade: {sim.bank.evPerUnit.toFixed(3)}. A high chance of hitting take profit comes with a smaller chance of a much bigger loss; the mean shows the price.
                        </p>
                    </>
                )}
            </Panel>

            <Panel eyebrow='ACROSS MARKETS' title='Structure by market (false-discovery adjusted)'>
                <div className='sf-table' role='table' aria-label='Structure by market'>
                    <div className='tr th'>
                        <span>Market</span>
                        <span>Uniformity p</span>
                        <span>adj. q</span>
                        <span>Dependence p</span>
                        <span>adj. q</span>
                        <span>Trace</span>
                    </div>
                    {table.map(r => (
                        <div className='tr' key={r.symbol}>
                            <span>{shortName(r.symbol)}</span>
                            <span>{r.uniformity.p === null ? '—' : r.uniformity.p.toFixed(3)}</span>
                            <span className={r.uniformityQ !== null && r.uniformityQ < 0.1 ? 'neg' : ''}>{r.uniformityQ === null ? '—' : r.uniformityQ.toFixed(3)}</span>
                            <span>{r.transition.p === null ? '—' : r.transition.p.toFixed(3)}</span>
                            <span className={r.transitionQ !== null && r.transitionQ < 0.1 ? 'neg' : ''}>{r.transitionQ === null ? '—' : r.transitionQ.toFixed(3)}</span>
                            <span>
                                <Sparkline values={(p.series[r.symbol] ?? []).slice(-60)} />
                            </span>
                        </div>
                    ))}
                </div>
                <p className='sf-note'>A q below 0.10 would mean a market's digits are unlikely to be fair even after allowing for testing many markets. Expect none on Deriv's synthetic indices.</p>
            </Panel>
        </main>
    );
}

export default SixfoldPage;
