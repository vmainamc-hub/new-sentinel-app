// Run with: node scripts/manual-trader/soft-server-error-patch.test.js
// Applies the patch to a copy of the installed adapter file, then runs the patched handleIncoming against fake replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyToFile, findFile, MARKER } = require('./soft-server-error-patch.js');

const installed = path.join(__dirname, '..', '..', 'public', 'br_manual-trader', 'js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-soft-'));
const copy = path.join(tmp, path.basename(findFile(installed)));
fs.copyFileSync(findFile(installed), copy);

const first = applyToFile(copy);
assert.ok(['patched', 'already patched'].includes(first));
assert.equal(applyToFile(copy), 'already patched'); // idempotent
const source = fs.readFileSync(copy, 'utf8');
assert.equal(source.split(MARKER).length - 1, 1);

// pull the patched handler out of the escaped string and run it
const start = source.indexOf('var handleIncoming = function handleIncoming(raw, from_authorized) {');
const end = source.indexOf('\\n  nativeAdd(', start);
assert.ok(start > 0 && end > start);
const body = source.slice(start, end).replace(/\\n/g, '\n').replace(/\\'/g, "'");
const run = reply => {
    const emitted = [];
    const reports = [];
    const fn = new Function(
        'parse', 'report', 'emit', 'toLegacyResponse', 'active_loginid', '_login_oauth_accounts__WEBPACK_IMPORTED_MODULE_0__',
        `${body}\n return handleIncoming;`
    )(
        t => (typeof t === 'string' ? JSON.parse(t) : null),
        d => reports.push(d),
        p => emitted.push(p),
        r => r,
        'DOT1',
        { realToAlias: t => t }
    );
    fn(JSON.stringify(reply), false);
    return { emitted: emitted[0], reports };
};

for (const code of ['InternalServerError', 'OutputValidationFailed']) {
    const { emitted, reports } = run({ msg_type: 'proposal', error: { code, message: 'internal server error' } });
    assert.equal(emitted.error.code, 'ServerTemporarilyUnavailable');
    assert.equal(emitted.error.original_code, code);
    assert.equal(emitted.error.message, 'internal server error'); // message still reaches the part that asked
    assert.equal(reports[0].error.code, 'ServerTemporarilyUnavailable');
}
// other errors and normal replies are untouched
assert.equal(run({ msg_type: 'proposal', error: { code: 'InvalidToken', message: 'x' } }).emitted.error.code, 'InvalidToken');
assert.equal(run({ msg_type: 'tick', tick: { quote: 1 } }).emitted.tick.quote, 1);
console.log('soft-server-error-patch: ok');
