type SubscriptionLike = { unsubscribe?: () => void };

export const ensureDerivConnection = async (apiBase: { api?: any; init?: () => Promise<void> }) => {
    if (apiBase.api?.connection?.readyState === 1) return apiBase.api;

    await apiBase.init?.();

    if (apiBase.api?.connection?.readyState === 1) return apiBase.api;

    await new Promise<void>((resolve, reject) => {
        const connection = apiBase.api?.connection;
        if (!connection) {
            reject(new Error('Deriv connection is not initialized.'));
            return;
        }

        const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error('Deriv connection timed out.'));
        }, 10000);

        const cleanup = () => {
            window.clearTimeout(timeout);
            connection.removeEventListener?.('open', onOpen);
            connection.removeEventListener?.('error', onError);
            connection.removeEventListener?.('close', onClose);
        };

        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error('Deriv connection failed.'));
        };
        const onClose = () => {
            cleanup();
            reject(new Error('Deriv connection closed.'));
        };

        connection.addEventListener?.('open', onOpen);
        connection.addEventListener?.('error', onError);
        connection.addEventListener?.('close', onClose);
    });

    return apiBase.api;
};

export const safeSubscribe = (
    observable: { subscribe?: (...args: any[]) => SubscriptionLike } | SubscriptionLike | Promise<unknown>,
    onData: (data: any) => void,
    onError?: (error: unknown) => void
): SubscriptionLike => {
    try {
        const candidate = observable as { subscribe?: (...args: any[]) => SubscriptionLike };
        if (typeof candidate?.subscribe === 'function') {
            return candidate.subscribe(onData, onError);
        }
    } catch (error) {
        onError?.(error);
    }

    return { unsubscribe: () => undefined };
};
