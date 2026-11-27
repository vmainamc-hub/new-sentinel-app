// Run with: node scripts/manual-trader/tick-watchdog.test.js
// Loads tick-watchdog.js against a fake window and WebSocket and checks when it acts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'tick-watchdog.js'), 'utf8');

const setup = () => {
    const sockets = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = FakeWebSocket.OPEN;
            this.listeners = { message: [], close: [] };
            this.closed = 0;
            sockets.push(this);
        }
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        }
        close() {
            this.closed += 1;
            this.readyState = FakeWebSocket.CLOSED;
            (this.listeners.close || []).forEach(fn => fn({}));
        }
        emit(data) {
            this.listeners.message.forEach(fn => fn({ data }));
        }
    }
    FakeWebSocket.CONNECTING = 0;
    FakeWebSocket.OPEN = 1;
    FakeWebSocket.CLOSING = 2;
    FakeWebSocket.CLOSED = 3;

    const store = new Map();
    // html null: no Last Digit panel on screen. rect: optional box returned by getBoundingClientRect (omitted: no such method).
    const panel = { html: null, rect: null };
    const handlers = {};
    const win = {
        WebSocket: FakeWebSocket,
        innerWidth: 400,
        document: {
            hidden: false,
            querySelector: () => {
                if (panel.html === null) return null;
                const node = { innerHTML: panel.html };
                if (panel.rect) node.getBoundingClientRect = () => panel.rect;
                return node;
            },
        },
        addEventListener: (type, fn) => void (handlers[type] = fn),
        console: { warn: () => {} },
        sessionStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => {
                if (store.failWrites) throw new Error('storage is full');
                store.set(k, String(v));
            },
        },
        location: { reloads: 0, reload() { this.reloads += 1; } },
        setInterval: () => 0,
    };
    vm.runInNewContext(source, { window: win, Object, Date, Number, String, RegExp });
    return { win, sockets, store, panel, handlers, dog: win.__manualTraderTickWatchdog };
};

const tick = '{"msg_type":"tick","tick":{"symbol":"1HZ100V","quote":1332.35}}';
const main_url = 'wss://api.derivws.com/trading/v1/options/ws/public';
const own_url = 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc';

// Sockets keep working and instanceof still holds.
{
    const { win } = setup();
    const socket = new win.WebSocket(main_url);
    assert.ok(socket instanceof win.WebSocket);
    assert.equal(win.WebSocket.OPEN, 1);
}

// Does nothing before the first tick, and while ticks keep coming.
{
    const { win, sockets, dog } = setup();
    const main = new win.WebSocket(main_url);
    dog.check(1_000_000);
    assert.equal(main.closed, 0);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    dog.check(t0 + 5000);
    assert.equal(main.closed, 0);
    assert.equal(dog.state.stage, 0);
    assert.equal(sockets.length, 1);
}

// A stall closes the main socket once, then reloads once if ticks do not come back.
{
    const { win, dog } = setup();
    const main = new win.WebSocket(main_url);
    const own = new win.WebSocket(own_url);
    own.emit(tick);
    const t0 = dog.state.last_tick;
    dog.check(t0 + 9000);
    assert.equal(main.closed, 1, 'main socket closed to restart the connection');
    assert.equal(own.closed, 0, 'the sign-in socket is left to the app');
    dog.check(t0 + 12000);
    assert.equal(main.closed, 1, 'only once');
    assert.equal(win.location.reloads, 0);
    dog.check(t0 + 9000 + 10001);
    assert.equal(win.location.reloads, 1);
    dog.check(t0 + 60000);
    assert.equal(win.location.reloads, 1, 'never a second reload for the same stall');
}

