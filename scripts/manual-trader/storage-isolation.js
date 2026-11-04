/*
 * Storage isolation for the embedded Manual Trader (Deriv's DTrader build).
 *
 * The DTrader build is served from this site's own origin, so it shares localStorage and sessionStorage with the
 * Sentinel app. Both are Deriv-derived and use the same key names (active_loginid, client.accounts, account_type ...)
 * with different values (the DTrader build stores legacy ids such as VRTC123, Sentinel stores the real account id).
 * Left alone, opening the trader could silently switch the account Sentinel trades on.
 *
 * This script runs first in the DTrader page. It replaces window.localStorage and window.sessionStorage with views
 * that prefix every key with "mt:", except the keys the hand-off in manual-trader-session.ts shares on purpose.
 * Keep SHARED in step with TRADER_SESSION_KEY / TRADER_ACCOUNTS_KEY / TRADER_APP_ID_KEY there.
 *
 * scripts/build-manual-trader.sh inlines this file into the built index.html. It has no dependencies.
 */
(function (win) {
    'use strict';

    var PREFIX = 'mt:';
    // Members the page expects on a Storage object but that are not stored keys: hasOwnProperty, toString and the helpers the
    // trader adds to Storage.prototype itself (getObject / setObject). Without them the trader fails at start-up.
    var inherited = typeof win.Storage === 'function' && win.Storage.prototype ? win.Storage.prototype : Object.prototype;
    var SHARED = { deriv_oauth_session: true, deriv_oauth_accounts_raw: true, deriv_oauth_app_id: true };

    function isOwn(object, name) {
        return Object.prototype.hasOwnProperty.call(object, name);
    }

    function wrap(real) {
        function name(key) {
            key = String(key);
            return isOwn(SHARED, key) ? key : PREFIX + key;
        }

        function keys() {
            var out = [];
            for (var i = 0; i < real.length; i++) {
                var key = real.key(i);
                if (key === null) continue;
                if (key.indexOf(PREFIX) === 0) out.push(key.slice(PREFIX.length));
                else if (isOwn(SHARED, key)) out.push(key);
            }
            return out;
        }

        var methods = {
            getItem: function (key) {
                return real.getItem(name(key));
            },
            setItem: function (key, value) {
                real.setItem(name(key), String(value));
            },
            removeItem: function (key) {
                real.removeItem(name(key));
            },
            key: function (index) {
                var list = keys();
                return index >= 0 && index < list.length ? list[index] : null;
            },
            clear: function () {
                keys().forEach(function (key) {
                    real.removeItem(name(key));
                });
            },
        };

        return new Proxy(
            {},
            {
                get: function (_target, prop) {
                    if (prop === 'length') return keys().length;
                    if (typeof prop === 'symbol') return undefined;
                    if (isOwn(methods, prop)) return methods[prop];
                    if (prop in inherited) return inherited[prop];
                    var value = real.getItem(name(prop));
                    return value === null ? undefined : value;
                },
                set: function (_target, prop, value) {
                    if (typeof prop !== 'symbol') real.setItem(name(prop), String(value));
                    return true;
                },
                deleteProperty: function (_target, prop) {
                    if (typeof prop !== 'symbol') real.removeItem(name(prop));
                    return true;
                },
                has: function (_target, prop) {
                    return typeof prop === 'string' && (isOwn(methods, prop) || prop in inherited || real.getItem(name(prop)) !== null);
                },
                // Makes `storage instanceof Storage` true, which libraries (mobx-persist-store) use to recognise a storage object.
                getPrototypeOf: function () {
                    return inherited;
                },
                ownKeys: function () {
                    return keys();
                },
                getOwnPropertyDescriptor: function (_target, prop) {
                    if (typeof prop !== 'string') return undefined;
                    var value = real.getItem(name(prop));
                    if (value === null) return undefined;
                    return { value: value, writable: true, enumerable: true, configurable: true };
                },
            }
        );
    }

    ['localStorage', 'sessionStorage'].forEach(function (storage_name) {
        try {
            var proxy = wrap(win[storage_name]);
            Object.defineProperty(win, storage_name, { configurable: true, get: function () { return proxy; } });
        } catch (error) {
            // Without isolation the trader would share keys with Sentinel, so stop it from starting.
            throw new Error('Manual Trader storage isolation failed for ' + storage_name + ': ' + (error && error.message));
        }
    });
})(window);
