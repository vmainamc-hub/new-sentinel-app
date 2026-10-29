// Sixfold Meter screens: a compact verdict bar for the Scanner and a full Meter tab.
import { type ReactNode, useMemo } from 'react';
import { primaryContracts, type SixfoldSettings } from './money';
import { marketName, shortName } from './feed';
import { meterTrackRecord, type RegimeCell, type RegimeState, type RegimeSummary, type Verdict } from './regime';
import { sixfoldRunner } from './runner-instance';

const STATE_LABEL: Record<RegimeState, string> = { COLD: 'Loss cluster', NORMAL: 'Normal', HOT: 'Winning', TURNING: 'Turning' };
const VERDICT_TEXT: Record<Verdict, string> = { GO: 'Run', WAIT: 'Wait', AVOID: 'Hold off', LOADING: 'Loading' };
const tone = (v: Verdict) => (v === 'GO' ? 'go' : v === 'AVOID' ? 'avoid' : v === 'WAIT' ? 'wait' : 'load');
const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`);

function polar(cx: number, cy: number, r: number, value: number) {
    const a = ((180 - value * 1.8) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
}
function arc(cx: number, cy: number, r: number, from: number, to: number) {
    const [x1, y1] = polar(cx, cy, r, from);
    const [x2, y2] = polar(cx, cy, r, to);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function Gauge({ value, verdict, size = 200 }: { value: number; verdict: Verdict; size?: number }) {
    const w = 200;
    const [nx, ny] = polar(100, 100, 70, Math.min(100, Math.max(0, value)));
    return (
        <svg className={`mt-gauge t-${tone(verdict)}`} viewBox='0 0 200 118' width={size} role='img' aria-label={`Market meter ${value} out of 100: ${VERDICT_TEXT[verdict]}`}>
            <path d={arc(100, 100, 80, 0, 100)} className='trk' />
            <path d={arc(100, 100, 80, 0, 44)} className='seg avoid' />
            <path d={arc(100, 100, 80, 44, 50)} className='seg wait' />
            <path d={arc(100, 100, 80, 50, 100)} className='seg go' />
            {verdict !== 'LOADING' && <line x1='100' y1='100' x2={nx} y2={ny} className='needle' />}
            <circle cx='100' cy='100' r='5' className='hub' />
            <text x={w / 2} y='116' textAnchor='middle' className='val'>
                {verdict === 'LOADING' ? '—' : value}
            </text>
        </svg>
    );
}

const Strip = ({ cell }: { cell: RegimeCell }) => (
    <div className='mt-strip' aria-label={`Last ${cell.strip.length} results, oldest first`}>
        {cell.strip.map((w, i) => (
            <i key={i} className={w ? 'w' : 'l'} title={w ? 'win' : 'loss'} />
        ))}
    </div>
);

/** A compact bar above the Scanner: should you press Run? */
export function MeterStrip({ regime, running, onOpen }: { regime: RegimeSummary | null; running: boolean; onOpen: () => void }) {
    const v = regime?.verdict ?? 'LOADING';
    return (
        <section className={`mt-strip-bar t-${tone(v)}`} aria-label='Market meter'>
            <Gauge value={regime?.meter ?? 0} verdict={v} size={120} />
            <div className='txt'>
                <b>
                    Meter: {VERDICT_TEXT[v]}
                    {running && v !== 'GO' && v !== 'LOADING' ? ' (a session is running)' : ''}
                </b>
                <span>{regime?.reason ?? 'Waiting for enough ticks on the markets.'}</span>
            </div>
            <button type='button' className='sf-btn subtle' onClick={onOpen}>
                Open Meter
            </button>
        </section>
    );
}

export function MeterTab({
    regime,
    series,
    settings,
    panel,
}: {
    regime: RegimeSummary | null;
    series: Record<string, number[]>;
    settings: SixfoldSettings;
    panel: (p: { eyebrow?: string; title?: string; children: ReactNode; aside?: ReactNode }) => ReactNode;
}) {
    const contracts = primaryContracts(settings);
    const total = Object.values(series).reduce((a, d) => a + d.length, 0);
    const track = useMemo(
        () => meterTrackRecord(series, settings.markets, contracts, settings.duration),
        // Recomputed every ~250 new ticks across all markets, not on every tick.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [Math.floor(total / 250), settings.markets.join(','), contracts.map(c => `${c.side}${c.param}`).join(','), settings.duration]
    );
    const v = regime?.verdict ?? 'LOADING';
    const byMarket = useMemo(() => {
        const m = new Map<string, RegimeCell[]>();
        regime?.cells.forEach(c => m.set(c.symbol, [...(m.get(c.symbol) ?? []), c]));
        return [...m.entries()].sort((a, b) => Math.max(...b[1].map(c => c.strength)) - Math.max(...a[1].map(c => c.strength)));
    }, [regime]);
    const labels = contracts.map(c => `${c.side === 'OVER' ? 'Over' : 'Under'} ${c.param}`);
    const Panel = panel;

    return (
        <main className='mt-tab'>
            <Panel eyebrow='MARKET METER' title={v === 'GO' ? 'Good moment to run' : v === 'AVOID' ? 'Hold off for now' : v === 'WAIT' ? 'Wait for a better moment' : 'Loading the markets'}>
                <div className={`mt-hero t-${tone(v)}`}>
                    <Gauge value={regime?.meter ?? 0} verdict={v} size={240} />
                    <div>
                        <p className='lede'>{regime?.reason ?? 'Waiting for enough ticks on the markets.'}</p>
                        <div className='mt-counts'>
                            {(['COLD', 'NORMAL', 'HOT', 'TURNING'] as RegimeState[]).map(s => (
                                <span key={s} className={`st-${s.toLowerCase()}`}>
                                    {STATE_LABEL[s]} <b>{regime?.counts[s] ?? 0}</b>
                                </span>
                            ))}
                        </div>
                        <label className='mt-gate'>
                            <input type='checkbox' checked={settings.meterGate} onChange={e => sixfoldRunner.updateSettings({ meterGate: e.target.checked })} />
                            <span>
                                <b>Gate trading on the Meter</b> Skip any market and contract that is in a loss cluster while Sixfold runs.
                            </span>
                        </label>
                    </div>
                </div>
                <p className='sf-note'>
                    Each tick of each market is scored as if a contract had been bought on it. A market is in a <b>loss cluster</b> when its last 30 ticks won well under the normal rate or it is
                    4 or more losses in a row; <b>turning</b> means it just came out of 3 or more losses and wins have started; <b>winning</b> means the last 30 won well above normal. The meter
                    is the average strength of all cells: Run above 50 with few loss clusters, Wait in between, Hold off below 44 or when 40% of cells are cold.
                </p>
            </Panel>

            <Panel
                eyebrow='TRACK RECORD'
                title={track.informative ? 'After loss clusters, results were worse' : track.restVsCold.p === null ? 'Not enough history yet' : 'The meter has not shown it predicts the next result'}
            >
                <div className='mt-track'>
                    {(['COLD', 'NORMAL', 'HOT', 'TURNING'] as RegimeState[]).map(s => (
                        <div key={s} className={`cell st-${s.toLowerCase()}`}>
                            <small>After {STATE_LABEL[s].toLowerCase()}</small>
                            <b>{pct(track.states[s].rate)}</b>
                            <small>{track.states[s].n.toLocaleString()} trades</small>
                        </div>
                    ))}
                </div>
                <p className='sf-note'>
                    {track.restVsCold.p === null
                        ? 'Needs more ticks: at least 30 decisions in a loss cluster and 30 outside one.'
                        : `Replayed over ${track.ticks.toLocaleString()} past decisions: results after a non-cold state were ${track.restVsCold.diffPts! >= 0 ? '+' : ''}${track.restVsCold.diffPts!.toFixed(2)} points ${track.restVsCold.diffPts! >= 0 ? 'above' : 'below'} the results after a loss cluster (p = ${track.restVsCold.p.toFixed(3)}). `}
                    {track.informative
                        ? 'That is a real gap on this history, so the Meter gate is worth trying on a demo account. Check it again later: one good stretch of history is not proof.'
                        : track.restVsCold.p !== null
                          ? 'A gap near zero means the next trade won just as often after a loss cluster as after a normal stretch, so a loss cluster is a reason to be careful about the size of streaks, not a sign that wins are due or that wins are off. Deriv generates digits randomly, so this is the expected answer.'
                          : ''}
                </p>
            </Panel>

            <Panel eyebrow='EVERY MARKET' title='Recent wins and losses'>
                <div className='mt-rows' style={{ ['--n' as string]: labels.length }}>
                    <div className='mt-row th'>
                        <span>Market</span>
                        {labels.map(l => (
                            <span key={l}>{l}: last 24 results</span>
                        ))}
                    </div>
                    {byMarket.map(([symbol, cells]) => (
                        <div className='mt-row' key={symbol}>
                            <span className='nm' title={marketName(symbol)}>
                                {shortName(symbol)}
                            </span>
                            {cells.map(c => (
                                <div key={c.key} className={`mt-cell st-${c.state.toLowerCase()}`}>
                                    <Strip cell={c} />
                                    <span className='meta'>
                                        <em>{STATE_LABEL[c.state]}</em>
                                        <span>
                                            {pct(c.rate, 0)} · {c.strength}
                                            {c.clusterQ !== null && c.clusterQ <= 0.1 ? ' · clusters' : ''}
                                        </span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    ))}
                    {!byMarket.length && <p className='sf-muted'>Waiting for 60+ ticks on the selected markets.</p>}
                </div>
                <p className='sf-note'>
                    “clusters” appears when wins and losses on that market and contract arrive in more clumps than chance allows, even after correcting for the number of cells checked
                    ({regime?.clustered ?? 0} right now). Expect it to be rare. Even where clusters are real, the track record above is what says whether they help you time entries.
                </p>
            </Panel>
        </main>
    );
}
