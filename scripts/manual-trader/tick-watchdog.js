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
 *
 * Second failure mode: ticks keep arriving (from some stream) but the screen no longer follows them, e.g. the chart's own
 * stream was forgotten at settlement while another stream is still alive. The check above never fires then, because a tick is
 * a tick. So it also watches the Last Digit panel (.digits__container), which re-renders on every tick: if ticks keep coming
 * (RENDER_TICKS of them over RENDER_STALL_MS) and the panel's markup has not changed, it takes the same two steps (restart the
 * connection, then reload the frame once).
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
    var RENDER_STALL_MS = 8000;
    var RENDER_TICKS = 6;
    var RENDER_SELECTOR = '.digits__container';
    var LOG_KEEP = 14;
    var RELOAD_KEY = 'manual_trader_tick_watchdog_reload';
    var TICK = /"msg_type"\s*:\s*"tick"|"tick"\s*:\s*\{/;

    var state = { last_tick: 0, stage: 0, stage_at: 0, main: null, ticks: 0, sockets: [] };
    // Render watch: what the Last Digit panel looked like, when it last changed, and how many ticks came in since.
    var render = { sig: null, at: 0, ticks: 0, stage: 0, stage_at: 0, restarts: 0 };
    var events = [];

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
        state.sockets.push({ socket: socket, name: isMain ? 'public' : 'account' });
        if (state.sockets.length > 6) state.sockets.shift();
        // Added through the native prototype, so it is not affected by the trader replacing addEventListener on the instance.
        NativeWebSocket.prototype.addEventListener.call(socket, 'message', function (event) {
            if (typeof event.data === 'string' && TICK.test(event.data)) {
                state.last_tick = Date.now();
                state.ticks += 1;
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

    function restartConnection() {
        var main = state.main;
        if (main && (main.readyState === NativeWebSocket.OPEN || main.readyState === NativeWebSocket.CONNECTING)) {
            try {
                main.close();
            } catch (e) {
                // already closing
            }
        }
    }

    // The markup of the Last Digit panel, or null when it is not on screen (other trade types, still loading).
    function renderSignature() {
        try {
            var doc = win.document;
            if (!doc || typeof doc.querySelector !== 'function') return null;
            var node = doc.querySelector(RENDER_SELECTOR);
            return node ? String(node.innerHTML) : null;
        } catch (e) {
            return null;
        }
    }

    function checkRender(now) {
        var sig = renderSignature();
        if (sig === null || state.stage !== 0) {
            // Nothing to compare, or the plain tick stall above is already being handled.
            render.sig = null;
            render.stage = 0;
            return;
        }
        if (sig !== render.sig) {
            render.sig = sig;
            render.at = now;
            render.ticks = state.ticks;
            render.stage = 0;
            return;
        }
        if (render.stage === 0) {
            if (now - render.at > RENDER_STALL_MS && state.ticks - render.ticks >= RENDER_TICKS) {
                render.stage = 1;
                render.stage_at = now;
                render.restarts += 1;
                log(
                    state.ticks - render.ticks + ' ticks in ' + Math.round((now - render.at) / 1000) +
                        's but the screen did not change; restarting the connection'
                );
                restartConnection();
            }
        } else if (render.stage === 1) {
            if (now - render.stage_at > SOFT_WAIT_MS) {
                render.stage = 2;
                log('screen still frozen after the restart; reloading the trader');
                if (!reloadOnce(now)) log('reload skipped (done less than a minute ago)');
            }
        }
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
                restartConnection();
            }
        } else if (state.stage === 1) {
            if (now - state.stage_at > SOFT_WAIT_MS) {
                state.stage = 2;
                log('ticks did not resume; reloading the trader');
                if (!reloadOnce(now)) log('reload skipped (done less than a minute ago)');
            }
        }
        checkRender(now);
    }

    // The app reports every socket message it sends and receives as a 'deriv-socket-log' event; keep the last few (ticks are left out) so the readout can show what happened right before a freeze.
    function recordEvents() {
        if (typeof win.addEventListener !== 'function') return;
        win.addEventListener('deriv-socket-log', function (event) {
            var d = (event && event.detail) || {};
            if (d.type === 'tick') return;
            var text = (d.dir === 'out' ? '>' : '<') + ' ' + d.type + (d.error ? ' !' + (d.error.code || 'error') : '');
            events.push(text);
            if (events.length > LOG_KEEP) events.shift();
        });
    }

    // Optional on-screen readout (open the site with ?mt_debug=1). It tells "ticks stopped arriving" (age keeps growing)
    // apart from "ticks arrive but the chart does not move" (age stays near one second while the screen is frozen).
    function showReadout() {
        var doc = win.document;
        if (!doc || !doc.createElement || !win.location || !/[?&]mt_debug=1(&|$)/.test(String(win.location.search || ''))) return;
        var box = null;
        win.setInterval(function () {
            if (!box) {
                if (!doc.body) return;
                box = doc.createElement('div');
                box.style.cssText =
                    'position:fixed;left:4px;bottom:4px;z-index:2147483647;background:rgba(0,0,0,.75);color:#9f9;' +
                    'font:11px/1.3 monospace;padding:3px 6px;border-radius:4px;pointer-events:none;white-space:pre';
                doc.body.appendChild(box);
            }
            var age = state.last_tick ? ((Date.now() - state.last_tick) / 1000).toFixed(1) + 's' : 'none yet';
            var parts = state.sockets.map(function (item) {
                return item.name + ':' + ['connecting', 'open', 'closing', 'closed'][item.socket.readyState];
            });
            var shown = render.sig === null ? 'no digit panel' : 'panel changed ' + ((Date.now() - render.at) / 1000).toFixed(0) + 's ago';
            box.textContent =
                'ticks ' + state.ticks + ' | last ' + age + ' ago | stage ' + state.stage + '/' + render.stage +
                ' | ' + shown + ' | restarts ' + render.restarts + '\n' + parts.join('  ') +
                '\nlast calls: ' + events.join(' | ');
        }, 500);
    }

    win.__manualTraderTickWatchdog = {
        check: check,
        state: state,
        render: render,
        events: events,
        STALL_MS: STALL_MS,
        SOFT_WAIT_MS: SOFT_WAIT_MS,
        RENDER_STALL_MS: RENDER_STALL_MS,
        RENDER_TICKS: RENDER_TICKS,
    };
    recordEvents();
    win.setInterval(function () {
        check(Date.now());
    }, 1000);
    showReadout();
})(window);
