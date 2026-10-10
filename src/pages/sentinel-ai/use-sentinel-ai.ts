// SENTINEL AI — React binding for the runner singleton.
import { useEffect, useSyncExternalStore } from 'react';
import { sentinelAiRunner } from './sentinel-ai-runner-instance';
import type { SentinelAiSnapshot } from './sentinel-ai-types';

/** Subscribes to the runner. While `watch` is true the engine keeps analysing and the signal feed stays live. */
export const useSentinelAi = (watch = false): SentinelAiSnapshot => {
    const snapshot = useSyncExternalStore(sentinelAiRunner.subscribe, sentinelAiRunner.getSnapshot);

    useEffect(() => {
        if (!watch) return undefined;
        return sentinelAiRunner.watch();
    }, [watch]);

    return snapshot;
};
