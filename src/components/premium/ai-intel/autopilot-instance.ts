// APEX INTEL: the app-wide autopilot (background research and promotion), wired to the lab, registry, forward monitor and executor.
import { Autopilot, type AutopilotConfig } from './autopilot';
import { aiIntelExecutor } from './executor-instance';
import { apexSeries } from './feed-source';
import { forwardMonitor, labRunner, strategyRegistry } from './registry-instance';

const KEY = 'apex_intel_autopilot_v1';

export const autopilot = new Autopilot({
    strategies: () => strategyRegistry.getSnapshot(),
    forward: () => forwardMonitor.getSnapshot(),
    setStatus: (id, to, by, note) => strategyRegistry.setStatus(id, to, by, note),
    lab: labRunner,
    series: () => apexSeries(),
    duration: () => aiIntelExecutor.getSnapshot().config.duration,
    now: () => Date.now(),
    load: () => {
        try {
            const raw = window.localStorage.getItem(KEY);
            return raw ? (JSON.parse(raw) as Partial<AutopilotConfig>) : null;
        } catch {
            return null;
        }
    },
    save: c => {
        try {
            window.localStorage.setItem(KEY, JSON.stringify(c));
        } catch {
            /* storage unavailable */
        }
    },
});
