import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';

// The ported 360 pages used to read the Deriv session straight from sessionStorage. This app keeps it in
// OAuthTokenExchangeService / DerivWSAccountsService (persistent storage, Deriv-App-ID headers, OTP caching),
// so every ported page asks this adapter instead.
export type Hub360AuthContext = {
    accessToken: string;
    activeAccount: { account_id: string; account_type?: string; currency?: string };
};

export const getHub360AuthContext = (): Hub360AuthContext | null => {
    try {
        const accessToken = OAuthTokenExchangeService.getAuthInfo()?.access_token;
        const accounts = DerivWSAccountsService.getStoredAccounts();
        if (!accessToken || !accounts?.length) return null;

        const activeLoginId = window.localStorage.getItem('active_loginid');
        const activeAccount = accounts.find(account => account.account_id === activeLoginId) || accounts[0];
        return activeAccount?.account_id ? { accessToken, activeAccount } : null;
    } catch {
        return null;
    }
};

export const getHub360AuthenticatedUrl = async (): Promise<string> => {
    const accessToken = OAuthTokenExchangeService.getAuthInfo()?.access_token;
    if (!accessToken) throw new Error('Session Missing');
    return DerivWSAccountsService.getAuthenticatedWebSocketURL(accessToken);
};
