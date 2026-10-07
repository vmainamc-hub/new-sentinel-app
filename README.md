# Apex Sentinel

Standalone Deriv trading-bot app (React + RSBuild + Blockly) with the dark navy / gold "Smart Deriv Tools" interface.
Tabs: Dashboard, Bot Builder, Free Bots, DTrader, AI Bots, Auto Trades, TradingView, Copy Trading, Calculator, Analysis Tool, Digits Analysis.

This is one app. It has no site manager, no Supabase and no runtime dependency on any other site or GitHub repository.

## Configure (one place)

`brand.config.json` -> `sites.entries[0]`:

| Field | Value |
|---|---|
| `hosts` / `website_url` / `redirect_uri` | your production host, e.g. `https://peppy-starship-b80f54.netlify.app` and `/callback` |
| `client_id` | **your Deriv OAuth client id** (replace `YOUR_DERIV_OAUTH_CLIENT_ID`; it is public, not a secret) |

Register the same `redirect_uri` in your Deriv OAuth app.

Navigation order and colours: `public/site-config/domains/apex-sentinel.json`.
Free bots: `public/free-bots/domains/apex-sentinel.json` (+ XML in `public/free-bots/uploads/apex-sentinel/`).
Theme: `src/components/premium/apex-theme.scss`.

## Run / build

```bash
npm ci
npm run generate:brand-css
npm start            # dev (localhost is treated as signed in for UI work)
npm run build        # output: dist/
```

Netlify: `netlify.toml` already builds `dist/` and serves the OAuth token-exchange function (`netlify/functions/oauth-token.mjs`).
Node 22.x or 24.x.

## AI Bots and Digits Analysis

- **AI Bots** (`src/components/premium/pages/AIBotsPage.tsx`, rules in `apex-logic.ts`): seven native strategies (Even–Odd, Over 4–Under 5, Rise–Fall and four recovery variants). They watch live ticks and place trades through the signed-in Deriv account. Start asks for confirmation and enforces stake cap, take profit, stop loss and a maximum number of consecutive losses. Test on a demo account first.
- **Digits Analysis** (`DigitsAnalysisPage.tsx`): live ranking of 12 volatility markets by Over/Under or Even/Odd win rate, best-market streaks and the last digits.
- Tests: `npx jest src/components/premium`.

## Free Bots library

33 bundled Blockly bots in `public/free-bots/uploads/apex-sentinel/`, listed in `public/free-bots/domains/apex-sentinel.json`.
Not included yet: *14 Bora v2*, *KUMI NA NNE BORA V2* and *Even Odd Reverse psychology* use custom blocks
(`over_under_analysis`, `rise_fall_analysis`, `lastNTicksDirection`, `contract_changer_block`, `set_tp`, `set_sl`) that this app does not implement.
To add a bot: copy its XML into the folder above and add an entry to the manifest.

## Not built yet

The "Special Bots" gradient cards, the "Load Bot From Device" dashboard tile and the always-visible right-hand run panel from the reference screenshots.
