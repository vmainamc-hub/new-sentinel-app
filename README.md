# Apex Sentinel

Standalone Deriv trading-bot app (React + RSBuild + Blockly) with the dark navy / gold "Smart Deriv Tools" interface.
Tabs: Dashboard, Bot Builder, Free Bots, DTrader, Auto Trades, TradingView, Copy Trading, Calculator, Analysis Tool.

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

## Not built yet

AI Bots, Digits Analysis and the always-visible right-hand run panel from the reference screenshots.
