// APEX INTEL performance analytics: computed only from the trades Apex Intel actually placed (and, shown apart, its paper trades).
import type { ExecTrade } from './executor';

export type Group = { key: string; trades: number; wins: number; pnl: number };
export type PerfSummary = {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    maxDrawdown: number;
    longestLosingRun: number;
    /** Cumulative P/L after each settled trade, oldest first (starts at 0). */
    curve: number[];
    byMarket: Group[];
    byContract: Group[];
    byRecoveryStep: Group[];
    unconfirmed: number;
};

const round = (x: number) => Math.round(x * 100) / 100;

function group(trades: readonly ExecTrade[], key: (t: ExecTrade) => string): Group[] {
    const m = new Map<string, Group>();
    for (const t of trades) {
        const k = key(t);
        const g = m.get(k) ?? { key: k, trades: 0, wins: 0, pnl: 0 };
        g.trades += 1;
        if (t.status === 'won') g.wins += 1;
        g.pnl = round(g.pnl + (t.profit ?? 0));
        m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

/** `trades` is newest first, as Apex Intel stores it. */
export function summarise(all: readonly ExecTrade[], virtual = false): PerfSummary {
    const picked = all.filter(t => Boolean(t.virtual) === virtual);
    const settled = picked.filter(t => (t.status === 'won' || t.status === 'lost') && t.profit !== null).reverse();
    const wins = settled.filter(t => t.status === 'won');
    const losses = settled.filter(t => t.status === 'lost');
    const curve = [0];
    let peak = 0;
    let maxDrawdown = 0;
    let run = 0;
    let longest = 0;
    for (const t of settled) {
        const v = round(curve[curve.length - 1] + (t.profit as number));
        curve.push(v);
        peak = Math.max(peak, v);
        maxDrawdown = Math.max(maxDrawdown, round(peak - v));
        run = t.status === 'lost' ? run + 1 : 0;
        longest = Math.max(longest, run);
    }
    const sum = (xs: readonly ExecTrade[]) => xs.reduce((a, t) => a + (t.profit as number), 0);
    return {
        trades: settled.length,
        wins: wins.length,
        losses: losses.length,
        pnl: round(curve[curve.length - 1]),
        winRate: settled.length ? wins.length / settled.length : null,
        avgWin: wins.length ? round(sum(wins) / wins.length) : null,
        avgLoss: losses.length ? round(sum(losses) / losses.length) : null,
        maxDrawdown,
        longestLosingRun: longest,
        curve,
        byMarket: group(settled, t => t.market),
        byContract: group(settled, t => t.label),
        byRecoveryStep: group(settled, t => (t.recovery ? `Recovery step ${t.step}` : 'Main contract')),
        unconfirmed: picked.filter(t => t.status === 'unconfirmed').length,
    };
}