// Ticks that come back after the restart cancel the reload.
{
    const { win, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    dog.check(t0 + 9000);
    assert.equal(dog.state.stage, 1);
    const next = new win.WebSocket(main_url);
    next.emit(tick);
    assert.equal(dog.state.stage, 0);
    dog.check(Date.now() + 100);
    assert.equal(win.location.reloads, 0);
}

// A reload done less than a minute ago is not repeated.
{
    const { win, store, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    store.set('manual_trader_tick_watchdog_reload', String(t0 + 5000));
    dog.check(t0 + 9000);
    dog.check(t0 + 20000);
    assert.equal(win.location.reloads, 0);
}

// A hidden tab never counts as a stall.
{
    const { win, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    win.document.hidden = true;
    dog.check(t0 + 60000);
    win.document.hidden = false;
    dog.check(t0 + 62000);
    assert.equal(main.closed, 0);
    assert.equal(dog.state.stage, 0);
}

// Other websites are not watched.
{
    const { win, dog } = setup();
    const other = new win.WebSocket('wss://example.com/socket');
    other.emit(tick);
    assert.equal(dog.state.last_tick, 0);
}

// ---- frozen screen while ticks keep arriving ---------------------------------------------------------------------------

const feed = (socket, count) => {
    for (let i = 0; i < count; i += 1) socket.emit(tick);
};

// A panel that was updating and then stops while ticks keep arriving: restart once, then reload once.
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    const own = new win.WebSocket(own_url);
    panel.html = '<i>6</i>';
    own.emit(tick);
    const base = Date.now();
    dog.check(base); // baseline
    panel.html = '<i>7</i>';
    dog.check(base + 500); // it changed once, so it is known to follow the market
    assert.equal(dog.render.live, true);
    const t0 = base + 500; // time of the last change
    feed(own, 7);
    dog.check(t0 + 4000);
    assert.equal(main.closed, 0, 'not yet: stalled for less than RENDER_STALL_MS');
    dog.state.last_tick = t0 + 8400; // ticks are still flowing, so the plain tick check stays quiet
    dog.check(t0 + 8500);
    assert.equal(main.closed, 1, 'connection restarted');
    assert.equal(dog.render.stage, 1);
    dog.state.last_tick = t0 + 11900;
    dog.check(t0 + 12000);
    assert.equal(main.closed, 1, 'only once');
    assert.equal(win.location.reloads, 0);
    dog.state.last_tick = t0 + 18400;
    dog.check(t0 + 8500 + 10001);
    assert.equal(win.location.reloads, 1, 'reloaded when the restart did not help');
    dog.state.last_tick = t0 + 59900;
    dog.check(t0 + 60000);
    assert.equal(win.location.reloads, 1);
}

// The panel updates again after the restart: no reload.
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    panel.html = '<i>6</i>';
    main.emit(tick);
    const base = Date.now();
    dog.check(base);
    panel.html = '<i>7</i>';
    dog.check(base + 500);
    const t0 = base + 500;
    feed(main, 8);
    dog.state.last_tick = t0 + 8400;
    dog.check(t0 + 8500);
    assert.equal(dog.render.stage, 1);
    panel.html = '<i>3</i>';
    dog.state.last_tick = t0 + 9400;
    dog.check(t0 + 9500);
    assert.equal(dog.render.stage, 0);
    dog.state.last_tick = t0 + 29900;
    dog.check(t0 + 30000);
    assert.equal(win.location.reloads, 0);
}

// A panel that keeps changing never triggers anything.
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = Date.now();
    for (let i = 0; i < 30; i += 1) {
        panel.html = '<i>' + i + '</i>';
        main.emit(tick);
        dog.state.last_tick = t0 + i * 1000;
        dog.check(t0 + i * 1000);
    }
    assert.equal(main.closed, 0);
    assert.equal(dog.render.restarts, 0);
}

// No digit panel (other trade type), no ticks (closed market), or a hidden tab: never counted as frozen.
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = Date.now();
    feed(main, 20);
    dog.check(t0);
    dog.check(t0 + 6000);
    assert.equal(main.closed, 0, 'no panel on screen');

    panel.html = '<i>1</i>';
    dog.check(t0 + 7000); // baseline, no new ticks afterwards
    dog.state.last_tick = t0 + 7000;
    dog.check(t0 + 7000 + 7500);
    assert.equal(dog.render.restarts, 0, 'no ticks, so not a render freeze');

    feed(main, 10);
    win.document.hidden = true;
    dog.check(t0 + 60000);
    assert.equal(dog.render.restarts, 0, 'hidden tab');
}

// ---- bounds: it must never loop, and must not act on a panel that never worked ----------------------------------------------

const RELOAD_KEY = 'manual_trader_tick_watchdog_reload';

// A panel that is on screen but has never updated (nothing feeds it, e.g. no stats reach it on a phone): logged, never a restart
// or a reload. Restarting the connection cannot fix missing data and only wipes the chart again and again.
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    panel.html = '<i>0</i>';
    main.emit(tick);
    const t0 = Date.now();
    dog.check(t0);
    for (let s = 1; s <= 120; s += 1) {
        main.emit(tick);
        dog.state.last_tick = t0 + s * 1000;
        dog.check(t0 + s * 1000);
    }
    assert.equal(main.closed, 0, 'no restart');
    assert.equal(win.location.reloads, 0, 'no reload');
    assert.equal(dog.render.live, false);
    assert.equal(dog.render.silent, true, 'remembered as never updated');
}

// On a phone the digits and the chart are two pages side by side: a panel outside the frame, or one with no size, is not "frozen".
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    panel.html = '<i>6</i>';
    panel.rect = { left: 0, right: 400, width: 400, height: 80 };
    main.emit(tick);
    const base = Date.now();
    dog.check(base);
    panel.html = '<i>7</i>';
    dog.check(base + 500);
    assert.equal(dog.render.live, true, 'seen updating while on screen');

    panel.rect = { left: -400, right: 0, width: 400, height: 80 }; // swiped to the chart page
    feed(main, 20);
    for (let s = 1; s <= 40; s += 1) {
        dog.state.last_tick = base + s * 1000;
        dog.check(base + 500 + s * 1000);
    }
    assert.equal(main.closed, 0, 'off screen: no restart');
    assert.equal(dog.render.restarts, 0);
    assert.equal(dog.render.offscreen, true);

    panel.rect = { left: 0, right: 0, width: 0, height: 0 }; // no size
    for (let s = 41; s <= 80; s += 1) {
        dog.state.last_tick = base + s * 1000;
        dog.check(base + 500 + s * 1000);
    }
    assert.equal(main.closed, 0, 'no size: no restart');

    // Back in view with the same markup: it is only a new baseline, and it must be seen updating again before it can count.
    panel.rect = { left: 0, right: 400, width: 400, height: 80 };
    feed(main, 20);
    for (let s = 81; s <= 120; s += 1) {
        dog.state.last_tick = base + s * 1000;
        dog.check(base + 500 + s * 1000);
    }
    assert.equal(dog.render.live, false);
    assert.equal(main.closed, 0, 'back in view but not proven live: no restart');
}

