// Execution speed for bots started from this app.
// Fast: purchases happen immediately. Slow: each purchase waits SLOW_DELAY_MS first.
export type ExecutionSpeed = 'fast' | 'slow';
export const EXECUTION_SPEED_KEY = 'apex_execution_speed';
export const SLOW_DELAY_MS = 2000;

export const readExecutionSpeed = (): ExecutionSpeed => {
    try {
        return window.localStorage.getItem(EXECUTION_SPEED_KEY) === 'slow' ? 'slow' : 'fast';
    } catch {
        return 'fast';
    }
};
