# Precision Parity AI, vendored for Overlord Even / Odd

These files are the Precision Parity AI tool's engines, used by `../parity-engine.ts` and `../parity-assess.ts` (the backend of
Overlord's Even / Odd Find Market). They compute exactly what the Precision Parity tool computes. Do not reformat, lint or
"improve" them: Overlord reads Parity's verdict and never re-decides it. (Both `.prettierignore` and `.eslintignore` skip this
folder, like the other vendored engines.)

Source: the Precision Parity tool (`src/lib/precision-parity/`, zip `precisionapex6-main`, identical to
`vmainamc-hub/precisionapex4` on `main`). Git blob SHAs of the originals:

| file | original blob |
| --- | --- |
| types.ts | c68e63174d71be389f66e249908e527d04bbcee9 (unchanged) |
| engine.ts | 68fb0528caf59e49401c9335d3ca9c1e2601ff88 |
| analysts.ts | 00a5dc6563fffa77638494ce1fdce875e19cbbc1 |
| structural.ts | 30319912314612711e672e4eef0e584af03e818c (unchanged) |
| forecast.ts | 4de82d14e85604587fa90a81bfe9e63cb79692fd (unchanged) |
| forecast-calibration.ts | c389375ad502bf2d01fe631617c02e200cb640a5 (unchanged) |
| calibration.ts | 5436db0a820c08de2b318f2df2d3751516d0b45c (unchanged) |
| deep-reasoning.ts | 7aa32bf178d2265f0f9f79285dba4820469ea90a |
| journal.ts | 48461b311fa0ac47a35d1dd206fbd457db366a57 (unchanged) |

Only five lines differ from the originals, all of them unused declarations that this repo's `noUnusedLocals` (ts-jest and
`type-check`) rejects. None changes what the engines compute:

- `analysts.ts`: unused type import `ParityContract` removed; unused `stability` removed from a destructuring in `runDBotSurvival`.
- `deep-reasoning.ts`: unused `regime`, `hidden` removed from a destructuring; unused `const entropy = shannon(evenShare)` removed.
- `engine.ts`: unused import `panelApproves` removed.

Things to know:

- Parity reads a tick's last digit as `lastDigit(price)` (two decimals) and nothing else from a tick. `toParityTicks` hands it
  `digit / 100`, so the digit Overlord read at the market's own precision reaches Parity unchanged for every market.
- Parity is stateful per market (persistence, maturity, adaptive weights) and its virtual-trade check uses `Math.random`. That is
  how the tool behaves on its own page; the specs seed `Math.random` and call `resetParityMemory()`.
- Other repos hold a different, larger `engine.ts` (88,004 bytes, blob caf82d20bf8290edf2c8d1a3fb9bf3d12238c44e). That variant is NOT used here.
