# Sentinel AI integration — progress

Goal: a **Sentinel AI** tab between Auto Trades and TradingView. The Sentinel Signal Engine (from the zip) is the
backend, untouched. A new frontend and runner trade its signals on their entry digit, the same way Auto Trades runs,
and every trade shows on the Run Panel (the main deck).

Target repo: vmainamc-hub/new-sentinel-app (live: https://precisionapex.netlify.app). Deployed from `main` (auto-publish) to https://precisionsentinel.netlify.app.

## Done
- [x] Studied the repo: Auto Trades run flow (`buyContractForUi` -> transactions / run_panel / summary_card), Run Panel, nav (`PremiumLayout`, `site-customization`).
- [x] Engine isolated in `src/sentinel-engine/` (112 files, only import specifiers rewritten, verified against the zip). It does NOT go in `src/lib`: that folder already holds a different vendored engine (Insight Fusion, used by the Bulk Trader) and 13 files differ.
- [x] `src/pages/sentinel-ai/`: types + settings, signal mapper, read-only engine adapter, stake / martingale / recovery / stop rules, non-audio alerts, runner (waits for entry digit -> buy -> settle -> Run Panel), app-wide bridge, page + styles.
- [x] Nav wiring: `PremiumSection`, nav catalog and defaults, header icon, `PremiumLayout` (lazy), `DBOT_TABS.SENTINEL_AI`, `public/site-config/domains/apex-sentinel.json` (order: Auto Trades, Sentinel AI, TradingView), `public/site-config/catalog.json`.
- [x] Lint/format excludes for the vendored engine; `scripts/vendor-sentinel-engine.mjs` to refresh or verify it.
- [x] Checks that could run offline: 39 unit tests (bun's jest-compatible runner), `tsc` on the new TS + engine with stubs for heavy deps, repo validation scripts (site registry, free bots, site customization), and a headless-browser render of the page with the real runner and a simulated engine / Deriv / Run Panel (desktop + mobile, no console errors).

## Not done / could not be done here
- [ ] `npm ci`, `npm run build`, the repo's own `jest` and `eslint`: the session's network policy blocks registry.npmjs.org (403), so dependencies cannot be installed. Netlify / the GitHub workflow will run the build.
- [ ] Live test with a real Deriv account and the real engine feed (needs a logged-in session). Do it on a demo account first.

## Rules kept
- Engine files are never edited; the frontend only reads from them.
- Auto Trades, DTrader, Bulk Trader untouched.

## Review pass (latest session)
- Re-read the runner, stake/martingale/recovery rules, engine adapter, alerts, bridge and nav wiring: matches the brief (signal -> entry digit -> buy -> Run Panel; stake, martingale, recovery; non-sound alerts).
- Re-ran: 39 unit tests pass; engine verified 112 files / 0 mismatches vs the zip; repo validation scripts pass.
- Still blocked here: registry.npmjs.org is denied by the session proxy, so `npm ci` / `npm run build` / repo jest+eslint did not run. First thing to do on a machine with network: `npm ci && npm run type-check && npm test && npm run build`.
- Engine only runs while the Sentinel AI page is open or a session is running (it needs the logged-in Deriv socket).
- Test on a DEMO account first.
- Nothing committed or pushed: changes are in the working tree of `feat/sentinel-ai`.

## Repairs batch (latest)
Done (85 Sentinel AI unit tests pass; rebased on 15213c0 "Repair Auto Trades purchase flow" - `buyContractForUi` signature unchanged, so no code change needed):
- [x] Default entry digits for signals the engine gave no entry: Over = 2 or 4, Under = 5 or 7, first to print wins. Editable ("Default entry digits").
- [x] Target profit (default 100, 0 = off): own panel under the run bar with progress bar, editable while running; stops the session when reached.
- [x] Recovery split by side: Over signals recover on the Over recovery digit(s) (default 3), Under signals on the Under ones (default 6). Old saved single `recoveryDigit` migrates to both sides.
- [x] New mode "Touch once, then nonstop": waits for the entry digit once, then fires trades back to back like a bot (martingale still applies) until target profit / stop loss / max trades / max losses / Stop. Ignores runs-per-signal and recovery-digit waiting; a newer signal does not interrupt it (logged as "Not traded").
- [x] "Contract offers no return" error: left alone as instructed (fixed separately on main).

Not done / unverified:
- [ ] `npm run build`, repo jest/eslint, SCSS compile (registry blocked here) - check the Netlify deploy.
- [ ] Live run on a demo account in each mode.
- [ ] Under recovery default digit 6 is a guess; change it if you want another.

Next: run demo, tune defaults, then real account.
