#!/usr/bin/env node
// Keeps a temporary Deriv server error from replacing the whole Manual Trader screen.
//
// The trader's socket-general.js shows a full-screen "Sorry for the interruption" box (with the server's message, e.g.
// "internal server error") whenever ANY reply carries error code InternalServerError or OutputValidationFailed. On the new Deriv
// API a one-off error on a single request is not fatal, but it ended the user's session in the middle of an analysis.
// The socket adapter (deriv-socket) now gives such an error a different code, so the global handler ignores it and only the part
// of the screen that made the request sees the error (original code kept in `original_code`).
//
//   node scripts/manual-trader/soft-server-error-patch.js public/br_manual-trader/js/<core.main~n file>
// Also used by patch-built-output.js (step 10). Idempotent; fails loudly when its anchor is missing.
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '/* mt-soft-server-error */';
// The adapter lives in the built file as an escaped string: line breaks there are the two characters backslash + n.
const ANCHOR = 'parsed.balance.loginid = active_loginid;\\n      }\\n';
const INSERT =
    "      if (parsed.error && (parsed.error.code === 'InternalServerError' || parsed.error.code === 'OutputValidationFailed')) { " +
    "parsed.error = Object.assign({}, parsed.error, { code: 'ServerTemporarilyUnavailable', original_code: parsed.error.code }); } " +
    MARKER +
    '\\n';

const findFile = dir => {
    const hits = fs
        .readdirSync(dir)
        .filter(name => name.endsWith('.js'))
        .filter(name => {
            const text = fs.readFileSync(path.join(dir, name), 'utf8');
            return text.includes('handleIncoming') && (text.includes(ANCHOR) || text.includes(MARKER));
        });
    if (hits.length !== 1) throw new Error(`soft server error: expected one file with the adapter in ${dir}, found ${hits.length}.`);
    return path.join(dir, hits[0]);
};

const applyToFile = file => {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(MARKER)) return 'already patched';
    const count = text.split(ANCHOR).length - 1;
    if (count !== 1) throw new Error(`soft server error: anchor found ${count} times in ${path.basename(file)}; expected exactly 1.`);
    fs.writeFileSync(file, text.replace(ANCHOR, () => ANCHOR + INSERT));
    return 'patched';
};

module.exports = { applyToFile, findFile, MARKER, ANCHOR, INSERT };

if (require.main === module) {
    const target = process.argv[2];
    if (!target) {
        console.error('usage: node soft-server-error-patch.js <built core js file | js folder>');
        process.exit(1);
    }
    const file = fs.statSync(target).isDirectory() ? findFile(target) : target;
    console.log(`soft server error: ${applyToFile(file)} (${path.basename(file)})`);
}
