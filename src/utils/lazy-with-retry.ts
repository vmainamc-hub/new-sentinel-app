import { type ComponentType, lazy } from 'react';
import { retryImport } from './chunk-retry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const lazyWithRetry = <T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) =>
    lazy(() => retryImport(factory));
