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
- [x] Recovery BARRIER split by side: after a loss the next trade uses the recovery contract barrier of the signal's side (Under 8 loses -> Under 6; Over signal -> Over 3, defaults Over 3 / Under 6, editable), the signal's own barrier returns after a win. Entry digits are NOT changed by recovery. (An earlier build wrongly treated this as a recovery entry digit; replaced.)
- [x] New mode "Touch once, then nonstop": waits for the entry digit once, then fires trades back to back like a bot (martingale still applies) until target profit / stop loss / max trades / max losses / Stop. Ignores runs-per-signal; after a loss (recovery digits on) the next trade waits for the recovery digit of its side, nonstop again after a win; a newer signal does not interrupt it (logged as "Not traded").
- [x] "Contract offers no return" error: left alone as instructed (fixed separately on main).

Not done / unverified:
- [ ] `npm run build`, repo jest/eslint, SCSS compile (registry blocked here) - check the Netlify deploy.
- [ ] Live run on a demo account in each mode.
- [ ] Under recovery default barrier 6 is a guess; change it if you want another.

Next: run demo, tune defaults, then real account.

- [x] Fix: Touch-once now honours recovery digits (waits for the side's recovery digit after a loss, martingale stake kept). 86 tests pass.

## Signal quality + Jump 100 (latest)
Done (100 Sentinel AI tests pass):
- [x] Root cause of the score-0 trade: the engine's surface rule (psychology / rising losers / group threat / sweep) never checks score or the `blocked` flag, so an engine-blocked candidate (score 0) can surface. Engine left untouched; a gate now runs in `sentinel-ai-quality.ts` before the engine's surfacing rule, so a rejected candidate never hides the next-best one.
- [x] Signal quality settings (card "Signal quality"): minimum score (default 70 = engine's own opportunity threshold), maximum danger (default 45 = engine's safety boundary), skip engine-blocked (default on), 0 = off. Live-editable.
- [x] A signal that turns bad while waiting is dropped (outcome Skipped); a Touch-once run pauses (state "HELD") until the market qualifies again.
- [x] Score and danger shown on the signal; the page lists how many candidates are filtered out and why.
- [x] Jump 100: `excludedMarkets` setting, default `JD100` (editable). Any market Deriv refuses twice in a session is quarantined until the next Run.

Not done / unverified:
- [ ] The real Deriv error for Jump 100 could not be reproduced here (no Deriv access). If you re-enable it, send the exact message shown under the signal and we can repair it properly.
- [ ] Score/danger defaults may be too strict or loose in live use; tune on a demo account.

- [x] Touch-once is no longer ended by Max trades (nor Runs per signal). Its own stops: target profit, stop loss, max losses in a row, Stop. The other two modes keep Max trades / Runs per signal. 103 tests pass.

- [x] Pressing Run on a signal that is already waiting now trades it: while not running, a signal stays fresh as long as the engine keeps surfacing it, and its wait window restarts at Run. A digit that printed before Run does not count. 108 tests pass.

- [x] Score mismatch fix: a waiting signal that fails the score/danger gate is now HELD at once (never traded, reason shown) and dropped only after 5s of staying bad; the drop note is informational and clears when another signal takes over (it used to stay as a red error). 110 tests pass.
