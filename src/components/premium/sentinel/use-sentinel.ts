import { useEffect, useState } from 'react';
import { useSixfold } from '../sixfold/use-sixfold';
import { attachEngines, getEngineSettings, sentinelRunner, setEngineSettings } from './runner-instance';
import type { EngineSettings } from './settings';

/** React view of the Sentinel AI runner; keeps both engines running while the page is open. */
export function useSentinel() {
    const sx = useSixfold(true, sentinelRunner);
    useEffect(() => attachEngines(), []);
    const [engine, setEngine] = useState<EngineSettings>(getEngineSettings());
    const update = (patch: Partial<EngineSettings>) => {
        const next = { ...getEngineSettings(), ...patch };
        setEngineSettings(next);
        setEngine(next);
    };
    return { sx, engine, update };
}
