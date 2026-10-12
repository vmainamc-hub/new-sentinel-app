// SENTINEL AI — signal outcome log panel (paper outcomes: nothing here trades).
import { useMemo, useState, useSyncExternalStore } from 'react';
import { MIN_SIGNALS, summarize, type SummaryRow } from './sentinel-ai-outcomes';
import { sentinelAiOutcomeLog } from './sentinel-ai-runner-instance';

const pct = (value: number | null) => (value === null ? 'n/a' : `${value}%`);

const Row = ({ row }: { row: SummaryRow }) => (
    <tr>
        <th scope='row'>{row.label}</th>
        <td>{row.resolved}</td>
        <td>{row.wins}</td>
        <td>{pct(row.winPct)}</td>
        <td>{pct(row.breakEvenPct)}</td>
        <td>{row.low === null || row.high === null ? 'n/a' : `${row.low}% to ${row.high}%`}</td>
        <td>{row.note}</td>
    </tr>
);

const Table = ({ title, rows }: { title: string; rows: SummaryRow[] }) => (
    <div className='sentinel-ai-log__table-wrap'>
        <table className='sentinel-ai-log__table'>
            <caption>{title}</caption>
            <thead>
                <tr>
                    <th scope='col'>Signal</th>
                    <th scope='col'>Resolved</th>
                    <th scope='col'>Wins</th>
                    <th scope='col'>Win %</th>
                    <th scope='col'>Break-even %</th>
                    <th scope='col'>95% interval</th>
                    <th scope='col'>Reading</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(row => (
                    <Row key={row.key} row={row} />
                ))}
            </tbody>
        </table>
    </div>
);

const SentinelAiOutcomePanel = () => {
    // The version changes whenever the log changes; the summary is recomputed from it.
    const version = useSyncExternalStore(sentinelAiOutcomeLog.subscribe, sentinelAiOutcomeLog.getVersion);
    const summary = useMemo(() => summarize(sentinelAiOutcomeLog.getRecords()), [version]); // eslint-disable-line react-hooks/exhaustive-deps
    const [confirming, setConfirming] = useState(false);

    const download = () => {
        try {
            const blob = new Blob([sentinelAiOutcomeLog.toCsv()], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `sentinel-ai-signal-log-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch {
            // Download is a convenience; the log itself is unaffected.
        }
    };

    return (
        <section className='sentinel-ai-card sentinel-ai-log' aria-label='Signal outcome log'>
            <h3>Signal outcome log</h3>
            <p className='sentinel-ai-muted'>
                Paper outcomes only, no trades. Each surfaced signal is scored on the first tick printed after it surfaced.
                Rows below {MIN_SIGNALS} resolved signals are too small to judge.
            </p>
            <p className='sentinel-ai-muted'>
                {summary.total} logged · {summary.pending} pending · {summary.unresolved} unresolved (not counted) · {summary.traded}{' '}
                traded
            </p>
            {summary.total === 0 ? (
                <p className='sentinel-ai-muted'>Nothing logged yet. Signals are recorded while this page is open.</p>
            ) : (
                <>
                    <Table title='By signal type' rows={summary.byType} />
                    <Table
                        title='Momentum passed versus failed'
                        rows={[summary.overall, summary.momentumPassed, summary.momentumFailed]}
                    />
                </>
            )}
            <div className='sentinel-ai-log__actions'>
                <button type='button' className='sentinel-ai-secondary' onClick={download} disabled={summary.total === 0}>
                    Download CSV
                </button>
                {confirming ? (
                    <>
                        <span className='sentinel-ai-muted'>Delete all {summary.total} records?</span>
                        <button
                            type='button'
                            className='sentinel-ai-secondary'
                            onClick={() => {
                                sentinelAiOutcomeLog.clear();
                                setConfirming(false);
                            }}
                        >
                            Yes, clear
                        </button>
                        <button type='button' className='sentinel-ai-secondary' onClick={() => setConfirming(false)}>
                            Cancel
                        </button>
                    </>
                ) : (
                    <button
                        type='button'
                        className='sentinel-ai-secondary'
                        onClick={() => setConfirming(true)}
                        disabled={summary.total === 0}
                    >
                        Clear log
                    </button>
                )}
            </div>
        </section>
    );
};

export default SentinelAiOutcomePanel;
