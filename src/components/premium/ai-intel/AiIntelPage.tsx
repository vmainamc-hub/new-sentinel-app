// APEX INTEL: statistical digit intelligence for OVER 2 / UNDER 7 on the Volatility indices.
//
// Everything on screen is computed from the app-wide live market feed (the same one Sixfold uses, no second socket)
// with the Sixfold-compatible simulator. Nothing is mocked. It reports what rules did on past ticks and how sure that
// is; it does not predict the next digit. Sections that are not built yet are listed as such and cannot be clicked.
import { useEffect, useMemo, useState } from 'react';
import { marketName, shortName } from '@/components/premium/sixfold/feed';
import { useFeedOf } from '@/components/premium/sixfold/use-feed';
import { apexFeed, filterSeries } from './feed-source';
import {
    conservativeEdgePts,
    DIRECTIONS,
    type DirectionReport,
    FDR_Q,
    type MarketReport,
    MIN_TICKS_FOR_REGIME,
    MIN_TRADES,
    type Regime,
    type Row,
    scanRows,
} from './analysis';
import { ExecutionPanel, HistoryPanel } from './ExecutionPanel';
import { AiIntelligencePanel } from './AiIntelligencePanel';
import { StrategyLabPanel, StrategyLibraryPanel } from './StrategyPanels';
import { useExecutor } from './use-executor';
import './ai-intel.scss';

type TabId = 'overview' | 'scanner' | 'competition' | 'exec' | 'history' | 'lab' | 'library' | 'ai';

const TABS: Array<{ id: TabId | string; label: string; ready: boolean }> = [
    { id: 'overview', label: 'Overview', ready: true },
    { id: 'scanner', label: 'Live Scanner', ready: true },
    { id: 'competition', label: 'Virtual Competition', ready: true },
    { id: 'ai', label: 'AI Intelligence', ready: true },
    { id: 'lab', label: 'Strategy Lab', ready: true },
    { id: 'exec', label: 'Live Execution', ready: true },
    { id: 'library', label: 'Strategy Library', ready: true },
    { id: 'history', label: 'Trade History', ready: true },
    { id: 'perf', label: 'Performance', ready: false },
    { id: 'settings', label: 'Settings', ready: false },
];

