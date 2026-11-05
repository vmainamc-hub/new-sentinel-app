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
        '/* Only the outer box. The trade form (stake, payout, Buy buttons) has its own scroll box under #app_contents; making that',
        '   one visible as well cut off everything below the first options. */',
        '#app_contents > .dc-themed-scrollbars { overflow: visible !important; }',
        '/* With the top bar hidden, remove the gap it left above and below the trade area. */',
        '#deriv_app, #app_contents { margin-top: 0 !important; padding-top: 0 !important; }',
        '#app_contents { height: calc(100% - 36px) !important; }',
        '/* The trade area is the only scroller: the form (stake, payout, Over/Under or Even/Odd buttons) is taller than the frame and',
        '   is reached by scrolling it. Give it an explicit height so it always scrolls, and stop the page behind it scrolling. */',
        'html, body { overflow: hidden !important; }',
        '#trade_container { height: calc(100vh - 36px) !important; top: 0 !important; overflow-x: hidden !important; overflow-y: auto !important; }',
        '/* The chart is fixed under the (hidden) top bar; move it up to the top of the frame and size it to the free height. */',
        '.chart-container__wrapper { top: 2px !important; height: calc(100vh - 38px) !important; }',
        '/* "Go to Reports" sends the frame to the trader\'s own Reports page, which has no top bar and no way back. Sentinel has its own',
        '   reports, so the button is hidden. */',
        '#dt_positions_drawer_report_button { display: none !important; }',
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

// ---- 6. close the Recent positions drawer after a trade ------------------------------------------------------------------
// A purchase opens the drawer over the left of the chart and it stays open until the small "-" is pressed, so after a trade the
// screen looked stuck. Once every contract in it has closed, close it after a few seconds (the footer icon opens it again).
{
    const AUTO_ID = 'manual-trader-auto-close';
    const autoCloseScript = [
        `<script id="${AUTO_ID}">`,
        '(function () {',
        '    var closedSince = 0;',
        '    setInterval(function () {',
        "        var drawer = document.getElementById('dt_positions_drawer');",
        "        if (!drawer || drawer.className.indexOf('positions-drawer--open') === -1) { closedSince = 0; return; }",
        "        var text = drawer.innerText || '';",
        "        if (text.indexOf('Closed') === -1 || /Sell|Cancel|Running|Open/.test(text.replace('Recent positions', ''))) { closedSince = 0; return; }",
        '        if (!closedSince) closedSince = Date.now();',
        '        if (Date.now() - closedSince > 6000) {',
        "            var icon = document.getElementById('dt_positions_drawer_close_icon');",
        '            if (icon) icon.click();',
        '            closedSince = 0;',
        '        }',
        '    }, 1000);',
        '})();',
        '</script>',
        '',
    ].join('\n');
    const current = fs.readFileSync(indexHtml, 'utf8');
    const existing = new RegExp(`<script id="${AUTO_ID}">[\\s\\S]*?</script>\\n?`);
    if (existing.test(current)) {
        fs.writeFileSync(indexHtml, current.replace(existing, () => autoCloseScript));
        console.log('auto close drawer: updated');
    } else {
        const marker = '</head>';
        const count = current.split(marker).length - 1;
        if (count !== 1) fail(`expected exactly one </head> in index.html but found ${count}.`);
        fs.writeFileSync(indexHtml, current.replace(marker, () => autoCloseScript + marker));
        console.log('auto close drawer: installed');
    }
}

// ---- 7. tick watchdog -----------------------------------------------------------------------------------------------------
// After a trade settles the chart cursor and the last-digit circles can stop moving while the market keeps ticking, and the
// trader's own reconnect logic does not notice. scripts/manual-trader/tick-watchdog.js restarts the connection (and, if that
// does not help, reloads the frame once) when ticks stop. It is inlined first in <head> so it wraps WebSocket before any trader
// script runs. Tested by scripts/manual-trader/tick-watchdog.test.js.
{
    const WATCHDOG_ID = 'manual-trader-tick-watchdog';
    const watchdog = fs.readFileSync(path.join(__dirname, 'tick-watchdog.js'), 'utf8');
    if (watchdog.includes('</script')) fail('tick-watchdog.js must not contain </script>.');
    const block = `<script id="${WATCHDOG_ID}">\n${watchdog}\n</script>\n`;
    const current = fs.readFileSync(indexHtml, 'utf8');
    const existing = new RegExp(`<script id="${WATCHDOG_ID}">[\\s\\S]*?</script>\\n?`);
    if (existing.test(current)) {
        fs.writeFileSync(indexHtml, current.replace(existing, () => block));
        console.log('tick watchdog: updated');
    } else {
        const head = /<head[^>]*>/i.exec(current);
        if (!head) fail('no <head> tag in index.html; cannot install the tick watchdog.');
        const at = head.index + head[0].length;
        fs.writeFileSync(indexHtml, `${current.slice(0, at)}\n${block}${current.slice(at)}`);
        console.log('tick watchdog: installed');
    }
}

