import { useEffect, useSyncExternalStore } from 'react';
import type { SixfoldRunner, SixfoldSnapshot } from './runner';
import { sixfoldRunner } from './runner-instance';

/** React view of any Sixfold-style runner. `scan` keeps live scans coming while the page is open, even with no session. */
export function useRunner(runner: SixfoldRunner, scan = true): SixfoldSnapshot {
    useEffect(() => (scan ? runner.retainScan() : undefined), [runner, scan]);
    return useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
}

/** React view of the Sixfold runner (or another runner, as Apex Intel does). */
export function useSixfold(scan = true, runner: SixfoldRunner = sixfoldRunner): SixfoldSnapshot {
    return useRunner(runner, scan);
}
