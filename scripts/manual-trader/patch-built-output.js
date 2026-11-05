#!/usr/bin/env node
/**
 * Post-build patches for the embedded Manual Trader (Deriv's DTrader build, vmainamc-hub/db-traders-).
 * Used by scripts/build-manual-trader.sh after the build, and safe to run by hand on an installed folder:
 *
 *   node scripts/manual-trader/patch-built-output.js public/br_manual-trader
 *
 * Every patch is idempotent (running it twice changes nothing) and fails loudly when its anchor is not found, so a
 * changed source never ends up half-patched.
 *
 * 1. Route: the source maps BOTH `trade` and `bot` to '/', and the bot app is listed first, so '/' opened the Bot Builder
 *    shell, not the trade screen. The bot app then asked for its own files under /bot/..., which this site does not serve,
 *    and the page stayed on its loading dots. The bot route moves to '/bot' so '/' is the DTrader screen.
 * 2. Public path: the trader, reports and bot packages were built with publicPath "/", so once the trader screen opened
 *    it asked for its own files at /trader/js/..., /trader/css/... (404 on this site) and the loading dots never went
 *    away. Their entry files now point at the folder the build is served from.
 * 3. Keep the folder in the address: after sign-in the trader rewrites the page address to "/" (history.replaceState), which
 *    drops /br_manual-trader/. Its own helper then builds file addresses (icon sprites, the chart adapter) from the bare
 *    address and they 404, and a reload of the frame would open this site's own root. An inline script puts the folder back
 *    on any address the trader sets.
 * 4. Embedded look: inside Sentinel's frame the trader's own top bar (Reports link, notifications, profile and account
 *    switcher) is hidden. Sentinel's header is the one place the account is shown and switched; the trader is opened on
 *    that account (see manual-trader-session.ts) and reloaded when it changes. The same style block also fixes the trade
 *    area layout (full width, no clipping) so the trade form shows at the right of the chart.
 */
const fs = require('node:fs');
const path = require('node:path');

const folder = path.resolve(process.argv[2] || 'public/br_manual-trader');
const jsDir = path.join(folder, 'js');
const indexHtml = path.join(folder, 'index.html');

const fail = message => {
    console.error(`patch-built-output: ${message}`);
    process.exit(1);
};

if (!fs.existsSync(indexHtml) || !fs.existsSync(jsDir)) fail(`${folder} does not look like the trader build.`);

// ---- 1. route -------------------------------------------------------------------------------------------------------
const ROUTE_BEFORE = "trade: '/',\\n  bot: '/',";
const ROUTE_AFTER = "trade: '/',\\n  bot: '/bot',";
const chunks = fs.readdirSync(jsDir).filter(name => name.endsWith('.js'));
let routeDone = 0;
let routeAlready = 0;
for (const name of chunks) {
    const file = path.join(jsDir, name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(ROUTE_AFTER)) routeAlready += 1;
    const count = text.split(ROUTE_BEFORE).length - 1;
    if (count === 0) continue;
    if (count !== 1) fail(`route anchor found ${count} times in ${name}; expected exactly 1.`);
    fs.writeFileSync(file, text.replace(ROUTE_BEFORE, ROUTE_AFTER));
    routeDone += 1;
    console.log(`route: bot -> '/bot' in js/${name}`);
}
if (routeDone === 0 && routeAlready === 0) fail("route anchor (trade: '/', bot: '/') not found in any chunk; the source changed, review the patch.");
if (routeDone === 0) console.log('route: already patched');

// ---- 2. public path -------------------------------------------------------------------------------------------------
const base = `/${path.basename(folder)}/`;
const PATH_BEFORE = '__webpack_require__.p = "/";';
const PATH_AFTER = `__webpack_require__.p = "${base}";`;
const entries = ['trader/js/trader.js', 'reports/js/reports.js', 'bot/js/bot-web-ui.main.js'];

