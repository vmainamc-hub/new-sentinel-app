# Momentum engine (standalone)

`momentum-separation.ts` measures whether the recent digit movement of a candidate favours its contract (two-sided
separation between the winning and losing digit sides). `momentum-gate.ts` takes the list already produced by
`surfaceVetRank(...)` and returns which candidate may be **traded**: the first one, in the same rank order, that passes
momentum (or simply the first one when the switch is off). It never re-sorts, never removes anything, never mutates its
input, and fails closed (blocks) when momentum cannot be measured while the switch is on.

It lives beside the existing engines and is not wired into `surface-vetting.ts` or `scan.ts`. Only
`src/pages/sentinel-ai/sentinel-ai-engine.ts` calls it.

This is a filter on signal COUNT. It is not claimed to raise the win rate; measure that with the Sentinel AI signal
outcome log (momentum passed versus failed).
