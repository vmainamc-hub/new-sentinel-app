export const recordDiagnosticEvent = (name: string, payload?: Record<string, unknown>) => {
    if (process.env.NODE_ENV === 'development') console.debug(`[diagnostics] ${name}`, payload ?? {});
};

export const setDiagnosticGauge = (name: string, payload?: Record<string, unknown>) => {
    if (process.env.NODE_ENV === 'development') console.debug(`[diagnostics:gauge] ${name}`, payload ?? {});
};
