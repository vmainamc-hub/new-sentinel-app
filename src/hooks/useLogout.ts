import { useCallback } from 'react';
import { useStore } from '@/hooks/useStore';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';
import { ErrorLogger } from '@/utils/error-logger';

/**
 * Explicit logout is the boundary for the persistent local session.
 * Refresh/reconnect keeps the OAuth session; logout clears it.
 */
export const useLogout = () => {
    const { client } = useStore() ?? {};

    return useCallback(async () => {
        try {
            await client?.logout();
        } catch (error) {
            ErrorLogger.error('Logout', 'Logout request failed; clearing local session anyway', error);
        } finally {
            try {
                OAuthTokenExchangeService.clearAuthInfo();
                DerivWSAccountsService.clearCache();
                DerivWSAccountsService.clearStoredAccounts();

                localStorage.removeItem('active_loginid');
                localStorage.removeItem('authToken');
                localStorage.removeItem('accountsList');
                localStorage.removeItem('clientAccounts');
                localStorage.removeItem('client_account_details');
                localStorage.removeItem('account_type');
                localStorage.removeItem('client.country');

                sessionStorage.removeItem('oauth_code_verifier');
                sessionStorage.removeItem('oauth_code_verifier_timestamp');
                sessionStorage.removeItem('oauth_csrf_token');
                sessionStorage.removeItem('oauth_csrf_token_timestamp');
                sessionStorage.removeItem('oauth_site_id');
                sessionStorage.removeItem('oauth_redirect_uri');
            } catch (storageError) {
                ErrorLogger.error('Logout', 'Failed to clear persisted auth storage', storageError);
            }
        }
    }, [client]);
};
