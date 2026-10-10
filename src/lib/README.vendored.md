# Vendored: Insight Fusion (Sentinel x DigitPulse)

Everything under `src/lib/`, plus `src/types/sentinel.ts` and `src/hooks/useDerivStream.ts`, is a **byte-for-byte copy** of
the Insight Fusion engine (`insight-fusion-main`). The Over/Under decision logic lives here and must not be edited in place.

- Entry point: `src/lib/fusion/verdict.ts` -> `computeCombinedVerdict(market, ticks, previousV3)`.
- The Bulk Trader talks to it only through `src/components/premium/over-under-engine.ts` (feed, comparison, allowlist, validation).
- Only about 21 of these files execute at runtime; the rest are type-only references that `tsc` still needs to resolve.
- Excluded from prettier and eslint (`.prettierignore`, `.eslintignore`) so the files stay identical to the source.
- `src/hooks/useDerivStream.ts` and `src/lib/deriv/tick-bus.ts` open their own Deriv socket and are NOT used by this app.
- Known note: under this repo's `noUnusedLocals`, `tsc --noEmit` reports "declared but never used" (TS6133/TS6196) inside these files.

To update the engine, replace the files from the new Insight Fusion source and re-run the specs in
`src/components/premium/__tests__/over-under-engine.spec.ts`.
