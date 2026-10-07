import { useCallback, useEffect, useState } from 'react';
import { clearCSRFToken, validateCSRFToken } from '@/components/shared/utils/config/config';
import { clearAuthData } from '@/utils/auth-utils';

export interface OAuthCallbackParams {
    code: string | null;
    state: string | null;
    error: string | null;
    error_description: string | null;
}

export interface OAuthCallbackResult {
    isProcessing: boolean;
    isValid: boolean;
    params: OAuthCallbackParams;
    error: string | null;
    cleanupURL: () => void;
}

export const useOAuthCallback = (): OAuthCallbackResult => {
    const [result, setResult] = useState<Omit<OAuthCallbackResult, 'cleanupURL'>>({
        isProcessing: true,
        isValid: false,
        params: {
            code: null,
            state: null,
            error: null,
            error_description: null,
        },
        error: null,
    });

    const cleanupURL = useCallback(() => {
        const hash = window.location.hash || '';
        // OAuth redirect_uri is /callback. Once processed, leave that callback route
        // so refreshes never try to process a stale authorization code.
        window.history.replaceState({}, '', `/${hash}`);
    }, []);

    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');
        const error = urlParams.get('error');
        const error_description = urlParams.get('error_description');
        const isOAuthCallback = code !== null || error !== null || state !== null;

        if (!isOAuthCallback) {
            setResult({
                isProcessing: false,
                isValid: false,
                params: { code: null, state: null, error: null, error_description: null },
                error: null,
            });
            return;
        }

        if (error) {
            console.error('OAuth error:', error, error_description);
            setResult({
                isProcessing: false,
                isValid: false,
                params: { code, state, error, error_description },
                error: error_description || error,
            });
            cleanupURL();
            return;
        }

        if (!state) {
            clearAuthData();
            setResult({
                isProcessing: false,
                isValid: false,
                params: { code, state, error, error_description },
                error: 'Missing OAuth state parameter.',
            });
            cleanupURL();
            return;
        }

        if (!validateCSRFToken(state)) {
            clearAuthData();
            setResult({
                isProcessing: false,
                isValid: false,
                params: { code, state, error, error_description },
                error: 'OAuth state validation failed.',
            });
            cleanupURL();
            return;
        }

        clearCSRFToken();

        if (!code) {
            setResult({
                isProcessing: false,
                isValid: false,
                params: { code, state, error, error_description },
                error: 'Missing authorization code.',
            });
            cleanupURL();
            return;
        }

        setResult({
            isProcessing: false,
            isValid: true,
            params: { code, state, error, error_description },
            error: null,
        });
    }, [cleanupURL]);

    return {
        ...result,
        cleanupURL,
    };
};
