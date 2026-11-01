// APEX INTEL: Trade History. Real trades (and the Virtual Hook's paper trades, tagged) placed by Apex Intel. The trading
// screen itself is TradePanel.tsx.
import { marketName } from '@/components/premium/sixfold/feed';
import type { ExecTrade } from './executor';
import { useExecutor } from './use-executor';

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

function TradeTable({ trades, title }: { trades: ExecTrade[]; title: string }) {
    return (
        <div className='ai-card'>
            <h3>{title}</h3>
            {trades.length === 0 ? <small>No trades yet.</small> : null}
            <ul className='ai-trades'>
                {trades.map(t => (
                    <li key={t.id} className={t.status}>
                        <span>{new Date(t.at).toLocaleTimeString()}</span>
                        <span>{marketName(t.market)} · {t.label}{t.recovery ? ` ·R${t.step}` : ''}{t.virtual ? ' · paper' : ''}</span>
                        <span>{t.stake.toFixed(2)}</span>
                        <span>{t.status === 'open' ? 'open' : t.profit === null ? '?' : signed(t.profit)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function HistoryPanel() {
    const s = useExecutor();
    const exportCsv = () => {
        const head = ['time', 'market', 'contract', 'recovery_step', 'stake', 'duration_ticks', 'entry_digit', 'exit_digit', 'profit', 'status', 'contract_id'];
        const rows = s.trades.map(t => [new Date(t.at).toISOString(), t.market, t.label, t.step, t.stake, t.duration, t.triggerDigit, t.exitDigit, t.profit, t.status, t.contractId]);
        const blob = new Blob([[head, ...rows].map(r => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'apex-intel-trades.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    };
    return (
        <section>
            <div className='ai-toolbar'>
                <button className='ai-btn' disabled={!s.trades.length} onClick={exportCsv}>
                    Export CSV
                </button>
                <small>Real trades placed by Apex Intel, kept in this browser (latest 500). Paper trades show in the trade list during a run but are not saved.</small>
            </div>
            <TradeTable trades={s.trades} title={`Trades (${s.trades.length})`} />
        </section>
    );
}
