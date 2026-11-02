// APEX INTEL: the forward monitor and the intelligence service, wired to the shared feed, the registry, the lab and the executor.
// The service evaluates every few seconds (never per tick) and only while something needs it: the AI tab is open, or an AUTO run is going.
import { getCandidates } from './candidates';
import { type Decision, type IntelReport, runAgents } from './agents';
import { aiIntelExecutor } from './executor-instance';
import { apexFeed, apexSeries } from './feed-source';
import { rankPicks } from './picker';
import { forwardMonitor, labRunner, strategyRegistry } from './registry-instance';

export { forwardMonitor };

const LOG_KEY = 'apex_intel_decisions_v1';
const LOG_MAX = 200;
export const EVERY_MS = 3000;

export type IntelSnapshot = { report: IntelReport | null; log: readonly Decision[]; updatedAt: number | null };

const loadLog = (): Decision[] => {
    try {
        const raw = window.localStorage.getItem(LOG_KEY);
        return raw ? (JSON.parse(raw) as Decision[]).slice(0, LOG_MAX) : [];
    } catch {
        return [];
    }
};

class IntelService {
    private report: IntelReport | null = null;
    private log: Decision[] = loadLog();
    private updatedAt: number | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private users = 0;
    private listeners = new Set<() => void>();
    private snap: IntelSnapshot = { report: null, log: this.log, updatedAt: null };

    subscribe = (l: () => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    };
    getSnapshot = (): IntelSnapshot => this.snap;

    /** Keep evaluating while something needs it. Returns the release function. */
    retain = () => {
        this.users += 1;
        if (!this.timer) {
            this.timer = setInterval(() => this.refresh(), EVERY_MS);
            this.refresh();
        }
        return () => {
            this.users = Math.max(0, this.users - 1);
            if (!this.users && this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
        };
    };

    refresh = () => {
        const now = Date.now();
        const exec = aiIntelExecutor.getSnapshot();
        const lab = labRunner.getSnapshot();
        const series = apexSeries();
        const picks = rankPicks(series, m => apexFeed.getLastTickAt(m), now, { duration: exec.config.duration, evidenceOnly: false, directions: 'BOTH', candidates: getCandidates() });
        const report = runAgents({
            now,
            series,
            lastTickAt: m => apexFeed.getLastTickAt(m),
            picks,
            strategies: strategyRegistry.getSnapshot(),
            forward: forwardMonitor.getSnapshot(),
            lab: { state: lab.state, note: lab.note, results: lab.results.length, passed: lab.results.filter(r => r.passed).length },
            exec: { running: exec.running, trades: exec.session.trades, pnl: exec.session.pnl, market: exec.trades.find(t => !t.virtual)?.market ?? null },
            duration: exec.config.duration,
        });
        const last = this.log[0];
        const d = report.decision;
        const same = last && last.decision === d.decision && last.market === d.market && last.direction === d.direction && last.explanation.join('|') === d.explanation.join('|');
        if (!same) {
            this.log = [d, ...this.log].slice(0, LOG_MAX);
            try {
                window.localStorage.setItem(LOG_KEY, JSON.stringify(this.log));
            } catch {
                /* storage unavailable */
            }
        }
        this.report = report;
        this.updatedAt = now;
        this.snap = { report, log: this.log, updatedAt: now };
        this.listeners.forEach(l => l());
    };
}

export const intelService = new IntelService();
