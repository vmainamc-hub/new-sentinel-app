import { getCurrentSiteConfig } from '@/config/site-registry';
import brandConfig from '../../brand.config.json';

export interface DerivAccount {
    account_id: string;
    balance: string | number;
    currency: string;
    group: string;
    status: string;
    account_type: 'demo' | 'real';
}

interface AccountsResponse {
    data: DerivAccount[];
}

interface OTPResponse {
    data: {
        url: string;
        otp?: string;
    };
}

const ACCOUNTS_STORAGE_KEY = 'deriv_accounts';

/**
 * Handles the current Deriv Options REST -> OTP -> authenticated WebSocket flow.
 * Every authenticated REST request includes both the OAuth Bearer token and
 * the Deriv-App-ID belonging to the current host's site configuration.
 */
export class DerivWSAccountsService {
    private static accountsFetchPromise: Promise<DerivAccount[]> | null = null;
    private static otpFetchPromises = new Map<string, Promise<string>>();

    private static getSite() {
        return getCurrentSiteConfig();
    }

    private static getDerivWSBaseURL(): string {
        const site = this.getSite();
        return brandConfig.platform.derivws.url[site.environment];
    }

    private static getHeaders(accessToken: string): HeadersInit {
        return {
            Authorization: `Bearer ${accessToken}`,
            'Deriv-App-ID': this.getSite().client_id,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }

    private static async readError(response: Response): Promise<string> {
        const raw = await response.text().catch(() => '');
        if (!raw) return response.statusText;
        try {
            const parsed = JSON.parse(raw);
            return parsed?.errors?.[0]?.message || parsed?.error_description || parsed?.message || raw;
        } catch {
            return raw;
        }
    }

    private static activeAccounts(accounts: DerivAccount[]): DerivAccount[] {
        return accounts.filter(account => account?.account_id && (!account.status || account.status === 'active'));
    }

    private static selectAccount(accounts: DerivAccount[]): DerivAccount | null {
        const usable = this.activeAccounts(accounts);
        const activeLoginId = localStorage.getItem('active_loginid');
        return (activeLoginId && usable.find(account => account.account_id === activeLoginId)) || usable[0] || null;
    }

    private static persistSelectedAccount(account: DerivAccount): void {
        localStorage.setItem('active_loginid', account.account_id);
        localStorage.setItem('account_type', account.account_type === 'demo' ? 'demo' : 'real');
    }

    static clearCache(): void {
        this.accountsFetchPromise = null;
        this.otpFetchPromises.clear();
    }

    static storeAccounts(accounts: DerivAccount[]): void {
        localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
        sessionStorage.removeItem(ACCOUNTS_STORAGE_KEY);
    }

    static getStoredAccounts(): DerivAccount[] | null {
        try {
            const persistent = localStorage.getItem(ACCOUNTS_STORAGE_KEY);
            const legacy = sessionStorage.getItem(ACCOUNTS_STORAGE_KEY);
            const raw = persistent || legacy;
            if (!raw) return null;
            const accounts = JSON.parse(raw) as DerivAccount[];
            if (!persistent && legacy) {
                localStorage.setItem(ACCOUNTS_STORAGE_KEY, legacy);
                sessionStorage.removeItem(ACCOUNTS_STORAGE_KEY);
            }
            return Array.isArray(accounts) ? accounts : null;
        } catch (error) {
            console.error('[DerivWS] Error parsing stored accounts:', error);
            return null;
        }
    }

    static updateStoredAccountBalance(accountId: string, balance: string | number, currency?: string): void {
        const accounts = this.getStoredAccounts();
        if (!accounts?.length) return;

        this.storeAccounts(
            accounts.map(account =>
                account.account_id === accountId
                    ? {
                          ...account,
                          balance,
                          currency: currency || account.currency,
                      }
                    : account
            )
        );
    }

    static getDefaultAccount(): DerivAccount | null {
        return this.selectAccount(this.getStoredAccounts() || []);
    }

    static clearStoredAccounts(): void {
        localStorage.removeItem(ACCOUNTS_STORAGE_KEY);
        sessionStorage.removeItem(ACCOUNTS_STORAGE_KEY);
    }

    static async fetchAccountsList(accessToken: string): Promise<DerivAccount[]> {
        if (this.accountsFetchPromise) return this.accountsFetchPromise;

        this.accountsFetchPromise = (async () => {
            try {
                const baseURL = this.getDerivWSBaseURL();
                const optionsDir = brandConfig.platform.derivws.directories.options;
                const endpoint = `${baseURL}${optionsDir}accounts`;

                const response = await fetch(endpoint, {
                    method: 'GET',
                    headers: this.getHeaders(accessToken),
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch Deriv accounts (${response.status}): ${await this.readError(response)}`);
                }

                const data: AccountsResponse = await response.json();
                const accounts = Array.isArray(data?.data) ? this.activeAccounts(data.data) : [];
                this.storeAccounts(accounts);
                return accounts;
            } catch (error) {
                this.accountsFetchPromise = null;
                console.error('[DerivWS] Error fetching accounts:', error);
                throw error;
            } finally {
                window.setTimeout(() => {
                    this.accountsFetchPromise = null;
                }, 100);
            }
        })();

        return this.accountsFetchPromise;
    }

    static async refreshAccounts(accessToken: string): Promise<DerivAccount[]> {
        this.clearCache();
        return this.fetchAccountsList(accessToken);
    }

    static async resetDemoBalance(accessToken: string, accountId: string): Promise<DerivAccount[]> {
        const storedAccount = this.getStoredAccounts()?.find(account => account.account_id === accountId);
        if (storedAccount && storedAccount.account_type !== 'demo') {
            throw new Error('Only a Deriv demo Options account can be reset.');
        }

        const baseURL = this.getDerivWSBaseURL();
        const optionsDir = brandConfig.platform.derivws.directories.options;
        const endpoint = `${baseURL}${optionsDir}accounts/${encodeURIComponent(accountId)}/reset-demo-balance`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: this.getHeaders(accessToken),
        });

        if (!response.ok) {
            throw new Error(`Failed to reset demo balance (${response.status}): ${await this.readError(response)}`);
        }

        return this.refreshAccounts(accessToken);
    }

    static async fetchOTPWebSocketURL(accessToken: string, accountId: string): Promise<string> {
        const cacheKey = accountId;
        const cached = this.otpFetchPromises.get(cacheKey);
        if (cached) return cached;

        const otpPromise = (async () => {
            try {
                const baseURL = this.getDerivWSBaseURL();
                const optionsDir = brandConfig.platform.derivws.directories.options;
                const endpoint = `${baseURL}${optionsDir}accounts/${encodeURIComponent(accountId)}/otp`;

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: this.getHeaders(accessToken),
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch WebSocket OTP (${response.status}): ${await this.readError(response)}`);
                }

                const otpResponse: OTPResponse = await response.json();
                const websocketURL = otpResponse?.data?.url;
                if (!websocketURL) throw new Error('Deriv OTP response did not contain a WebSocket URL.');
                return websocketURL;
            } catch (error) {
                this.otpFetchPromises.delete(cacheKey);
                console.error('[DerivWS] Error fetching OTP:', error);
                throw error;
            } finally {
                window.setTimeout(() => this.otpFetchPromises.delete(cacheKey), 100);
            }
        })();

        this.otpFetchPromises.set(cacheKey, otpPromise);
        return otpPromise;
    }

    static async getAuthenticatedWebSocketURL(accessToken: string): Promise<string> {
        let accounts = this.getStoredAccounts();
        if (!accounts?.length) accounts = await this.fetchAccountsList(accessToken);
        let targetAccount = this.selectAccount(accounts || []);
        if (!targetAccount) throw new Error('No active Deriv Options accounts are available for this user.');

        this.persistSelectedAccount(targetAccount);

        try {
            return await this.fetchOTPWebSocketURL(accessToken, targetAccount.account_id);
        } catch (firstError) {
            // Stored account data can become stale after account changes or a new
            // OAuth session. Refresh once instead of silently falling back to the
            // public socket, which would make charts work while every buy fails.
            console.warn('[DerivWS] Stored account OTP failed. Refreshing the account list once.');
            const refreshedAccounts = await this.refreshAccounts(accessToken);
            targetAccount = this.selectAccount(refreshedAccounts);
            if (!targetAccount) throw firstError;
            this.persistSelectedAccount(targetAccount);
            return this.fetchOTPWebSocketURL(accessToken, targetAccount.account_id);
        }
    }
}
