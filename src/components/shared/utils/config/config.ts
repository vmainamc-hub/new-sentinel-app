import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';
import {
    requireCurrentSiteConfig,
    resolveSiteConfig,
} from '@/config/site-registry';
import brandConfig from '../../../../../brand.config.json';

// =============================================================================
// Constants - Domain & Server Configuration (from brand.config.json)
// =============================================================================

export const PRODUCTION_DOMAINS = {
    COM: brandConfig.platform.hostname.production.com,
} as const;

export const STAGING_DOMAINS = {
    COM: brandConfig.platform.hostname.staging.com,
} as const;

export const WS_SERVERS = {
    STAGING: `${brandConfig.platform.derivws.url.staging}options/ws/public`,
    PRODUCTION: `${brandConfig.platform.derivws.url.production}options/ws/public`,
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Environment is selected by the current host entry in brand.config.json -> sites.
 * This is intentionally not inferred from whether the hostname equals a specific production domain,
 * because one deployment can serve several production domains with different OAuth apps.
 */
export const isProduction = () => {
    const configuredSite = resolveSiteConfig();
    if (configuredSite) return configuredSite.environment === 'production';

    const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
    const productionDomains = Object.values(PRODUCTION_DOMAINS) as string[];
    return productionDomains.includes(hostname);
};

export const isLocal = () => /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
    typeof window !== 'undefined' ? window.location.host : ''
);

const getDefaultServerURL = () => {
    const isProductionEnv = isProduction();

    try {
        return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
    } catch (error) {
        console.error('Error in getDefaultServerURL:', error);
    }

    return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
};

/**
 * Gets the WebSocket URL using the authenticated OTP flow when an OAuth token exists.
 * Once OAuth is present we must never silently downgrade to the public market-data
 * socket: a public socket makes charts appear healthy but cannot purchase contracts.
 */
export const getSocketURL = async (): Promise<string> => {
    const authInfo = OAuthTokenExchangeService.getAuthInfo();
    if (!authInfo || !authInfo.access_token) {
        return getDefaultServerURL();
    }

    try {
        return await DerivWSAccountsService.getAuthenticatedWebSocketURL(authInfo.access_token);
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : (error as any)?.error?.message || (error as any)?.message || 'Unable to create authenticated Deriv WebSocket.';
        console.error('[DerivWS] Authenticated WebSocket setup failed:', message);
        throw error instanceof Error ? error : new Error(message);
    }
};

export const getDebugServiceWorker = () => {
    const debug_service_worker_flag = window.localStorage.getItem('debug_service_worker');
    if (debug_service_worker_flag) return !!parseInt(debug_service_worker_flag);
    return false;
};

const generateCSRFToken = (): string => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const base64 = btoa(String.fromCharCode(...array));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

const generateCodeVerifier = (): string => {
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from(array, byte => charset[byte % charset.length]).join('');
};

const generateCodeChallenge = async (verifier: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const base64 = btoa(String.fromCharCode(...hashArray));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

// OAuth may start on www.example.site while Deriv redirects to example.site/callback.
// sessionStorage is origin-specific, so keep a short-lived cookie fallback scoped to the
// site's parent host. This preserves the PKCE verifier and CSRF state across www/non-www
// aliases without making them persistent credentials.
const OAUTH_TRANSIENT_TTL_SECONDS = 600;

const getOAuthCookieDomain = (): string => {
    try {
        const site = resolveSiteConfig();
        const configuredHost = site ? new URL(site.website_url).hostname : window.location.hostname;
        return configuredHost.replace(/^www\./i, '');
    } catch {
        return typeof window !== 'undefined' ? window.location.hostname.replace(/^www\./i, '') : '';
    }
};

const readOAuthCookie = (name: string): string | null => {
    if (typeof document === 'undefined') return null;

    const prefix = `${name}=`;
    const cookie = document.cookie
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(prefix));

    if (!cookie) return null;

    try {
        return decodeURIComponent(cookie.slice(prefix.length));
    } catch {
        return cookie.slice(prefix.length);
    }
};

const writeOAuthCookie = (name: string, value: string): void => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const domain = getOAuthCookieDomain();
    const domainPart = domain && !isLocal() ? `; Domain=${domain}` : '';
    const securePart = window.location.protocol === 'https:' ? '; Secure' : '';

    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${OAUTH_TRANSIENT_TTL_SECONDS}; SameSite=Lax${securePart}${domainPart}`;
};

const clearOAuthCookie = (name: string): void => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const domain = getOAuthCookieDomain();
    const domainPart = domain && !isLocal() ? `; Domain=${domain}` : '';
    const securePart = window.location.protocol === 'https:' ? '; Secure' : '';

    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${securePart}${domainPart}`;
};

