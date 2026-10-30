import { useEffect, useSyncExternalStore } from 'react';
import type { SixfoldRunner, SixfoldSnapshot } from './runner';
import { sixfoldRunner } from './runner-instance';

/** React view of the Sixfold runner. `scan` keeps live scans coming while the page is open, even with no session. */
export function useSixfold(scan = true, runner: SixfoldRunner = sixfoldRunner): SixfoldSnapshot {
    useEffect(() => (scan ? runner.retainScan() : undefined), [scan, runner]);
    return useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
}