// ---- 8. last-digit pointer stuck on the finished contract's digit ---------------------------------------------------------------
// While a contract is on screen the Last Digit panel follows the CONTRACT's tick stream; it returns to the live tick only when
// isContractElapsed() says a live tick is 2 s past the contract's end. That needs getEndTime(), which relies on the legacy
// `is_expired` flag. If the new API does not send it, the panel never leaves contract mode: the pointer stays on the digit the
// contract ended on while the stats, chart and price keep moving.
//  a) the trader's Digits wrapper also treats a finished contract (won / lost / sold / is_sold) as elapsed once a live tick is
//     2 s past its best known end time (sell_time, exit_tick_time, exit_spot_time, date_expiry, else its last contract tick);
//  b) the socket adapter fills in `is_expired` (and exit_tick_time from exit_spot_time) for a won/lost contract when missing.
{
    const replaceOnce = (file, before, after, marker, what) => {
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(marker)) return console.log(`${what}: already patched`);
        const count = text.split(before).length - 1;
        if (count !== 1) fail(`${what}: anchor found ${count} times in ${path.basename(file)}; expected exactly 1. The source changed, review the patch.`);
        fs.writeFileSync(file, text.replace(before, () => after));
        console.log(`${what}: patched`);
    };
    const findChunk = (dir, needle) => {
        const hits = fs
            .readdirSync(dir)
            .filter(name => name.endsWith('.js'))
            .filter(name => fs.readFileSync(path.join(dir, name), 'utf8').includes(needle));
        if (hits.length !== 1) fail(`digit pointer: expected exactly one file containing the anchor in ${dir}, found ${hits.length}.`);
        return path.join(dir, hits[0]);
    };

    // a) the Digits wrapper (the module is stored as an escaped string, so the replacement must stay on one line with no double quotes)
    const ELAPSED_BEFORE =
        'var is_contract_elapsed = is_trade_page ? (0,_deriv_shared__WEBPACK_IMPORTED_MODULE_4__.isContractElapsed)(contract_info, tick) : false;';
    const finished =
        "(function (ci, t) { try { if (!ci || !t || !t.epoch) return false; var st = ci.status; " +
        "if (!(ci.is_sold || ci.is_expired || st === 'won' || st === 'lost' || st === 'sold')) return false; " +
        "var ts = ci.tick_stream; var last = ts && ts.length ? ts[ts.length - 1] : null; " +
        "var end = Number(ci.sell_time) || Number(ci.exit_tick_time) || Number(ci.exit_spot_time) || Number(ci.date_expiry) || (last ? Number(last.epoch) : 0); " +
        "return !!end && Number(t.epoch) - end >= 2; } catch (e) { return false; } })(contract_info, tick)";
    const ELAPSED_AFTER =
        'var is_contract_elapsed = is_trade_page ? ((0,_deriv_shared__WEBPACK_IMPORTED_MODULE_4__.isContractElapsed)(contract_info, tick) || ' +
        finished +
        ') : false; /* mt-digit-elapsed */';
    replaceOnce(
        findChunk(path.join(folder, 'trader', 'js'), ELAPSED_BEFORE) ,
        ELAPSED_BEFORE,
        ELAPSED_AFTER,
        '/* mt-digit-elapsed */',
        'digit pointer (Digits wrapper)'
    );

    // b) the adapter's open-contract translation (also an escaped string; \n here is the two characters backslash and n)
    const POC_BEFORE = '// sell_spot / sell_spot_time are deprecated in favour of exit_spot / exit_spot_time.';
    const POC_AFTER =
        "if (result.is_expired === undefined && (result.status === 'won' || result.status === 'lost')) result.is_expired = 1; /* mt-poc-expired */\\n  " +
        "if (result.exit_tick_time === undefined && result.exit_spot_time !== undefined) result.exit_tick_time = result.exit_spot_time;\\n  " +
        POC_BEFORE;
    replaceOnce(findChunk(jsDir, POC_BEFORE), POC_BEFORE, POC_AFTER, '/* mt-poc-expired */', 'digit pointer (open contract fields)');
}

// ---- 9. extra Last Digit colours ------------------------------------------------------------------------------------------
// scripts/manual-trader/digit-highlights.js shades the 2nd most and 2nd least frequent digits and glows the most increasing one
// (the trader itself only shades the most and least frequent). It only reads the percentages on screen and adds CSS classes.
// Inlined at the end of <head>; it waits for the page to load. Tested by scripts/manual-trader/digit-highlights.test.js.
{
    const HIGHLIGHT_ID = 'manual-trader-digit-highlights';
    const highlights = fs.readFileSync(path.join(__dirname, 'digit-highlights.js'), 'utf8');
    if (highlights.includes('</script')) fail('digit-highlights.js must not contain </script>.');
    const block = `<script id="${HIGHLIGHT_ID}">\n${highlights}\n</script>\n`;
    const current = fs.readFileSync(indexHtml, 'utf8');
    const existing = new RegExp(`<script id="${HIGHLIGHT_ID}">[\\s\\S]*?</script>\\n?`);
    if (existing.test(current)) {
        fs.writeFileSync(indexHtml, current.replace(existing, () => block));
        console.log('digit highlights: updated');
    } else {
        const close = /<\/head>/i.exec(current);
        if (!close) fail('no </head> tag in index.html; cannot install the digit highlights.');
        fs.writeFileSync(indexHtml, `${current.slice(0, close.index)}${block}${current.slice(close.index)}`);
        console.log('digit highlights: installed');
    }
}
