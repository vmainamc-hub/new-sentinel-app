// APEX INTEL: Performance analytics from the trades Apex Intel placed (real) and, apart, its paper trades.
import { marketName } from '@/components/premium/sixfold/feed';
import { type Group, summarise } from './performance';
import { useExecutor } from './use-executor';

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(1)}%`);

function Curve({ points }: { points: number[] }) {
    if (points.length < 2) return <div className='ai-empty'>The equity curve appears after the first settled trade.</div>;
    const w = 640;
    const h = 160;
    const lo = Math.min(...points, 0);
    const hi = Math.max(...points, 0);
    const span = hi - lo || 1;
    const x = (i: number) => (i / (points.length - 1)) * w;
    const y = (v: number) => h - 8 - ((v - lo) / span) * (h - 16);
    const d = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return (
        <svg viewBox={`0 0 ${w} ${h}`} className='ai-curve' role='img' aria-label='Cumulative profit and loss'>
            <line x1='0' x2={w} y1={y(0)} y2={y(0)} stroke='currentColor' strokeOpacity='0.25' strokeDasharray='4 4' />
            <path d={d} fill='none' stroke='currentColor' strokeWidth='2' />
        </svg>
    );
}

function Table({ title, rows, name }: { title: string; rows: Group[]; name?: (k: string) => string }) {
    return (
        <div className='ai-card'>
            <h3>{title}</h3>
            {rows.length === 0 ? <small>No settled trades yet.</small> : null}
            <ul className='ai-trades'>
                {rows.map(g => (
                    <li key={g.key} className={g.pnl >= 0 ? 'won' : 'lost'}>
                        <span>{name ? name(g.key) : g.key}</span>
                        <span>{g.trades} trades</span>
                        <span>{pct(g.trades ? g.wins / g.trades : null)}</span>
                        <span>{signed(g.pnl)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function PerformancePanel() {
    const s = useExecutor();
    const real = summarise(s.trades, false);
    const paper = summarise(s.trades, true);
    return (
        <section>
            <div className='ai-stats'>
                <div>
                    <small>Real P/L</small>
                    <b className={real.pnl >= 0 ? 'pos' : 'neg'}>{signed(real.pnl)}</b>
                </div>
                <div>
                    <small>Trades · win rate</small>
                    <b>
                        {real.trades} · {pct(real.winRate)}
                    </b>
                </div>
                <div>
                    <small>Avg win / avg loss</small>
                    <b>
                        {real.avgWin === null ? '–' : signed(real.avgWin)} / {real.avgLoss === null ? '–' : signed(real.avgLoss)}
                    </b>
                </div>
                <div>
                    <small>Max drawdown</small>
                    <b>{real.maxDrawdown.toFixed(2)}</b>
                </div>
                <div>
                    <small>Longest losing run</small>
                    <b>{real.longestLosingRun}</b>
                </div>
            </div>
            <div className='ai-card wide'>
                <h3>Equity curve (real trades)</h3>
                <Curve points={real.curve} />
                {real.unconfirmed > 0 && <small>{real.unconfirmed} unconfirmed trade(s) are left out: check your Deriv statement.</small>}
            </div>
            <div className='ai-two-col'>
                <Table title='By market' rows={real.byMarket} name={marketName} />
                <Table title='By contract' rows={real.byContract} />
            </div>
            <div className='ai-two-col'>
                <Table title='Main contract vs recovery' rows={real.byRecoveryStep} />
                <div className='ai-card'>
                    <h3>Paper trades (Virtual Hook, this run)</h3>
                    <small>
                        {paper.trades} settled · {pct(paper.winRate)} won · {signed(paper.pnl)} estimated at a 5% margin. Paper results never reach your P/L.
                    </small>
                </div>
            </div>
            <div className='ai-info'>
                Digits are random: a short winning run says little. The figures above describe what happened, not what will happen.
            </div>
        </section>
    );
}
