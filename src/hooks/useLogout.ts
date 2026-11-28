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

                // The embedded Manual Trader keeps its own copy of the session: the three keys the hand-off shares on purpose
                // (see manual-trader-session.ts) and everything it stores under the "mt:" prefix (scripts/manual-trader/storage-isolation.js).
                ['deriv_oauth_session', 'deriv_oauth_accounts_raw', 'deriv_oauth_app_id'].forEach(key => localStorage.removeItem(key));
                for (let index = localStorage.length - 1; index >= 0; index -= 1) {
                    const key = localStorage.key(index);
                    if (key && key.startsWith('mt:')) localStorage.removeItem(key);
                }

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
