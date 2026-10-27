// Sixfold charts: small dependency-free SVG components. Colours come from CSS classes so the theme decides them.
import type { Cell } from './scanner';
import type { CrowdPosition } from './crowd';
import { type ContractSide } from './engine';
import { shortName } from './feed';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ---------- line charts ----------

type Point = number | null;

function path(values: Point[], x: (i: number) => number, y: (v: number) => number): string {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) {
            pen = false;
            return;
        }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
    });
    return d.trim();
}

export function LineChart({
    values,
    height = 150,
    lines = [],
    format = (v: number) => v.toFixed(2),
    area = false,
    label,
    domain,
}: {
    values: Point[];
    height?: number;
    /** Horizontal reference lines (for example break-even). */
    lines?: Array<{ value: number; label: string; tone: 'muted' | 'amber' | 'teal' | 'red' }>;
    format?: (v: number) => string;
    area?: boolean;
    label: string;
    domain?: [number, number];
}) {
    const W = 640,
        padL = 44,
        padR = 10,
        padT = 10,
        padB = 18;
    const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (finite.length < 2) return <div className='sf-chart-empty'>Not enough data to chart yet.</div>;
    const all = [...finite, ...lines.map(l => l.value)];
    let lo = domain ? domain[0] : Math.min(...all),
        hi = domain ? domain[1] : Math.max(...all);
    if (hi - lo < 1e-9) {
        hi += 1;
        lo -= 1;
    }
    const pad = domain ? 0 : (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const x = (i: number) => padL + (i / Math.max(1, values.length - 1)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
    const d = path(values, x, y);
    const last = finite[finite.length - 1];
    const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
    return (
        <svg className='sf-chart' viewBox={`0 0 ${W} ${height}`} role='img' aria-label={label} preserveAspectRatio='none'>
            {ticks.map((t, i) => (
                <g key={i}>
                    <line className='grid' x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
                    <text className='axis' x={padL - 6} y={y(t) + 3} textAnchor='end'>
                        {format(t)}
                    </text>
                </g>
            ))}
            {lines.map((l, k) => (
                <g key={l.label} className={`ref ${l.tone}`}>
                    <line x1={padL} x2={W - padR} y1={y(l.value)} y2={y(l.value)} />
                    <text x={k % 2 === 0 ? W - padR - 2 : padL + 4} y={y(l.value) + (k % 2 === 0 ? -4 : 11)} textAnchor={k % 2 === 0 ? 'end' : 'start'}>
                        {l.label}
                    </text>
                </g>
            ))}
            {area && <path className='area' d={`${d} L${x(values.length - 1)},${height - padB} L${x(0)},${height - padB} Z`} />}
            <path className='line' d={d} />
            <circle className='dot' cx={x(values.length - 1)} cy={y(last)} r={3.5} />
        </svg>
    );
}

export function Sparkline({ values, width = 96, height = 26 }: { values: number[]; width?: number; height?: number }) {
    if (values.length < 2) return <span className='sf-spark-empty'>–</span>;
    const lo = Math.min(...values),
        hi = Math.max(...values);
    const span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
    return (
        <svg className='sf-spark' viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden='true'>
            <polyline points={pts.join(' ')} />
        </svg>
    );
}

// ---------- digit bars ----------

export function DigitBars({ counts, expected, label }: { counts: number[]; expected: number; label: string }) {
    const max = Math.max(expected * 1.6, ...counts, 1);
    return (
        <div className='sf-digits' role='img' aria-label={label}>
            <div className='sf-digits-base' style={{ bottom: `${(expected / max) * 100}%` }} title={`Expected ${expected.toFixed(1)}`} />
            {counts.map((c, i) => {
                const dev = (c - expected) / Math.sqrt(Math.max(expected, 1));
                return (
                    <div key={i} className='sf-digit'>
                        <span className='n'>{c}</span>
                        <div className='track'>
                            <i className={dev > 1.5 ? 'hi' : dev < -1.5 ? 'lo' : ''} style={{ height: `${(c / max) * 100}%` }} />
                        </div>
                        <b>{i}</b>
                    </div>
                );
            })}
        </div>
    );
}

// ---------- transition heat map ----------

export function TransitionHeat({ z, label }: { z: number[][]; label: string }) {
    return (
        <div className='sf-trans' role='img' aria-label={label}>
            <div className='row'>
                <div className='corner'>to →</div>
                {Array.from({ length: 10 }, (_, j) => (
                    <div key={`h${j}`} className='head'>
                        {j}
                    </div>
                ))}
            </div>
            {z.map((row, i) => (
                <div key={`r${i}`} className='row'>
                    <div className='head'>{i}</div>
                    {row.map((v, j) => {
                        const a = clamp(Math.abs(v) / 3.5, 0, 1);
                        return (
                            <div
                                key={j}
                                className={`cell ${v >= 0 ? 'pos' : 'neg'}`}
                                style={{ opacity: 0.12 + a * 0.88 }}
                                title={`${i} → ${j}: ${v >= 0 ? '+' : ''}${v.toFixed(1)}σ from independence`}
                            />
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

// ---------- the six traders ----------

const HEX: ContractSide[] = ['OVER', 'UNDER', 'EVEN', 'ODD', 'MATCHES', 'DIFFERS'];
const HEX_LABEL: Record<ContractSide, string> = {
    OVER: 'Over',
    UNDER: 'Under',
    EVEN: 'Even',
    ODD: 'Odd',
    MATCHES: 'Matches',
    DIFFERS: 'Differs',
};

/** One vertex per trader type; the further out, the harder the market has pulled them in; red = trapped. */
export function Hexagon({ positions }: { positions: CrowdPosition[] }) {
    const C = 130,
        R = 92;
    const by = new Map(positions.map(p => [p.archetype, p]));
    const pt = (k: number, r: number): [number, number] => {
        const a = ((-90 + k * 60) * Math.PI) / 180;
        return [C + Math.cos(a) * r, C + Math.sin(a) * r];
    };
    const poly = HEX.map((s, k) => pt(k, 14 + ((by.get(s)?.conviction ?? 0) / 100) * (R - 14)).join(',')).join(' ');
    return (
        <svg className='sf-hex' viewBox='0 0 260 260' role='img' aria-label='Where the six trader types are'>
            {[0.33, 0.66, 1].map(f => (
                <polygon key={f} className='ring' points={HEX.map((_, k) => pt(k, R * f).join(',')).join(' ')} />
            ))}
            {HEX.map((_, k) => {
                const [x, y] = pt(k, R);
                return <line key={k} className='spoke' x1={C} y1={C} x2={x} y2={y} />;
            })}
            <polygon className='shape' points={poly} />
            {HEX.map((s, k) => {
                const p = by.get(s);
                const [vx, vy] = pt(k, 14 + ((p?.conviction ?? 0) / 100) * (R - 14));
                const [lx, ly] = pt(k, R + 20);
                return (
                    <g key={s} className={`vertex cs-${(p?.state ?? 'QUIET').toLowerCase()}`}>
                        <circle cx={vx} cy={vy} r={p?.state === 'TRAPPED' ? 7 : 5} />
                        <text x={lx} y={ly + 3} textAnchor='middle'>
                            {HEX_LABEL[s]}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}

// ---------- the scanner dial ----------

export type DialMarket = { symbol: string; best: Cell | undefined; eligible: boolean; significant: boolean; quarantined: boolean };

export function Radar({
    markets,
    armedSymbol,
    running,
    center,
    sub,
    tone,
}: {
    markets: DialMarket[];
    armedSymbol: string | null;
    running: boolean;
    center: string;
    sub?: string;
    tone: 'idle' | 'scan' | 'armed' | 'trade' | 'warn';
}) {
    const C = 200,
        R = 150;
    const at = (k: number, r: number): [number, number] => {
        const a = ((-90 + (k * 360) / markets.length) * Math.PI) / 180;
        return [C + Math.cos(a) * r, C + Math.sin(a) * r];
    };
    return (
        <svg className={`sf-radar t-${tone} ${running ? 'running' : ''}`} viewBox='0 0 400 400' role='img' aria-label='Market scanner'>
            <defs>
                <linearGradient id='sf-sweep-grad' x1='0' y1='0' x2='1' y2='0'>
                    <stop offset='0' stopColor='currentColor' stopOpacity='0' />
                    <stop offset='1' stopColor='currentColor' stopOpacity='0.55' />
                </linearGradient>
            </defs>
            <circle className='disc' cx={C} cy={C} r={R + 28} />
            {[0.45, 0.72, 1].map(f => (
                <circle key={f} className='ring' cx={C} cy={C} r={R * f} />
            ))}
            {markets.map((_, k) => {
                const [x, y] = at(k, R);
                return <line key={k} className='spoke' x1={C} y1={C} x2={x} y2={y} />;
            })}
            <g className='sweep'>
                <path d={`M${C},${C} L${C + R + 14},${C} A${R + 14},${R + 14} 0 0 0 ${C + (R + 14) * Math.cos(-0.9)},${C + (R + 14) * Math.sin(-0.9)} Z`} fill='url(#sf-sweep-grad)' />
            </g>
            {markets.map((m, k) => {
                const [x, y] = at(k, R);
                const [lx, ly] = at(k, R + 24);
                const tier = m.quarantined ? 'out' : m.significant ? 'sig' : m.eligible ? 'hot' : (m.best?.score ?? 0) >= 50 ? 'warm' : 'cold';
                const armed = m.symbol === armedSymbol;
                return (
                    <g key={m.symbol} className={`mk ${tier} ${armed ? 'armed' : ''}`}>
                        {armed && <line className='lock' x1={C} y1={C} x2={x} y2={y} />}
                        {armed && <circle className='pulse' cx={x} cy={y} r={11} />}
                        <circle className='pt' cx={x} cy={y} r={armed ? 8 : 6} />
                        <text x={lx} y={ly + 3} textAnchor='middle'>
                            {shortName(m.symbol)}
                        </text>
                    </g>
                );
            })}
            <circle className='core' cx={C} cy={C} r={62} />
            <text className='core-text' x={C} y={C + (sub ? -2 : 5)} textAnchor='middle'>
                {center}
            </text>
            {sub && (
                <text className='core-sub' x={C} y={C + 16} textAnchor='middle'>
                    {sub}
                </text>
            )}
        </svg>
    );
}
