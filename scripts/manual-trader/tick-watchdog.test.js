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
    const panel = { html: null }; // null: no Last Digit panel on screen
    const handlers = {};
    const win = {
        WebSocket: FakeWebSocket,
        document: { hidden: false, querySelector: () => (panel.html === null ? null : { innerHTML: panel.html }) },
        addEventListener: (type, fn) => void (handlers[type] = fn),
        console: { warn: () => {} },
        sessionStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => void store.set(k, String(v)),
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

// Ticks arrive, the digit panel does not change: restart once, then reload once.
{
    const { win, panel, dog } = setup();
    const main = new win.WebSocket(main_url);
    const own = new win.WebSocket(own_url);
    panel.html = '<i>7</i>';
    own.emit(tick);
    const t0 = Date.now();
    dog.check(t0); // baseline
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
    panel.html = '<i>7</i>';
    main.emit(tick);
    const t0 = Date.now();
    dog.check(t0);
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
