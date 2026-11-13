# AI Over/Under Intelligence ("AI Intel") — progress

Spec: master prompt (14 parts). Branch `feat/ai-intelligence` (merge to main only after build + tests pass; main auto-deploys to Netlify). Module dir: `src/components/premium/ai-intel/`.

## Apex Intel Entry digit: the Entry Digit Lab, a digit that follows the market (latest)
Problem: the first version worked a digit out once from a replay of history and kept it 60 s (`ENTRY_DIGIT_TTL_MS`). A 1-tick contract trades dozens of times a minute, so ONE digit served all of them while the market moved, and a weak digit was traded anyway. Result: many losses.
- [x] New `ai-intel/entry-lab.ts`, an always-on lab. Every live tick of every market (fed from `apexFeed.onTick`, whether or not a run is on) goes through ONE step shared by replay and live. For each market x contract x run length it keeps ten candidate rules, "enter right after digit e prints", as a shadow ledger (newest 240 entries). Each shadow entry settles on the digit `duration` ticks later, so it never sees the future.
- [x] Each tick all ten are re-scored: recency-weighted win rate (half-life 40 entries) as a z-score against the fair rate, a check on the newest 40% of entries, and a cooling flag after 3 shadow losses in a row. States: `confirmed`, `leading`, `weak`, `thin`, `cooling`, `benched`. Only confirmed/leading is tradable. The digit in use is replaced only when a challenger beats it by 0.35 z (hysteresis), so it does not flicker.
- [x] Real results feed back: after 2 lost trades in a row on a digit (live or Virtual Hook paper), it is benched for 90 ticks and the log says so; a win clears the count.
- [x] If no digit holds up, Apex Intel STANDS ASIDE on that market (`tradable: false`) instead of trading the best of a poor lot. This is a behaviour change from the first version, which traded weak digits.
- [x] Learned from the Lovable `sentinel-parity-hub` zip (`entry-conditions.ts` EntryLab): continuous shadow simulation, causal context, settle on the real expiry digit, recency and newest-window checks, degrading/invalidated states.
- [x] UI: board rows show `on N (confirmed|leading)` / `no digit holds up`; new "Entry digit lab" card shows all ten digits (state, rate of n, z), the digit in use, how long it has been held and how often it switched. Console: `apexEntryLab.view('R_10', {side:'OVER',param:2}, 1)`.
- [x] Files: new `entry-lab.ts`; `entry-digit.ts` rewritten as a facade (`get / observe / record / view / reset`); `executor.ts` (`tradable`, `entryResult`, `entryView`, `entryLab` on the snapshot, `entryDigit` stored on open trades); `executor-instance.ts` (wiring, lab fed before the executor on each tick); `TradePanel.tsx`; `ai-intel.scss`. Standard mode, Sentinel AI and the Bulk Trader untouched.
- Checked: 21 new lab tests (no look-ahead, replay == live, adaptation after a regime flip, benching, hysteresis) and the rewritten `entry-digit.spec.ts` (executor + real-lab runs); `ai-intel` + `edge-gates` 200 pass under bun. tsc (scratch config): no new errors in touched files (remaining ones are the missing react types and one line that was already there). NOT done: `npm run build`, jest, a live Deriv run, a browser look at the new card.
- Honest limit: Deriv digits are random. A lab can only decide WHEN to enter and when to sit out; it cannot raise the win probability above the contract's fair rate. Expect fewer trades, not guaranteed wins.

