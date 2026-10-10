// ═══════════════════════════════════════════════════════════════════════════
// VETO ENGINE — CAN STOP A SIGNAL REGARDLESS OF ITS SCORE
//
// Nothing in here is a vote. Every rule is a gate. Scores are produced upstream
// (structure decides direction, pressure confirms or contradicts it); this layer
// only decides whether the signal is ALLOWED to reach the operator.
//
// Verdict ladder — the worst verdict any rule produces wins:
//
//   ALLOW    — no gate fired.
//   CAUTION  — a soft gate fired: signal survives, score is discounted.
//   SUPPRESS — signal must not be presented as a trade; it may still be shown
//              as a watch item. Score is heavily discounted.
//   VETO     — hard stop. Non-negotiable, cannot be scored around.
//
// Rules implemented (each maps to a named, auditable code):
//   STRUCTURAL_HARD_BLOCK   FATAL structural corruption only, as defined by
//                           src/lib/sentinel/red-semantics.ts: RED / 2ND RED on
//                           the EXCLUDED digit (1 for OVER, 8 for UNDER), or an
//                           INVALIDATED configuration.  → VETO
//                           NOTE (Phase 15A): losing-side placement, wrong
//                           parity and out-of-range RED / 2ND RED are
//                           STRUCTURAL_CONFLICT — penalties, cautions and
//                           quantified danger, NEVER a veto. This comment
//                           previously overstated them as vetoes; the live rule
//                           is and always was red-semantics.ts.
//   STRUCTURAL_CONFLICT     Structure has no direction.                  → VETO
//   STRUCTURAL_INSUFFICIENT Canonical ticks insufficient.               → VETO
//   STRUCTURAL_INVALIDATED  Canonical leadership collapsed.              → SUPPRESS
//   PRESSURE_CONTRADICTION  Pressure REJECTs the structural direction.   → SUPPRESS
//   LOSING_SIDE_TAKEOVER    Losing group taking over across 120→15.      → VETO
//   LOSING_CLIMB_BREADTH    2+ losing digits climbing in every window.   → SUPPRESS
//   EXCLUDED_DIGIT_PRESSURE The side's forbidden digit (1 for OVER, 8 for
//                           UNDER) is building.                          → SUPPRESS
//   WINDOW_DISAGREEMENT     Only an isolated window supports the move.   → CAUTION
//   PRESSURE_ROTATION       Both sides building — regime transition.     → CAUTION
//   LOW_CONVICTION          Structure barely committed.                  → CAUTION
//   OPERATOR_VETO           Externally supplied manual/learned veto.     → VETO
// ═══════════════════════════════════════════════════════════════════════════
import type { PressureField } from "./pressure-windows";
import { sideSpec, type StructuralDirectionReport } from "./structural-direction";
import type { PressureValidation } from "./pressure-validator";
import { clamp, type Side } from "./types";

export type VetoVerdict = "ALLOW" | "CAUTION" | "SUPPRESS" | "VETO";

export type VetoCode =
  | "STRUCTURAL_HARD_BLOCK"
  | "STRUCTURAL_CONFLICT"
  | "STRUCTURAL_INSUFFICIENT"
  | "STRUCTURAL_INVALIDATED"
  | "PRESSURE_CONTRADICTION"
  | "LOSING_SIDE_TAKEOVER"
  | "LOSING_CLIMB_BREADTH"
  | "EXCLUDED_DIGIT_PRESSURE"
  | "WINDOW_DISAGREEMENT"
  | "PRESSURE_ROTATION"
  | "LOW_CONVICTION"
  | "OPERATOR_VETO";

export interface VetoRuleHit {
  code: VetoCode;
  verdict: Exclude<VetoVerdict, "ALLOW">;
  /** Which layer raised it — useful for the operator-facing explanation. */
  layer: "STRUCTURE" | "PRESSURE" | "OPERATOR";
  /** True when no score anywhere in the pipeline may override it. */
  nonNegotiable: boolean;
  reason: string;
}

