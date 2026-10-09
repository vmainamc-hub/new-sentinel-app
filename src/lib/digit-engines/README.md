# Apex Sentinel digit engines

This is the architecture layer for three separate signal engines sharing precision-correct tick ingestion and one conservative qualification gate. It is intentionally separate from Bulk Trader until engine tests and integration contracts are reviewed.

## Engines
- Even/Odd combines recent parity rates with a smoothed conditional transition estimate. Estimates are shrunk toward the 50% theoretical prior.
- Matches ranks resurgence using short-window momentum, medium-to-long recovery, and a small comeback-after-gap feature. A gap alone never creates evidence.
- Differs ranks declining digit share and competitor gains. It only generates barriers 2, 3, 4, 5, 6, and 7; output is filtered a second time. Digits 0, 1, 8, and 9 are prohibited.

## Shared design
- Last-digit extraction uses each market's Deriv pip_size, not a fixed two-decimal assumption.
- Windows are 24, 80, and 240 ticks. Frequency estimates are smoothed and confidence uses a Wilson lower bound.
- candidateScore is a ranking score, not a win probability.
- The strongest candidate remains visible when unqualified, but canTrade remains false until every gate passes.
- Qualification requires sufficient sample, current proposal economics, positive payout-aware expected value, a Wilson lower bound above break-even, and at least 100 walk-forward outcomes with Brier score better than baseline by a safety margin.
- EV = probability of win × total payout − stake, where total payout includes returned stake. Break-even probability = stake / total payout.
- WalkForwardValidator settles only forecasts recorded before their outcomes. Production wiring must avoid training on the same ticks used to make a prediction.

## Contract mapping
| Engine | Contract | Barrier |
|---|---|---|
| Even/Odd | DIGITEVEN or DIGITODD | none |
| Matches | DIGITMATCH | digit 0–9 |
| Differs | DIGITDIFF | digit 2–7 only |

The future execution adapter must freeze market, contract, barrier, duration, and stake into an immutable batch plan. It must reconcile uncertain purchase responses rather than blindly retrying a buy.

## Integration remains separate
No trades are placed here. A production adapter still needs per-market tick streams, live proposal quotes, forecast/outcome collection, websocket health, and a distinct execution gate. Digit history alone does not prove future predictability; without these external signals, candidates remain unqualified.
