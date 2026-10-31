// APEX INTEL: the app-wide strategy registry and Strategy Lab, wired to the shared feed and the picker.
import { sixfoldFeed } from '@/components/premium/sixfold/feed';
import { setCandidateProvider } from './candidates';
import { LabRunner } from './lab';
import { BASELINE_CANDIDATES } from './picker';
import { localStorageRegistry, StrategyRegistry } from './registry';

export const strategyRegistry = new StrategyRegistry(localStorageRegistry('apex_intel_strategies_v1'));

// The picker trades the baseline entries plus every ACTIVE strategy. Nothing else.
setCandidateProvider(() => [...BASELINE_CANDIDATES, ...strategyRegistry.activeCandidates()]);

export const labRunner: LabRunner = new LabRunner(
    () => sixfoldFeed.getLiveSeries(),
    (results, cfg) => strategyRegistry.addFromLab(results, cfg, labRunner.getSnapshot().ticks)
);