export interface VetoReport {
  verdict: VetoVerdict;
  /** Multiplier for the downstream opportunity score. */
  modifier: number;
  /** True when the signal must not be presented as tradeable. */
  blocked: boolean;
  hits: VetoRuleHit[];
  /** Only the hits that produced the final verdict. */
  decisive: VetoRuleHit[];
  summary: string;
}

/** Manual / learned vetoes supplied by the existing global-veto layer. */
export interface OperatorVetoInput {
  active: boolean;
  reason?: string;
}

export interface VetoEngineInputs {
  structure: StructuralDirectionReport;
  /** Null when structure produced no direction. */
  validation: PressureValidation | null;
  /** Optional — enables per-digit rules (excluded digit, climb breadth). */
  field?: PressureField | null;
  /** Optional pass-through from global-veto.ts / operator-learning.ts. */
  operator?: OperatorVetoInput | null;
  /** Minimum structural conviction before a signal is considered committed. */
  minConviction?: number;
}

const RANK: Record<VetoVerdict, number> = { ALLOW: 0, CAUTION: 1, SUPPRESS: 2, VETO: 3 };
const MODIFIER: Record<VetoVerdict, number> = { ALLOW: 1, CAUTION: 0.88, SUPPRESS: 0.55, VETO: 0 };

export const DEFAULT_MIN_CONVICTION = 30;
/** pp of excluded-digit gain that trips EXCLUDED_DIGIT_PRESSURE. */
export const EXCLUDED_DIGIT_BUILD_PP = 1.2;

const worst = (a: VetoVerdict, b: VetoVerdict): VetoVerdict => (RANK[a] >= RANK[b] ? a : b);

/**
 * Run every gate. Pure — no I/O, no state, safe to call per tick per contract.
 */
