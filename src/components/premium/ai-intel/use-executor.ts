import { useSyncExternalStore } from 'react';
import { aiIntelExecutor } from './executor-instance';

/** React view of the app-wide Apex Intel executor. */
export const useExecutor = () => useSyncExternalStore(aiIntelExecutor.subscribe, aiIntelExecutor.getSnapshot, aiIntelExecutor.getSnapshot);
