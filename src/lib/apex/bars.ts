// APEX SENTINEL — GREEN / RED BAR ENGINE.
// A "bar" is one tick: green when the quote closed above the previous quote,
// red when it closed below. This matches the definition the terminal has
// always used elsewhere (green = up tick, red = down tick).
// Bar state is supporting evidence only — never a standalone signal.

export interface BarState {
  color: "GREEN" | "RED" | "FLAT";
  magnitude: number; // absolute log return of the bar
  digit: number; // digit printed by that bar
}

export interface BarStructure {
  n: number;
  current: BarState | null;
  previous: BarState | null;
  secondPrevious: BarState | null;
  /** Consecutive bars of the current colour. */
  consecutive: number;
  greenRate: number; // last 120 bars
  /** Longest green run inside the observed window. */
  maxGreenRun: number;
  maxRedRun: number;
  reversalRate: number; // colour flips per bar
  directionalPersistence: number; // 0..1, P(same colour repeats)
  acceleration: number; // recent magnitude vs baseline magnitude − 1
  compression: boolean;
  expansion: boolean;
  /** P(next bar green | current colour) observed. */
  nextGreenGivenCurrent: number;
  /** Digit distribution observed after runs of the current colour and length. */
  analogueDigitShare: number[] | null;
  analogueN: number;
  /** True when the configured long green-bar sequence threshold is reached. */
  longGreenSequence: boolean;
  longSequenceThreshold: number;
}

const WINDOW = 400;

function colorOf(prev: number, cur: number): BarState["color"] {
  if (cur > prev) return "GREEN";
  if (cur < prev) return "RED";
  return "FLAT";
}

/**
 * @param longSequenceThreshold Length of the "green-bar sequence" structure the
 * operator watches (default 22 — configurable, not an invented formula).
 */
export function barEngine(
  prices: number[],
  digits: number[],
  longSequenceThreshold = 22,
): BarStructure {
  const p = prices.slice(Math.max(0, prices.length - WINDOW));
  const d = digits.slice(Math.max(0, digits.length - p.length));
  const bars: BarState[] = [];
  for (let i = 1; i < p.length; i++) {
    const mag = p[i - 1] > 0 ? Math.abs(Math.log(p[i] / p[i - 1])) : 0;
    bars.push({ color: colorOf(p[i - 1], p[i]), magnitude: mag, digit: d[i] ?? -1 });
  }
  const n = bars.length;
  if (!n) {
    return {
      n: 0,
      current: null,
      previous: null,
      secondPrevious: null,
      consecutive: 0,
      greenRate: 0.5,
      maxGreenRun: 0,
      maxRedRun: 0,
      reversalRate: 0,
      directionalPersistence: 0.5,
      acceleration: 0,
      compression: false,
      expansion: false,
      nextGreenGivenCurrent: 0.5,
      analogueDigitShare: null,
      analogueN: 0,
      longGreenSequence: false,
      longSequenceThreshold,
    };
  }

  const current = bars[n - 1];
  const previous = n >= 2 ? bars[n - 2] : null;
  const secondPrevious = n >= 3 ? bars[n - 3] : null;

  let consecutive = 1;
  for (let i = n - 2; i >= 0 && bars[i].color === current.color; i--) consecutive++;

  const recent = bars.slice(Math.max(0, n - 120));
  const green = recent.filter((b) => b.color === "GREEN").length;
  const greenRate = recent.length ? green / recent.length : 0.5;

  let flips = 0;
  let sameColor = 0;
  let pairs = 0;
  let maxGreenRun = 0;
  let maxRedRun = 0;
  let run = 0;
  let runColor: BarState["color"] = bars[0].color;
  for (let i = 1; i < n; i++) {
    if (bars[i].color !== bars[i - 1].color) flips++;
    else sameColor++;
    pairs++;
    if (bars[i].color === runColor) run++;
    else {
      if (runColor === "GREEN") maxGreenRun = Math.max(maxGreenRun, run + 1);
      if (runColor === "RED") maxRedRun = Math.max(maxRedRun, run + 1);
      runColor = bars[i].color;
      run = 0;
    }
  }
  if (runColor === "GREEN") maxGreenRun = Math.max(maxGreenRun, run + 1);
  if (runColor === "RED") maxRedRun = Math.max(maxRedRun, run + 1);

  const meanMag = bars.reduce((a, b) => a + b.magnitude, 0) / n;
  const recentMag = recent.reduce((a, b) => a + b.magnitude, 0) / Math.max(1, recent.length);
  const acceleration = meanMag > 0 ? recentMag / meanMag - 1 : 0;

  // P(next green | current colour) from the observed colour chain.
  let sameStart = 0;
  let greenNext = 0;
  for (let i = 0; i < n - 1; i++) {
    if (bars[i].color !== current.color) continue;
    sameStart++;
    if (bars[i + 1].color === "GREEN") greenNext++;
  }

  // Historical analogue: the digit distribution that followed identical
  // colour-run lengths in this same stream.
  const share = new Array(10).fill(0);
  let analogueN = 0;
  for (let i = 1; i < n - 1; i++) {
    let r = 1;
    for (let k = i - 1; k >= 0 && bars[k].color === bars[i].color; k--) r++;
    if (bars[i].color === current.color && r === consecutive) {
      const nextDigit = bars[i + 1].digit;
      if (nextDigit >= 0 && nextDigit <= 9) {
        share[nextDigit]++;
        analogueN++;
      }
    }
  }

  return {
    n,
    current,
    previous,
    secondPrevious,
    consecutive,
    greenRate,
    maxGreenRun,
    maxRedRun,
    reversalRate: pairs ? flips / pairs : 0,
    directionalPersistence: pairs ? sameColor / pairs : 0.5,
    acceleration,
    compression: acceleration < -0.25,
    expansion: acceleration > 0.35,
    nextGreenGivenCurrent: sameStart >= 20 ? greenNext / sameStart : 0.5,
    analogueDigitShare: analogueN >= 20 ? share.map((c) => c / analogueN) : null,
    analogueN,
    longGreenSequence: current.color === "GREEN" && consecutive >= longSequenceThreshold,
    longSequenceThreshold,
  };
}
