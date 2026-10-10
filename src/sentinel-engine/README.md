# Sentinel Signal Engine (isolated copy)

The signal backend for the **Sentinel AI** tab (`src/pages/sentinel-ai`). It is a copy of the Sentinel Signal
Engine from `Sentinel-Signal-Engine-and-Sentinel-Forge-source.zip` (`apexsentinel-main/src`), and the decision logic
must not be edited in place.

## Why it lives here and not in `src/lib`

`src/lib` already holds a *different* vendored engine (Insight Fusion, used by the Bulk Trader; see
`src/lib/README.vendored.md`). 13 files exist in both with different contents (`deriv/tick-bus.ts`,
`sentinel/entry-point.ts`, `precision-edge/bot/simulator.ts`, ...). Overwriting them would change what the Bulk Trader
runs on, so this engine is kept in its own folder and the two never share modules or state.

## What was changed

Only import specifiers, so the files resolve inside this folder:

| In the zip                  | Here                                   |
| --------------------------- | -------------------------------------- |
| `@/lib/...`                 | `@/sentinel-engine/lib/...`            |
| `@/types/sentinel`          | `@/sentinel-engine/types/sentinel`     |
| `@/hooks/useDerivStream`    | `@/sentinel-engine/hooks/useDerivStream` |

Nothing else differs. `MANIFEST.json` lists every file with the SHA-256 of its original. 112 files: the import
closure of `lib/apex/{core,scan,surface-vetting,types}` and `lib/deriv/tick-bus`.

The engine's own tick bus (`lib/deriv/tick-bus.ts`) feeds from the app's authenticated Deriv connection
(`api_base` from `@/external/bot-skeleton`), so it only starts producing once you are logged in.

## Re-vendor / verify

```bash
# copy (or refresh) the engine from an extracted zip
node scripts/vendor-sentinel-engine.mjs <zip>/apexsentinel-main/src ./src

# prove it still matches the zip apart from the import specifiers
node scripts/vendor-sentinel-engine.mjs <zip>/apexsentinel-main/src ./src --verify
```

## Lint and types

Excluded from prettier and eslint (`.prettierignore`, `.eslintignore`) so the files stay identical to the source.
Under this repo's `noUnusedLocals`, `tsc --noEmit` reports "declared but never used" (TS6133/TS6196) inside these
files, the same known note as `src/lib`.