export function runVetoEngine(input: VetoEngineInputs): VetoReport {
  const { structure, validation, field, operator } = input;
  const minConviction = input.minConviction ?? DEFAULT_MIN_CONVICTION;
  const hits: VetoRuleHit[] = [];

  const push = (
    code: VetoCode,
    verdict: Exclude<VetoVerdict, "ALLOW">,
    layer: VetoRuleHit["layer"],
    reason: string,
    nonNegotiable = verdict === "VETO",
  ) => hits.push({ code, verdict, layer, nonNegotiable, reason });

  // ── OPERATOR ───────────────────────────────────────────────────────────
  if (operator?.active) {
    push(
      "OPERATOR_VETO",
      "VETO",
      "OPERATOR",
      operator.reason ?? "Operator veto is active for this pattern.",
    );
  }

  // ── STRUCTURE ──────────────────────────────────────────────────────────
  const direction = structure.direction;
  const directional = direction === "OVER" || direction === "UNDER";

  if (direction === "UNKNOWN") {
    push(
      "STRUCTURAL_INSUFFICIENT",
      "SUPPRESS",
      "STRUCTURE",
      structure.reasons[0] ??
        "Canonical 1,000-tick window has not filled enough to define a direction.",
    );
  }
  if (direction === "CONFLICT") {
    push(
      "STRUCTURAL_CONFLICT",
      "CAUTION",
      "STRUCTURE",
      structure.reasons[0] ??
        "Structural psychology gives no direction — both sides score alike or both are blocked.",
    );
  }
  if (directional) {
    const chosen = direction === "OVER" ? structure.over : structure.under;
    if (chosen.hardBlock) {
      // Should be unreachable (Engine A never picks a blocked side) — kept as a
      // belt-and-braces gate so a future scoring change cannot slip past it.
      push(
        "STRUCTURAL_HARD_BLOCK",
        "VETO",
        "STRUCTURE",
        `${direction} carries a non-negotiable structural block: ${chosen.hardBlockReasons[0]}`,
      );
    }
    if (structure.change === "INVALIDATED") {
      push(
        "STRUCTURAL_INVALIDATED",
        "SUPPRESS",
        "STRUCTURE",
        "Canonical configuration is INVALIDATED — the roles that produced this direction have collapsed.",
      );
    }
    if (structure.conviction < minConviction) {
      push(
        "LOW_CONVICTION",
        "CAUTION",
        "STRUCTURE",
        `Structural conviction ${structure.conviction}/100 is below ${minConviction} — direction is held, not trusted.`,
      );
    }
  }

  // ── PRESSURE ───────────────────────────────────────────────────────────
  if (directional && validation) {
    if (validation.verdict === "REJECT") {
      push(
        "PRESSURE_CONTRADICTION",
        "SUPPRESS",
        "PRESSURE",
        `15/30/60/120 pressure contradicts the structural ${direction}: ${validation.reasons[0] ?? validation.summary}`,
      );
    }

    const lose = validation.losingSide;
    if (
      lose.measurable &&
      lose.movement === "TAKING OVER" &&
      lose.ratePp >= 3.5 &&
      lose.agreement === "4/4"
    ) {
      push(
        "LOSING_SIDE_TAKEOVER",
        "VETO",
        "PRESSURE",
        `Losing side of ${direction} is TAKING OVER — ${lose.ratePp.toFixed(2)}pp across 120→15 with ${lose.agreement} window agreement.`,
      );
    } else if (lose.measurable && (lose.movement === "TAKING OVER" || lose.ratePp >= 2.5)) {
      push(
        "PRESSURE_CONTRADICTION",
        "SUPPRESS",
        "PRESSURE",
        `Losing side of ${direction} is building — ${lose.ratePp.toFixed(2)}pp across 120→15 (${lose.movement}).`,
      );
    }

    if (validation.losingClimbers.length >= 2) {
      push(
        "LOSING_CLIMB_BREADTH",
        "SUPPRESS",
        "PRESSURE",
        `Losing digits ${validation.losingClimbers.map((c) => c.digit).join(", ")} are gaining in every window — broad hostile build.`,
      );
    }

    if (validation.rotating) {
      push(
        "PRESSURE_ROTATION",
        "CAUTION",
        "PRESSURE",
        "Winning and losing sides are both gaining — regime rotation; wait for one side to resolve.",
      );
    }

    if (
      (validation.verdict === "CONFIRM" || validation.verdict === "NEUTRAL") &&
      (validation.agreement === "1/4" || validation.agreement === "NONE")
    ) {
      push(
        "WINDOW_DISAGREEMENT",
        "CAUTION",
        "PRESSURE",
        `Only an isolated window carries the move (${validation.agreement}) — likely a 15-tick burst, not pressure.`,
      );
    }

    // Excluded digit: the one digit that must never lead this side. Pressure
    // does not know it is special, so the gate reads it explicitly.
    if (field?.measurable) {
      const excluded = sideSpec(direction as Side).excludedRedDigit;
      const r = field.digits[excluded];
      if (r && r.ratePp >= EXCLUDED_DIGIT_BUILD_PP && r.persistence >= 0.66) {
        push(
          "EXCLUDED_DIGIT_PRESSURE",
          "SUPPRESS",
          "PRESSURE",
          `Excluded digit ${excluded} for ${direction} is building (${r.ratePp.toFixed(2)}pp, ${r.agreement}, ${r.movement}) — this side's forbidden digit must stay quiet.`,
        );
      }
    }
  } else if (directional && !validation) {
    push(
      "WINDOW_DISAGREEMENT",
      "CAUTION",
      "PRESSURE",
      "No pressure validation available — the structural direction is unconfirmed.",
    );
  }

  const verdict = hits.reduce<VetoVerdict>((acc, h) => worst(acc, h.verdict), "ALLOW");
  const decisive = hits.filter((h) => h.verdict === verdict);
  const modifier = clamp(MODIFIER[verdict], 0, 1);

  return {
    verdict,
    modifier,
    blocked: verdict === "VETO",
    hits,
    decisive,
    summary:
      verdict === "ALLOW"
        ? `VETO ENGINE: ALLOW — no gate fired (${direction}, conviction ${structure.conviction}/100).`
        : `VETO ENGINE: ${verdict} — ${decisive.map((h) => `${h.code}: ${h.reason}`).join(" | ")}`,
  };
}
