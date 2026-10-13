/** True for the errors a browser raises when a lazy-loaded file cannot be fetched (offline, 401/403/404, deploy swap). */
export const isChunkLoadError = (error: unknown): boolean => {
    const text = `${(error as { name?: string })?.name ?? ''} ${(error as { message?: string })?.message ?? ''}`;
    return /ChunkLoadError|Loading (CSS )?chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
        text
    );
};

/**
 * Runs a dynamic import and retries it a couple of times when the file could not be fetched, so a brief network blip or
 * a refused request does not break the tab for the rest of the session. Other errors are thrown at once.
 */
export const retryImport = async <T>(factory: () => Promise<T>, retries = 2, delayMs = 800): Promise<T> => {
    let attempt = 0;
    for (;;) {
        try {
            return await factory();
        } catch (error) {
            if (!isChunkLoadError(error) || attempt >= retries) throw error;
            attempt += 1;
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
    }
};
