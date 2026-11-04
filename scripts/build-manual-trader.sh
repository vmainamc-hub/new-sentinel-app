#!/usr/bin/env bash
#
# Builds Deriv's DTrader app (vmainamc-hub/db-traders-) and installs it as public/br_manual-trader/,
# which the "Manual Trader" tab (src/components/premium/manual-trader) shows in an iframe.
#
# STATUS: written against the source repo's own sub-folder build (its `deploy:folder` flow) but NOT yet run end to
# end. The first run is the real test. It fails loudly (set -e, and the patch step checks its anchor) rather than
# installing something half-built.
#
# Needs: Node 18 (the source's engines field), npm 9+, git, network access to GitHub and the npm registry. It takes a long
# time: the source is a lerna monorepo with ~20 packages.
#
# Why the folder is called br_manual-trader: the source router only treats a first path segment starting with
# "br_" as a base path (packages/core/src/App/app.jsx).
#
# What is changed in the source build (nothing in packages/trader, so the trader UI and logic are untouched):
#   1. packages/shared/src/utils/config/deriv-socket.ts: the one-time-WebSocket request also sends the Deriv-App-ID
#      header when a client id is stored under deriv_oauth_app_id. The token comes from this site's own sign-in, so it
#      belongs to this site's OAuth client, not the source's.
#   3. dist/index.html: the anti-clickjack check no longer sends the top window to the trader's own address when this
#      same site is the one framing it (it did, so the tab left the app instead of opening the trader in place).
#   2. dist/index.html: scripts/manual-trader/storage-isolation.js is inlined first, so the trader's localStorage and
#      sessionStorage keys are namespaced and cannot overwrite Sentinel's (it shares this site's origin).
#
# Overrides: MANUAL_TRADER_SOURCE_REPO, MANUAL_TRADER_SOURCE_REF (a commit; default is the one this was written against).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REPO="${MANUAL_TRADER_SOURCE_REPO:-https://github.com/vmainamc-hub/db-traders-}"
SOURCE_REF="${MANUAL_TRADER_SOURCE_REF:-5f15b9aab5738170e0fe98565a50fe393cacad73}"
FOLDER="br_manual-trader"
WORK="$ROOT/.manual-trader-build"
OUT="$ROOT/public/$FOLDER"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" != "18" ]; then
    echo "Node 18 is required (found $(node -v)). Switch with: nvm install 18 && nvm use 18" >&2
    exit 1
fi

echo "==> Fetching $SOURCE_REPO @ $SOURCE_REF"
rm -rf "$WORK"
mkdir -p "$WORK"
git -C "$WORK" init -q
git -C "$WORK" remote add origin "$SOURCE_REPO"
git -C "$WORK" fetch --depth 1 origin "$SOURCE_REF"
git -C "$WORK" checkout -q FETCH_HEAD
SOURCE_COMMIT="$(git -C "$WORK" rev-parse HEAD)"

echo "==> Patching the one-time-WebSocket request (Deriv-App-ID)"
node - "$WORK/packages/shared/src/utils/config/deriv-socket.ts" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const before = "headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },";
const after =
    "headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(localStorage.getItem('deriv_oauth_app_id') ? { 'Deriv-App-ID': localStorage.getItem('deriv_oauth_app_id') as string } : {}) },";
const text = fs.readFileSync(file, 'utf8');
const count = text.split(before).length - 1;
if (count !== 1) {
    console.error(`Patch anchor found ${count} times in ${file}; expected exactly 1. The source changed, so review the patch.`);
    process.exit(1);
}
fs.writeFileSync(file, text.replace(before, after));
NODE

echo "==> Installing the source's packages (slow)"
(cd "$WORK" && npm run bootstrap)

echo "==> Building the source packages and the core app for /$FOLDER/ (slow)"
(cd "$WORK" && npm run build:gh-pages -- "$FOLDER")
(cd "$WORK/packages/core" && npm run build -- "$FOLDER")

DIST="$WORK/packages/core/dist"
if [ ! -f "$DIST/index.html" ]; then
    echo "Build finished but $DIST/index.html is missing." >&2
    exit 1
fi

echo "==> Inlining storage isolation into index.html"
node - "$DIST/index.html" "$ROOT/scripts/manual-trader/storage-isolation.js" <<'NODE'
const fs = require('node:fs');
const [html_path, shim_path] = process.argv.slice(2);
const html = fs.readFileSync(html_path, 'utf8');
const shim = fs.readFileSync(shim_path, 'utf8');
if (shim.includes('</script')) {
    console.error('storage-isolation.js must not contain </script>.');
    process.exit(1);
}
const head = /<head[^>]*>/i.exec(html);
if (!head) {
    console.error('No <head> tag in index.html; cannot inline the storage isolation.');
    process.exit(1);
}
const at = head.index + head[0].length;
fs.writeFileSync(html_path, `${html.slice(0, at)}\n<script>\n${shim}\n</script>${html.slice(at)}`);
NODE

echo "==> Letting index.html open inside this site's own frame (anti-clickjack check)"
node - "$DIST/index.html" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const before = [
    "            if (self === top) {",
    "                var antiClickjack = document.getElementById('antiClickjack');",
    "                antiClickjack.parentNode.removeChild(antiClickjack);",
    "            } else {",
    "                top.location = self.location;",
    "            }",
].join('\n');
const after = [
    "            var sameSiteParent = false;",
    "            try {",
    "                sameSiteParent = window.top.location.origin === window.location.origin;",
    "            } catch (e) {",
    "                sameSiteParent = false;",
    "            }",
    "            if (self === top || sameSiteParent) {",
    "                var antiClickjack = document.getElementById('antiClickjack');",
    "                antiClickjack.parentNode.removeChild(antiClickjack);",
    "            } else {",
    "                top.location = self.location;",
    "            }",
].join('\n');
const text = fs.readFileSync(file, 'utf8');
const count = text.split(before).length - 1;
if (count !== 1) {
    console.error('Anti-clickjack anchor found ' + count + ' times in ' + file + '; expected exactly 1. The source changed, so review the patch.');
    process.exit(1);
}
fs.writeFileSync(file, text.replace(before, after));
NODE

echo "==> Hiding the trader's own brand strip (Sentinel shows its own header)"
node - "$DIST/index.html" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const marker = '</head>';
const count = text.split(marker).length - 1;
if (count !== 1) {
    console.error('Expected exactly one </head> in ' + file + ' but found ' + count + '.');
    process.exit(1);
}
const style = [
    '<style id="manual-trader-embed">',
    '.apollo_info { display: none !important; }',
    '</style>',
    '',
].join('\n');
fs.writeFileSync(file, text.replace(marker, style + marker));
NODE

echo "==> Installing into public/$FOLDER"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$DIST/." "$OUT/"
printf '{\n  "source_repo": "%s",\n  "source_commit": "%s",\n  "built_at": "%s"\n}\n' \
    "$SOURCE_REPO" "$SOURCE_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/manual-trader.json"

echo "==> Done: $(du -sh "$OUT" | cut -f1) in public/$FOLDER (source $SOURCE_COMMIT)"
BIG="$(find "$OUT" -type f -size +50M | head -5)"
if [ -n "$BIG" ]; then
    echo "WARNING: files over 50 MB (GitHub rejects files over 100 MB):" >&2
    echo "$BIG" >&2
fi
