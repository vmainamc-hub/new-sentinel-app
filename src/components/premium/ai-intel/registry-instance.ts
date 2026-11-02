// APEX INTEL: the app-wide strategy registry and Strategy Lab, wired to the shared feed and the picker.
import { apexFeed, apexSeries } from './feed-source';
import { type Counts, ForwardMonitor } from './monitor';
import { setCandidateProvider } from './candidates';
import { LabRunner } from './lab';
import { BASELINE_CANDIDATES } from './picker';
import { localStorageRegistry, StrategyRegistry } from './registry';

export const strategyRegistry = new StrategyRegistry(localStorageRegistry('apex_intel_strategies_v1'));

// The picker trades the baseline entries plus every ACTIVE strategy. Nothing else.
setCandidateProvider(() => [...BASELINE_CANDIDATES, ...strategyRegistry.activeCandidates()]);

export const labRunner: LabRunner = new LabRunner(
    () => apexSeries(),
    (results, cfg) => strategyRegistry.addFromLab(results, cfg, labRunner.getSnapshot().ticks)
);

const FORWARD_KEY = 'apex_intel_forward_v1';
/** Paper-trades every APPROVED / ACTIVE strategy on the live ticks and suspends one that fails. Always on. */
export const forwardMonitor = new ForwardMonitor(
    () => strategyRegistry.getSnapshot(),
    (id, note) => strategyRegistry.setStatus(id, 'SUSPENDED', 'monitor', note),
    () => Date.now(),
    {
        load: () => {
            try {
                const raw = window.localStorage.getItem(FORWARD_KEY);
                return raw ? (JSON.parse(raw) as Record<string, Counts>) : null;
            } catch {
                return null;
            }
        },
        save: c => window.localStorage.setItem(FORWARD_KEY, JSON.stringify(c)),
    }
);
apexFeed.onTick((market, digit) => forwardMonitor.handleTick(market, digit));
