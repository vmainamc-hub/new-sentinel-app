import { useEffect, useSyncExternalStore } from 'react';
import { sixfoldRunner } from './runner-instance';
import type { SixfoldSnapshot } from './runner';

/** React view of the Sixfold runner. `scan` keeps live scans coming while the page is open, even with no session. */
export function useSixfold(scan = true): SixfoldSnapshot {
    useEffect(() => (scan ? sixfoldRunner.retainScan() : undefined), [scan]);
    return useSyncExternalStore(sixfoldRunner.subscribe, sixfoldRunner.getSnapshot, sixfoldRunner.getSnapshot);
}
