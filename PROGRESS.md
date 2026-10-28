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

## Alignment pass (latest)
- [x] The signal card now always shows the engine's LIVE score/danger for the signal (previously it could keep stale figures while the gate judged newer ones, so "score 65" on screen vs "score 35 dropped" in the note).
- [x] A waiting signal is paused/dropped only when CLEARLY out of bounds (10 points past the score/danger limit, or engine-blocked) for 5s; dips around a limit are ignored. New signals are still admitted strictly at the limits.
- [x] Touch-once: after the touch, quality never pauses or drops it; no "runs" wording; if Deriv refuses the touched market it carries on with the next signal without a new touch. Only target profit, stop loss, max losses in a row and Stop end it.
- 113 tests pass. Still unverified: full build / live run (registry blocked here).

## Momentum gate + signal outcome log (latest)
Done:
- [x] New standalone momentum engine in `src/sentinel-engine/lib/momentum/` (`momentum-separation.ts`, `momentum-gate.ts`, tests, README). No existing engine file was edited (not surface-vetting.ts, scan.ts, price-action-psychology.ts).
- [x] `sentinel-ai-engine.ts` now calls `surfaceVetRank(eligible)` then `selectTradable(vetted, { requireMomentum })`. With the switch off this equals the old `selectSurfacedOpportunity(eligible)` (first vetted candidate, same order).
- [x] Setting `requireMomentum` (DEFAULT ON, localStorage with try/catch). UI: switch with plain one-line explanation, momentum verdict + blockers on the current signal, "Momentum blocked N of the last 40 surfaced signals" line. Momentum holds a signal that is still waiting for its entry; it never pauses a trade in flight or a Touch-once run that already touched its entry.
- [x] Signal outcome log (paper outcomes, no trades): one record per surfaced signal (key symbol+contract+barrier, re-logged only after it has been gone 3 s), outcome = last digit of the first tick strictly after the decision tick, unresolved after 30 s, 5000-record cap, localStorage key `sentinel_ai_signal_log_v1`, summary by signal type and momentum pass vs fail (Wilson 95%, break-even p0/0.955, "too few signals to judge" under 300), Download CSV, Clear log with confirmation. Read-only: failures never reach the engine or runner.
- Momentum is a filter on signal COUNT; it is not described anywhere as improving win rate. Use the log to find out.

Not done / unverified:
- [ ] `npm run build`, repo jest/eslint (registry blocked here); tests ran under bun.
- [ ] No live or demo run; nothing was traded.
- Logged candidates are the ones left after Sentinel AI's own quality/exclusion filters (`surfaceVetRank(eligible)`), not the engine's unfiltered list.

