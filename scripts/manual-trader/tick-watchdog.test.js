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
    const win = {
        WebSocket: FakeWebSocket,
        document: { hidden: false },
        console: { warn: () => {} },
        sessionStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => void store.set(k, String(v)),
        },
        location: { reloads: 0, reload() { this.reloads += 1; } },
        setInterval: () => 0,
    };
    vm.runInNewContext(source, { window: win, Object, Date, Number, String, RegExp });
    return { win, sockets, store, dog: win.__manualTraderTickWatchdog };
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

console.log('tick-watchdog: all checks passed');
