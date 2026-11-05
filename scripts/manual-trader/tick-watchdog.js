/*
 * Tick watchdog for the embedded Manual Trader (Deriv's DTrader build).
 *
 * Symptom it covers: after a trade settles, the chart cursor and the last-digit circles stop moving and stay where they
 * were, although the market keeps ticking. The trader's own reconnect logic does not notice, because the sockets are
 * still open.
 *
 * What it does: it watches every WebSocket the page opens to api.derivws.com and remembers when the last tick message
 * arrived. If ticks were flowing and then stop for STALL_MS while the tab is visible:
 *   1. it closes the trader's main socket, which makes the app's own reconnect logic start over (new sign-in socket,
 *      new subscriptions);
 *   2. if ticks have not come back after SOFT_WAIT_MS, it reloads the trader frame once (never more than once a minute).
 * It only arms after the first tick of a page load, so a closed market (no ticks at all) never triggers it more than once.
 *
 * It does not change or hide any message; it only listens. scripts/manual-trader/patch-built-output.js inlines this file
 * into the built index.html before any other script. It has no dependencies.
 */
(function (win) {
    'use strict';

    var NativeWebSocket = win.WebSocket;
    if (!NativeWebSocket || win.__manualTraderTickWatchdog) return;

    var STALL_MS = 8000;
    var SOFT_WAIT_MS = 10000;
    var RELOAD_GAP_MS = 60000;
    var RELOAD_KEY = 'manual_trader_tick_watchdog_reload';
    var TICK = /"msg_type"\s*:\s*"tick"|"tick"\s*:\s*\{/;

    var state = { last_tick: 0, stage: 0, stage_at: 0, main: null };

    function log(message) {
        try {
            win.console.warn('[manual-trader watchdog] ' + message);
        } catch (e) {
            // no console
        }
    }

    function watch(socket, url) {
        if (url.indexOf('api.derivws.com') === -1) return;
        var isMain = /\/ws\/public(\?|$)/.test(url);
        if (isMain) state.main = socket;
        // Added through the native prototype, so it is not affected by the trader replacing addEventListener on the instance.
        NativeWebSocket.prototype.addEventListener.call(socket, 'message', function (event) {
            if (typeof event.data === 'string' && TICK.test(event.data)) {
                state.last_tick = Date.now();
                state.stage = 0;
            }
        });
        NativeWebSocket.prototype.addEventListener.call(socket, 'close', function () {
            if (state.main === socket) state.main = null;
        });
    }

    function WatchedWebSocket(url, protocols) {
        var socket = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
        try {
            watch(socket, String(url));
        } catch (e) {
            // never get in the way of the connection itself
        }
        return socket;
    }
    WatchedWebSocket.prototype = NativeWebSocket.prototype;
    // CONNECTING / OPEN / CLOSING / CLOSED are read-only on the native constructor, so they are inherited, not copied.
    Object.setPrototypeOf(WatchedWebSocket, NativeWebSocket);
    win.WebSocket = WatchedWebSocket;

    function reloadOnce(now) {
        try {
            var last = Number(win.sessionStorage.getItem(RELOAD_KEY) || 0);
            if (last && now - last < RELOAD_GAP_MS) return false;
            win.sessionStorage.setItem(RELOAD_KEY, String(now));
        } catch (e) {
            // storage unavailable: still allow a single reload per page load via the stage counter
        }
        win.location.reload();
        return true;
    }

    function check(now) {
        if (win.document && win.document.hidden) {
            // Background tabs are throttled and get no timely ticks; do not count that as a stall.
            if (state.last_tick) state.last_tick = now;
            return;
        }
        if (!state.last_tick) return;

        if (state.stage === 0) {
            if (now - state.last_tick > STALL_MS) {
                state.stage = 1;
                state.stage_at = now;
                log('no ticks for ' + Math.round((now - state.last_tick) / 1000) + 's; restarting the connection');
                var main = state.main;
                if (main && (main.readyState === NativeWebSocket.OPEN || main.readyState === NativeWebSocket.CONNECTING)) {
                    try {
                        main.close();
                    } catch (e) {
                        // already closing
                    }
                }
            }
        } else if (state.stage === 1) {
            if (now - state.stage_at > SOFT_WAIT_MS) {
                state.stage = 2;
                log('ticks did not resume; reloading the trader');
                if (!reloadOnce(now)) log('reload skipped (done less than a minute ago)');
            }
        }
    }

    win.__manualTraderTickWatchdog = { check: check, state: state, STALL_MS: STALL_MS, SOFT_WAIT_MS: SOFT_WAIT_MS };
    win.setInterval(function () {
        check(Date.now());
    }, 1000);
})(window);
