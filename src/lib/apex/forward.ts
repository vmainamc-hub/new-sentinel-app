// APEX SENTINEL — FORWARD STATE PROJECTION + MARKET STATE TRAJECTORY.
// This layer is deliberately constrained. It never claims a digit "will"
// appear. It describes how the CURRENT observable state is trending and how
// confident that description is, always with an uncertainty figure.
import type { BarStructure } from "./bars";
import type { DigitIntel } from "./digit-intel";
import type { ThreatReport } from "./threat";

export type Trajectory = "STRENGTHENING" | "HOLDING" | "WEAKENING" | "DETERIORATING";

export interface ForwardState {
  direction: Trajectory;
  /** 0..100 — how strong the observed drift is. */
  strength: number;
  /** 0..100 — how uncertain that reading is. */
  uncertainty: number;
  horizonTicks: number;
  winningPressureOutlook: "CONTINUING" | "WEAKENING" | "FLAT";
  losingThreatOutlook: "INCREASING" | "STABLE" | "DECREASING";
  concentrationOutlook: "PERSISTING" | "DISPERSING" | "STABLE";
  regimeOutlook: "CONTINUING" | "TRANSITIONING";
  analogueSupport: string;
  statement: string;
  current: string;
  developing: string;
  risk: string;
}

export function forwardProjection(
  contractLabel: string,
  intel: DigitIntel,
  threat: ThreatReport,
  bars: BarStructure,
  regime: string,
  entropyDelta: number,
  analogue: { n: number; rate: number } | null,
  horizonTicks: number,
): ForwardState {
  const winOutlook =
    threat.winning.velocity > 0.006
      ? "CONTINUING"
      : threat.winning.velocity < -0.006
        ? "WEAKENING"
        : "FLAT";
  const threatOutlook =
    threat.losing.velocity > 0.006 || threat.losing.acceleration > 0.004
      ? "INCREASING"
      : threat.losing.velocity < -0.006
        ? "DECREASING"
        : "STABLE";
  const concentration = intel.profiles.reduce((a, p) => a + Math.abs(p.pressure), 0);
  const concentrationOutlook =
    entropyDelta < -0.004 ? "PERSISTING" : entropyDelta > 0.004 ? "DISPERSING" : "STABLE";
  const regimeOutlook =
    bars.expansion || Math.abs(bars.acceleration) > 0.5 || bars.reversalRate > 0.62
      ? "TRANSITIONING"
      : "CONTINUING";

  let score = 0;
  score += winOutlook === "CONTINUING" ? 22 : winOutlook === "WEAKENING" ? -22 : 0;
  score += threatOutlook === "INCREASING" ? -28 : threatOutlook === "DECREASING" ? 18 : 0;
  score += threat.asymmetry * 18;
  score += regimeOutlook === "TRANSITIONING" ? -10 : 6;
  score -= threat.recurrence === "SEVERE" ? 22 : threat.recurrence === "ACTIVE" ? 12 : 0;

  const direction: Trajectory =
    score > 18
      ? "STRENGTHENING"
      : score > -8
        ? "HOLDING"
        : score > -26
          ? "WEAKENING"
          : "DETERIORATING";

  const strength = Math.max(0, Math.min(100, Math.abs(score) * 2.2));
  const uncertainty = Math.max(
    12,
    Math.min(
      100,
      100 -
        strength * 0.45 -
        (analogue && analogue.n >= 120 ? 18 : 0) -
        (intel.n >= 1000 ? 12 : 0) +
        (regimeOutlook === "TRANSITIONING" ? 12 : 0) +
        concentration * 40,
    ),
  );

  const analogueSupport =
    analogue && analogue.n >= 30
      ? `${analogue.n} analogous states observed by this terminal resolved ${(analogue.rate * 100).toFixed(1)}% in favour of the contract.`
      : "No sufficiently observed historical analogue — projection rests on current structure only.";

  const worst = threat.threats[0];
  const current = `${contractLabel} ${threat.asymmetry >= 0 ? "favourable" : "contested"} — winning-side pressure ${(threat.winning.pressure * 100).toFixed(2)}pp vs losing-side ${(threat.losing.pressure * 100).toFixed(2)}pp.`;
  const developing = worst
    ? `Digit ${worst.digit} threat ${worst.score.toFixed(0)} (${worst.state}), losing-side pressure ${threatOutlook.toLowerCase()}.`
    : "No losing digit is currently developing pressure.";
  const risk =
    threatOutlook === "INCREASING" || threat.state === "HIGH" || threat.state === "CRITICAL"
      ? `${contractLabel} losing-side threat becoming ${threat.state.toLowerCase()} within the next ${horizonTicks} ticks.`
      : regimeOutlook === "TRANSITIONING"
        ? `Regime (${regime}) is transitioning — structural readings may reset.`
        : "No dominant deterioration path identified from current evidence.";

  const statement =
    direction === "STRENGTHENING"
      ? `Current evidence suggests continued winning-side pressure over roughly ${horizonTicks} ticks, but uncertainty remains ${uncertainty.toFixed(0)}/100.`
      : direction === "HOLDING"
        ? `Current evidence suggests the structure holds over roughly ${horizonTicks} ticks without a clear directional improvement; uncertainty ${uncertainty.toFixed(0)}/100.`
        : `Current evidence suggests elevated probability of continued losing-side pressure over roughly ${horizonTicks} ticks, but uncertainty remains ${uncertainty.toFixed(0)}/100.`;

  return {
    direction,
    strength,
    uncertainty,
    horizonTicks,
    winningPressureOutlook: winOutlook,
    losingThreatOutlook: threatOutlook,
    concentrationOutlook,
    regimeOutlook,
    analogueSupport,
    statement,
    current,
    developing,
    risk,
  };
}