// The restart budget: repeated stalls restart the connection only MAX_RESTARTS times per window, then the page is left alone;
// once the window has passed it may act again.
{
    const { win, dog } = setup();
    let T = Date.now();
    const closes = [];
    for (let i = 0; i < 6; i += 1) {
        const main = new win.WebSocket(main_url);
        main.emit(tick); // ticks are flowing again after the previous stall
        dog.state.last_tick = T;
        dog.check(T + 9000); // and stall again
        closes.push(main.closed);
        T += 30000;
    }
    assert.deepEqual(closes, [1, 1, 1, 0, 0, 0]);
    assert.equal(dog.restartCount(), 3);
    assert.equal(win.location.reloads, 0);
    T += dog.RESTART_WINDOW_MS;
    const later = new win.WebSocket(main_url);
    later.emit(tick);
    dog.state.last_tick = T;
    dog.check(T + 9000);
    assert.equal(later.closed, 1, 'allowed again after the window');
}

// The same budget covers a frozen panel: a live panel that freezes again and again is restarted MAX_RESTARTS times, not forever.
{
    const { win, panel, dog } = setup();
    let T = Date.now();
    let restarts = 0;
    for (let i = 0; i < 6; i += 1) {
        const main = new win.WebSocket(main_url);
        panel.html = '<i>a' + i + '</i>';
        main.emit(tick);
        dog.check(T); // baseline (the panel changed since the last round)
        panel.html = '<i>b' + i + '</i>';
        dog.check(T + 500); // live
        feed(main, 8);
        dog.state.last_tick = T + 8400;
        dog.check(T + 8600); // frozen for more than RENDER_STALL_MS
        restarts += main.closed;
        T += 30000;
    }
    assert.equal(restarts, 3, 'three restarts, then it stops');
    assert.equal(win.location.reloads, 0);
}

// Frame reloads are capped over time and the count survives the reload itself (it lives in sessionStorage): one more is allowed
// after one earlier reload, but not after two within the window.
{
    const { win, store, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    store.set(RELOAD_KEY, String(t0 - 120000));
    dog.check(t0 + 9000);
    dog.check(t0 + 9000 + 10001);
    assert.equal(win.location.reloads, 1);
    assert.equal(store.get(RELOAD_KEY).split(',').length, 2, 'both reloads are remembered');
}
{
    const { win, store, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    store.set(RELOAD_KEY, t0 - 300000 + ',' + (t0 - 120000));
    dog.check(t0 + 9000);
    dog.check(t0 + 9000 + 10001);
    assert.equal(win.location.reloads, 0, 'two reloads inside the window is the limit');
}
{
    const { win, store, dog } = setup();
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    store.set(RELOAD_KEY, 'junk,' + (t0 - dog.RELOAD_WINDOW_MS - 1000) + ',' + (t0 - dog.RELOAD_WINDOW_MS - 2000));
    dog.check(t0 + 9000);
    dog.check(t0 + 9000 + 10001);
    assert.equal(win.location.reloads, 1, 'reloads older than the window, and unreadable values, are forgotten');
}

// If the reload cannot be counted (storage not writable) it is not done at all.
{
    const { win, store, dog } = setup();
    store.failWrites = true;
    const main = new win.WebSocket(main_url);
    main.emit(tick);
    const t0 = dog.state.last_tick;
    dog.check(t0 + 9000);
    dog.check(t0 + 9000 + 10001);
    assert.equal(main.closed, 1, 'the restart still happens');
    assert.equal(win.location.reloads, 0, 'but no uncounted reload');
}

// The app's own call log is kept, ticks left out, and trimmed.
{
    const { handlers, dog } = setup();
    handlers['deriv-socket-log']({ detail: { dir: 'out', type: 'forget_all' } });
    handlers['deriv-socket-log']({ detail: { dir: 'in', type: 'tick' } });
    handlers['deriv-socket-log']({ detail: { dir: 'in', type: 'forget_all', error: { code: 'X' } } });
    assert.deepEqual(Array.from(dog.events), ['> forget_all', '< forget_all !X']);
    for (let i = 0; i < 40; i += 1) handlers['deriv-socket-log']({ detail: { dir: 'out', type: 'proposal' } });
    assert.ok(dog.events.length <= 14);
}

console.log('tick-watchdog: all checks passed');