const storeCodeVerifier = (verifier: string): void => {
    const timestamp = Date.now().toString();
    sessionStorage.setItem('oauth_code_verifier', verifier);
    sessionStorage.setItem('oauth_code_verifier_timestamp', timestamp);
    writeOAuthCookie('oauth_code_verifier', verifier);
    writeOAuthCookie('oauth_code_verifier_timestamp', timestamp);
};

export const getCodeVerifier = (): string | null => {
    const verifier = sessionStorage.getItem('oauth_code_verifier') || readOAuthCookie('oauth_code_verifier');
    const timestamp =
        sessionStorage.getItem('oauth_code_verifier_timestamp') || readOAuthCookie('oauth_code_verifier_timestamp');

    if (!verifier || !timestamp) return null;

    const verifierAge = Date.now() - parseInt(timestamp, 10);
    if (!Number.isFinite(verifierAge) || verifierAge > OAUTH_TRANSIENT_TTL_SECONDS * 1000) {
        clearCodeVerifier();
        return null;
    }

    return verifier;
};

export const clearCodeVerifier = (): void => {
    sessionStorage.removeItem('oauth_code_verifier');
    sessionStorage.removeItem('oauth_code_verifier_timestamp');
    clearOAuthCookie('oauth_code_verifier');
    clearOAuthCookie('oauth_code_verifier_timestamp');
};

const storeCSRFToken = (token: string): void => {
    const timestamp = Date.now().toString();
    sessionStorage.setItem('oauth_csrf_token', token);
    sessionStorage.setItem('oauth_csrf_token_timestamp', timestamp);
    writeOAuthCookie('oauth_csrf_token', token);
    writeOAuthCookie('oauth_csrf_token_timestamp', timestamp);
};

export const validateCSRFToken = (token: string): boolean => {
    const storedToken = sessionStorage.getItem('oauth_csrf_token') || readOAuthCookie('oauth_csrf_token');
    const timestamp =
        sessionStorage.getItem('oauth_csrf_token_timestamp') || readOAuthCookie('oauth_csrf_token_timestamp');

    if (!storedToken || !timestamp || storedToken !== token) return false;

    const tokenAge = Date.now() - parseInt(timestamp, 10);
    if (!Number.isFinite(tokenAge) || tokenAge > OAUTH_TRANSIENT_TTL_SECONDS * 1000) {
        clearCSRFToken();
        return false;
    }

    return true;
};

export const clearCSRFToken = (): void => {
    sessionStorage.removeItem('oauth_csrf_token');
    sessionStorage.removeItem('oauth_csrf_token_timestamp');
    clearOAuthCookie('oauth_csrf_token');
    clearOAuthCookie('oauth_csrf_token_timestamp');
};

/**
 * Build a Deriv OAuth2 Authorization Code + PKCE URL for the current domain.
 * Every domain must have its own explicit host/client_id/redirect_uri entry.
 */
export const generateOAuthURL = async (prompt?: string) => {
    try {
        const site = requireCurrentSiteConfig();
        const authBase = brandConfig.platform.auth2_url[site.environment];
        if (!authBase) throw new Error(`No Deriv OAuth base URL for ${site.environment}`);

        const csrfToken = generateCSRFToken();
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        storeCSRFToken(csrfToken);
        storeCodeVerifier(codeVerifier);
        sessionStorage.setItem('oauth_site_id', site.id);
        sessionStorage.setItem('oauth_redirect_uri', site.redirect_uri);

        const oauthUrl = new URL('auth', authBase);
        oauthUrl.searchParams.set('response_type', 'code');
        oauthUrl.searchParams.set('client_id', site.client_id);
        oauthUrl.searchParams.set('redirect_uri', site.redirect_uri);
        oauthUrl.searchParams.set('scope', site.scopes.join(' '));
        oauthUrl.searchParams.set('state', csrfToken);
        oauthUrl.searchParams.set('code_challenge', codeChallenge);
        oauthUrl.searchParams.set('code_challenge_method', 'S256');

        if (prompt) oauthUrl.searchParams.set('prompt', prompt);
        if (site.legacy_app_id) oauthUrl.searchParams.set('app_id', site.legacy_app_id);

        return oauthUrl.toString();
    } catch (error) {
        console.error('Error generating OAuth URL:', error);
        return '';
    }
};
