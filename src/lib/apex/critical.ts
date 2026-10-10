// APEX SENTINEL — CRITICAL DIGIT PROTECTION.
// The operator watches a small set of sensitive digit structures. Their
// definitions are NOT invented here: they reuse the terminal's existing
// digit-role model (see src/lib/digit-roles.ts).
//
//   GREEN BAR         → most appearing digit
//   SECOND GREEN BAR  → second most appearing digit
//   RED BAR           → least appearing digit
//   SECOND RED BAR    → second least appearing digit
//   MOST INCREASING   → digit with the strongest rising momentum
//   GREEN-BAR SEQUENCE→ digit printed while an unusually long green bar run is
//                       active. The run length is CONFIGURABLE (default 22 —
//                       the operator's "22nd green bar"); it is a watched
//                       structure, not a derived mathematical law.
import { assignDigitRoles } from "@/lib/digit-roles";
import type { BarStructure } from "./bars";
import type { DigitIntel } from "./digit-intel";

export type CriticalRole =
  | "GREEN BAR"
  | "SECOND GREEN BAR"
  | "RED BAR"
  | "SECOND RED BAR"
  | "MOST INCREASING"
  | "GREEN-BAR SEQUENCE";

export interface CriticalDigit {
  digit: number;
  role: CriticalRole;
  detail: string;
}

export interface CriticalReport {
  digits: CriticalDigit[];
}

export interface CriticalConflict {
  /** 0..100 — how strongly critical structures point at losing digits. */
  penalty: number;
  conflicts: CriticalDigit[];
  aligned: CriticalDigit[];
  detail: string;
}

export function criticalDigits(intel: DigitIntel, bars: BarStructure): CriticalReport {
  const pct = intel.profiles.map((p) => p.windowShare[7] || p.fast); // 500-tick window
  const delta = intel.profiles.map((p) => p.frequencyVelocity);
  const roles = assignDigitRoles(pct, delta);

  const digits: CriticalDigit[] = [];
  const push = (digit: number, role: CriticalRole, detail: string) => {
    if (digit >= 0 && digit <= 9) digits.push({ digit, role, detail });
  };

  push(
    roles.hot,
    "GREEN BAR",
    `Most appearing digit (${(pct[roles.hot] * 100 || 0).toFixed(1)}%).`,
  );
  push(roles.hot2, "SECOND GREEN BAR", "Second most appearing digit.");
  push(
    roles.cold,
    "RED BAR",
    `Least appearing digit (${(pct[roles.cold] * 100 || 0).toFixed(1)}%).`,
  );
  push(roles.cold2, "SECOND RED BAR", "Second least appearing digit.");
  if (roles.rising >= 0)
    push(
      roles.rising,
      "MOST INCREASING",
      `Strongest rising share (${(delta[roles.rising] * 100).toFixed(2)}pp vs medium window).`,
    );
  if (bars.longGreenSequence && bars.current)
    push(
      bars.current.digit,
      "GREEN-BAR SEQUENCE",
      `Digit printed during a ${bars.consecutive}-bar green run (threshold ${bars.longSequenceThreshold}).`,
    );

  return { digits };
}

/**
 * Compare the critical structures against a contract's losing group.
 * `reliability` (0..1) is the validated historical usefulness of the feature —
 * the penalty is scaled by it so an unvalidated structure cannot dominate.
 */
export function criticalConflict(
  report: CriticalReport,
  losers: number[],
  maxPenalty: number,
  reliability: number,
): CriticalConflict {
  const loserSet = new Set(losers);
  const conflicts = report.digits.filter((c) => loserSet.has(c.digit));
  const aligned = report.digits.filter((c) => !loserSet.has(c.digit));

  const severity: Record<CriticalRole, number> = {
    "GREEN BAR": 1,
    "MOST INCREASING": 0.95,
    "GREEN-BAR SEQUENCE": 0.8,
    "SECOND GREEN BAR": 0.6,
    "SECOND RED BAR": 0.25,
    "RED BAR": 0.15,
  };

  const raw = conflicts.reduce((a, c) => a + severity[c.role], 0);
  const penalty = Math.max(
    0,
    Math.min(maxPenalty, raw * maxPenalty * 0.45 * Math.max(0.25, reliability)),
  );

  return {
    penalty,
    conflicts,
    aligned,
    detail: conflicts.length
      ? `${conflicts.map((c) => `${c.role} = digit ${c.digit}`).join("; ")} sits on the losing side.`
      : "No critical digit structure points at the losing side.",
  };
}
