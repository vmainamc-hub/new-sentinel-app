// APEX SENTINEL — DANGER CLEARANCE + INSTABILITY ("rogue market") MODEL.
//
// A signal can be directionally attractive and still not be executable. This
// module answers a separate question from "is there an edge?": *is this market
// currently safe enough to act on the edge?*
//
// Every reason emitted here is derived from a measured value on THIS market's
// own intelligence and THIS market's own simulator ledger. Nothing is invented,
// nothing is borrowed from another market.
import type { ContractEval, MarketIntel } from "./types";
import type { SimPerformance } from "./simulator";

export type ClearanceState = "CLEAR" | "CAUTION" | "UNSTABLE" | "BLOCKED" | "INSUFFICIENT EVIDENCE";

export type ClearanceSeverity = "BLOCK" | "WARN" | "INFO";

export interface ClearanceReason {
  /** Stable machine code — safe for the eventual XML/DBot consumer. */
  code: string;
  severity: ClearanceSeverity;
  text: string;
  /** Measured value that produced this reason. */
  value: number | null;
}

export interface InstabilityReport {
  /** 0..100 — how "rogue"/fluctuating the market currently looks. */
  score: number;
  label: "CALM" | "NORMAL" | "FLUCTUATING" | "ROGUE";
  drivers: string[];
}

export interface ClearanceReport {
  state: ClearanceState;
  /** 0..100 — how much of the safety budget is consumed (higher = worse). */
  risk: number;
  reasons: ClearanceReason[];
  blockers: ClearanceReason[];
  cautions: ClearanceReason[];
  instability: InstabilityReport;
  /** One-line operator summary; always references measured evidence. */
  summary: string;
  /** True only for CLEAR — the sole state a bot may act on unattended. */
  executable: boolean;
}

export interface ClearanceInputs {
  intel: MarketIntel;
  contract: ContractEval;
  /** Rolling-window record for THIS market/contract. Never global. */
  recent: SimPerformance | null;
  /** Lifetime record for THIS market/contract. Never global. */
  lifetime: SimPerformance | null;
  /** Danger ceiling in force (from simulator/scan configuration). */
  maxDanger: number;
  /** Losing-side group-threat ceiling in force. */
  maxLosingThreat: number;
}

/** Danger digits watched more closely — never banned, only scored. */
export const DANGER_DIGITS = [8, 9, 0, 1];

/**
 * Instability / "manipulation-like" pattern detection.
 *
 * This is explicitly an OBSERVED-BEHAVIOUR label. It never asserts external
 * manipulation as fact — it reports that this market's own digit structure is
 * behaving in a way that has historically preceded unstable outcomes.
 */
