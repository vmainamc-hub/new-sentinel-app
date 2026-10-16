import { useEffect, useMemo, useState } from 'react';
import { type BotConfig, type Contract, contractLabel, DEFAULT_BOT, isValidContract, winProbability } from './bot';
import { simulateBot } from './bot';
import { ARCHETYPE_TEXT, type CrowdPosition, DEFAULT_CROWD, SENSITIVITY, type Sensitivity } from './crowd';
import { crowdMap } from './crowd';
import { buildDossier, ladder } from './dossier';
import type { ContractSide } from './engine';
import { marketName, MARKETS, useFeed } from './feed';
import {
    isValidBarrier,
    loadSignalIntoRecoverBot,
    prefetchRecoverBots,
    RECOVER_BOTS,
    type RecoverContract,
} from './recover-bots';
import { assessRun, STATE_TEXT, type ViabilityState } from './viability';
import './sixfold.scss';

const SIDES: ContractSide[] = ['OVER', 'UNDER', 'EVEN', 'ODD', 'MATCHES', 'DIFFERS'];
const pct = (x: number | null, d = 0) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`);
const pill = (s: ViabilityState) => <span className={`vstate vs-${s.toLowerCase()}`}>{STATE_TEXT[s].label}</span>;

const SixfoldPage = ({ openBotBuilder }: { openBotBuilder: () => void }) => {
    const feed = useFeed();
    useEffect(() => {
        prefetchRecoverBots();
    }, []);
    const [tab, setTab] = useState<'board' | 'desk'>('board');
    const [market, setMarket] = useState('1HZ10V');
    const [contract, setContract] = useState<Contract>({ side: 'OVER', param: 2 });
    const [bot, setBot] = useState<BotConfig>(DEFAULT_BOT);
    const [sens, setSens] = useState<Sensitivity>('standard');
    const [importText, setImportText] = useState('');
    const crowdCfg = useMemo(() => ({ ...DEFAULT_CROWD, ...SENSITIVITY[sens] }), [sens]);
    const digits = feed.series[market] ?? [];

    const open = (m: string, c?: Contract) => {
        setMarket(m);
        if (c) setContract(c);
        setTab('desk');
    };

    return (
        <div className='sixfold sf'>
            <header className='sf-top'>
                <b className='sf-brand'>SIXFOLD</b>
                <nav>
                    {(
                        [
                            ['board', 'Market board'],
                            ['desk', 'Contract desk'],
                        ] as const
                    ).map(([k, l]) => (
                        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                            {l}
                        </button>
                    ))}
                </nav>
                <span className={`sf-feed ${feed.status}`}>
                    {feed.mode === 'demo'
                        ? 'DEMO DATA'
                        : feed.mode === 'import'
                          ? 'IMPORTED'
                          : feed.status.toUpperCase()}
                </span>
            </header>

            <section className='sf-feedbar'>
                <button className='btn primary' onClick={feed.connect}>
                    Connect live
                </button>
                <button className='btn secondary' onClick={feed.useDemo}>
                    Demo data
                </button>
                {feed.error && (
                    <div className='error-banner'>
                        <span>{feed.error}</span>
                    </div>
                )}
                {feed.mode === 'demo' && (
                    <div className='notice'>
                        <span>
                            Demo data is random digits made for testing. Nothing on this screen about it says anything
                            about a real market.
                        </span>
                    </div>
                )}
            </section>

            {tab === 'board' && <Board series={feed.series} bot={bot} cfg={crowdCfg} open={open} />}
            {tab === 'desk' && (
                <Desk
                    digits={digits}
                    market={market}
                    setMarket={setMarket}
                    contract={contract}
                    setContract={setContract}
                    bot={bot}
                    setBot={setBot}
                    sens={sens}
                    setSens={setSens}
                    cfg={crowdCfg}
                    importText={importText}
                    setImportText={setImportText}
                    onImport={() => feed.importDigits(market, importText)}
                    openBotBuilder={openBotBuilder}
                />
            )}
            <footer className='sf-foot'>
                Sixfold reads patterns in past digits. It cannot see other traders, and Deriv digits are generated
                randomly, so “no edge” is a normal and honest result. Not financial advice.
            </footer>
        </div>
    );
};

function Board({
    series,
    bot,
    cfg,
    open,
}: {
    series: Record<string, number[]>;
    bot: BotConfig;
    cfg: typeof DEFAULT_CROWD;
    open: (m: string, c?: Contract) => void;
}) {
    const rows = useMemo(
        () =>
            MARKETS.map(([sym, name]) => {
                const d = series[sym] ?? [];
                const o2 = assessRun(simulateBot(d, { side: 'OVER', param: 2 }, bot)),
                    u7 = assessRun(simulateBot(d, { side: 'UNDER', param: 7 }, bot));
                const lad = d.length
                    ? ladder(d, 'OVER', bot)
                          .filter(r => r.score !== null && r.assessment.trades >= 20)
                          .sort((a, b) => b.score! - a.score!)[0]
                    : undefined;
                return { sym, name, n: d.length, last: d.at(-1), o2, u7, best: lad, crowd: crowdMap(d, cfg) };
            }),
        [series, bot, cfg]
    );
    return (
        <main className='sf-board'>
            <h1>Where is each market right now?</h1>
            <p className='lede'>
                Click a market to see its contracts. Each card shows how Over 2 and Under 7 have been doing for a bot
                that trades them the way DBot does, and where the crowd is.
            </p>
            <div className='sf-cards'>
                {rows.map(r => (
                    <article key={r.sym} className='mcard'>
                        <header>
                            <b>{r.name}</b>
                            <span className='dg'>{r.last ?? '–'}</span>
                        </header>
                        {r.n === 0 ? (
                            <p className='muted'>No ticks yet.</p>
                        ) : (
                            <>
                                <div className='mrow'>
                                    <button onClick={() => open(r.sym, { side: 'OVER', param: 2 })}>Over 2</button>
                                    {pill(r.o2.state)}
                                    <small>{r.o2.trades} trades</small>
                                </div>
                                <div className='mrow'>
                                    <button onClick={() => open(r.sym, { side: 'UNDER', param: 7 })}>Under 7</button>
                                    {pill(r.u7.state)}
                                    <small>{r.u7.trades} trades</small>
                                </div>
                                {r.best && (
                                    <p className='muted'>
                                        Healthiest Over lately: <b>{r.best.label}</b>
                                    </p>
                                )}
                                <p className='crowdline'>{r.crowd.headline}</p>
                            </>
                        )}
                        <button className='btn subtle' onClick={() => open(r.sym)}>
                            Open desk →
                        </button>
                    </article>
                ))}
            </div>
        </main>
    );
}

function ContractPicker({ contract, setContract }: { contract: Contract; setContract: (c: Contract) => void }) {
    const range =
        contract.side === 'OVER'
            ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
            : contract.side === 'UNDER'
              ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
              : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const hasParam = contract.side !== 'EVEN' && contract.side !== 'ODD';
    const dual = contract.side === 'MATCHES' || contract.side === 'DIFFERS';
    return (
        <>
            <label>
                Contract{' '}
                <select
                    aria-label='Contract type'
                    value={contract.side}
                    onChange={e => {
                        const side = e.target.value as ContractSide;
                        const c: Contract = { side, param: side === 'OVER' ? 2 : side === 'UNDER' ? 7 : 0 };
                        if (isValidContract(c)) setContract(c);
                    }}
                >
                    {SIDES.map(s => (
                        <option key={s} value={s}>
                            {s[0] + s.slice(1).toLowerCase()}
                        </option>
                    ))}
                </select>
            </label>
            {hasParam && (
                <label>
                    {dual ? 'Digit' : 'Barrier'}{' '}
                    <select
                        aria-label='Barrier or digit'
                        value={contract.dynamic ? 'L' : contract.param}
                        onChange={e =>
                            setContract(
                                e.target.value === 'L'
                                    ? { side: contract.side, param: 0, dynamic: true }
                                    : { side: contract.side, param: Number(e.target.value) }
                            )
                        }
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

function Desk(p: {
    digits: number[];
    market: string;
    setMarket: (m: string) => void;
    contract: Contract;
    setContract: (c: Contract) => void;
    bot: BotConfig;
    setBot: (b: BotConfig) => void;
    sens: Sensitivity;
    setSens: (s: Sensitivity) => void;
    cfg: typeof DEFAULT_CROWD;
    importText: string;
    setImportText: (s: string) => void;
    onImport: () => void;
    openBotBuilder: () => void;
}) {
    const d = useMemo(
        () => (p.digits.length ? buildDossier(p.digits, p.contract, p.bot, p.cfg) : null),
        [p.digits, p.contract, p.bot, p.cfg]
    );
    const a = d?.assessment;
    return (
        <main className='sf-desk'>
            <div className='sf-controls'>
                <label>
                    Market{' '}
                    <select aria-label='Market' value={p.market} onChange={e => p.setMarket(e.target.value)}>
                        {MARKETS.map(m => (
                            <option key={m[0]} value={m[0]}>
                                {m[1]}
                            </option>
                        ))}
                    </select>
                </label>
                <ContractPicker contract={p.contract} setContract={p.setContract} />
                <label>
                    Contract length{' '}
                    <select
                        aria-label='Duration'
                        value={p.bot.duration}
                        onChange={e => p.setBot({ ...p.bot, duration: Number(e.target.value) })}
                    >
                        {[1, 2, 3, 4, 5].map(n => (
                            <option key={n} value={n}>
                                {n} tick{n > 1 ? 's' : ''}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Bot enters{' '}
                    <select
                        aria-label='Entry'
                        value={p.bot.entry.mode}
                        onChange={e => p.setBot({ ...p.bot, entry: { mode: e.target.value as 'SETUP' | 'ANY' } })}
                    >
                        <option value='SETUP'>on a losing digit (setup)</option>
                        <option value='ANY'>on any digit</option>
                    </select>
                </label>
                <label>
                    Payout margin{' '}
                    <select
                        aria-label='Margin'
                        value={p.bot.margin}
                        onChange={e => p.setBot({ ...p.bot, margin: Number(e.target.value) })}
                    >
                        {[0.03, 0.05, 0.08].map(m => (
                            <option key={m} value={m}>
                                {m * 100}%
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Trap sensitivity{' '}
                    <select
                        aria-label='Sensitivity'
                        value={p.sens}
                        onChange={e => p.setSens(e.target.value as Sensitivity)}
                    >
                        {Object.keys(SENSITIVITY).map(k => (
                            <option key={k}>{k}</option>
                        ))}
                    </select>
                </label>
            </div>

            {!d || !a ? (
                <div className='notice'>
                    <span>
                        No ticks for {marketName(p.market)} yet. Connect live, use demo data, or paste digits below.
                    </span>
                </div>
            ) : (
                <>
                    <section className='panel sf-hero'>
                        <div>
                            <div className='eyebrow'>
                                {marketName(p.market).toUpperCase()} · {d.run.n} TICKS
                            </div>
                            <h1>
                                {d.label} {pill(a.state)}
                            </h1>
                            <p className='lede'>
                                {STATE_TEXT[a.state].blurb} {a.reasons.join(' ')}
                            </p>
                        </div>
                        <div className='sf-verdict'>
                            <b>Reading</b>
                            <p>{d.verdict}</p>
                        </div>
                    </section>

                    <section className='panel'>
                        <div className='panel-head'>
                            <div>
                                <div className='eyebrow'>LAST 20 TRADES, AS A BOT WOULD TAKE THEM</div>
                                <h2>Wins and losses, not digits</h2>
                                <p>
                                    The bot waits for an entry digit, buys on the next tick, settles {p.bot.duration}{' '}
                                    tick(s) later, then waits again. One trade at a time.
                                </p>
                            </div>
                        </div>
                        <div className='wl' role='list' aria-label='Last 20 trades'>
                            {d.last20.length === 0 ? (
                                <span className='muted'>No simulated trades yet.</span>
                            ) : (
                                d.last20.map((t, i) => (
                                    <span
                                        key={i}
                                        role='listitem'
                                        className={`wlchip ${t.won ? 'w' : 'l'}`}
                                        title={`entry ${t.entryDigit} → exit ${t.exitDigit}`}
                                    >
                                        {t.won ? 'W' : 'L'}
                                        <small>
                                            {t.entryDigit}→{t.exitDigit}
                                        </small>
                                    </span>
                                ))
                            )}
                        </div>
                        <div className='mini-stats stats4'>
                            <div>
                                <small>Last 20</small>
                                <b>
                                    {a.last20.wins}/{a.last20.n} · {pct(a.last20.rate)}
                                </b>
                            </div>
                            <div>
                                <small>Last 50</small>
                                <b>{pct(a.last50.rate)}</b>
                            </div>
                            <div>
                                <small>Normal / break-even</small>
                                <b>
                                    {pct(a.p0)} / {pct(a.breakEven, 1)}
                                </b>
                            </div>
                            <div>
                                <small>Streak · worst loss run</small>
                                <b>
                                    {d.streak.kind ?? '–'}
                                    {d.streak.length} · {d.streak.longestLoss}
                                </b>
                            </div>
                        </div>
                        {d.run.open && (
                            <p className='muted'>A contract is open and settles in {d.run.open.ticksLeft} tick(s).</p>
                        )}
                    </section>

                    <Signals
                        market={p.market}
                        contract={p.contract}
                        trapped={d.crowd.trapped}
                        openBotBuilder={p.openBotBuilder}
                    />

                    {d.ladder && (
                        <section className='panel'>
                            <div className='panel-head'>
                                <div>
                                    <div className='eyebrow'>THE {p.contract.side} LADDER</div>
                                    <h2>Is a different barrier better right now?</h2>
                                    <p>
                                        Score = recent win rate minus break-even, in points. Positive means beating the
                                        payout lately; it does not predict the next trade.
                                    </p>
                                </div>
                            </div>
                            <div className='ladder'>
                                {d.ladder.map(r => (
                                    <button
                                        key={r.key}
                                        className={`lrow ${r.key === `${d.contract.side}:${d.contract.param}` ? 'sel' : ''}`}
                                        onClick={() => p.setContract(r.contract)}
                                    >
                                        <b>{r.label}</b>
                                        {pill(r.assessment.state)}
                                        <span className='lbar'>
                                            <i
                                                style={{
                                                    width: `${Math.max(2, Math.min(100, 50 + (r.score ?? -50)))}%`,
                                                }}
                                                className={(r.score ?? -1) >= 0 ? 'pos' : 'neg'}
                                            />
                                        </span>
                                        <small>
                                            {r.score === null
                                                ? '—'
                                                : `${r.score >= 0 ? '+' : ''}${r.score.toFixed(1)} pts`}
                                        </small>
                                    </button>
                                ))}
                            </div>
                            {d.bestRung ? (
                                <p className='callout'>
                                    {d.bestRung.label} has been healthier lately: {d.bestRung.score!.toFixed(1)} pts
                                    against break-even, versus{' '}
                                    {(
                                        d.ladder.find(r => r.key === `${d.contract.side}:${d.contract.param}`)?.score ??
                                        0
                                    ).toFixed(1)}{' '}
                                    pts for {d.label}. On random digits a gap like this often fades.
                                </p>
                            ) : (
                                <p className='muted'>No other barrier is clearly healthier than {d.label} right now.</p>
                            )}
                        </section>
                    )}

                    <section className='panel'>
                        <div className='panel-head'>
                            <div>
                                <div className='eyebrow'>WHERE THE SIX TRADERS ARE</div>
                                <h2>{d.crowd.headline}</h2>
                                <p>
                                    A model, not an observation: each trader type is a rule applied to the digits just
                                    printed. “Trapped” = the market showed their side, then delivered the opposite.
                                </p>
                            </div>
                        </div>
                        <div className='crowd'>
                            {d.crowd.positions.map(c => (
                                <CrowdRow key={c.archetype} c={c} />
                            ))}
                        </div>
                    </section>

                    <section className='panel'>
                        <div className='panel-head'>
                            <div>
                                <div className='eyebrow'>TRADE THE OPPOSITE: DOES IT HAVE AN EDGE?</div>
                                <h2>
                                    {d.edge
                                        ? `${contractLabel(d.edge.trade)} against the ${d.edgeFor!.toLowerCase()} crowd`
                                        : 'No trapped crowd right now'}
                                </h2>
                            </div>
                            {d.edge && (
                                <span className={`vstate ev-${d.edge.verdict.toLowerCase()}`}>
                                    {d.edge.verdict.replace('_', ' ')}
                                </span>
                            )}
                        </div>
                        <p className='lede'>
                            {d.edge
                                ? d.edge.summary
                                : 'When a trader type is trapped, Sixfold replays "trade their opposite" over this history and tells you whether it beat break-even or just matched chance.'}
                        </p>
                        {d.edge && d.edge.pValue !== null && (
                            <div className='mini-stats stats4'>
                                <div>
                                    <small>Trades</small>
                                    <b>{d.edge.trades}</b>
                                </div>
                                <div>
                                    <small>Chance of this by luck</small>
                                    <b>{(d.edge.pValue * 100).toFixed(0)}%</b>
                                </div>
                                <div>
                                    <small>First / second half</small>
                                    <b>
                                        {pct(d.edge.halves[0])} / {pct(d.edge.halves[1])}
                                    </b>
                                </div>
                                <div>
                                    <small>Break-even</small>
                                    <b>{pct(d.edge.breakEven, 1)}</b>
                                </div>
                            </div>
                        )}
                    </section>

                    <section className='panel'>
                        <div className='panel-head'>
                            <div>
                                <div className='eyebrow'>LAST 100 TICKS</div>
                                <h2>Digit shares</h2>
                            </div>
                            <span className='muted'>
                                {d.contract.dynamic ? '' : `normal win rate ${pct(winProbability(d.contract))}`}
                            </span>
                        </div>
                        <div className='digit-bars'>
                            {d.digitShare.map((n, i) => (
                                <div className='digit-bar' key={i}>
                                    <span className='digit-value'>{n}</span>
                                    <div className='digit-bar-track'>
                                        <div
                                            className='digit-bar-fill'
                                            style={{ height: `${Math.min(100, n * 6)}%` }}
                                        />
                                    </div>
                                    <b>{i}</b>
                                </div>
                            ))}
                        </div>
                    </section>
                </>
            )}

            <section className='panel'>
                <div className='panel-head'>
                    <div>
                        <div className='eyebrow'>IMPORT</div>
                        <h2>Paste digits for {marketName(p.market)}</h2>
                        <p>Digits 0–9 separated by spaces, commas or new lines, oldest first.</p>
                    </div>
                </div>
                <textarea
                    className='digit-input'
                    aria-label='Digits to import'
                    value={p.importText}
                    onChange={e => p.setImportText(e.target.value)}
                    placeholder='1 4 7 2 4 …'
                />
                <div className='form-foot'>
                    <span />
                    <button className='btn secondary' onClick={p.onImport}>
                        Use these digits
                    </button>
                </div>
            </section>
        </main>
    );
}

function CrowdRow({ c }: { c: CrowdPosition }) {
    return (
        <div className={`crow cs-${c.state.toLowerCase()}`}>
            <div className='cwho'>
                <b>{c.name}</b>
                <small>{ARCHETYPE_TEXT[c.archetype].rule}</small>
            </div>
            <div className='chold'>
                <small>Holds</small>
                <b>{contractLabel(c.holds)}</b>
            </div>
            <div className='cstate'>
                <span className='vstate'>{c.state}</span>
                <span className='cbar'>
                    <i style={{ width: `${c.conviction}%` }} />
                </span>
            </div>
            <div className='copp'>
                <small>Opposite</small>
                <b>{contractLabel(c.opposite)}</b>
            </div>
            <p className='cnote'>{c.note}</p>
        </div>
    );
}

export default SixfoldPage;

const toRecover = (c: Contract): { contract: RecoverContract; barrier: number } | null =>
    (c.side === 'OVER' || c.side === 'UNDER') && isValidBarrier(c.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER', c.param)
        ? { contract: c.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER', barrier: c.param }
        : null;

function Signals({
    market,
    contract,
    trapped,
    openBotBuilder,
}: {
    market: string;
    contract: Contract;
    trapped: CrowdPosition[];
    openBotBuilder: () => void;
}) {
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const rows = [
        { key: 'this', title: 'The contract on this desk', why: 'You chose it.', c: contract },
        ...trapped.map(t => ({
            key: t.archetype,
            title: `Opposite of the trapped ${t.name.toLowerCase()}s`,
            why: `${contractLabel(t.holds)} buyers look trapped.`,
            c: t.opposite,
        })),
    ];
    const load = async (key: string, c: Contract) => {
        const r = toRecover(c);
        if (!r) return;
        setBusy(key);
        setMessage(null);
        try {
            const out = await loadSignalIntoRecoverBot({ symbol: market, ...r }, openBotBuilder);
            setMessage({
                ok: true,
                text: `Loaded bot ${out.bot.number} (${out.botName}) in Bot Builder: ${marketName(market)}, ${contractLabel(c)} first. Nothing has been traded. Check stake and take profit, then press Run yourself.`,
            });
        } catch (e) {
            setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy('');
        }
    };
    return (
        <section className='panel'>
            <div className='panel-head'>
                <div>
                    <div className='eyebrow'>SIGNAL → BOT BUILDER</div>
                    <h2>Load a signal into a bot</h2>
                    <p>
                        Sixfold never trades. This sets the market and the first barrier in the matching Recover bot and
                        opens Bot Builder. The bot keeps its own stake, martingale and take profit.
                    </p>
                </div>
            </div>
            <div className='sigs'>
                {rows.map(r => {
                    const rec = toRecover(r.c);
                    return (
                        <div className='sig' key={r.key}>
                            <div>
                                <small>{r.title}</small>
                                <b>
                                    {marketName(market)} · {contractLabel(r.c)}
                                </b>
                                <small>{r.why}</small>
                            </div>
                            {rec ? (
                                <button className='btn primary' disabled={busy !== ''} onClick={() => load(r.key, r.c)}>
                                    {busy === r.key
                                        ? 'Loading…'
                                        : `Load into Bot Builder (bot ${RECOVER_BOTS[rec.contract].number})`}
                                </button>
                            ) : (
                                <small className='muted'>The Recover bots trade Over/Under only.</small>
                            )}
                        </div>
                    );
                })}
            </div>
            {message && (
                <div className={message.ok ? 'notice okmsg' : 'error-banner'}>
                    <span>{message.text}</span>
                </div>
            )}
        </section>
    );
}
