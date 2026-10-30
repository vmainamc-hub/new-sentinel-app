# Sentinel AI integration — progress

## Signal Zone + Sentinel AI merged into one machine (latest)
Signal Zone is gone as a separate tab; everything it did now lives inside **Sentinel AI**, which trades by itself the way Sixfold does.
- **One scanner loop** (`sentinel-ai-board.ts` + runner): every second the board ranks every vetted Sentinel candidate; the runner arms the best tradable one, waits for its entry digit, buys, settles, then looks again. A worked setup is not re-armed until it leaves the board and returns ("spent"). A waiting signal is only swapped for a clearly better one (8+ rank points).
- **Both engines, one decision** (`sentinel-ai-fusion.ts`): Insight Fusion is read from the app-wide feed (`bulkFeed`, same one the Bulk Trader uses). Setting `engines`: `prefer` (default: Fusion agreeing moves a signal up 6, disagreeing moves it down 12), `require` (both must agree), `fusion_leads` (Fusion picks the contract, Sentinel's validated entry digit rides along, else the default digits), `sentinel` (Fusion ignored). If Fusion cannot be read the scanner carries on with Sentinel alone.
- **Sixfold-style safety**: loss shield (the market that lost rests a few trades, doubles on a second loss there, comes back by itself after 5 min) and a small extra score bar after a loss that fades in under a minute. Both are settings and can be switched off.
- **Page**: status dial (scanning / armed / buying / in trade / next), market radar, scanner board with the reason every row is or is not tradable and what Fusion says, then the existing signal card, outcome log, history and trades. Settings: Engines first, then stake, martingale, recovery, risk (+ loss shield); execution mode, default entry digits, signal quality and alerts moved under "Advanced settings".
- **Signal Zone removed**: `src/components/premium/signal-zone/` deleted (page, load-into-Masika-bot flow, bridge, history). Nav entry, header icon, site-config and types cleaned; old `#signal_zone` links open Sentinel AI. `submarketFor` moved into `digits-analysis-loader.ts` (the only thing outside Signal Zone that used it).
- Per-setup alerts are now off while Run is on (the Run Panel shows each trade); they still fire while watching.
- Engines (`src/sentinel-engine`, `src/lib`) untouched.

Checked: 196 Sentinel AI tests pass (incl. new board, Fusion, scanner-cycle and page-render tests), `npm run build` passes, site registry / customization / free-bots validators pass, no type or lint errors in touched files. The 13 failing tests in Auto Trades, recover-bots and digits-analysis-loader fail identically on the untouched original (bot-manifest data), not from this work.
Not verified: a live run with a real Deriv account and the live Fusion feed. **Run on a demo account first.**

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
- [x] Safer recovery: payout-sized stakes (each stake sized so one win pays back a chosen % of what is owed; part-recoveries keep the rest owed), a streak budget (when the next stake would push the open loss past N x base stake, the loss is accepted and the stake restarts at base), and a live 'if you lose 5 in a row' cost readout with the win rate / streak chance of the recovery barrier. The Lab's bankroll simulation uses the same rules. Default is payout-sized, 50%, budget 10x; the old x multiplier is still there.
- [x] Recovery entry gate (off by default): while recovering, also wait until the market's last K ticks would all have won (After wins), lost (After losses), or lost K times and then won once (Loss → win) for the contract being bought. Lab 'Entry test' panel pools every market's live ticks and tests, with p-values, whether either run-based entry changes the next result versus any tick. On random digits it should show nothing; the panel exists so the live data decides.
- [x] Market Meter (`regime.ts`, `meter-ui.tsx`): every market x contract is scored tick by tick as win/loss and read as Loss cluster / Normal / Winning / Turning (30-tick z-score, current loss run, loss-run-then-wins). A gauge and a Run / Wait / Hold off verdict sit above the Scanner; the Meter tab shows each market's last 24 results, a clustering test (do wins and losses clump, FDR-corrected) and a track record that replays history and compares the next result after cold vs non-cold states. Optional Meter gate (off by default) skips contracts in a loss cluster while running.
- [x] Per-market ticks: the feed ignores ticks for markets it does not track, drops repeats / out-of-order ticks using Deriv's tick epoch, and records each market's measured tick gap (1s indices vs 2s plain indices). The Meter is computed from the published ticks with a per-market cache, so a market's strip changes only when its own ticks arrive. Meter tab has a Feed check table (Deriv says vs measured, ticks in the last 60s, repeats dropped). Squares now show the digit; session trades show entry -> exit digit.

Not done / unverified:
- [ ] `npm ci`, `npm run build`, repo `jest` / `eslint` / `prettier`, and the SCSS compile were not run (registry blocked in the session). Run `npm ci && npm run type-check && npm test && npm run build` first.
- [ ] Never run against a real Deriv account. Test on a DEMO account first.
- [ ] Payouts are still an adjustable margin estimate (default 5%); the live proposal price is not used for scoring.
- [ ] The old "Load into Recover bot" button was removed from the page (`recover-bots.ts` and its test are kept, unused).

## Sixfold Entry Lab (entry rules that must beat "enter immediately")
- New `sixfold/entry-lab.ts`, modelled on Sentinel's entry-condition discovery: 10 entry rules plus an IMMEDIATE control are replayed on every market and contract as shadow trades (rule sees only ticks up to the entry, resolved on the real settlement digit, one trade at a time per rule).
- A rule is VALIDATED only with BH-corrected q <= 0.10 across all tests, a positive edge in both the earlier 60% and later 40% of history, and 100+ trades. Otherwise the answer is "enter immediately".
- New settings: Entry = "Entry Lab" and Recovery entry = "Entry Lab" (recovery uses the recovery barrier's own report). Runner refreshes the report every 8 s; with no validated rule it buys on the next tick.
- Lab tab: Entry Lab panel with test count, chance expectation, and leading rules.
- Fix: trade-row exit digit now reads the settled contract's display-value fields in order (exit_tick_display_value, exit_spot_display_value, exit_spot, sell_spot_display_value, …).
- Tests: entry-lab.spec.ts (random digits validate ~nothing; planted edge validates), runner LAB tests.

## Entry Brain (replaces the Entry Lab as an entry mode)
Why: the Entry Lab was a referee. It only allowed a rule that had already beaten "enter immediately", and on random digits that almost never happens, so trades fell back to entering on the next tick: no entry at all.

Done (src/components/premium/sixfold; 139 sixfold tests pass under bun; strict tsc clean on entry-brain / runner / money / entry; page typechecked against React stubs):
- [x] `entry-brain.ts` (pure, causal): 14 entry methods (setup digit, last tick won, learned digit set, learned two-digit pattern, 8 run/form rules, an online logistic AI model). Every method is replayed as a shadow trade on each market and contract; tables and the model learn an outcome only after it has printed.
- [x] Plan choice: recency-weighted Beta posteriors starting at the theoretical rate; Thompson sampling picks the plan per trade (rotates when evidence is flat). Recovery uses the lower confidence bound (most proven plan) AND the AI model must agree ("double lock"). A plan that does not fire in a third of the wait window gives way to the next (up to 3 times). A fallback plan exists before any history, so no trade is ever entered blind.
- [x] Ledger: every plan-timed trade is compared with the win rate a blind entry had on that market and contract (z-score, honest verdict). Per-trade `plan` and `baseRate` recorded.
- [x] Settings: new default entry `BRAIN` (saved `SMART` migrates once; the retired `LAB` modes map to `BRAIN`). Recovery entry option "Brain · AI lock".
- [x] UI: plan pill on the armed card, compact Brain card in Scanner, full Brain panel in Lab (plan per market, pooled method table, AI skill, ledger). The old lab stays as "Entry audit" (false-discovery referee).
- Measured on synthetic data: random digits -> 0.4% false "leads" and AI skill about -1% (it cannot beat a coin, and says so); planted structure -> the learned-digit and AI methods are flagged and AI skill about +4%.

Not done / unverified:
- [ ] `npm ci`, full `tsc`, repo jest/eslint/prettier, SCSS build (registry blocked here). Run `npm ci && npm run type-check && npm test && npm run build` first.
- [ ] Not rendered in a browser; no live or demo run. Test on a DEMO account.
- [ ] Deriv digits are random: no plan can be promised to raise the win rate. Watch the ledger line (plan-timed vs random-tick) over 100+ trades before trusting it.
- [ ] A full Brain refresh costs ~150 ms for 10 markets x 4 contracts every 8 s on the main thread; move to a worker if the page feels janky.

Next: demo run, read the ledger after 100+ trades, then prune methods that read "Worse than not entering".
