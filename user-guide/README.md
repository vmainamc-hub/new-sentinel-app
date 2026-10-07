# Trading Bot Template — Developer Documentation

A field guide for developers who want to fork this template, customize it, and deploy their own trading bot platform on top of the Deriv API.

This is not documentation for a finished product. Each guide tells you what you get out of the box, what is yours to change, and what must stay pointed at Deriv's infrastructure to keep authentication and trading working.

---

## Documentation Index

| #  | Guide                                                    | Description                                              |
| -- | -------------------------------------------------------- | -------------------------------------------------------- |
| 01 | [Getting Started](./01-getting-started.md)               | Prerequisites, fork setup, commands, environment variables |
| 02 | [Architecture Overview](./02-architecture-overview.md)   | Application layers, state management (MobX), RxJS streams, bot engine |
| 03 | [White Labeling](./03-white-labeling.md)                 | Branding, colors, typography, logo, menus, theme configuration |
| 04 | [Authentication](./04-authentication.md)                 | OAuth 2.0 with PKCE, token exchange, session management, logout |
| 05 | [WebSocket Integration](./05-websocket-integration.md)   | Connection architecture, public/authenticated endpoints, DerivWS API |
| 06 | [Error Handling](./06-error-handling.md)                 | Centralized ErrorLogger, reporting service integration, migration |
| 07 | [Monitoring & Analytics](./07-monitoring-analytics.md)   | Datadog RUM, TrackJS, Rudderstack, Growthbook feature flags |
| 08 | [Changelog](./08-changelog.md)                           | All architectural changes from the original Deriv Bot to this template |

New to the template? Read 01–07 in order. The tech stack is summarized in the [top-level README](../README.md#what-you-get) and covered in depth in [Architecture Overview](./02-architecture-overview.md). For the setup walkthrough, jump straight to [Getting Started](./01-getting-started.md).

---

## Common Journeys

- **Just re-skinning the app?** [White Labeling](./03-white-labeling.md).
- **Setting up auth on a new domain?** [Authentication](./04-authentication.md) then [WebSocket Integration](./05-websocket-integration.md).
- **Wondering what changed from Deriv Bot?** [Changelog](./08-changelog.md) — maps every file removed, renamed, or rewritten.
- **Plugging in error reporting?** [Error Handling](./06-error-handling.md) for the `ErrorLogger` interface; [Monitoring & Analytics](./07-monitoring-analytics.md) for Datadog/TrackJS/Rudderstack setup.

---

## What Stays, What Changes

Some pieces are meant to be swapped out; others must stay pointed at Deriv.

**You own (and should change):**
- `brand.config.json` — brand name, domain, colors, typography, logo, footer, your deployment hostnames
- `src/components/layout/app-logo/BrandLogo.tsx` — SVG logo markup
- `src/components/layout/header/header-config.tsx` — desktop menu items
- `src/components/layout/header/mobile-menu/use-mobile-menu-config.tsx` — mobile menu items
- `.env` — your `CLIENT_ID` and any optional monitoring credentials

**Must stay pointed at Deriv:**
- `platform.auth2_url` in `brand.config.json` — OAuth server (needed for login)
- `platform.derivws` in `brand.config.json` — WebSocket API base URLs (needed for all trading functionality)

Changing the Deriv-bound URLs will break authentication and trading. See [Changelog — Configuration Constraints](./08-changelog.md#configuration-constraints).
