import Cookies from 'js-cookie';
import { BOT_VERSION_CONFIG } from '@/constants/bot-version';

/**
 * Clears all localStorage data except for the bot_version
 */
const clearLocalStorage = (): void => {
    try {
        // Get the current bot_version before clearing
        const currentBotVersion = localStorage.getItem(BOT_VERSION_CONFIG.STORAGE_KEY);

        // Clear all localStorage
        localStorage.clear();

        // Restore the bot_version if it existed
        if (currentBotVersion) {
            localStorage.setItem(BOT_VERSION_CONFIG.STORAGE_KEY, currentBotVersion);
        }
    } catch (error) {
        console.error('Error clearing localStorage:', error);
    }
};

/**
 * Clears all non-OAuth cookies for the current domain and parent domains.
 *
 * The OAuth PKCE verifier/state cookies are intentionally preserved here. They are
 * short-lived (10 minutes) and are removed by the OAuth flow itself after use. Clearing
 * them during app bootstrap would make a valid Deriv callback look unauthenticated,
 * especially when login starts on www.example.site and returns to example.site/callback.
 */
const clearCookies = (): void => {
    try {
        // Get all cookies
        const cookies = document.cookie.split(';');

        // Clear each cookie for different domain variations
        const domains = [`.${document.domain.split('.').slice(-2).join('.')}`, `.${document.domain}`, document.domain];

        const paths = ['/', window.location.pathname.split('/', 2)[1] || ''];

        cookies.forEach(cookie => {
            const cookieName = cookie.split('=')[0].trim();
            if (!cookieName || cookieName.startsWith('oauth_')) return;

            // Remove cookie for different domain and path combinations
            domains.forEach(domain => {
                paths.forEach(path => {
                    Cookies.remove(cookieName, { domain, path });
                });
            });
            // Also try removing without domain/path
            Cookies.remove(cookieName);
        });
    } catch (error) {
        console.error('Error clearing cookies:', error);
    }
};

/**
 * Sets the bot version in localStorage to prevent infinite clearing
 */
const setBotVersion = (): void => {
    try {
        localStorage.setItem(BOT_VERSION_CONFIG.STORAGE_KEY, BOT_VERSION_CONFIG.REQUIRED_VERSION.toString());
    } catch (error) {
        console.error('Error setting bot version:', error);
    }
};

/**
 * Checks if the current bot version matches the required version
 * @returns true if version matches or is not set, false if version is different
 */
const isVersionValid = (): boolean => {
    try {
        const currentVersion = localStorage.getItem(BOT_VERSION_CONFIG.STORAGE_KEY);

        // If no version is set, consider it invalid (needs clearing)
        if (currentVersion === null) {
            return false;
        }

        // Parse the version and check if it matches
        const versionNumber = parseInt(currentVersion, 10);
        return versionNumber === BOT_VERSION_CONFIG.REQUIRED_VERSION;
    } catch (error) {
        console.error('Error checking bot version:', error);
        return false;
    }
};

const isOAuthCallback = (): boolean => {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('code') || params.get('state') || params.get('error'));
};

/**
 * Performs version check and clears storage if necessary.
 * This function is called at the very beginning of app initialization.
 *
 * OAuth callbacks are a special case: never clear callback state before React has
 * validated it and exchanged the authorization code. When the callback arrives on a
 * different www/non-www alias, that host may not have a bot_version entry yet even
 * though the login was started correctly on the sibling host. In that case we simply
 * initialise the version marker and allow OAuth processing to continue.
 */
export const performVersionCheck = (): void => {
    console.log('Performing bot version check...');

    if (isOAuthCallback()) {
        if (!isVersionValid()) setBotVersion();
        console.log('OAuth callback detected. Preserving PKCE/state during version bootstrap.');
        return;
    }

    if (!isVersionValid()) {
        console.log('Bot version mismatch or not set. Clearing localStorage and non-OAuth cookies...');

        // Clear all non-OAuth storage
        clearLocalStorage();
        clearCookies();

        // Set the correct version to prevent infinite clearing
        setBotVersion();

        console.log('Storage cleared and bot version set to:', BOT_VERSION_CONFIG.REQUIRED_VERSION);
    } else {
        console.log('Bot version is valid:', BOT_VERSION_CONFIG.REQUIRED_VERSION);
    }
};
