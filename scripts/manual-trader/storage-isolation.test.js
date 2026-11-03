// Run with: node scripts/manual-trader/storage-isolation.test.js
// Loads storage-isolation.js against a fake window and checks the prefixing rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const makeStorage = () => {
    const data = new Map();
    return {
        get length() {
            return data.size;
        },
        key: i => Array.from(data.keys())[i] ?? null,
        getItem: k => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => void data.set(k, String(v)),
        removeItem: k => void data.delete(k),
        clear: () => data.clear(),
        raw: data,
    };
};

const run = () => {
    const win = { localStorage: makeStorage(), sessionStorage: makeStorage() };
    const real = win.localStorage;
    const realSession = win.sessionStorage;
    // Sentinel's own values, written before the trader starts.
    real.setItem('active_loginid', 'ROT91139228');
    real.setItem('client.accounts', '{"sentinel":true}');
    real.setItem('deriv_oauth_session', '{"access_token":"t"}');
    real.setItem('deriv_oauth_accounts_raw', '{"data":[]}');
    real.setItem('deriv_oauth_app_id', 'app1');
    realSession.setItem('oauth_site_id', 'apex-sentinel');

    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'storage-isolation.js'), 'utf8'), { window: win, Proxy, Object });
    return { win, real, realSession };
};

const { win, real, realSession } = run();
const ls = win.localStorage;

// The trader cannot see or change Sentinel's keys.
assert.equal(ls.getItem('active_loginid'), null);
assert.equal(ls.getItem('client.accounts'), null);
ls.setItem('active_loginid', 'VRTC92307170');
assert.equal(ls.getItem('active_loginid'), 'VRTC92307170');
assert.equal(real.getItem('active_loginid'), 'ROT91139228', "Sentinel's active account must not change");
assert.equal(real.getItem('mt:active_loginid'), 'VRTC92307170');

// The hand-off keys are shared both ways.
assert.equal(ls.getItem('deriv_oauth_session'), '{"access_token":"t"}');
assert.equal(ls.getItem('deriv_oauth_app_id'), 'app1');
ls.removeItem('deriv_oauth_session');
assert.equal(real.getItem('deriv_oauth_session'), null);
real.setItem('deriv_oauth_session', '{"access_token":"t2"}');
assert.equal(ls.getItem('deriv_oauth_session'), '{"access_token":"t2"}');

// Property access, in, delete, enumeration, length, key().
ls.theme = 'dark';
assert.equal(real.getItem('mt:theme'), 'dark');
assert.equal(ls.theme, 'dark');
assert.equal('theme' in ls, true);
assert.equal('client.accounts' in ls, false);
assert.equal(ls.missing, undefined);
delete ls.theme;
assert.equal(real.getItem('mt:theme'), null);
ls.setItem('a', 1);
assert.deepEqual(Object.keys(ls).sort(), ['a', 'active_loginid', 'deriv_oauth_accounts_raw', 'deriv_oauth_app_id', 'deriv_oauth_session']);
assert.equal(ls.length, 5);
assert.equal(ls.key(99), null);
assert.equal(typeof ls.key(0), 'string');

// clear() removes only the trader's own keys and the shared ones it sees, never Sentinel's.
ls.clear();
assert.equal(real.getItem('active_loginid'), 'ROT91139228');
assert.equal(real.getItem('client.accounts'), '{"sentinel":true}');
assert.equal(real.getItem('mt:active_loginid'), null);

// sessionStorage gets the same treatment.
assert.equal(win.sessionStorage.getItem('oauth_site_id'), null);
win.sessionStorage.setItem('oauth_site_id', 'x');
assert.equal(realSession.getItem('oauth_site_id'), 'apex-sentinel');

console.log('storage-isolation: all checks passed');