## Multi-market Ultemate profit bot v3 (user-supplied patch)
- Done: engine mixin `MultiMarket` (watch markets, read digits of any market, trade on a chosen market), 5 new Bot Builder blocks + toolbox entries, Virtual Hook settles on the traded market, tick-bus pip-size/digit-count/age readers.
- Done: bot added to Free Bots as #103 (`apex-library-ultemate-profit-bot-v3-multimarket-70`).
- Not tested here: jest specs (jest/rxjs not installed in this container), and no live run. Only the pure MultiMarket logic was checked under bun.
- Known (from the author's guide): "Maximum session loss" does not trigger (session profit is hard-wired to 0, inherited from v2). Run on demo first.
- Next: run `npm test` locally, then try the bot on a demo account.

## Ultemate profit bot v4 (heat-ranked), Free Bot 104
- Done: copy of v3 where, among markets that ALREADY signal, the one with the lowest "heat" is traded (heat = losing digits 6/7/8/9 in the last 20 ticks + 2 x the last 3 ticks); score only breaks ties. No signal is gated. Settings in INITIALIZATION: Loss digits, Heat window, Recent window, Recent weight, Heat ranking enabled (0 = v3 behaviour).
- Checked in an XML interpreter simulation (6 seeds x 400 ticks x 10 markets): signals identical to v3 on every tick, heat-off identical to v3, chosen market always the minimum-heat qualifier. Not run live. Digits on synthetic indices are random, so no change in long-run win rate is claimed.
- Still open: v3/v4 "Maximum session loss" never triggers (session profit stuck at 0).

## Ultemate profit bot v5 (transition ranking), Free Bot 105
- Done: v4 plus a "Transition score" procedure, evaluated only for markets that already signal. It adds: loss-digit cooling per window (10/24/40/60), hot-to-cold hand-off per window, per-digit cooling (window 24, hot count 3), fast (6) under slow (40) average. Rank = heat - Transition weight x score; lowest rank is traded, score breaks ties. Transition weight 0 = v4. Nothing is blocked.
- Checked in the XML interpreter (6 seeds x 400 ticks x 10 markets): signals identical to v3 on every tick, weight 0 identical to v4, the bot's transition score equals an independent Python reference, chosen market always has the minimum rank. Not run live; no claim of a higher win rate (digits are random).
- Next: backtest v3/v4/v5 on recorded real ticks if the user supplies a CSV; fix the broken session loss cap.

## Sixfold Auto (autonomous scanner + trader)
Done (src/components/premium/sixfold, 64 unit tests pass, strict `tsc` clean, driven end-to-end in headless Chromium with a fake Deriv socket):
- [x] Press **Run** on the Sixfold page: it scans every market for the two primary contracts only (Over 2 and Under 7 by default, switchable, barriers editable), arms the best eligible one, waits for its entry digit, buys, waits for the result, then looks again. One trade at a time, across all markets. It no longer loads or drives a bot.
- [x] Trades go through `buyContractForUi` / `streamContractUntilSettled` and are pushed to the transactions / Run Panel / summary stores (same hand-off as Sentinel AI), so they show in the general Transactions area. The Run Panel's Stop ends the session.
- [x] Money rules: stake, TP, SL, martingale (multiplier, max steps, max stake), recovery barrier (Over 3 / Under 6 by default), loss-streak stop, max trades. Pure functions in `money.ts`.
- [x] Safety: never trades a market whose last tick is stale; a Deriv-refused contract is skipped and a market refused twice is taken out for the session; a purchase with an unknown outcome stops the session (never retried); a dropped Deriv session stops it.
- [x] Analysis: Benjamini-Hochberg false-discovery control across all scanned cells (`scanner.ts`), digit uniformity (chi-square), digit-to-next-digit dependence (chi-square 9x9), runs test, calibration of Sixfold's own labels against what happened next, 1,000-session bankroll Monte Carlo using the runner's own money rules (`analysis.ts`), Sentinel AI agreement badge (`agree.ts`).
- [x] UI: scanner dial + Run/Stop, settings panel, candidate queue, activity log, market x contract heat map, equity and rolling win-rate charts, six-trader hexagon, digit and transition heat maps. Light and dark themes; phone layout.
- [x] The market feed is now one app-wide singleton (`feed.ts`) with reconnect and a stale-stream watchdog, so scanning continues on any tab. `sixfold-bridge.tsx` is mounted in `PremiumLayout`.
- [x] Primary-contract restriction: Sixfold never trades Over 7 / Under 1-3 etc. Recovery after a loss is Over 3 / Under 6 (on by default). New Contracts control in Scanner; Board shows just the two contracts. Tests assert every buy is Over 2 / Under 7 (or recovery 3 / 6).
- [x] Loss shield (a market that loses is rested for N other trades, doubling after 2 losses there, max 5 min), adaptive entry (`entry.ts`: entry digits learned from the armed market's own ticks, recomputed while waiting, the digit that just lost is skipped next time), and pickier-after-a-loss (+10 score that fades over 150 s). Controls in Scanner; resting markets shown on the dial.

Not done / unverified:
- [ ] `npm ci`, `npm run build`, repo `jest` / `eslint` / `prettier`, and the SCSS compile were not run (registry blocked in the session). Run `npm ci && npm run type-check && npm test && npm run build` first.
- [ ] Never run against a real Deriv account. Test on a DEMO account first.
- [ ] Payouts are still an adjustable margin estimate (default 5%); the live proposal price is not used for scoring.
- [ ] The old "Load into Recover bot" button was removed from the page (`recover-bots.ts` and its test are kept, unused).