const STALE_SECONDS = 15;
const pct = (x: number | null, digits = 1) => (x === null ? '–' : `${(x * 100).toFixed(digits)}%`);
const pts = (x: number | null) => (x === null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(1)} pts`);
const REGIME_TEXT: Record<Regime, string> = {
    STABLE: 'Stable',
    CHANGING: 'Changing',
    UNUSUAL: 'Unusual',
    UNSTABLE: 'Unstable',
    INSUFFICIENT_DATA: 'Not enough data',
};

type MarketView = {
    report: MarketReport;
    ageSeconds: number | null;
    lastDigit: number | null;
    eligible: boolean;
    why: string;
};

function eligibility(report: MarketReport, ageSeconds: number | null): { eligible: boolean; why: string } {
    if (report.ticks < MIN_TICKS_FOR_REGIME) return { eligible: false, why: `needs ${MIN_TICKS_FOR_REGIME} ticks, has ${report.ticks}` };
    if (ageSeconds === null || ageSeconds > STALE_SECONDS) return { eligible: false, why: 'no recent ticks' };
    const bad = report.directions.every(d => d.regime.regime === 'UNSTABLE' || d.regime.regime === 'INSUFFICIENT_DATA');
    return bad ? { eligible: false, why: 'regime unstable' } : { eligible: true, why: 'enough fresh data' };
}

const Chip = ({ regime }: { regime: Regime }) => <span className={`ai-chip regime-${regime.toLowerCase()}`}>{REGIME_TEXT[regime]}</span>;

function DigitBars({ counts }: { counts: number[] }) {
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const max = Math.max(...counts, total / 10);
    return (
        <div className='ai-bars' role='img' aria-label='Digit frequency'>
            {counts.map((c, d) => (
                <div key={d} className='ai-bar' title={`Digit ${d}: ${c} (${((c / total) * 100).toFixed(1)}%)`}>
                    <i style={{ height: `${Math.max(2, (c / max) * 100)}%` }} />
                    <span>{d}</span>
                </div>
            ))}
            <div className='ai-bar-line' style={{ bottom: `${((total / 10 / max) * 100).toFixed(1)}%` }} />
        </div>
    );
}

function DirectionCell({ d }: { d: DirectionReport }) {
    const s = d.setup;
    return (
        <div className='ai-dir'>
            <div className='ai-dir-h'>
                <b>{d.label}</b>
                <Chip regime={d.regime.regime} />
            </div>
            <div className='ai-kv'>
                <span>Last 100 ticks win digit</span>
                <b>{pct(d.rolling[0].rate, 0)}</b>
            </div>
            <div className='ai-kv'>
                <span>SETUP trades</span>
                <b>{s.trades}</b>
            </div>
            <div className='ai-kv'>
                <span>SETUP win rate</span>
                <b>{s.enough ? `${pct(s.rate)} (${pct(s.ci!.lo, 0)}–${pct(s.ci!.hi, 0)})` : `needs ${MIN_TRADES}+ trades`}</b>
            </div>
            <div className='ai-kv'>
                <span>Chance level</span>
                <b>{pct(s.baseline, 0)}</b>
            </div>
        </div>
    );
}

export default function AiIntelPage() {
    const feed = useFeedOf(apexFeed);
    const series = useMemo(() => filterSeries(feed.series), [feed.version]); // eslint-disable-line react-hooks/exhaustive-deps
    const exec = useExecutor();
    const [tab, setTab] = useState<TabId>('overview');
    const [duration, setDuration] = useState(1);
    const [open, setOpen] = useState<string | null>(null);
    const [sortBy, setSortBy] = useState<'market' | 'ticks'>('market');
    const [dirFilter, setDirFilter] = useState<'ALL' | 'OVER_2' | 'UNDER_7'>('ALL');
    const [methodFilter, setMethodFilter] = useState<'ALL' | 'SETUP' | 'ANY'>('ALL');
    const [clock, setClock] = useState(() => Date.now());

    useEffect(() => {
        if (apexFeed.getMode() === 'live' && apexFeed.getStatus() === 'offline') apexFeed.connect();
        const id = window.setInterval(() => setClock(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);

    // Recomputed when the feed publishes (about every 400 ms) or the contract duration changes.
    const scan = useMemo(() => scanRows(series, duration), [feed.version, duration]); // eslint-disable-line react-hooks/exhaustive-deps

    const views: MarketView[] = scan.reports.map(report => {
        const at = apexFeed.getLastTickAt(report.market);
        const ageSeconds = at === null ? null : Math.max(0, (clock - at) / 1000);
        const mSeries = series[report.market] ?? [];
        return { report, ageSeconds, lastDigit: mSeries.length ? mSeries[mSeries.length - 1] : null, ...eligibility(report, ageSeconds) };
    });
    const sortedViews = [...views].sort((a, b) =>
        sortBy === 'ticks' ? b.report.ticks - a.report.ticks : a.report.market.localeCompare(b.report.market, undefined, { numeric: true })
    );

    const ranked = scan.rows
        .filter(r => r.stats.enough)
        .sort((a, b) => (b.stats.ci ? b.stats.ci.lo - b.stats.baseline : -1) - (a.stats.ci ? a.stats.ci.lo - a.stats.baseline : -1));
    const significant = scan.rows.filter(r => r.significant);
    const eligibleCount = views.filter(v => v.eligible).length;
    const live = feed.status === 'live';
    const monitored = views.filter(v => v.report.ticks > 0).length;

    const leaderboard = ranked.filter(
        r => (dirFilter === 'ALL' || r.direction === dirFilter) && (methodFilter === 'ALL' || r.method === methodFilter)
    );
    const regimeCounts = views.reduce<Record<string, number>>((acc, v) => {
        const key = v.report.directions[0].regime.regime;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});

    return (
        <div className='ai-intel'>
            <header className='ai-top'>
                <div className='ai-brand'>
                    <span className='ai-logo' aria-hidden>
                        ◆
                    </span>
                    <div>
                        <h1>Apex Intel</h1>
                        <p>Over/Under digit intelligence</p>
                    </div>
                </div>
                <div className='ai-top-r'>
                    <span className={`ai-status ${live ? 'on' : feed.status === 'connecting' ? 'wait' : 'off'}`}>
                        {live ? 'Live feed' : feed.status === 'connecting' ? 'Connecting' : feed.status === 'error' ? 'Feed error' : 'Offline'}
                    </span>
                    <label className='ai-field'>
                        Contract length
                        <select value={duration} onChange={e => setDuration(Number(e.target.value))}>
                            {[1, 2, 3, 4, 5].map(n => (
                                <option key={n} value={n}>
                                    {n} tick{n > 1 ? 's' : ''}
                                </option>
                            ))}
                        </select>
                    </label>
                    {live || feed.status === 'connecting' ? (
                        <button className='ai-btn' onClick={feed.stop}>
                            Stop feed
                        </button>
                    ) : (
                        <button className='ai-btn primary' onClick={feed.connect}>
                            Connect feed
                        </button>
                    )}
                </div>
            </header>
            {feed.error ? <div className='ai-error'>{feed.error}</div> : null}

            <nav className='ai-tabs' aria-label='Apex Intel sections'>
                {TABS.map(t => (
                    <button
                        key={t.id}
                        className={`${tab === t.id ? 'active' : ''} ${t.ready ? '' : 'soon'}`}
                        disabled={!t.ready}
                        title={t.ready ? undefined : 'Not built yet'}
                        onClick={() => t.ready && setTab(t.id as TabId)}
                    >
                        {t.label}
                        {t.ready ? null : <em>soon</em>}
                    </button>
                ))}
            </nav>

            {tab === 'overview' && (
                <section className='ai-grid'>
                    <div className='ai-card wide verdict'>
                        <h2>What the data says</h2>
                        {monitored === 0 ? (
                            <p>Waiting for ticks. Connect the feed to start measuring.</p>
                        ) : significant.length ? (
                            <p>
                                {significant.length} rule{significant.length > 1 ? 's' : ''} beat chance after false-discovery control (q ≤ {FDR_Q}) on the ticks seen so far. Treat this as a
                                finding to re-test on new ticks, not a promise: it can still fade.
                            </p>
                        ) : (
                            <p>
                                No entry rule beats chance after false-discovery control across {scan.rows.length} market × direction × method tests ({ranked.length} have {MIN_TRADES}+
                                trades). On fair random digits that is the expected result, and it is reported as is.
                            </p>
                        )}
                    </div>
                    <div className='ai-card'>
                        <h3>Markets monitored</h3>
                        <strong>{monitored}</strong>
                        <small>{eligibleCount} eligible for evaluation</small>
                    </div>
                    <div className='ai-card'>
                        <h3>Best by conservative edge</h3>
                        {ranked[0] ? (
                            <>
                                <strong>
                                    {shortName(ranked[0].market)} · {ranked[0].label}
                                </strong>
                                <small>
                                    {ranked[0].method} · {pts(conservativeEdgePts(ranked[0].stats))} at the interval's lower bound · {ranked[0].stats.trades} trades
                                </small>
                            </>
                        ) : (
                            <small>Nothing has {MIN_TRADES}+ trades yet.</small>
                        )}
                    </div>
                    <div className='ai-card'>
                        <h3>Regimes (OVER 2 view)</h3>
                        <div className='ai-chips'>
                            {Object.entries(regimeCounts).map(([k, n]) => (
                                <span key={k} className={`ai-chip regime-${k.toLowerCase()}`}>
                                    {REGIME_TEXT[k as Regime]} · {n}
                                </span>
                            ))}
                            {monitored === 0 ? <small>No data yet</small> : null}
                        </div>
                    </div>
                    <div className='ai-card'>
                        <h3>Execution</h3>
                        <strong>{exec.running ? (exec.config.mode === 'AUTO' ? 'AUTO running' : 'Assisted running') : 'Stopped'}</strong>
                        <small>
                            {exec.session.trades} trades this session · P/L {exec.session.pnl >= 0 ? '+' : ''}
                            {exec.session.pnl.toFixed(2)}
                        </small>
                    </div>
                    <div className='ai-card wide'>
                        <h3>How to read this</h3>
                        <p className='ai-note'>
                            A trade starts when a trigger digit prints, enters on the next tick and settles after the chosen number of ticks. Trigger digits are never losses; only the
                            settlement digit decides win or loss (OVER 2 wins on 3–9, UNDER 7 wins on 0–6). Win rates come with a 95% interval and are only ranked once they have {MIN_TRADES}+ trades.
                        </p>
                    </div>
                </section>
            )}

            {tab === 'scanner' && (
                <section>
                    <div className='ai-toolbar'>
                        <label className='ai-field'>
                            Sort
                            <select value={sortBy} onChange={e => setSortBy(e.target.value as 'market' | 'ticks')}>
                                <option value='market'>Market</option>
                                <option value='ticks'>Most ticks</option>
                            </select>
                        </label>
                        <small>
                            {monitored} markets · Volatility indices discovered from Deriv, plus Sixfold's ten
                        </small>
                    </div>
                    {sortedViews.length === 0 ? <div className='ai-empty'>No market data yet. {live ? 'Waiting for the first ticks…' : 'Connect the feed.'}</div> : null}
                    <div className='ai-markets'>
                        {sortedViews.map(v => {
                            const stale = v.ageSeconds === null || v.ageSeconds > STALE_SECONDS;
                            return (
                                <article key={v.report.market} className={`ai-market ${v.eligible ? 'ok' : ''}`}>
                                    <button className='ai-market-h' onClick={() => setOpen(open === v.report.market ? null : v.report.market)} aria-expanded={open === v.report.market}>
                                        <div>
                                            <b>{marketName(v.report.market)}</b>
                                            <small>
                                                {v.report.ticks} ticks · {stale ? 'stale' : `${v.ageSeconds!.toFixed(0)}s ago`}
                                            </small>
                                        </div>
                                        <span className='ai-digit'>{v.lastDigit ?? '–'}</span>
                                        <span className={`ai-elig ${v.eligible ? 'on' : ''}`}>{v.eligible ? 'Eligible' : v.why}</span>
                                    </button>
                                    <DigitBars counts={v.report.counts} />
                                    <div className='ai-dirs'>
                                        {v.report.directions.map(d => (
                                            <DirectionCell key={d.id} d={d} />
                                        ))}
                                    </div>
                                    {open === v.report.market && (
                                        <div className='ai-detail'>
                                            <div className='ai-kv'>
                                                <span>Digit uniformity (chi-square)</span>
                                                <b>{v.report.uniformity.p === null ? 'needs 50+ ticks' : `p = ${v.report.uniformity.p.toFixed(3)}`}</b>
                                            </div>
                                            {v.report.directions.map(d => (
                                                <div key={d.id} className='ai-detail-d'>
                                                    <b>{d.label}</b>
                                                    <div className='ai-kv'>
                                                        <span>Regime</span>
                                                        <b>{d.regime.reason}</b>
                                                    </div>
                                                    <div className='ai-kv'>
                                                        <span>Win-digit share, last 100 / 300 / 1000</span>
                                                        <b>{d.rolling.map(r => pct(r.rate, 0)).join(' / ')}</b>
                                                    </div>
                                                    <div className='ai-kv'>
                                                        <span>ANY entry (buy whenever free)</span>
                                                        <b>
                                                            {d.any.trades} trades · {d.any.enough ? pct(d.any.rate) : 'too few'}
                                                        </b>
                                                    </div>
                                                    <div className='ai-kv'>
                                                        <span>SETUP p-value vs chance</span>
                                                        <b>{d.setup.enough && d.setup.pValue !== null ? d.setup.pValue.toFixed(3) : 'too few trades'}</b>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                </section>
            )}

            {tab === 'ai' && <AiIntelligencePanel />}
            {tab === 'lab' && <StrategyLabPanel />}
            {tab === 'library' && <StrategyLibraryPanel />}
            {tab === 'exec' && <ExecutionPanel />}
            {tab === 'history' && <HistoryPanel />}

            {tab === 'competition' && (
                <section>
                    <div className='ai-toolbar'>
                        <label className='ai-field'>
                            Direction
                            <select value={dirFilter} onChange={e => setDirFilter(e.target.value as typeof dirFilter)}>
                                <option value='ALL'>Both</option>
                                {DIRECTIONS.map(d => (
                                    <option key={d.id} value={d.id}>
                                        {d.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className='ai-field'>
                            Entry method
                            <select value={methodFilter} onChange={e => setMethodFilter(e.target.value as typeof methodFilter)}>
                                <option value='ALL'>All</option>
                                <option value='SETUP'>SETUP</option>
                                <option value='ANY'>ANY</option>
                            </select>
                        </label>
                        <small>
                            Ranked by the lower bound of the 95% interval, so a lucky small sample cannot lead. Needs {MIN_TRADES}+ trades. CUSTOM and SMART join when the Strategy Lab is built.
                        </small>
                    </div>
                    {leaderboard.length === 0 ? (
                        <div className='ai-empty'>No entry has {MIN_TRADES}+ settled trades yet. Keep the feed running.</div>
                    ) : (
                        <div className='ai-board' role='table'>
                            <div className='ai-row head' role='row'>
                                <span>#</span>
                                <span>Market</span>
                                <span>Contract</span>
                                <span>Entry</span>
                                <span>Trades</span>
                                <span>Win rate (95%)</span>
                                <span>Edge vs chance</span>
                                <span>q-value</span>
                                <span>Regime</span>
                            </div>
                            {leaderboard.slice(0, 40).map((r: Row, i) => (
                                <div key={`${r.market}-${r.direction}-${r.method}`} className={`ai-row ${r.significant ? 'sig' : ''}`} role='row'>
                                    <span>{i + 1}</span>
                                    <span>{shortName(r.market)}</span>
                                    <span>{r.label}</span>
                                    <span>{r.method}</span>
                                    <span>{r.stats.trades}</span>
                                    <span>
                                        {pct(r.stats.rate)} ({pct(r.stats.ci!.lo, 0)}–{pct(r.stats.ci!.hi, 0)})
                                    </span>
                                    <span>{pts(r.stats.edgePts)}</span>
                                    <span>{r.q === null ? '–' : r.q.toFixed(3)}</span>
                                    <span>{REGIME_TEXT[r.regime]}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