## Apex Intel: Overlord selection modes (in progress, branch `feat/overlord-mode`, NOT on main)
Goal: Overlord's over/under engines choose WHICH market and contract Apex Intel trades, with every existing Apex Intel condition (AI guard, edge gates, digit 1 / 8 rule, limits, recovery, Virtual Hook) still running on whatever is chosen. Three modes: STANDARD (as it always was, default), OVERLORD (Overlord ranks and vetoes the picker's candidates), COMBINED (Overlord AND the picker's own edge must both say yes). Overlord's trading code (`hub360/Overlord.jsx`) is deliberately NOT ported: the executor already trades. Rise/Fall and Even/Odd are out of scope.
- [x] Step 1: pure selector + reader. `ai-intel/overlord-select.ts`: `selectByOverlord` (only removes and re-orders the picker's candidates; STANDARD returns the same array; missing reading = no trade) and `createOverlordReader` (reads Over 2 / Under 7 / Over 3 / Under 6 per market with the unchanged Overlord engines, one market per call, picker's markets first, keeps the last 6 reads to measure steadiness, needs 3 reads and 60% clear). `sixfold/feed.ts`: additive `getLivePrices()` (quotes kept in step with the digits; Overlord's volatility / trend / bar engines need prices). 14 tests incl. the no-dilution property (never adds or changes a candidate; COMBINED is a subset of OVERLORD, which is a subset of STANDARD).
- Cost measured on a desktop (2000 ticks, 4 contracts): 137 ms per market with every engine, 95 ms without the fluctuation replay, 25 ms without the model ensemble too. One market per board tick, so a market is re-read about every 2 s x (markets in play).
- [x] Step 2: executor. `ExecConfig.selection` (STANDARD default; a saved config without it loads STANDARD). `refreshBoard` now takes the picker's book, hands the WHOLE unfiltered book to the edge gates as before (`onBoard`), then `applySelection` removes / re-orders it with Overlord's reading before the board is cut. Recovery (Over 3 / Under 6) is read and selected the same way. Missing / throwing reading = no trade. `executor-instance.ts` wires one `createOverlordReader` on the shared feed (no second socket). The AI guard, edge gates, digit 1 / 8 rule, limits, recovery stakes, Virtual Hook and Entry digit mode are untouched and run on whatever is chosen. 15 tests in `__tests__/overlord-mode.spec.ts` (STANDARD never touches Overlord and keeps the same pick objects; guard / digit 1-8 rule still veto an Overlord choice; COMBINED only trades markets OVERLORD would).
- [x] Step 3: UI (`TradePanel.tsx`): "Market and contract selection" switch (Standard / Overlord / Combined) with a plain explanation, Overlord tier + score on each board row, and a "Held back by Overlord" list with the reason per market. Transpiles; NOT render-tested.
- Checked: 29 new tests pass. Regression: the same 6 tests + 1 module error fail with and without my changes (6 Sentinel gate tests and the missing `react/jsx-runtime`), 777 pass in total, none new.
- [ ] Step 4: generalise past Over 2 / Under 7 (Overlord's other barriers); every Apex rule must be checked per contract and fail closed
- NOT done / unverified: `npm run build`, jest, a live run against Deriv, a look in a browser (no node_modules or network in this workspace).

## Apex Intel: a second mode, "Entry digit" (first version, superseded above)
- [x] Apex Intel now has an **Entry mode** switch on its trade screen: **Standard** (Apex Intel exactly as before, the default) or **Entry digit**. Nothing in Standard was changed: the entry type (fixed digit / any tick / custom / SMART rule) still arms the trade. A config saved before this existed loads as Standard.
- [x] Entry digit mode uses Sentinel AI's formula, not a copy of it: `entryTriggerOf` in `sentinel/overlay.ts`, which calls the Bulk Trader's `discoverEntry` (`bulk-scan.ts`). Once Apex Intel has identified a market and contract (Over 2 / Under 7, or Over 3 / Under 6 while recovering), that market's digit is worked out by replaying its own history (chosen on the older two thirds, checked on the newest third), kept for 60 s, and the trade is placed on the first tick that shows it. It replaces the entry type's trigger. Labelled `confirmed` or `weak` (a timing choice, not an edge), same as Sentinel; a weak digit is still traded, as Sentinel does, and the log says so.
- [x] Unchanged in both modes: which market and contract are picked, the AI guard, the mandatory digit 1 / 8 rule, the edge gates, Virtual Hook, recovery stakes and every limit. No digit (under 300 ticks, or the lookup fails) means no trade on that market yet, never a guess.
- [x] Files: new `ai-intel/entry-digit.ts` (the one-minute memory around Sentinel's formula); `executor.ts` (`entryMode`, `ExecIO.entryDigit` / `resetEntryDigits`, `plan()`, `entryDigits` on the snapshot); `executor-instance.ts` (wiring to the live feed); `TradePanel.tsx` (the switch, the digit shown next to each market on the board and in the status line). Sentinel AI and the Bulk Trader were not touched.
- Checked: 19 new tests in `ai-intel/__tests__/entry-digit.spec.ts` (including the real formula on a planted series); all 170 tests in `ai-intel` and `edge-gates` pass under bun, Standard-mode tests unchanged. Type-check shows no new errors in the touched files (the ones it reports were there before). NOT done here: `npm run build`, jest, a live run against Deriv or a look at the page in a browser (no node_modules or network in this workspace).
- Honest limit: Deriv digits are random. The best of ten digits looks good in the past by construction, so the entry digit decides WHEN Apex Intel buys, not whether the contract wins.

## Sentinel AI: a calculated entry digit for every market (latest)
- [x] Every market Sentinel arms now comes with an entry digit worked out from that market's previous ticks, and the trade is placed on the first NEW tick that shows it (never on a digit already on screen). The digit comes from the Bulk Trader's engine (`bulk-scan.ts` `discoverEntry`): for each digit 0-9, how often the contract won when entered right after it, chosen on the older two thirds of the history and checked on the newest third. Labelled `confirmed` (it held on the newest third) or `weak` (best digit found, none stands out: a timing choice, not an edge). Needs 300 ticks; kept for 60 s per market and contract so it does not change while waited for.
- [x] It REPLACES "N winning digits in a row" as the trigger, because the entry digit can itself be a losing digit. What stays: no red run (the 2 digits just before the entry digit are not both losers: `redRunBeforeLast`), a market with 4+ losses in its last 10 (Over 2) is still dropped, and the special-digit rule, pressure / window / Meter gates, freshness and loss shield all still hold. Works in best-score and first-to-qualify mode. Ignored when the entry rule is "any tick" or the Brain; with no digit available (short history, contract outside the six) the old entry applies.
- [x] Plumbing: `RunnerOverlay.entryTrigger` (sixfold/overlay.ts), `Armed.trigger`, `triggerFor` / `triggerGate` in the runner (all inert unless an overlay supplies a trigger, so Sixfold and Vanguard are unchanged), `entryTrigger` in sentinel/overlay.ts. Page: "Over 2 · Vol 50 · waiting for entry digit 7" plus how the digit did; log: "entry digit 7 (its trigger, confirmed)".
- Checked: 26 new tests (sixfold runner / streak-guard, sentinel/__tests__/entry-trigger.spec.ts); existing Sixfold, Sentinel, Overlord tests unchanged (the 54 failures in this sandbox are the same before and after: missing node_modules / jest env); strict tsc clean on the touched files. NOT done here: `npm run build`, jest, a live run against Deriv.
- Honest limit: Deriv digits are random. The best of ten digits looks good in the past by construction, so the digit decides WHEN it buys, not whether it wins. On random digits about 65% of entry-digit prints pass the protections (about 31% skipped for 4+ losses in the last 10, about 5% for a red run).

## Overlord: evidence rule for Rise/Fall and Even/Odd signals (latest)
- [x] A signal is only given when the market already shows the side dominating its latest ticks: at least 6 of the last 10 ticks must be falls for a Fall, rises for a Rise, even digits for Even, odd digits for Odd. Any order, not consecutive; a tick that did not move counts for neither side; fewer than 10 ticks cannot show it. Without it the market is shown with the reason ("only 3 of the last 10 ticks were falls, need 6"), is never presented as a signal, and Run refuses to trade it. Numbers: `EVIDENCE_WINDOW` / `EVIDENCE_MIN` in `overlord-engine/evidence.ts`. (A first version demanded an exact unbroken run FFFF / EEEEE; that was far stricter than intended and blocked nearly everything, so it was replaced.)
- [x] Rise/Fall: `rise-fall-run.ts` also subscribes to each market's live ticks (only when the rule is on); `scanRiseFall` takes `ticks` + `requireEvidence`; a market that has a setup sorts ahead of one that does not. Even/Odd: `ParityRead.evidence`, `requireEvidence` in `scanParity` / `pickFromReads` / `ParityAssessment` (same pattern as the Oracle conditions); an Even/Odd "closest market" without the evidence is shown but not traded.
- [x] Page: switch "Only give a signal when the market already shows it" (default ON) for Rise/Fall and Even/Odd, evidence line on the result card and in the log.
- Checked: 30 tests in `__tests__/evidence.spec.ts` + the existing Overlord-engine tests pass under bun (106 total); strict tsc clean on the touched engine files; Overlord.jsx parses. NOT done here: `npm run build` / jest / a browser run (no network in this workspace). Fails closed: if live ticks do not arrive the rule says "no latest ticks to check" and gives no signal.
- Honest limit: on random ticks a given side is in the majority of the last 10 about 38% of the time, so this removes signals without evidence; it does not make the next tick predictable.

## Audit findings (real repo, commit e361ede)
- Stack: React 18 + TS, rsbuild, jest (`npm test`), MobX stores, SCSS. Premium tabs lazy-loaded in `PremiumLayout.tsx` (`case 'sixfold'` pattern); nav catalog in `public/site-config/*`.
- Sixfold simulation rules live in `entry-lab.ts` `walkForward` (trigger at i, exit at i+duration, next trigger search resumes at exit+1, one contract at a time, decisions use only past ticks) and `runner.ts` `virtualTick`/`executeVirtual` (win = `winningDigits(contract)`). `virtual-hook.ts` is the Virtual Hook state machine, NOT the simulator. Entry modes in `bot.ts`: ANY, SETUP, SMART, CUSTOM (explicit digit set), plus BRAIN (entry-brain.ts). Tests: entry-lab.spec, runner.spec exist.
- Feed: `sixfoldFeed` (feed.ts) is the app-wide singleton on Deriv public WS, 10 hardcoded markets (1HZ10-100V, R_10-100), `onTick(symbol, digit)` listener. Reuse it; no second tick socket. Gap: market list is hardcoded, spec wants API-discovered (active_symbols) with that list as fallback.
- Execution: `buyContractForUi` + `streamContractUntilSettled` (`src/utils/trade-purchase.ts`) with the existing authorised Deriv session and Run Panel stores (`runner-instance.ts` shows wiring). Reuse; no tokens in new code.
- Storage: no server DB. Netlify has only `oauth-token.mjs`. `localforage` is a dependency, so persistence = IndexedDB client-side. Server-side DB is NOT available without new infra — documented limitation.
- AI: no LLM integration exists. Plan: the 10 "agents" are deterministic statistical/ML modules; an optional LLM explanation boundary (Netlify function, key via env) added last, off by default.

## Plan (stages; each ships tested before the next)
1. [x] Core types + Sixfold-compatible simulator (`ai-intel/sim.ts`) + 12 tests, incl. spec example 1,5,2,6,3 and exact parity with Sixfold `walkForward` on 4000 pseudo-random digits (ANY/SETUP, OVER 2/UNDER 7, durations 1/2/3/5)
2. [~] Stats: DONE `analysis.ts` (chi-square uniformity, exact binomial, Wilson, rolling windows, CUSUM + shift-test regime, BH false-discovery control, market x direction x method scan) with tests. NOT done: Bayesian estimates, transition matrices/runs/Markov, cross-market correlation
3. [~] Scanner: DONE reads the shared `sixfoldFeed` (no 2nd socket), freshness, eligibility. NOT done: active_symbols market discovery (still Sixfold's 10 fixed Volatility indices), reconnection tests
4. [ ] Strategy registry + versioning + lifecycle (EXPERIMENTAL→…→RETIRED, promote/rollback) + IndexedDB persistence
5. [ ] Strategy lab: candidate generation, walk-forward train/validate split, overfit checks
6. [ ] Competition engine (min samples, CI, stability, decay)
7. [ ] Agents + Chief agent (structured decisions, NO TRADE default)
8. [~] Execution: DONE `executor.ts` + bridge + Live Execution/Trade History tabs. Real OVER 2 / UNDER 7 trades via `buyContractForUi`/`streamContractUntilSettled` (same path as Sixfold/Auto Trades, shows on Run Panel). Entry SETUP/ANY/CUSTOM, martingale recovery + optional recovery barrier, max stake, stop loss, target profit, max trades, ASSISTED (confirm each) or AUTO (needs explicit authorisation tick), instant STOP, no retry on unknown purchase, one contract at a time, stale-feed refusal. 17 tests with a fake Deriv. NOT done: reconciliation of an open contract after a page reload, concurrent contracts, AI-selected entries, live-account verification
9. [~] UI: tab 'Apex Intel' is in the main nav (`ai_intel`); Overview, Live Scanner, Virtual Competition work on live data; the other 7 sections are shown disabled labelled 'soon'
10. [ ] Build, full test run, merge to main

## Update (latest): AUTO market runner
- [x] `picker.ts`: ranks every fresh market x direction x entry (SETUP/ANY/CUSTOM strategies) by the LOWER bound of the win-rate interval; `evidenceOnly` mode requires BH-significance. 4 tests.
- [x] Executor: market `AUTO` = tool picks market/direction/entry (reviewed every 4 s, switch only if +2 pts better, never while a contract is open or a signal awaits confirmation); recovery stake keeps doubling across picks; all limits unchanged. 6 tests.
- [x] Live Execution UI: "AUTO" market option, directions filter, evidence-only toggle, pick card with next-best.
- Honest note: default (evidence-only OFF) trades the best-ranked market even without proven edge. On random digits no market is expected to beat chance; evidence-only ON will mostly wait.
- 45 Apex Intel tests pass under bun. Still no `npm run build` here (registry unreachable).
- [x] Market discovery: `discovery.ts` (active_symbols, Volatility only, open and not suspended; returns [] on any error so the fixed ten always remain) + `SixfoldFeed.addMarkets` (extra markets on the SAME socket, no second connection; Sixfold's own scans unaffected, its 22-file suite unchanged). Wired in `AiIntelBridge`; market dropdown and scanner list discovered markets. 5 tests. NOT verified live: Deriv's real active_symbols reply shape on the public endpoint (parser accepts `underlying_symbol` or `symbol`).
- [x] Strategy engine (logic): `rules.ts` (serializable rules: trigger digits + condition on preceding ticks), `lab.ts` (evolutionary search on TRAIN only, finalists tested ONCE on held-out VALIDATION, exact binomial + BH correction, overfit/degradation check, seeded/deterministic, start/pause/resume/stop), `registry.ts` (immutable rules, versions, lifecycle EXPERIMENTAL->UNDER_VALIDATION->APPROVED->ACTIVE->SUSPENDED->RETIRED, audit trail, rollback, lab can never approve/activate, monitor can only suspend), picker + executor trade ACTIVE strategies (rule must hold on live history). 22 new tests; lab finds a planted pattern and validates it, and finds nothing on fair random digits.
- [x] Strategy Lab + Strategy Library screens (`StrategyPanels.tsx`, tabs enabled): start/pause/resume/stop, config, progress, finalists with train vs unseen stats, approve/activate/suspend/retire/rollback, per-strategy audit history, override confirm. Transpiles; NOT render-tested (React not installed here).
- [x] Shared feed: Apex Intel now reads the app's all-markets `vanguardFeed` (Volatility indices that offer DIGITOVER/DIGITUNDER); no extra socket.
- [x] Forward monitor (`monitor.ts`): paper-trades APPROVED/ACTIVE strategies on live ticks with the same simulator; suspends a strategy (and only suspends) when 60+ forward trades have a Wilson upper bound below chance. In-memory counts (reset on reload).
- [x] Ten agents + Chief (`agents.ts`, `intel-instance.ts`, `AiIntelligencePanel.tsx`, tab enabled): rule-based, no learned model, no LLM. Chief says ENTER only if significant after FDR control, 60+ trades, STABLE regime, fresh feed, strategy not failing forward, and entry met on the latest tick; otherwise NO TRADE with reasons. Four separate evidence blocks (never one confidence number), rejected opportunities with reasons, forward-test table, decision log (200, saved in the browser). Evaluates every 3 s only while the tab is open or an AUTO run is going. The Chief is advisory: trades are placed only from Live Execution under its limits.
- 78 Apex Intel tests pass under bun (356 across Apex Intel + Sixfold + Vanguard; the 1 fail + 1 error is the old 'react/jsx-runtime' FreeBotsPage issue). Site-config validators pass.
- NOT done: Performance Analytics and Settings tabs (still 'soon'); decision log / forward counts are browser-local (no server DB); open-contract reconciliation after reload; no LLM explanation layer.
- NOT verified: `npm run build`, type-check, eslint, any React render, any live Deriv run (registry unreachable here). Run first on a networked machine: `npm ci && npm run build && npm test`, then try a DEMO account.
- Expect NO TRADE most of the time: Deriv digits are random, so nothing should pass validation; recovery stakes raise losses.

## Rework: multi-market trading screen (latest)
- [x] Executor now scans ALL markets at once: a board of the best entry per market (top 6, rebuilt every 2 s) and buys whichever market's entry fires first. One contract at a time. No single-market setting any more (markets can be switched off under More settings).
- [x] Recovery: after ANY loss (Over 2 or Under 7) the next trade is Over 3 or Under 6, whichever is more viable on the market showing its entry (`rankRecovery`: simulator + lower-bound score, fixed-digit or any-tick entry), at stake x multiplier per loss; a win goes back to Over 2 / Under 7. Max steps and stop loss still stop the run.
- [x] Virtual Hook ported from Sixfold (same state machine): paper trades after N real losses, settle on the market's real ticks, back to real after M paper wins (or fixed count); optional "open every run on paper". Paper rows show in Transactions as Virtual and never touch session P/L, stake or limits.
- [x] New screen `TradePanel.tsx`, built from Sixfold's own controls: Run/Stop, status, P/L, Over 2 / Under 7, stake, take profit, stop loss, recovery, virtual hook, "Trade automatically"; best entries now; latest trades; More settings (entry, length, max trades, proven-edge-only, hook details, markets, activity log). Removed from settings: max stake (implied by multiplier x steps), per-market choice, recovery barrier fields.
- [x] Nothing removed: Overview, Live Scanner, Virtual Competition, AI Intelligence, Strategy Lab, Strategy Library and Trade History are under the Insights switch. Forward monitor, lab, Chief and market discovery keep running in the background.
- Tests: 359 pass across Apex Intel + Sixfold + Vanguard (1 fail + 1 error are the old FreeBotsPage import). Still no build, render or live run here.
- Note: all markets score close to chance on random digits, so the "best" entry is a ranking, not an edge; the 'Only proven edge' switch makes it wait instead.

## Completion pass: AI in live execution, strategies that execute, analytics (latest)
- [x] AI guard in live execution (`guard.ts`, setting AI guard Off / Guard / Strict, default Guard): every signal, real or paper, is checked just before it is bought: regime, winning digits drying up (last 100 ticks), strategy failing its forward test; Strict also needs a stable regime and, for main contracts, proven edge after false-discovery control. It can only block (fails closed), logs the reason, and the reason is written into each trade's log line. Rule-based statistics, no language model.
- [x] Autopilot (`autopilot.ts`, always on in the background): re-runs the Strategy Lab on markets with 1000+ ticks (new seed, every N min), approves strategies that passed validation on unseen ticks, activates them by level: Strict (60+ forward trades, interval floor above chance) / Balanced (30+ forward trades at or above chance, default) / Fast (on validation alone) / Off. Max running strategies, audit entries as `auto`. The executor then trades ACTIVE strategies as SMART entries (tested end to end: lab -> registry -> autopilot -> picker -> executor buys).
- [x] Forward monitor counts are saved in the browser and continue after a reload (open paper contracts restart).
- [x] Reconciliation: a real contract saved as open at reload is looked up on Deriv and its result filled in (or marked unconfirmed); never touches a running session.
- [x] Performance tab (`performance.ts`): equity curve, win rate, avg win/loss, max drawdown, longest losing run, by market / contract / recovery step, paper trades apart.
- [x] Trade screen: AI guard selector, "AI & strategies" card (Chief verdict, guard passed/blocked, strategies running), autopilot controls under More settings. The Chief and forward monitor now run whenever the app is open.
- Tests: 382 pass across Apex Intel + Sixfold + Vanguard (1 fail + 1 error = old FreeBotsPage import). Still no build, render or live run.
- NOT done: language-model explanations (needs an API key and a server function; none exists in this repo), server-side database (browser storage only), live Deriv verification.

## Done
- [x] Repo cloned, audited, branch created, plan committed.
- [x] Apex Intel tab wired into the app (types, PremiumLayout, header icon, nav catalog, apex-sentinel domain nav); site-config validators pass.
- [x] Stage 1: `sim.ts` (SimStream, SimBook, simulate) + `__tests__/sim.spec.ts` — 12/12 pass under bun's jest-compatible runner.

## Not done / next
- Execution has NEVER been run against real Deriv from here. Test on a DEMO account first.
- Next: strategy registry + persistence (IndexedDB), then Strategy Lab (CUSTOM/SMART candidates with train/validation split), then agents/AI Intelligence tab, then execution governance.
- Apex Intel page has NOT been opened in a browser or built (no npm here): it transpiles, validators pass, sim+analysis are strict-typed. First thing on a networked machine: `npm ci && npm run build && npm test`, then open the Apex Intel tab.
- BLOCKED here: `npm ci` (registry.npmjs.org does not resolve in this sandbox; it is on the proxy's no-proxy list, so I did not override it). So `npm run build`, repo jest/eslint and type-check have NOT run. Tests run with `bun test`; pure-TS modules only (no React) until a networked machine can run `npm ci && npm run type-check && npm test && npm run build`.
- Existing Sixfold suite under bun: 206 pass, 1 fail + 1 error (both 'react/jsx-runtime' missing from FreeBotsPage import, identical without my changes).
- Nothing pushed; main untouched.

---

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
- [x] **Vanguard: the Under 7 Psychology bot's entry rules on every market, bought through Sixfold's execution** (`premium/vanguard/`, small reusable hooks in `sixfold/`). Sixfold is unchanged in behaviour (its ten markets, best-score, its own settings; its page differs from before only by six `export`s and one phase label). Vanguard is its own menu entry with its own feed (20 markets: the ten Sixfold markets, Volatility 15/30/90/150/250 (1s) and the Jump indices), runner, module id (`vanguard`, so it never trades alongside Sixfold or Auto Trades), settings key (`vanguard.settings.v1`) and Transactions label. `vanguard/bot-rules.ts` is a port of the bot's Blockly logic (windows of 10/30/5/5 ticks, pressure and momentum per digit and per group, the 12-point regime score, Pressure Signal, Attack Veto, Winning Active, Digit 8 threat, the psychology gate, last digit <= 6) evaluated on each market's own digits, plus the bot's paper mode (two paper losses before a real trade, a real win returns to paper). It was checked against the real bot: the bot XML (V4, run unchanged in an offline interpreter) and the port made the same entry decision on all 7,500 ticks of three recorded streams (216 entries, 0 mismatches); the recorded decisions are in `bot-rules.spec.ts`. The runner takes an optional `rules` engine: every tick of every market goes to it and, on "enter", the existing `execute()` buys (Under 7, Under 6 + recovery stake after a loss, Sixfold stake sizing and caps, one trade at a time, stale-tick, refusal and unknown-outcome handling, take profit / stop loss / loss-streak stop). Defaults: stake/TP/SL are Sixfold's (not the bot's placeholders of 3 / 1 / 1, which would stop after one trade), recovery stake sized to win back 50% of the open loss (the bot's split of 2) with Sixfold's step and streak-budget caps, psychology gate at 1 (the bot's 2 let almost nothing through; selectable). The 1000-digit loop in the bot is not ported: nothing reads it. The Entry Authorized latch is not ported: before_purchase re-checks the same conditions on the same tick, so it adds nothing. 215 Sixfold-module tests pass under a tsx shim (including the engine-vs-bot golden test and trade-flow tests); strict `tsc` shows no new errors in the touched files. Also present but not used by Vanguard's page: an optional scanner-based "first to qualify" execution mode in the runner (Sixfold keeps Best score).
- [ ] Unverified against the live Deriv API: that `contracts_for` is answered on the public options endpoint in the shape assumed (`contracts_for.available[].contract_type`), which digit contracts the Jump indices and 1HZ150V/250V offer, and the Jump indices' tick rate. Until `contracts_for` answers, offers are treated as unknown (allowed); a market Deriv refuses at purchase is taken out.
- [ ] Vanguard is not run against live Deriv or built with `npm run build` here; the first Netlify build is the compile check.

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
- [x] **Vanguard: a separate execution tool across every market** (`premium/vanguard/`, plus reusable pieces in `sixfold/`). Sixfold itself is unchanged (its ten markets, best-score execution, its own settings). Vanguard has its own menu entry, feed, runner, module id (`vanguard`, so it can never trade alongside Sixfold or Auto Trades), settings key (`vanguard.settings.v1`) and Transactions source label. It scans 20 markets: the ten Sixfold markets plus Volatility 15/30/90/150/250 (1s) and the Jump indices (JD10/25/50/75/100), and uses Sixfold's scanner screen and rules unchanged. Execution is **first to qualify** by default: every contract passing the same eligibility rules is watched at once and the first to show its entry (entry digit, Entry Brain plan, recovery form, Meter last-look) is bought; **best score** is a switch on its page. One trade at a time, same stale-tick / refusal / unknown-outcome safety. The feed asks Deriv `contracts_for` per market and a contract Deriv does not offer there is not executable; unknown = allowed (Deriv's refusal at purchase quarantines the market). A market Deriv will not stream is left out without raising a feed error. Reusable changes in `sixfold/`: `markets.ts`, feed takes a symbol list, runner takes `moduleId`/`defaults`, `ScannerTab` is exported and takes a `tool`, `rankedPicks`/`offers` in the scanner, `execution` setting. 190 Sixfold tests pass under a tsx shim (28 new in `execution.spec.ts`); strict `tsc` shows no new errors in the touched files.
- [ ] Unverified against the live Deriv API: that `contracts_for` is answered on the public options endpoint in the shape assumed (`contracts_for.available[].contract_type`), which digit contracts the Jump indices and 1HZ150V/250V actually offer, and the Jump indices' tick rate. Until `contracts_for` answers, offers are treated as unknown (allowed).
- [ ] Vanguard's Meter tab and Lab are not duplicated: its page is the scanner screen plus the Meter strip. Sixfold's tabs stay on Sixfold.

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
- [x] **More markets + first-to-qualify execution** (`markets.ts`, `feed.ts`, `scanner.ts`, `runner.ts`, `money.ts`, page). Sixfold now tracks 20 markets: the original ten Volatility indices plus Volatility 15/30/90/150/250 (1s) and the Jump indices (JD10/25/50/75/100). New setting **Execution** (default *First to qualify*): every contract that passes the same eligibility rules is kept on a watchlist on every market at once and the first to show its entry (entry digit, Entry Brain plan, recovery form, Meter last-look) is bought; *Best score* keeps the old single-armed behaviour. Same rules, one trade at a time, same stale-tick / refusal / unknown-outcome safety. The feed asks Deriv `contracts_for` per market and a contract Deriv does not offer there is not executable; unknown = allowed (Deriv's refusal at purchase quarantines the market). A market Deriv will not stream is left out without raising a feed error. Saved settings get the new markets once (markets you turned off stay off). 26 new tests (`execution.spec.ts`); the older runner specs are pinned to Best score. 188 Sixfold tests pass under a tsx shim; strict `tsc` shows no new errors in the touched files.
- [ ] Unverified against the live Deriv API: that `contracts_for` is answered on the public options endpoint in the shape assumed (`contracts_for.available[].contract_type`), which digit contracts the Jump indices and 1HZ150V/250V actually offer, and the Jump indices' tick rate. Until `contracts_for` answers, offers are treated as unknown (allowed).

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

## Sixfold win-streak guard
- New `sixfold/streak-guard.ts` + settings `winStreakGate` (on), `winStreak` (6), `lossAbort` (1). The contract about to be bought (recovery barrier after a loss) must have won on each of the market's last N ticks (Over 2 -> WWWWWW). Checked on every tick, for every entry mode, including the instant-buy path.
- A market with too many losses in its last 10 (expected losses + `lossAbort`) is dropped, and the scanner skips it; it first prefers markets already part-way into a run of wins, then any non-aborted market.
- With the guard on, the old "wait for a losing digit" setups do not apply (the streak is the entry); Brain digits, recovery gates and Meter floors still apply on top.
- Tests: streak-guard.spec.ts, two runner tests.

## Sixfold purchase timing
- Investigated "delayed execution": a confirmed entry calls `execute` synchronously from the feed tick and sends one `buy` request (no separate proposal, no timer). The only built-in pause is the 1 s cooldown after a contract settles.
- Added measurement: every Bought log line now shows ms from the trigger tick to the buy being sent and the buy round trip; after settlement a warning appears if the contract started later than the very next tick (`reportStart`, uses Deriv's entry tick time vs the trigger tick epoch). `sixfoldFeed.getLastEpoch`.

## Sixfold Virtual Hook
- Studied the bot builder's Virtual Hook (`tradeEngine/trade/VirtualHook.js`): after N real losses it trades with zero stake, settled on real ticks, and returns to real after M consecutive virtual wins (or a fixed count); virtual results skip the strategy's martingale logic and are excluded from run totals.
- Sixfold port: `virtual-hook.ts` (state machine) + runner integration. Settings `virtualHook` (off by default), `vhMode` STREAK/FIXED, `vhEnterLosses` 2, `vhReturnWins` 2, `vhFixedCount` 3. Paper trades use the same picks, entry rules and guards, settle on the market's ticks (exit on the d-th tick after the trigger), show in the transactions panel as Virtual, and never touch session P&L, stakes, loss counts or the stop rules. A paper trade with no ticks for 120 s is dropped.
- UI: Scanner switch + fields, status chip (real/virtual, progress, paper record), "Virtual" tag on trade rows. Tests: virtual-hook.spec.ts plus a runner test.

## Sixfold repairs: paper opening, clean first run, winning-side pressure
Done (204 sixfold tests pass under bun; strict tsc clean on runner / pressure / money; page typechecked against React stubs):
- [x] Virtual hook from the start: new setting "Open every run on paper" (`vhOpening`, default ON). Each Run's first trade is virtual. A paper win starts real trading; a paper loss stays on paper until one wins. Paper trades never touch the session, stake ladder or martingale. The regular Virtual Hook (after real losses) is unchanged and still has its own switch.
- [x] First run follows the rules: Run now starts from a clean slate (no scan, Brain read, guards from before Run or from older settings), and nothing is bought on a tick that printed before Run. Each market must print a fresh tick after Run first, then every gate (plan, streak, Meter, pressure, windows) is read on that tick. Previously the arming step could buy on the last pre-Run digit.
- [x] Winning-side pressure gate (`winPressureGate`, default ON, `winPressureMin` default 2 pp): the digits that win the contract about to be bought must gain share step by step across the 120 / 60 / 30 / 15 windows, with the latest window at or above fair. Flat ("dormant") or falling markets are not traded; the reason is shown in the queue. Works with the existing losing-side pressure gate and multi-window health.

Not done / unverified:
- [ ] `npm ci`, full build, repo jest/eslint (registry blocked here). No live or demo run.
- [ ] The winning-side gate trades less often; if it is too strict, lower "Min gain (pp)" or switch it off.
- [ ] I could not reproduce the first-run entry live. The cause found in code was the arm-time purchase using a pre-Run digit plus state carried over from before Run; both are closed, but watch the first trade of the next demo run.

Next: demo run, confirm the opening paper trade and the first real entry in the Activity log.

## Bulk Trader consolidation
- [x] Removed the round "runner" dial from the Bulk Trader. Auto Trader is now a Run/Stop bar with status, Runs, Won / Lost and P/L.
- [x] All Auto Trader parameters kept with the same labels, folded under "Auto trader parameters". Manual trading unchanged.
- [x] "View" menu (remembered in the browser) shows or hides: Fusion signal, Auto trader, Run results, Logs and tables, Notes and explanations. The live digit distribution and the Over / Under buttons are always shown.
- [x] Signal lock and One tick switches stay always visible next to the Over / Under buttons ("Notes and explanations" in View only adds their descriptions).

Not done / unverified: Jest could not run here (registry blocked); checked by type-check and a browser render only. Not run against live Deriv.

## Sentinel AI: mandatory special-digit rule (digit 1 and digit 8)
- [x] `sentinel/special-digits.ts`. Over trades only while digit 1 (loses Over) is dormant or falling AND digit 8 (wins Over) is increasing. Under: digit 8 dormant or falling AND digit 1 increasing. "Increasing" = prints per window rising: last 30 vs the 30 before together with last 15 vs the 15 before, or a jump of 2 between neighbouring windows, or a rise in all three 30-tick windows. Fewer than 120 ticks = held back.
- [x] CORRECTION: the first version blocked on a surge of the winning digit (the reverse of what was asked). Now the winning special digit must be increasing. `CHECK_WINNER_RISING` turns only that second check off; the first check has no switch.
- [x] Applied in every mode (the Hunter too): at scan time (`overlay.call`, shown in the queue) and on every tick before a buy (`overlay.guard` via `brainOk`, drops the arm, rests the contract 5 s, arms another market). Uses the contract that would be bought (recovery barrier included).
- [x] Specs: special-digits.spec.ts, runner.spec.ts (guard). Same 6 settings-spec failures as before this change.
- Measured on 200k random digits: Over passes ~32% of moments, Under ~23%. It waits, it does not stop for good. Thresholds are constants at the top of the file.
- Not done: Vanguard, Sixfold and Apex Intel (Sentinel AI first, as asked). Not run against live Deriv.
- [x] Last look inside the buy step (`lastLook` in `execute`): the special-digit rule is read once more for the contract about to be bought, so every route to a real-money buy passes it. Each passing trade logs "Special-digit check passed on <market>: digit counts"; a refusal logs "not bought: reason".

---

## Sentinel AI edge gates: Kalman health, cross-market danger + frequency, arbiter (latest)
Ported from the Precision Vantage zip (Precision Edge V2 / CIO) and built into Sentinel AI only. No screen changed: everything lives in `src/components/premium/sentinel/edge/` and plugs into the existing overlay (`overlay.ts` refresh / call / guard / onBought / onSettled), so it changes which signals come up for execution.
- **Kalman health** (`kalman.ts`): filtered win rate of each contract over the last 600 ticks with its uncertainty and drift. Vetoes a signal whose filtered rate is not above fair or that is decaying; eases the bar / ranks up a confident one. Hunter: never vetoes on level (bar only). Recovery trades are never refused for a weak level.
- **Cross-market danger + frequency** (`danger.ts`): cold spike, common-factor test (markets skewed the same way together) and digit surge fold into a 0-100 score; high/extreme holds every signal, elevated raises the bar. Frequency: cooldown per market after a buy (20 s), a signal must hold 2 scans, 40 trades/hour budget (not in Hunter); none of it delays a recovery trade. The zip's inputs (manipulation/crowding) do not exist here, so inputs were rebuilt from live digits.
- **Arbiter** (`arbiter.ts`): one pick per market, abstains when the best Over and best Under contradict (within 4 points), sticky pick, and the OTHER signal source (Pulse vs Digits Analysis) counts as a second opinion.
- **Evidence** (`influence.ts`): each time a gate stands a signal down, the next tick on that market is recorded as if it had been traded; trades actually settled are split live vs shadow. Console: `sentinelEdge.print()`, `sentinelEdge.set({ shadow: true })` (measure without acting), `sentinelEdge.set({ kalman: false })` (switch one off), `sentinelEdge.reset()`. Stored in `sentinelai.edge.settings.v1` / `sentinelai.edge.ledger.v1`.
- Tests: 58 new (Kalman, danger/frequency, arbiter, overlay integration). Apex Intel + Sixfold + Sentinel suites under bun: 491 pass, same 7 fail + 1 error as before (the `window`-less settings specs and the old FreeBotsPage import). New files type-check clean under the repo's strict config; NOT done: `npm run build`, eslint, a render, or any live Deriv run.
- Honest limits: Deriv digits are random. The danger gate stays calm on independent markets (0 of 400 random books blocked in the test) and the Kalman drift rarely fires on fair data (<5%); the gates decide WHICH signal and WHEN, they cannot create an edge. Judge them with `shadow` on and off over a few hundred trades before trusting them.
## Bulk Trader: market scanner and entry digit
- [x] `bulk-scan.ts` (pure engine). "Scan markets" reads all 13 markets for 5–30 s (default 20) on new ticks only and returns the market, the contract (Over 1/2/3, Under 6/7/8) and an entry digit. Gates: distribution edge, winners building, losers fading, end digit not climbing, no loss cluster, special digits 1/8. Independent of Fusion (Fusion left unmodified).
- [x] Entry digit found by replay: picked on the older 2/3 of ticks, checked on the newest 1/3 ("confirmed" at z ≥ 2.58 Bonferroni, otherwise "weak").
- [x] Load works two ways: click ("Load to Trading Deck", "Use digit N only") or automatic after a scan (toggles). Entry works two ways: Instant, or Wait for digit (buys only on a NEW tick showing the digit; times out, Cancel wait available). Entry digit is typed, loaded from a scan, or set by clicking a digit ring.
- [x] Manual Bulk Trader flow and all parameters unchanged; digit distribution and Over/Under buttons always shown. A scan pick bypasses the signal lock for that side only.
- [x] Checked: bulk-scan.spec.ts (15 pass), tsc (stub baseline errors only), browser render desktop + 390 px (no overflow, no console errors).
- Not verified: BulkTraderView.spec.tsx (.tsx specs cannot run here), live Deriv. Many scans end with "closest" rather than a pick (~1% of random looks pass every gate). Digits are random: a scan changes when and where you trade, not the odds.

## Bulk Trader: scanner rules applied to Fusion signals
- [x] Fusion's signals must now also pass the scanner's gates (`checkFusionRules` = `readCell`: distribution edge, winners building, losers fading, end digit not climbing, no loss cluster, special digits 1/8) on that market's live digits. Fusion (src/lib) is untouched.
- [x] Enforced in four places: the recommendation offered (`recommend(..., accept)` via `bulkFeed.accept`), the validity check (`validateRecommendation(..., rules)`), the signal-lock gate (`executeGate(..., rules)`) and the Auto trader (it uses the same validity check). A refused signal shows the reason, e.g. "Scanner rules block Over 2: Special digits 1 / 8."
- [x] Switch "Apply these rules to Fusion signals" in the scanner panel, ON by default, remembered in the browser. Off = Fusion exactly as before.
- Specs: bulk-scan (19), over-under-engine, bulk-engine all pass under Bun. Not run against live Deriv. Expect fewer Fusion signals; the rules cut the number of trades, not the randomness of digits.

## Edge gates on Sixfold, Vanguard and Apex Intel (same three gates as Sentinel AI, commit 868ee32)
Asked: add the Kalman health, cross-market danger + frequency and arbiter gates (built for Sentinel AI) to Vanguard, Apex Intel and Sixfold. Chosen: arbiter runs on the runner's own eligible cells (small shared hook); straight to main.
Plan: 1) generalize the edge layer + runner hook, 2) Sixfold + Vanguard, 3) Apex Intel, 4) verify + push.
- [x] Step 1 + 2 (Sixfold, Vanguard). Same gates, same defaults as Sentinel (all ON, `shadow` off). They only veto, ease or rank; no entry plan, contract, stake or recovery step is changed, so Sixfold's "every trade is on a plan" rule is untouched.
  - Shared runner: new optional overlay hook `arbitrate(eligible, now)` (the cells that pass the runner's OWN bars, Meter and guards, called every scan) and `guardLabel` (log wording; Sentinel keeps "Special-digit check"). Overlays without them behave exactly as before.
  - Edge layer: `sentinel/edge/` now takes a storage key per engine (`browserLedger(key)`, `loadEdge(key)`/`saveEdge(s, key)`), and `refresh({ board: null })` + `arbitrate(board)` for engines whose board only exists after the scan. Sentinel's own calls are unchanged.
  - New `edge-gates/`: `cell-row.ts` (a scanner cell read as a board row: 70+ strong, 62+ steady, else watch, the scanner's own bars), `runner-gates.ts` (`createGateOverlay`, `createEngineGates`).
  - Wired in `sixfold/runner-instance.ts` and `vanguard/vanguard-instance.ts`. Console handles `sixfoldEdge` and `vanguardEdge` (same shape as `sentinelEdge`: `set({ shadow: true })`, `set({ kalman: false })`, `print()`, `reset()`). Separate settings and evidence keys per engine.
  - 28 new tests; Sentinel + Sixfold + Vanguard + Apex Intel suites: 519 pass, the same 7 failures and 1 error as before (window-less settings specs, old FreeBotsPage import). Changed files type-check clean.
- [x] Step 3: Apex Intel. The gates sit AFTER its AI guard (`assess` is unchanged and runs first); a signal it passes then meets the gates, which can only block. UI unchanged.
  - Executor: three optional hooks, `onBoard(ranked, recoveryRanked, now)` (the full ranked book before the one-per-market cut), `onBought`, `onSettled`. Absent hooks change nothing; a throwing hook never stops a board refresh, a buy or a settlement.
  - `edge-gates/apex-gates.ts` (`createApexGates`): the arbiter reads the whole ranked book (so it can abstain when Over and Under are about equal, or stand down a weaker direction); picks become rows (proven = strong, lower bound above chance = steady, else watch; score 0-100 = 50 + 400 x score). Danger, Kalman, frequency and the buy-tick last look run in `review`. Recovery signals: no cooldown, hold or budget, no arbiter row.
  - Veto-only here (Apex Intel has no score bar or ranking to ease). A veto shows as `AI guard skipped ...: edge gates: <reason>` in the existing log and counter. With the AI guard OFF Apex Intel runs no checks, gates included.
  - Console handle `apexIntelEdge` (same shape as the others; own settings and evidence keys). 14 new tests. Premium suites: 892 pass, same 51 failures and 3 errors as before the change (window-less settings specs etc.). Changed files type-check clean.
- Known behaviour to measure, not hide: (a) Kalman's "not above fair" veto reads the contract's raw win rate, while Sixfold/Vanguard score entry-conditioned simulated trades, so on a market where only the entry-conditioned rate is high the gate stands the cell down (shadow mode shows how often); (b) default cooldown 20 s per market and hourly budget 40 will slow a fast session: `sixfoldEdge.set({ hourlyBudget: 0, cooldownMs: 0 })`; (c) no Hunter here, so the level rule and the budget always apply.
- NOT verified: `npm run build`, eslint, any React render, any live Deriv run (registry unreachable here). Run first on a networked machine: `npm ci && npm run build && npm test`, then a DEMO account with `sixfoldEdge.set({ shadow: true })` to compare.

## Manual Trader (exact Deriv DTrader frontend) — branch `feat/manual-trader`
Goal: a "Manual Trader" tab that is the real DTrader screen from `vmainamc-hub/db-traders-` (packages/trader, route "/"), not a rebuild. The existing "DTrader" tab (`dtrader/DTraderPage.tsx`) is untouched and stays as is.
Approach (chosen by the owner): same-origin iframe. The source's own app is built once and served from `/br_manual-trader/`; the new tab shows it in an iframe. Reasons it is not a code copy: the trader is ~650 files on React 17 / react-router 5 / webpack and reads its state from `@deriv/stores`, `@deriv/shared`, `@deriv/components` and core stores (client, ui, portfolio, common, ...) that this app does not have.
- Folder name: must start with `br_`, the only prefix the source router (`packages/core/src/App/app.jsx`) accepts as a base path.
- Login: no second Deriv login. `ManualTraderPage` copies the app's own sign-in into the keys the DTrader build reads (`deriv_oauth_session`, `deriv_oauth_accounts_raw`, `deriv_oauth_app_id`) and opens it with the acct1/token1/cur1 address (tokens there are `oauth:<account_id>`, never the bearer token). It opens on the account Sentinel is already on, else demo.
- Storage: the build shares this origin's localStorage/sessionStorage and both apps use the same key names with different values (`active_loginid`: real id here, `VRTC...` alias there). `scripts/manual-trader/storage-isolation.js` is inlined first in the built `index.html` and namespaces every key `mt:` except the three shared ones.
- Source patch (only one): the one-time-WebSocket request in `packages/shared/src/utils/config/deriv-socket.ts` also sends `Deriv-App-ID`. Nothing in packages/trader changes.

### Done
- [x] Tab `manual_trader` ("Manual Trader"): `types.ts`, `site-customization.ts`, `PremiumLayout.tsx` (lazy page + case), `catalog.json` (regenerated with `scripts/site-customization-catalog.js`), `domains/apex-sentinel.json`
- [x] `manual-trader/manual-trader-session.ts` (pure hand-off logic) + `ManualTraderPage.tsx` + scss; shows "not installed yet" until the build is in place (checked via `/br_manual-trader/manual-trader.json`, so the SPA fallback page cannot fool it)
- [x] `netlify.toml` rewrite for `/br_manual-trader/*`
- [x] `scripts/build-manual-trader.sh` (`npm run build:manual-trader`): fetch source commit `5f15b9a`, patch, build with the source's own sub-folder flow, inline the isolation script, install into `public/br_manual-trader/`, write the manifest
- [x] Checked offline: `node scripts/manual-trader/storage-isolation.test.js` passes; session logic run under Node; the build script's patch and inline steps dry-run on copies (patch fails if its anchor ever stops matching once); `bash -n` ok; JSON files valid

### Not done / not verified
- NOT done: the source build itself (needs Node 18 and the npm registry; unreachable in the session that wrote this). Until `npm run build:manual-trader` runs, the tab shows the "not installed" notice.
- NOT verified: that the source builds under `/br_manual-trader/` (header/footer checks of the form `pathname === '/'` in core may not match under a sub-folder), that the iframe loads, that the bridged token authorizes (OTP request with `Deriv-App-ID`), that the storage isolation works in a real browser with the trader's libraries, `npm run build`, `npm run type-check`, `npm test` (the new spec is written, not run).
- NOT decided: whether the built folder is committed (check size; GitHub rejects files over 100 MB) or built in CI.
- Not handled: `ultimatetraders` / `vantagetraders` hosts are not in `brand.config.json` `sites.entries` (only sendivinnie, precisionapex and one preview), so sign-in fails closed there regardless of this feature.

### Next
1. On a machine with Node 18 and network: `npm run build:manual-trader`, fix whatever the first real build reports.
2. `npm ci && npm run type-check && npm test && npm run test:manual-trader-storage`.
3. Open a branch deploy with a DEMO account: Manual Trader tab loads, balance shows, one demo trade works, and Sentinel's active account is unchanged afterwards.
4. Only then decide on committing the built folder and merging.


### Manual Trader repair (2026-11-04)
- Fixed the endless loading dots: the bot app owned route "/" (now "/bot"), the sub-packages loaded files from "/" instead of the build folder, and the trader dropped the folder from the page address. All three are patched by `scripts/manual-trader/patch-built-output.js`, which `npm run build:manual-trader` now runs.
- The trader's own header (second account, Reports, bell) is hidden; the account comes from Sentinel. The page reopens the trader when the active account changes.
- Trade form layout fixed (chart left, Rise/Fall form right).
- Verified in a headless browser against a simulated Deriv API only; a real demo trade is still to be confirmed on the live site.

### Manual Trader: screen freezes after a trade settles (2026-11-05)
- Symptom: after a trade settles the chart cursor and Last Digit panel stop; the market keeps ticking. The earlier tick watchdog only reacted when NO ticks arrived, so it stayed silent if some stream kept ticking while the one feeding the screen was gone.
- `scripts/manual-trader/tick-watchdog.js` now also watches `.digits__container`: ticks arriving (6+ over 8 s) while its markup does not change = frozen screen -> restart the connection, then reload the frame once (max once a minute). Tests added in `tick-watchdog.test.js`.
- `?mt_debug=1` readout now also shows the panel age, restart count and the last 14 socket calls (ticks left out), to see what the app sent just before a freeze.
- NOT confirmed: the root cause. Suspects seen in the code, not proven: `deriv-socket.ts` sends `forget` / `forget_all` raw to BOTH sockets (two replies with the same req_id), and after sign-in ticks are requested on the account socket while earlier streams live on the public one. Needs a freeze captured with `?mt_debug=1`.
- Update (same day): the `?mt_debug=1` readout showed the feed was NOT frozen (ticks 0.7 s old, panel changing, both sockets open). Only the Last Digit pointer stayed on the finished contract's digit. Cause: the panel follows the contract's tick stream until `isContractElapsed()` is true, which needs `getEndTime()` -> legacy `is_expired`; unverified whether the new API sends it. `patch-built-output.js` step 8 (a) makes the Digits wrapper treat a won/lost/sold contract as elapsed 2 s after its end (live tick epoch vs sell_time / exit_tick_time / date_expiry / last contract tick), (b) fills `is_expired` and `exit_tick_time` in the adapter when missing. Both patched in `public/br_manual-trader`. Still to confirm on the live site with a demo trade.
- Update: the digit fix did not show for the owner because the trader's service worker serves everything under /br_manual-trader/ cache-first for 24 h and the patched files kept their names. `TRADER_PAGE_TAG` bumped to `mt_page=10` and the one-time reset in `ManualTraderPage.tsx` now also deletes the worker's caches. RULE: bump the tag whenever anything under public/br_manual-trader changes.

### Manual Trader: extra Last Digit colours (2026-11-05)
- The trader shades the most frequent digit green and the least frequent red. `scripts/manual-trader/digit-highlights.js` adds: 2nd most frequent = blue ring, 2nd least frequent = violet ring, most increasing = gold glow (can sit on top of any ring). Hover a digit for its label.
- "Most increasing" = biggest gain in a digit's share versus 100 stats updates ago (set `localStorage` `digit_trend_window` to 5..900 to change; needs ~10 updates of history before it shows; a gain under 0.05 points counts as nothing). Ties for the 2nd places shade every tied digit.
- It only reads the percentages on screen and adds CSS classes, inside try/catch, so it cannot affect a trade. Inlined at the end of `<head>` of `public/br_manual-trader/index.html` (step 9 of `patch-built-output.js`; for the installed folder it was applied on its own because re-running the whole patch script on an installed folder stops at step 8, whose anchor is already patched). `TRADER_PAGE_TAG` bumped to `mt_page=11`.
- Checked: `node scripts/manual-trader/digit-highlights.test.js` (ranking logic) and a run of the installed script against a fake page. NOT checked: how the colours look in a real browser (ring/glow visibility on the light and dark themes).

### Manual Trader: "Sorry for the interruption / internal server error" in the middle of an analysis (2026-11-05)
- Cause (from the source, not yet seen live which request it was): `packages/core/src/Services/socket-general.js` shows the full-screen error box with the server's message for ANY reply whose error code is `InternalServerError` or `OutputValidationFailed` (except mt5_login_list). One temporary error from the new Deriv API on any single request therefore replaced the whole screen.
- Fix: the socket adapter gives those two codes the code `ServerTemporarilyUnavailable` (original in `original_code`, message unchanged), so the global handler ignores them and only the part of the screen that made the request sees the error. `scripts/manual-trader/soft-server-error-patch.js` (applied to `public/br_manual-trader/js/core.main~n...js`, step 10 of `patch-built-output.js`), test `soft-server-error-patch.test.js`. `TRADER_PAGE_TAG` bumped to `mt_page=12`.
- Trade-off: a genuinely broken server now shows per-request errors (e.g. in the trade form) instead of one box. If a request keeps failing, the part of the screen that needs it will not update.
- NOT confirmed: which request produced the error, or that it is the only thing that interrupted the session. If the box still appears, note the time and what was on screen; the old `?debug=1` panel (inside the trader frame) lists the failing call.

## Elite Prime (Pro): own entry conditions for recovery trades
Branch `feat/elite-recovery-conditions` (not on main; main auto-deploys). File: `src/components/premium/hub360/ElitePremium.jsx` (+ 2 css lines in `ElitePrimeLite.css`).
- [x] Recovery card has its own "Recovery entry conditions" builder (same lookback / digits-or-moves / OVER-UNDER digit rules, up to 4, "+ CONDITION", live summary line) and its own "Recovery duration (ticks)"; set before Run, locked while running.
- [x] After a loss (Recovery mode on) the bot waits for the RECOVERY conditions on any selected market, then places the recovery contract. The strategies' conditions are NOT used for recovery. No recovery conditions = trade on the next tick.
- [x] Recovery trades go through a separate `executeRecoveryTrade` (labelled "Recovery" in transactions/last signal). Martingale stake, win-returns-to-main, and "One recovery trade, then back" behave as before; after a recovery trade the bot no longer jumps straight into the main strategy without its conditions.
- [x] Start-time validation of recovery conditions; history buffers sized to include recovery lookbacks.
- Checked: file transpiles (bun) and the new helpers were run on sample digits. NOT done: `npm run build`, eslint, render test, live/demo run (no node_modules / registry here). NOT done: same change for Elite Prime LITE (`ElitePrimeLite.jsx`) - its builder UI is different, ask if wanted.
- NEXT: run `npm ci && npm run build`, try on a DEMO account (lose a trade, confirm recovery waits for its own conditions), then merge to main.

## Overlord recovery digit + stuck 10 USD transaction
- [x] Overlord (`hub360/Overlord.jsx`): recovery digit was only used when the recovery contract TYPE differed from the main one, so OVER 2 -> recovery OVER 3 kept trading OVER 2 (martingale stake only). Now recovering = Recovery on AND last trade lost (RISE/FALL pairs unchanged). Proposal log line shows RECOVERY and the digit sent.
- [x] Stuck pending row: run-panel transactions are cached in session storage and an unfinished contract (here #37289745799, 2026-11-05, 10 USD) was shown forever. `src/utils/stale-pending-transactions.ts` drops unfinished contracts older than 24 h when the store loads and on every new transaction; 5 tests pass under bun. Finished trades are never touched.
- NOT verified: npm build, eslint, a live/demo Overlord run. NEXT: after deploy, hard-refresh and run Overlord on Demo: lose one trade, confirm the log says RECOVERY OVER 3.
- [x] Stale row kept coming back after Reset: `GlobalContractBridge` (portfolio recovery + account-wide `proposal_open_contract` stream) re-sent the old unfinished contract and `pushTransaction` re-added it. `TransactionsStore.pushTransaction` now refuses unfinished contracts older than 24 h, whatever the source. Checked with API-style epoch and stored-string start times under bun. NOT verified: npm build, eslint, live run. NOTE: a multiplier left open for more than a day would also be hidden from the run panel.

## Oracle: assessment window, losing-digit risk, best-available Even/Odd, compact layout
- [x] Over/Under no longer signals instantly. A scan is an 18 s assessment (Even/Odd 15 s). It keeps reading live ticks, then gives one verdict. `StabilityTracker` records how often each contract was STRONG / clear during the window; STRONG at the end needs it STRONG now and in >= 60% of the window, otherwise it is offered as BEST AVAILABLE. If markets still have too few ticks at the end it waits up to 12 s more, then answers with what it has.
- [x] New layer `risk` (over-under.ts, `readLossRisk`): share of the last 30 / 100 / 300 ticks that LOST the contract against its fair losing share (z-scores). HIGH = hard veto, ELEVATED = never STRONG. A market whose leading contract is vetoed is FLAGGED and listed (max 3) while scanning and on the signal card. Thresholds are in `readLossRisk`.
- [x] Even/Odd always answers: STRONG when all six rules hold, else BEST AVAILABLE with a match % (half rules passed, half board strength) and "n of 6 rules". Under 4 of 6 shows a weak-board warning.
- [x] Layout: card is 460 px wide (was 1240), Scan and Run sit side by side directly under the tabs so the run panel cannot cover Run; subtitle and the long check list are gone (the checks are under "Why this one").
- Checked: 29 oracle tests pass under bun (11 new: risk, flagging, stability, assessment timing, Even/Odd best available); tsc shows no errors in oracle/; layout rendered in Chromium from the real Oracle.css. NOT done: `npm run build`, eslint/prettier (not installed here), a live run on Deriv. Loss-risk thresholds are untuned.

## Free Bots: renames and removals (2026-11-10)
- [x] Edited `public/free-bots/domains/apex-sentinel.json` (the manifest zenith-traders uses) and its identical copy `public/free-bots/bots.json`. 105 -> 90 bots, `count` updated.
- Renamed (number prefix kept, ids and files unchanged so loaders that look bots up by id keep working): 1, 5, 9, 10, 13, 15, 17, 18, 28.
- Removed from the list: 2, 3, 7, 8, 11, 12, 14, 19, 20, 21, 22, 23, 24, 25, 27. Their XML files are still in `public/free-bots/uploads/` (only the list entries went). Remaining bots keep their original numbers, so the list has gaps.
- NOTE: every site in brand.config.json (apex-sentinel x3 and zenith-traders) points at this one manifest, so all of them show the new list. To give one site its own list, copy the manifest to `domains/<site-id>.json` and point that site's `bot_library.manifest_url` at it.
- Checked: `node scripts/validate-free-bots.js` passes (90 assets); diff by id shows exactly 9 renamed, 15 removed, 81 untouched.
- [x] Free Bots renumbered 1-90 in display order (name prefix and `priority` both updated; ids, files and order unchanged). Earlier numbers in this log (bot 5, 18, ...) refer to the OLD numbering. Old -> new for the ones that were renamed: 1->1, 5->3, 9->5, 10->6, 13->7, 15->8, 17->10, 18->11, 28->13.

## forwardtraders.netlify.app registered (2026-11-10)
- [x] `brand.config.json`: new site `forward-traders` (host forwardtraders.netlify.app, redirect https://forwardtraders.netlify.app/callback). It reuses the existing Deriv OAuth client_id 34BIr72thLXMJHaL9PQxN; if a NEW Deriv OAuth app is created for this URL, replace `client_id` in this entry with the new one.
- [x] `public/site-config/domains/forward-traders.json`: copy of zenith-traders (same tabs and colours). Without this file the site would fall back to the 13 default tabs.
- Same Free Bots list as the other sites (shared manifest).
- Still outside the repo: Netlify env vars GD_CLIENT_ID / GD_APP_ID / GD_API_KEY on the forwardtraders site (Google Drive), and the redirect URL registered on developers.deriv.com (and Google Cloud origins for Drive).
- Manual Trader bundle still carries its own fallback login for dbbtradders.netlify.app (same as zenithtraders today); not changed.
- Checked: registry/customization/free-bots validators pass; simulated host resolution and the oauth-token function for the new host (200, correct redirect_uri; wrong site id is refused). NOT checked: a real login, which needs the redirect URL registered on Deriv first.

## Free Bot 7 (Over 1, Recovery Over 5/Under 4 Premium Bot): Portuguese -> English (2026-11-10)
- File: `public/free-bots/uploads/apex-sentinel/d5-original-version.xml` (id d5-original-version). Only the NAMES of 9 variables changed (32 lines); the message strings were already English. Variable ids are unchanged, so the logic is identical (checked by parsing both XMLs: same structure once the names are mapped).
- Deixar em 8 ou 9 -> Leave at 8 or 9 | Número de loss ( Não Alterar ) -> Number of losses ( Do Not Change ) | Entrada Inicial -> Initial Stake | Parar com perda de -> Stop at loss of | LUCRO DESEJADO -> DESIRED PROFIT | Contador -> Counter | ENTRADA AO VENCER -> STAKE ON WIN | 1 ou 2 segundos -> 1 or 2 seconds | Gale -> Martingale
- Not checked: loading it in a live Bot Builder (no Blockly here). The Manual Trader's own bundled bot app has an unrelated copy of the Portuguese names; not touched.

## Free Bot 7: split martingale that recovers ALL losses in parts (2026-11-11)
- File: `public/free-bots/uploads/apex-sentinel/d5-original-version.xml`. Contract choice (before_purchase), Over 1 entry, 5/6 recovery predictions and the stop-loss/take-profit block are unchanged.
- Old behaviour: stake += last loss x Martingale(0.8); ANY win reset everything, so a win that did not cover the whole loss left the loss unrecovered.
- New: `Total Loss` counts every losing trade; every win subtracts its profit. After a win, if `Total Loss` is still above 0.005 the bot STAYS in recovery (does not reset). It resets (stake, lost, Counter, Total Loss, Parts Left) only when Total Loss is fully recovered.
- Stake in recovery = round-up-to-cents( (Total Loss / Parts Left) / payout ratio ), never below STAKE ON WIN. Payout ratio = (1 - Payout Margin) / Win Prob - 1, Win Prob = (9-p)/10 for Over, p/10 for Under. Each win recovers one part; `Parts Left` drops by 1 after each partial win (min 1), so the last part recovers everything still owed. Losses add to Total Loss and the next stake is re-sized.
- New settable variables (INITIALIZATION): `Recovery Parts` = 3 (replaces the unused-now `Martingale`), `Payout Margin` = 0.025. Internal: Total Loss, Parts Left, Win Prob.
- Checked: XML well-formed; validate-free-bots passes; ran the actual XML blocks in a Python interpreter over random digits (60 runs x 3000 trades, payout margin 2.5% and 4%): 0 recovery cycles ended below zero (old bot: 65% of cycles ended negative, avg -1.24 per cycle). Recovery Parts 5 and 8 behaved the same.
- Cost: stakes in a long losing run get large (last part is a full martingale). Simulated peak stake median ~690 (p99 ~16,000) over 3000 trades with stake 1, because the simulation does NOT apply the Stop at loss of = 1000 limit.
- Not checked: loading in a live Bot Builder / real Deriv payouts (Blockly not available here).

## Overlord: advanced Over/Under Find Market engine applied from patch (2026-11-11)
- Applied the user-supplied patch `overlord-advanced-over-under.patch` unchanged: new `src/components/premium/overlord-engine/` (engine, history, legacy, apex layers, 2 spec files) and edits to `hub360/Overlord.jsx` / `Overlord.css`.
- Find Market now uses it for Over/Under only (deep 5000-tick history per market, then the engine); Even/Odd keeps the old scan. Optional checkbox lets the engine also pick side and barrier.
- Checked: patch applied cleanly on main; its 20 tests pass under bun; Overlord.jsx transpiles. NOT checked: live behaviour in the browser, real Deriv history responses, or the earlier "arrow shows Over on an Under trade" report (not yet investigated).

## Free Bot 7: recovery barriers set to Over 4 / Under 5 (2026-11-11)
- User report: bot should trade Over 1, then recovery Over 4 and Under 5; trades looked wrong (Under placed, arrow showed Over).
- Finding: the Transactions arrow/label is drawn straight from the contract_type Deriv returns for the bought contract (transaction.tsx -> TradeTypeIcon(contract.contract_type)), and Purchase/selectProposal buy exactly the type the bot asks for, so no display fault found in the app. The bot itself was the mismatch: recovery used a RANDOM barrier 5 or 6 for BOTH sides (after the 1st loss it bought OVER 5/6, after the 2nd+ it bought UNDER 5/6).
- Fix (XML only, `d5-original-version.xml`): contract choice untouched; barrier now follows the contract: Over 1 first -> after 1st loss OVER 4 -> after the 2nd+ loss UNDER 5. Applies in the loss branch and the partial-win recovery branch; Win Prob for stake sizing uses the same barriers (0.5 each).
- Checked: XML well-formed, validate-free-bots passes, simulated 40 runs x 3000 trades: only (OVER,1), (OVER,4), (UNDER,5) are ever bought; 0 recovery cycles net negative.
- Manifest name still says "Over 5/Under 4" (not changed). Not checked live.

## Overlord: "Any market" toggle + engines judge every candidate (2026-11-11)
- `Overlord.jsx` (Over/Under only): new checkbox "Any market: the engines pick it for me". When on, the market dropdown is replaced by a read-only "engine picks" box, the button reads FIND ANY MARKET, and RUN scans and picks the market itself first (reuses a pick made less than 90 s ago). Setting is remembered per browser (localStorage, optional). The existing checkbox still lets the engine choose side and barrier too.
- Run handler now reads symbol/contract from refs (set directly after a pick) so the first trade uses the picked market even though the pick happens in the same tick.
- Slow walk-forward model engine now runs on EVERY candidate (selected mode: all 11 markets; smart mode: top 24) instead of top 6.
- Measured on random 5000-tick data (like Deriv synthetics), 40 scans (Over 2, selected mode): best tier BEST 39 / STRONG 1; 69% of candidate readings hit a hard veto (signal-life/Kalman most often, then Apex edge, risk); pick equals the old lowest-share pick 0/40 and equals pure score order 88%; next-500-tick win rate engine 70.05% vs old rule 69.92% vs random market 70.17% (fair 70%): no measurable edge, as expected for random digits.
- Not checked in a browser; Even/Odd, Rise/Fall, Matches/Differs still use the old scan.

## Overlord: more Apex Sentinel engines in the backend (2026-11-12)
- Source: user-supplied zip `precisionapex6-main` (Apex Sentinel tool). Engines already in the patch (stats, pressure, entropy, regime, psychology, exposure, special digits, threat, bars, critical, ML ensemble) were left as they are.
- Newly ported (pure, under `overlord-engine/apex/`): `agreement.ts` (engine agreement), `clearance.ts` (instability / "rogue market" + danger clearance), `fluctuation.ts`, `stage-direction.ts` (Stage 1), `stage-danger.ts` (Stage 2a), `intel.ts` + `sim-types.ts` (types). New `apex-stages.ts` builds Apex's market-intel object from the deep history and runs them; `engine.ts` adds layers apexAgreement (required, HARD on STRONG CONFLICT), apexStability (hard on ROGUE), apexClearance (hard on BLOCKED), apexDirection, apexStageDanger (hard on auto-block components), apexFluctuation. Fluctuation is replayed (18 reads, 5 ticks apart) for the 4 leading markets only.
- NOT ported, on purpose: engines that read Apex's live paper-trade ledger (simulator, entry-condition lab, market profiles, combination learning, analogue memory, engine effectiveness). A one-shot scan has no ledger. Stage 2 setup was ported then dropped: it is multiplied by ledger sample size, so it reads ~0 for every contract.
- UI: result card shows Engines / Psychology / Stability / Direction / Fluctuation readings.
- Checked: tsc clean on overlord-engine files; 23 tests pass (3 new); selected scan 11x5000 ticks ~0.5 s, smart scan ~1.3 s on this machine. On random data ~78% of readings are vetoed and ~10% of scans end CAUTION (every contract vetoed). Copied Apex files keep their original formatting (prettier unavailable here). Not checked in a browser.

## Overlord: one market dropdown instead of the checkbox texts (2026-11-12)
- The "Any market" and "choose side and barrier" checkboxes did not render as controls on the live page (only their text showed). Replaced with ONE dropdown in the MARKET field: "Any market (engine picks)", "Any market, side and barrier", then each market. Selecting a market keeps the old behaviour. Removed the helper sentences ("Don't know which market...", "The engines pick it...", "What do you want to trade?"). Choice is remembered per browser. Over/Under only; other trade types show only the markets.
- Not checked in a browser.

## Overlord: Find Market assesses live for 15 s before answering (2026-11-12)
- Complaint: results appeared ~2 s after the click and could not be trusted (Oracle takes several seconds).
- New `overlord-engine/assess.ts`: after the 5000-tick history arrives, the 11 markets are watched LIVE (one socket, ticks subscription) for 15 s. Every 3 s the whole scan is re-run on history + new ticks (fast engines; slow model engine and fluctuation replay only in the final scan). Each contract is scored on how often it was clear of every veto and how often it was among the top 3; verdict = 60% final scan + 25% leader share + 15% clear share. STRONG is kept only if clear in >= 60% of rounds. If no live tick arrives within a third of the window it answers from the history (and says so in the log).
- UI: while assessing, the card shows "ASSESSING LIVE", seconds, a progress bar, number flagged and current leader; result card shows "Clear in X% of N live checks". Stop works during the assessment.
- Checked: 31 tests pass (8 new, fake socket); Overlord.jsx compiles. Not checked in a browser or against the real Deriv feed. Honest limit: this watches whether a contract's health holds; it does not predict the next tick.

## Rate-limit errors ("You are rate limited ... retrying" / "reached the rate limit for proposal_open_contract") - Overlord, Elite Prime
Deriv gives `proposal`, `proposal_open_contract`, `buy`, `sell` ONE shared budget (360/min, 14,400/h; https://developers.deriv.com/docs/limits/). Request id 190 on the engine's own socket shows that budget was already used up elsewhere, so the extra sockets are suspect.
- [x] Stuck contract: when Deriv refused a contract's update stream, Overlord / Elite Prime never got the result and stayed on "Contract bought" / "Trade is live" forever. New `hub360/rate-limit.ts` (11 tests): on a RateLimit reply the page pauses (3 s, 6 s, 12 s ... max 30 s), then re-requests that contract, or starts a fresh trade cycle after a refused proposal/buy. Trading is paused during the cool-down.
- [x] No idle account sessions: each opened tab used to keep its own authenticated Deriv socket forever (Overlord on mount; Elite Lite + Pro each, with 13 tick streams) and a 1.5 s watchdog re-opened it with no backoff. Now Overlord opens its session on Run and releases it when idle; Elite Prime idles on the PUBLIC tick feed (live digits board still works) and upgrades on Run / drops back after. Reconnects back off 1 s, 2 s, 4 s ... 30 s.
- [x] Lifecycle bug: the connect effects depended on callbacks, so editing e.g. the duration closed and reopened a (running) session. Deps are now empty and the timers use refs.
- [x] Late-close bug: an old socket's delayed `close` event nulled the NEW socket (duplicate sessions). Now ignored.
- NOT verified: npm build, eslint, any live/demo run (no network). Cause is inferred from code + Deriv's published limits, not measured.
- NEXT: hard-refresh, run Overlord and Elite Prime on Demo together with a Bot Builder bot; if "slow down" still shows up constantly, note which tabs were running (each cycle = proposal + buy + contract stream, about 3 calls; several bots at once add up).
- Also noticed, NOT changed: `DerivWSAccountsService.fetchOTPWebSocketURL` hands concurrent callers (within 100 ms) the same session URL, but Deriv says each URL works once.

## Overlord: live ticks now count as evidence, and the stronger market after assessment is the one shown (2026-11-12)
- During the 15 s assessment the ticks that arrive per market are counted against each contract (wins vs what chance gives, as a z-score). Needs at least 5 live ticks per market to count. Blend with live ticks: 50% final scan, 20% leader share, 10% clear share, 20% live support. A contract whose live ticks clearly go against it (z <= -1.8) is vetoed (CAUTION, reason shown). STRONG drops to BEST if the live ticks are below expectation.
- The list is re-ranked after the blend, so a market that looked weaker at the start (e.g. 10 1s) can be overtaken by one that holds up live (e.g. 100 1s); the one on top is presented.
- UI: result card shows "Live ticks: X of N won (about Y expected)"; progress line shows live ticks received.
- The fake socket exists only in automated tests; the app uses the real Deriv WebSocket. 34 tests pass; Overlord.jsx compiles. Not checked in a browser or against the live feed. Sample is small (about 15 ticks on a 1s market in 15 s): it is evidence, not a prediction.

## Overlord: Run never rescans once a market has been scanned (2026-11-12)
- Run used to rescan when the pick was older than 15 min. Now a market picked by Find Market (Over/Under or Even/Odd) is traded whenever Run is pressed, however long after; Run scans only when nothing has been scanned yet for that kind of trade. Press Find Market again for a new pick.

## Overlord Even/Odd: Run trades the closest market instead of scanning again (2026-11-12)
- Cause found: when Precision Parity had no READY market, the scan showed the closest market "for information only" and selected nothing, so no pick was recorded and Run started a second scan. Now the closest market shown is selected and recorded; Run trades it with no scan. The card says "NO READY MARKET, CLOSEST SHOWN (RUN TRADES IT)".

## Overlord: Rise / Fall mode with six indicators (2026-11-12)
- New `overlord-engine/rise-fall.ts` (Bollinger 20/2, Stoch RSI 14/14/3/3, RSI 14, MACD 12/26/9, Momentum 10, Connors RSI 3/2/100 on 1-minute candles; each votes RISE/FALL/none, needing the reading on one side AND turning that way) and `rise-fall-run.ts` (one socket: `ticks_history` candles, granularity 60, subscribed so the forming candle updates live; re-read every 3 s for 15 s).
- Best available market = most indicators agreeing, fewest against; card shows "X/6 INDICATORS AGREE", each indicator's vote, and how steadily the market held its side during the watch. Tiers: STRONG (5+ agree, steady), BEST (4+), WEAK (best available shown).
- Overlord: choosing Rise or Fall and Find Market runs it; market dropdown offers Any market / Any market and side; Run trades the pick without a second scan. Contract length is the existing Duration field (1 tick by default).
- 11 new tests; engine tests 72 pass; Overlord.jsx compiles. Not checked in a browser or against Deriv. Honest limit: indicators describe recent price, they do not predict the next tick.

## Overlord Rise/Fall: Reversal style, trading against a fading move (2026-11-12)
- New dropdown "Rise / Fall style" (default Reversal; "With the indicators" keeps the earlier behaviour). Reversal finds the prevailing move first (last ~9 one-minute candles, at least 1.5 average candle ranges, also read as it stood 3 candles ago so a stalled move is still seen). Seven readings then vote for the OPPOSITE side only when the move is running out of steam: MACD bars fading/crossed, Momentum slowing, RSI / Stoch RSI / Connors RSI turning back from the move's side, Bollinger (price in the move's half, last candle closed back), Candle slowing (small candles or one closing against the move). Indicators still gathering strength count against.
- A reversal point needs a move, at least 3 readings for the reversal and more for than against. The card says "(after a rise/fall)" and "X/7 SAY REVERSAL". No reversal point = the closest is shown, labelled not traded, and Run refuses it (no rescan, no trade); press Find Market again.
- Watched live 15 s like the others: a reversal that does not hold its side while watched is ranked lower.
- 15 tests in rise-fall.spec.ts; engine tests 76 pass; Overlord.jsx compiles. Not checked in a browser. Honest limit: a fading move is not evidence that the next tick reverses; Deriv's markets are random.
