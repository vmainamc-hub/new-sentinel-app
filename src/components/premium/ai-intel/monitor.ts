// APEX INTEL forward monitor (the Performance Monitoring Agent's data): every APPROVED or ACTIVE strategy is paper-traded
// on the live ticks that arrive AFTER it was approved, with the same Sixfold-compatible simulator and one independent stream
// per strategy and market. This is genuine out-of-sample evidence: those ticks did not exist when the rule was chosen.
//
// Deterioration: with MIN_TRADES+ forward trades, if even the UPPER end of the win-rate interval is below the contract's
// chance level, the strategy is SUSPENDED by the monitor. The monitor can only suspend: it can never approve, activate or
// edit a rule. Counts live in memory (since this page load); persisting them is not built.
import { winProbability } from '@/components/premium/sixfold/bot';
import { wilson } from '@/components/premium/sixfold/stats';
import { MIN_TRADES } from './analysis';
import { contractOf } from './picker';
import type { Strategy, StrategyStatus } from './registry';
import { compileRule } from './rules';
import { SimBook, SimStream } from './sim';

export type Forward = { strategyId: string; trades: number; wins: number; rate: number | null; lo: number; hi: number; baseline: number; since: number; suspended: boolean };

export class ForwardMonitor {
    private book = new SimBook();
    private streams = new Map<string, { strategyId: string; market: string }>();
    private counts = new Map<string, { trades: number; wins: number; since: number; suspended: boolean }>();
    private listeners = new Set<() => void>();
    private snap: readonly Forward[] = [];

    constructor(
        private getStrategies: () => readonly Strategy[],
        private suspend: (id: string, note: string) => string | null,
        private now: () => number = () => Date.now()
    ) {}

    subscribe = (l: () => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    };
    getSnapshot = (): readonly Forward[] => this.snap;

    private tracked(s: Strategy): boolean {
        const st: StrategyStatus = s.status;
        return st === 'APPROVED' || st === 'ACTIVE';
    }

    private rebuild(strategies: readonly Strategy[]) {
        const live = new Set(strategies.filter(s => this.tracked(s)).map(s => s.id));
        for (const key of [...this.streams.keys()]) {
            if (!live.has(this.streams.get(key)!.strategyId)) {
                this.book.remove(key);
                this.streams.delete(key);
            }
        }
        for (const id of [...this.counts.keys()]) if (!strategies.some(s => s.id === id)) this.counts.delete(id);
    }

    /** One live tick of one market. */
    handleTick(market: string, digit: number, epoch = this.now()) {
        const strategies = this.getStrategies();
        this.rebuild(strategies);
        let changed = false;
        for (const s of strategies) {
            if (!this.tracked(s) || (s.markets.length && !s.markets.includes(market))) continue;
            const key = `${s.id}|${market}`;
            if (!this.streams.has(key)) {
                const contract = contractOf(s.direction);
                this.book.add(key, market, new SimStream(contract, { method: 'SMART', trigger: compileRule(s.rule, contract) }, s.duration));
                this.streams.set(key, { strategyId: s.id, market });
                if (!this.counts.has(s.id)) this.counts.set(s.id, { trades: 0, wins: 0, since: this.now(), suspended: false });
            }
        }
        for (const { id, event } of this.book.push(market, { digit, epoch })) {
            if (event.kind !== 'settled') continue;
            const meta = this.streams.get(id);
            const c = meta && this.counts.get(meta.strategyId);
            if (!meta || !c) continue;
            c.trades += 1;
            if (event.trade.won) c.wins += 1;
            changed = true;
            const s = strategies.find(x => x.id === meta.strategyId);
            if (s && !c.suspended && c.trades >= MIN_TRADES) {
                const baseline = winProbability(contractOf(s.direction));
                const hi = wilson(c.wins, c.trades).hi;
                if (hi < baseline) {
                    c.suspended = true;
                    this.suspend(s.id, `Forward test: ${c.wins}/${c.trades} wins (${((c.wins / c.trades) * 100).toFixed(1)}%), even the interval's upper end ${(hi * 100).toFixed(1)}% is below chance ${(baseline * 100).toFixed(0)}%`);
                }
            }
        }
        if (changed) this.publish(strategies);
    }

    private publish(strategies: readonly Strategy[]) {
        this.snap = strategies
            .filter(s => this.counts.has(s.id))
            .map(s => {
                const c = this.counts.get(s.id)!;
                const w = c.trades ? wilson(c.wins, c.trades) : { lo: 0, hi: 1 };
                return { strategyId: s.id, trades: c.trades, wins: c.wins, rate: c.trades ? c.wins / c.trades : null, lo: w.lo, hi: w.hi, baseline: winProbability(contractOf(s.direction)), since: c.since, suspended: c.suspended };
            });
        this.listeners.forEach(l => l());
    }
}