export function assessInstability(intel: MarketIntel): InstabilityReport {
  const drivers: string[] = [];
  let score = 0;

  const vol = intel.volatility;
  if (vol) {
    if (vol.label === "violent") {
      score += 26;
      drivers.push(`Volatility violent — recent/base ratio ${vol.ratio.toFixed(2)}.`);
    } else if (vol.label === "elevated") {
      score += 12;
      drivers.push(`Volatility elevated — recent/base ratio ${vol.ratio.toFixed(2)}.`);
    } else if (vol.label === "calm") {
      score -= 8;
      drivers.push(`Volatility calm — ratio ${vol.ratio.toFixed(2)} (quality advantage).`);
    }
  }

  if (intel.anomaly && intel.anomaly.score >= 55) {
    score += Math.min(22, (intel.anomaly.score - 45) * 0.5);
    drivers.push(
      `Anomaly score ${intel.anomaly.score.toFixed(0)} — ${intel.anomaly.reasons[0] ?? "structure deviates from its own baseline"}.`,
    );
  }

  // Competing pressure: a suppressed digit surging while a dominant one
  // collapses is exactly the "losing digit fighting a gaining digit" pattern.
  const p = intel.pressure;
  if (p && Array.isArray(p.pressure)) {
    const rising = p.pressure.map((v, d) => ({ d, v })).filter((x) => x.v > 1.4);
    const falling = p.pressure.map((v, d) => ({ d, v })).filter((x) => x.v < -1.4);
    if (rising.length >= 2 && falling.length >= 2) {
      score += 10;
      drivers.push(
        `Competing digit pressure — ${rising.length} digits gaining against ${falling.length} releasing.`,
      );
    }
    const dangerSurge = rising.filter((x) => DANGER_DIGITS.includes(x.d));
    if (dangerSurge.length) {
      score += Math.min(18, dangerSurge.length * 7);
      drivers.push(
        `Danger digit${dangerSurge.length > 1 ? "s" : ""} ${dangerSurge.map((x) => x.d).join(", ")} accelerating (+${dangerSurge.map((x) => x.v.toFixed(1)).join("/")}pp).`,
      );
    }
  }

  if (intel.regime?.label === "CHAOTIC") {
    score += 16;
    drivers.push(`Regime CHAOTIC (confidence ${intel.regime.confidence.toFixed(0)}).`);
  }
  if (intel.regime?.label === "BALANCED" || intel.regime?.label === "COMPRESSED") {
    score -= 4;
  }

  if (intel.entropy?.uniformityFail) {
    score += 6;
    drivers.push(`Uniformity test failed — chi² ${intel.entropy.chi2.toFixed(1)}.`);
  }

  const contradiction = Math.max(...intel.contracts.map((c) => c.contradiction), 0);
  if (contradiction >= 55) {
    score += Math.min(14, (contradiction - 45) * 0.35);
    drivers.push(`Engine disagreement — peak contradiction ${contradiction.toFixed(0)}.`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label: InstabilityReport["label"] =
    score >= 62 ? "ROGUE" : score >= 40 ? "FLUCTUATING" : score >= 18 ? "NORMAL" : "CALM";
  if (!drivers.length) drivers.push("No instability drivers measured on this market.");
  return { score, label, drivers };
}

/** Dynamic, evidence-based danger score for one digit on one market. */
export function digitDanger(
  intel: MarketIntel,
  digit: number,
): { score: number; drivers: string[] } {
  const drivers: string[] = [];
  let score = DANGER_DIGITS.includes(digit) ? 12 : 0;
  if (DANGER_DIGITS.includes(digit)) drivers.push(`Digit ${digit} is under elevated monitoring.`);

  const p = intel.pressure;
  if (p && Array.isArray(p.pressure)) {
    const press = p.pressure[digit] ?? 0;
    if (press > 1.2) {
      score += Math.min(28, press * 9);
      drivers.push(`Pressure +${press.toFixed(1)}pp and rising.`);
    }
    const impulse = Array.isArray(p.impulse) ? (p.impulse[digit] ?? 0) : 0;
    if (impulse > 1.5) {
      score += Math.min(20, impulse * 6);
      drivers.push(`Fast impulse +${impulse.toFixed(1)}pp — unusual acceleration.`);
    }
    if (Array.isArray(p.lifecycle) && (p.lifecycle[digit] ?? "neutral") === "emerging" && (intel.stats?.pct[digit] ?? 10) < 10) {
      score += 10;
      drivers.push(`Suppressed digit emerging from below 10%.`);
    }
  }
  const share = intel.stats?.recentPct[digit];
  if (share !== undefined && share > 13) {
    score += Math.min(16, (share - 12) * 3);
    drivers.push(`Recent share ${share.toFixed(1)}% — abnormal concentration.`);
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), drivers };
}

/**
 * Final danger clearance for one market/contract.
 *
 * Order matters: hard integrity/data failures produce INSUFFICIENT EVIDENCE,
 * safety failures produce BLOCKED, structural turbulence produces UNSTABLE,
 * and everything else degrades gracefully through CAUTION to CLEAR.
 */
export function assessClearance(input: ClearanceInputs): ClearanceReport {
  const { intel, contract: c, recent, lifetime, maxDanger, maxLosingThreat } = input;
  const reasons: ClearanceReason[] = [];
  const instability = assessInstability(intel);

  const add = (
    code: string,
    severity: ClearanceSeverity,
    text: string,
    value: number | null = null,
  ) => reasons.push({ code, severity, text, value });

  // ── Evidence availability ────────────────────────────────────────────
  if (intel.dataState === "UNAVAILABLE") {
    add("DATA_UNAVAILABLE", "BLOCK", "No tick data buffered for this market.", 0);
  } else if (intel.dataState === "STALE") {
    add("DATA_STALE", "BLOCK", `Feed silent for ${(intel.ageMs / 1000).toFixed(1)}s.`, intel.ageMs);
  } else if (intel.dataState === "THIN") {
    add("DATA_THIN", "WARN", `Only ${intel.ticks} ticks buffered on this market.`, intel.ticks);
  }

  // ── Safety ───────────────────────────────────────────────────────────
  if (c.danger > maxDanger) {
    add(
      "DANGER_ABOVE_LIMIT",
      "BLOCK",
      `Contract danger ${c.danger.toFixed(0)} exceeds the ${maxDanger} ceiling.`,
      c.danger,
    );
  } else if (c.danger > maxDanger - 12) {
    add(
      "DANGER_NEAR_LIMIT",
      "WARN",
      `Danger ${c.danger.toFixed(0)} approaching the ${maxDanger} ceiling.`,
      c.danger,
    );
  }

  if (c.threat) {
    if (c.threat.groupThreat >= maxLosingThreat) {
      add(
        "LOSING_THREAT",
        "BLOCK",
        `Losing-side threat ${c.threat.groupThreat.toFixed(0)} (${c.threat.state}) — digits ${c.threat.threats
          .slice(0, 2)
          .map((t) => t.digit)
          .join(", ")} dangerous.`,
        c.threat.groupThreat,
      );
    } else if (c.threat.groupThreat >= maxLosingThreat - 14) {
      add(
        "LOSING_THREAT_RISING",
        "WARN",
        `Losing-side threat ${c.threat.groupThreat.toFixed(0)} (${c.threat.state}) below the ${maxLosingThreat} limit but elevated.`,
        c.threat.groupThreat,
      );
    }
  }

  // Danger digits are scored, never banned.
  for (const d of c.winners.length ? DANGER_DIGITS : []) {
    if (!c.winners.includes(d)) {
      const dd = digitDanger(intel, d);
      if (dd.score >= 55) {
        add(
          `DANGER_DIGIT_${d}`,
          dd.score >= 72 ? "BLOCK" : "WARN",
          `Danger digit ${d} scores ${dd.score} on the losing side — ${dd.drivers[0] ?? "elevated behaviour"}`,
          dd.score,
        );
      }
    } else {
      const dd = digitDanger(intel, d);
      if (dd.score >= 65) {
        add(
          `DANGER_DIGIT_${d}_WINNING`,
          "INFO",
          `Danger digit ${d} is on the winning side but scores ${dd.score} — treat its support as unstable.`,
          dd.score,
        );
      }
    }
  }

  if (c.critical && c.critical.conflicts.length >= 2) {
    add(
      "CRITICAL_CONFLICT",
      "BLOCK",
      `Critical digit conflict — ${c.critical.detail}`,
      c.critical.conflicts.length,
    );
  } else if (c.critical && c.critical.conflicts.length === 1) {
    add("CRITICAL_CONFLICT_SINGLE", "WARN", `Sensitive-digit conflict — ${c.critical.detail}`, 1);
  }

  if (c.fakeEdge?.verdict === "REJECTED") {
    add(
      "FAKE_EDGE",
      "BLOCK",
      `Fake-edge interrogation failed ${c.fakeEdge.failures} checks — ${c.fakeEdge.answers.find((a) => !a.ok)?.question ?? "unspecified"}`,
      c.fakeEdge.failures,
    );
  }

  // ── Stability ────────────────────────────────────────────────────────
  if (instability.label === "ROGUE") {
    add(
      "MARKET_ROGUE",
      "BLOCK",
      `Instability ${instability.score} (ROGUE) — ${instability.drivers[0]}`,
      instability.score,
    );
  } else if (instability.label === "FLUCTUATING") {
    add(
      "MARKET_FLUCTUATING",
      "WARN",
      `Instability ${instability.score} — ${instability.drivers[0]}`,
      instability.score,
    );
  }
  if (c.phase === "INVALIDATING") {
    add(
      "SETUP_INVALIDATING",
      "WARN",
      "Setup is invalidating — contradictory evidence rising.",
      null,
    );
  }
  if (c.forward?.direction === "DETERIORATING") {
    add(
      "FORWARD_DETERIORATING",
      "WARN",
      `Forward projection deteriorating — ${c.forward.statement}`,
      null,
    );
  }
  if (!c.regimeCompatible) {
    add(
      "REGIME_MISMATCH",
      "WARN",
      c.regimeNote || "Current regime is outside this contract's validated range.",
      null,
    );
  }

  // ── This market's own contract-resolved record ───────────────────────
  if (lifetime && lifetime.n >= 60 && lifetime.expectancy < 0) {
    add(
      "SIM_NEGATIVE_EXPECTANCY",
      "BLOCK",
      `This market's own record is negative — expectancy ${lifetime.expectancy.toFixed(3)} over N=${lifetime.n} resolutions.`,
      lifetime.expectancy,
    );
  }
  if (recent && recent.n >= 8 && recent.longestLosingStreak >= 5) {
    add(
      "RECENT_LOSS_STREAK",
      "WARN",
      `Recent window shows a ${recent.longestLosingStreak}-loss streak over N=${recent.n}.`,
      recent.longestLosingStreak,
    );
  }
  if (recent && recent.n >= 12 && recent.winRate < c.theoretical - 0.08) {
    add(
      "RECENT_UNDERPERFORMANCE",
      "WARN",
      `Recent window ${(recent.winRate * 100).toFixed(1)}% vs ${(c.theoretical * 100).toFixed(0)}% baseline over N=${recent.n}.`,
      recent.winRate,
    );
  }
  if (!lifetime || lifetime.n === 0) {
    add(
      "NO_RESOLVED_SAMPLE",
      "INFO",
      "No contract-resolved sample for this market/contract yet.",
      0,
    );
  }

  const blockers = reasons.filter((r) => r.severity === "BLOCK");
  const cautions = reasons.filter((r) => r.severity === "WARN");

  const risk = Math.max(
    0,
    Math.min(
      100,
      Math.round(blockers.length * 34 + cautions.length * 11 + instability.score * 0.25),
    ),
  );

  let state: ClearanceState;
  if (intel.dataState === "UNAVAILABLE" || intel.dataState === "STALE")
    state = "INSUFFICIENT EVIDENCE";
  else if (blockers.length) state = "BLOCKED";
  else if (instability.label === "FLUCTUATING" || instability.label === "ROGUE") state = "UNSTABLE";
  else if (intel.dataState === "THIN" && (!lifetime || lifetime.n < 10))
    state = "INSUFFICIENT EVIDENCE";
  else if (cautions.length) state = "CAUTION";
  else state = "CLEAR";

  const summary =
    state === "CLEAR"
      ? `Clearance CLEAR — danger ${c.danger.toFixed(0)}, instability ${instability.score}, no blocking condition on ${intel.name}.`
      : state === "BLOCKED"
        ? `Clearance BLOCKED — ${blockers[0].text}`
        : state === "UNSTABLE"
          ? `Clearance UNSTABLE — ${instability.drivers[0]}`
          : state === "INSUFFICIENT EVIDENCE"
            ? `Clearance INSUFFICIENT EVIDENCE — ${reasons[0]?.text ?? "not enough observed data on this market."}`
            : `Clearance CAUTION — ${cautions[0].text}`;

  return {
    state,
    risk,
    reasons,
    blockers,
    cautions,
    instability,
    summary,
    executable: state === "CLEAR",
  };
}