// The core app embeds each package's entry inside its own chunk (core.trader.*.js, core.reports.*.js, ...), as an escaped string
// with a renamed require function, and it is THAT copy that loads the package's files at run time.
const NESTED = /(__nested_webpack_require_\d+__\.p = \\")\/(\\";)/g;
let nestedDone = 0;
let nestedChunks = 0;
for (const name of chunks) {
    const file = path.join(jsDir, name);
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.match(NESTED);
    if (!matches) continue;
    nestedChunks += 1;
    nestedDone += matches.length;
    fs.writeFileSync(file, text.replace(NESTED, `$1${base}$2`));
    console.log(`public path: ${matches.length} embedded entry in js/${name} -> ${base}`);
}
if (nestedDone === 0 && !chunks.some(name => name.includes('trader') && fs.readFileSync(path.join(jsDir, name), 'utf8').includes(`.p = \\"${base}\\"`))) {
    fail('no embedded package entry with publicPath "/" found in any core chunk; the source changed, review the patch.');
}
for (const entry of entries) {
    const file = path.join(folder, entry);
    if (!fs.existsSync(file)) {
        console.log(`public path: ${entry} not present, skipped`);
        continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(PATH_AFTER) && !text.includes(PATH_BEFORE)) {
        console.log(`public path: ${entry} already patched`);
        continue;
    }
    const count = text.split(PATH_BEFORE).length - 1;
    if (count !== 1) fail(`public path anchor found ${count} times in ${entry}; expected exactly 1.`);
    fs.writeFileSync(file, text.replace(PATH_BEFORE, PATH_AFTER));
    console.log(`public path: ${entry} -> ${base}`);
}

// ---- 3. keep the folder in the address -------------------------------------------------------------------------------
const KEEP_ID = 'manual-trader-keep-base';
const keepBaseScript = [
    `<script id="${KEEP_ID}">`,
    '(function () {',
    `    var BASE = ${JSON.stringify(base)};`,
    "    var folder = BASE.slice(0, -1);",
    "    ['replaceState', 'pushState'].forEach(function (name) {",
    '        var original = window.history[name];',
    '        window.history[name] = function (state, title, url) {',
    "            if (typeof url === 'string' && url.charAt(0) === '/' && url.charAt(1) !== '/' && url.indexOf(BASE) !== 0 && url !== folder) {",
    '                url = folder + url;',
    '            }',
    '            return original.call(this, state, title, url);',
    '        };',
    '    });',
    '})();',
    '</script>',
    '',
].join('\n');

// ---- 4. embedded look -----------------------------------------------------------------------------------------------
const STYLE_ID = 'manual-trader-embed-header';
{
    const current = fs.readFileSync(indexHtml, 'utf8');
    if (current.includes(KEEP_ID)) {
        console.log('keep base path: already patched');
    } else {
        const marker = '</head>';
        const count = current.split(marker).length - 1;
        if (count !== 1) fail(`expected exactly one </head> in index.html but found ${count}.`);
        fs.writeFileSync(indexHtml, current.replace(marker, keepBaseScript + marker));
        console.log('keep base path: installed');
    }
}
const html = fs.readFileSync(indexHtml, 'utf8');
{
    const style = [
        `<style id="${STYLE_ID}">`,
        '/* Sentinel shows the account; the trader must not show a second one. */',
        'header.header { display: none !important; }',
        '/* The trade area is absolutely positioned inside a zero-height scroll box, so it was clipped (right-hand form invisible)',
        '   and shrink-wrapped to 256px (form hidden behind the fixed chart). Give it the full width and stop the clipping. */',
        '#trade_container { width: 100% !important; }',
        '#app_contents .dc-themed-scrollbars { overflow: visible !important; }',
        '</style>',
        '',
    ].join('\n');
    const existing = new RegExp(`<style id="${STYLE_ID}">[\\s\\S]*?</style>\\n?`);
    if (existing.test(html)) {
        fs.writeFileSync(indexHtml, html.replace(existing, () => style));
        console.log('embedded look: header hidden, trade area layout fixed');
    } else {
        const marker = '</head>';
        const count = html.split(marker).length - 1;
        if (count !== 1) fail(`expected exactly one </head> in index.html but found ${count}.`);
        fs.writeFileSync(indexHtml, html.replace(marker, () => style + marker));
        console.log('embedded look: installed');
    }
}

// ---- 5. drop inline source maps ---------------------------------------------------------------------------------------
// The build is a development build with a source map inlined after every module (about a third of the folder). It only feeds
// browser dev tools; parsing it slows the first load and can run small devices out of memory. Removing it changes no behaviour.
{
    const INLINE_SOURCE_MAP = /\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,[A-Za-z0-9+/=]+/g;
    const walk = dir =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory() ? walk(full) : [full];
        });
    let dropped = 0;
    let files = 0;
    for (const file of walk(folder).filter(name => name.endsWith('.js'))) {
        const text = fs.readFileSync(file, 'utf8');
        let found = 0;
        const next = text.replace(INLINE_SOURCE_MAP, () => {
            found += 1;
            return '';
        });
        if (found > 0) {
            fs.writeFileSync(file, next);
            dropped += found;
            files += 1;
        }
    }
    console.log(dropped ? `source maps: dropped ${dropped} inline map(s) from ${files} file(s)` : 'source maps: none left');
}
