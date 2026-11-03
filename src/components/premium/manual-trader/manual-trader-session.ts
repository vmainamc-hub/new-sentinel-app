/**
 * Manual Trader hand-off.
 *
 * The Manual Trader is Deriv's own DTrader frontend (built from vmainamc-hub/db-traders-) served from this site
 * under /br_manual-trader/ and shown in an iframe. It must NOT run a second Deriv login, so this page gives it the
 * session the app already has, in the format the DTrader build reads:
 *   deriv_oauth_session       { access_token, expires_at }
 *   deriv_oauth_accounts_raw  { data: [ { account_id, balance, currency, account_type, status } ] }
 *   deriv_oauth_app_id        the OAuth client id the token was issued to (sent as Deriv-App-ID)
 * and opens it with the "login coming back" address (acct1/token1/cur1 ... selected_acct) that its client store
 * turns into accounts after `authorize`. The per-account "token" in that address is `oauth:<account_id>`, never the
 * real bearer token.
 *
 * Everything here is pure so it can be tested without a browser. The page does the reading and writing.
 */

/** Folder the DTrader build is served from. The name must start with `br_`: that is the only prefix its router accepts as a base path. */
export const MANUAL_TRADER_BASE_PATH = '/br_manual-trader/';
/** Written by scripts/build-manual-trader.sh. Its presence (as JSON) tells the page the build is installed. */
export const MANUAL_TRADER_MANIFEST_URL = `${MANUAL_TRADER_BASE_PATH}manual-trader.json`;

/** localStorage keys shared with the embedded build (everything else it stores is namespaced, see scripts/manual-trader/storage-isolation.js). */
export const TRADER_SESSION_KEY = 'deriv_oauth_session';
export const TRADER_ACCOUNTS_KEY = 'deriv_oauth_accounts_raw';
export const TRADER_APP_ID_KEY = 'deriv_oauth_app_id';

export type TTraderAccount = {
    account_id: string;
    balance?: string | number;
    currency?: string;
    account_type?: string;
    status?: string;
    group?: string;
};

export type TTraderAuth = {
    access_token?: string;
    expires_at?: number;
};

export type TManualTraderManifest = {
    source_commit: string;
    built_at?: string;
};

/** Accepts the manifest only if it is the JSON the build script writes (a SPA fallback page is HTML and fails this). */
export const parseManifest = (raw: unknown): TManualTraderManifest | null => {
    if (!raw || typeof raw !== 'object') return null;
    const { source_commit, built_at } = raw as Record<string, unknown>;
    if (typeof source_commit !== 'string' || !source_commit) return null;
    return { source_commit, ...(typeof built_at === 'string' ? { built_at } : {}) };
};

/** Only active accounts with an id can be traded on. */
export const usableAccounts = (accounts: TTraderAccount[] | null | undefined): TTraderAccount[] =>
    (Array.isArray(accounts) ? accounts : []).filter(
        account => Boolean(account && account.account_id) && (!account.status || account.status === 'active')
    );

/** Deriv's new account ids (DOT123 / ROT123) get the legacy-looking alias the DTrader code expects (VRTC123 / CR123). */
export const toTraderLoginid = (accountId: string, accountType?: string) =>
    `${accountType === 'demo' ? 'VRTC' : 'CR'}${accountId.replace(/^[A-Za-z]+/, '')}`;

/** The session the DTrader build reads; null when there is no usable token. */
export const buildTraderSession = (auth: TTraderAuth | null | undefined) =>
    auth && auth.access_token ? { access_token: auth.access_token, expires_at: auth.expires_at ?? 0 } : null;

/** The accounts list in the shape of Deriv's /options/accounts response, which is what the build stores after its own sign-in. */
export const buildTraderAccounts = (accounts: TTraderAccount[] | null | undefined) => ({
    data: usableAccounts(accounts),
});

/**
 * The "login coming back" query. Accounts are listed demo first, as the DTrader build does. The account the app is
 * already on (activeAccountId) is selected when it is in the list, so the trader opens where the user already is;
 * otherwise the demo account is selected, so a first open never lands on a real account by accident.
 */
export const buildTraderLoginQuery = (accounts: TTraderAccount[] | null | undefined, activeAccountId?: string | null) => {
    const list = usableAccounts(accounts).map(account => ({
        id: account.account_id,
        loginid: toTraderLoginid(account.account_id, account.account_type),
        virtual: account.account_type === 'demo' ? 1 : 0,
        currency: account.currency || 'USD',
    }));
    const ordered = [...list].sort((a, b) => b.virtual - a.virtual);
    const params = new URLSearchParams();
    ordered.forEach((account, index) => {
        params.set(`acct${index + 1}`, account.loginid);
        params.set(`token${index + 1}`, `oauth:${account.id}`);
        params.set(`cur${index + 1}`, account.currency);
    });
    const selected = ordered.find(account => account.id === activeAccountId) ?? ordered[0];
    if (selected) params.set('selected_acct', selected.loginid);
    return params.toString();
};

/** Address the iframe opens. */
export const buildTraderUrl = (query: string) => (query ? `${MANUAL_TRADER_BASE_PATH}?${query}` : MANUAL_TRADER_BASE_PATH);
