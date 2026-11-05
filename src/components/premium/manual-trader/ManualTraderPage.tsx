import { useEffect, useState } from 'react';
import { getCurrentSiteConfig } from '@/config/site-registry';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';
import {
    MANUAL_TRADER_MANIFEST_URL,
    TRADER_ACCOUNTS_KEY,
    TRADER_APP_ID_KEY,
    TRADER_SESSION_KEY,
    buildTraderAccounts,
    buildTraderLoginQuery,
    buildTraderSession,
    buildTraderUrl,
    parseManifest,
    usableAccounts,
} from './manual-trader-session';
import './manual-trader.scss';

/**
 * Marks the address of the current trader page. The trader's own service worker keeps pages and scripts it has seen for up to a
 * day (cache first), so older copies would otherwise be reused. Raise the number whenever ANY file under public/br_manual-trader/
 * changes: patched scripts keep their file names, so only this reset makes browsers fetch them again.
 */
const TRADER_PAGE_TAG = 'mt_page=12';

/** Caches the trader's service worker (Workbox) fills; other caches of this site are left alone. */
const TRADER_CACHE_NAMES = ['assets', 'core-js-files', 'smartchart-files', 'core-css-files', 'packages-files'];

type TState =
    | { status: 'loading' }
    | { status: 'missing' }
    | { status: 'error'; message: string }
    | { status: 'ready'; src: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True when the DTrader build has been installed under /br_manual-trader/ (see scripts/build-manual-trader.sh). */
const isInstalled = async () => {
    try {
        const response = await fetch(MANUAL_TRADER_MANIFEST_URL, { cache: 'no-store' });
        if (!response.ok) return false;
        return parseManifest(await response.json()) !== null;
    } catch {
        return false;
    }
};

/** Makes sure the stored sign-in is fresh, then returns it. */
const freshAuth = async () => {
    let auth = OAuthTokenExchangeService.getAuthInfo();
    const expiresSoon = Boolean(auth?.expires_at && Date.now() >= auth.expires_at - 30_000);
    if (!auth?.access_token || expiresSoon) {
        await OAuthTokenExchangeService.restoreSession();
        auth = OAuthTokenExchangeService.getAuthInfo();
    }
    return auth;
};

/**
 * Removes the trader's own service worker AND the files it cached, once per page tag. An earlier copy of the trader cached its
 * broken files (they were requested from the wrong folder) and its worker would keep serving them after the fix; the same happens
 * when a script is patched but keeps its file name. The worker registers itself again on the next load and caches fresh copies.
 */
const dropStaleTraderWorker = async () => {
    try {
        const flag = `manual_trader_worker_reset_${TRADER_PAGE_TAG}`;
        if (window.localStorage.getItem(flag) || !('serviceWorker' in navigator)) return;
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
            registrations.filter(item => item.scope.includes('/br_manual-trader/')).map(item => item.unregister())
        );
        if ('caches' in window) {
            const names = await window.caches.keys();
            await Promise.all(
                names
                    .filter(name => TRADER_CACHE_NAMES.includes(name) || name.startsWith('workbox-'))
                    .map(name => window.caches.delete(name))
            );
        }
        window.localStorage.setItem(flag, '1');
    } catch {
        // Not critical: the trader still opens, it may just show an older copy until its worker refreshes.
    }
};

const prepare = async (): Promise<TState> => {
    if (!(await isInstalled())) return { status: 'missing' };
    await dropStaleTraderWorker();

    const auth = await freshAuth();
    const session = buildTraderSession(auth);
    if (!session) return { status: 'error', message: 'Your sign-in has expired. Please log in again.' };

    let accounts = usableAccounts(DerivWSAccountsService.getStoredAccounts());
    if (!accounts.length) accounts = usableAccounts(await DerivWSAccountsService.fetchAccountsList(session.access_token));
    if (!accounts.length) return { status: 'error', message: 'No active Deriv Options accounts were found for this login.' };

    try {
        window.localStorage.setItem(TRADER_SESSION_KEY, JSON.stringify(session));
        window.localStorage.setItem(TRADER_ACCOUNTS_KEY, JSON.stringify(buildTraderAccounts(accounts)));
        window.localStorage.setItem(TRADER_APP_ID_KEY, getCurrentSiteConfig().client_id);
    } catch (error) {
        return { status: 'error', message: `Browser storage is unavailable (${errorText(error)}).` };
    }

    const query = buildTraderLoginQuery(accounts, window.localStorage.getItem('active_loginid'));
    const address = buildTraderUrl(query);
    // ?mt_debug=1 on this site shows a small tick readout inside the trader (see scripts/manual-trader/tick-watchdog.js).
    const debug = /[?&]mt_debug=1(&|$)/.test(window.location.search) ? '&mt_debug=1' : '';
    return { status: 'ready', src: `${address}${address.includes('?') ? '&' : '?'}${TRADER_PAGE_TAG}${debug}` };
};

const ManualTraderPage = () => {
    const [state, setState] = useState<TState>({ status: 'loading' });

    useEffect(() => {
        let alive = true;
        const activeAccount = () => {
            try {
                return window.localStorage.getItem('active_loginid');
            } catch {
                return null;
            }
        };
        let shown = activeAccount();
        const open = () => {
            shown = activeAccount();
            prepare()
                .then(next => alive && setState(next))
                .catch(error => alive && setState({ status: 'error', message: errorText(error) }));
        };
        open();
        // The trader has no account switcher of its own: when the account is changed in Sentinel's header, reopen it on that account.
        const timer = window.setInterval(() => {
            if (activeAccount() !== shown) open();
        }, 1000);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);

    if (state.status === 'ready') {
        return (
            <div className='manual-trader-page'>
                <iframe
                    className='manual-trader-page__iframe'
                    src={state.src}
                    title='Manual Trader'
                    allow='fullscreen; clipboard-write'
                />
            </div>
        );
    }

    return (
        <div className='manual-trader-page manual-trader-page--notice'>
            {state.status === 'loading' && <p>Opening Manual Trader...</p>}
            {state.status === 'missing' && (
                <>
                    <h2>Manual Trader is not installed yet</h2>
                    <p>
                        The Deriv DTrader build has not been added to this site. Run <code>npm run build:manual-trader</code> (Node 18) and
                        deploy the result.
                    </p>
                </>
            )}
            {state.status === 'error' && (
                <>
                    <h2>Manual Trader could not start</h2>
                    <p>{state.message}</p>
                </>
            )}
        </div>
    );
};

export default ManualTraderPage;
