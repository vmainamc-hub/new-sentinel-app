// ═══════════════════════════════════════════════════════════════════════════
// RED / 2ND RED SEMANTICS — SINGLE AUTHORITATIVE DEFINITION (PHASE 15A)
//
// FORENSIC FINDING
// ----------------
// RED / 2ND RED semantics were described inconsistently across the codebase:
//
//   • proposal/veto-engine.ts (header comment) described "RED / 2ND RED /
//     2ND GREEN / MOST INCREASING on the losing side" as a
//     STRUCTURAL_HARD_BLOCK → VETO.
//   • digit-psychology.ts (live code, per Master Corrective Prompt §10/§11)
//     treats losing-side placement, wrong parity and out-of-range RED as a
//     STRUCTURAL CONFLICT: a scoring penalty plus a caution, NOT a veto.
//   • price-action-psychology.ts treats a RISING losing-side RED / 2ND RED as
//     a small ranking penalty and a caution.
//
// RESOLUTION (source-verified)
// ----------------------------
// The LIVE code path is digit-psychology.ts, and it implements §10/§11: only
// FATAL structural corruption blocks. The veto-engine header comment was the
// stale artifact and has been corrected to match the live rules.
//
// There are therefore exactly TWO classifications, and this module is the only
// place either is defined:
//
//   FATAL                — the configuration is corrupt; the setup cannot be
//                          scored around. RED or 2ND RED sitting on the
//                          EXCLUDED digit (1 for OVER, 8 for UNDER), or an
//                          INVALIDATED configuration.  → hard block
//
//   STRUCTURAL_CONFLICT  — the configuration is intact but misaligned: RED or
//                          2ND RED out of range, wrong parity, or sitting on
//                          the losing side.  → scoring penalty + caution +
//                          quantified danger contribution. NEVER a veto.
//
// A rising losing-side RED / 2ND RED is a STRUCTURAL_CONFLICT whose severity
// increases with the movement; it is expressed through danger, not through a
// veto. Every consumer must read this module rather than restate the rules.
// ═══════════════════════════════════════════════════════════════════════════

import type { CanonicalDigitState, ContractShape } from "./digit-psychology";

export type RedClassification = "FATAL" | "STRUCTURAL_CONFLICT";

export type RedRole = "RED" | "2ND RED";

export type RedRule =
  | "EXCLUDED_DIGIT"
  | "CONFIGURATION_INVALIDATED"
  | "OUT_OF_RANGE"
  | "WRONG_PARITY"
  | "LOSING_SIDE_PLACEMENT";

/**
 * Authoritative penalty weights for RED-family structural conflicts, in the
 * same scoring units digit-psychology.ts uses. These are the pre-existing
 * live values, relocated here so they are declared exactly once.
 */
export const RED_SEMANTICS = {
  /** Digit RED / 2ND RED may never occupy, by side. */
  excludedDigit: { OVER: 1, UNDER: 8 } as const,
  /** Range RED / 2ND RED must sit in, by side. */
  range: { OVER: [5, 9], UNDER: [0, 4] } as const,
  /** Parity RED / 2ND RED must have, by side. */
  parity: { OVER: "ODD", UNDER: "EVEN" } as const,
  penalty: {
    RED_OUT_OF_RANGE: 15,
    SECOND_RED_OUT_OF_RANGE: 10,
    RED_WRONG_PARITY: 15,
    RED_LOSING_SIDE: 15,
    SECOND_RED_LOSING_SIDE: 10,
  },
} as const;

export interface RedViolation {
  role: RedRole;
  digit: number;
  rule: RedRule;
  classification: RedClassification;
  /** digit-psychology scoring penalty attributable to this violation. */
  scorePenalty: number;
  /** 0..100 contribution to the RED conflict severity used by danger.ts. */
  severity: number;
  note: string;
}

export interface RedSemantics {
  /** Configuration is corrupt — hard block. */
  fatal: boolean;
  fatalReason: string | null;
  violations: RedViolation[];
  /** 0..100 aggregate severity of NON-fatal structural conflicts. */
  conflictSeverity: number;
  /** True when a losing-side RED / 2ND RED is actively gaining share. */
  risingOnLosingSide: boolean;
  summary: string;

  // ─────────────────────────────────────────────────────────────────────
  // MANDATORY STRUCTURE (non-compensable). Distinct from `conflictSeverity`
  // above: conflictSeverity still feeds a compensable scoring penalty for
  // out-of-range/parity conflicts. These three checks — RED on winning
  // side, 2ND RED on winning side, winning side gaining — are the
  // irreducible setup conditions. A cell that fails any of them must never
  // qualify or reach Best-of-90, no matter how high its PsychologyScore or
  // opportunityScore is otherwise. See qualification.ts for the gate that
  // consumes this.
  // ─────────────────────────────────────────────────────────────────────

  /** RED sits on the winning side. Null when RED hasn't formed yet. */
  redOnWinningSide: boolean | null;
  /** 2ND RED sits on the winning side. Null when 2ND RED hasn't formed yet. */
  secondRedOnWinningSide: boolean | null;
  /** Sum of deltaPp across all winning digits is > 0 — the winning side is
   *  actually gaining share right now, not just correctly positioned. */
  winningSideGainingPercentage: boolean;
  /** True iff redOnWinningSide === false, secondRedOnWinningSide === false,
   *  or winningSideGainingPercentage === false. Non-compensable — set this,
   *  never re-derive it from conflictSeverity or any score. */
  mandatoryRedStructureFailed: boolean;
  /** Human-readable reasons for mandatoryRedStructureFailed, for UI/explain. */
  mandatoryFailureReasons: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Classify RED / 2ND RED placement for one contract. Pure.
 *
 * @param state   canonical 1,000-tick structural state
 * @param shape   contract under evaluation
 * @param winners winning digits for this contract (defaults to shape.winners)
 */
export function classifyRedSemantics(
  state: CanonicalDigitState,
  shape: ContractShape,
  winners: number[] = shape.winners,
): RedSemantics {
  const isOver = shape.side === "OVER";
  const excluded = isOver ? RED_SEMANTICS.excludedDigit.OVER : RED_SEMANTICS.excludedDigit.UNDER;
  const [lo, hi] = isOver ? RED_SEMANTICS.range.OVER : RED_SEMANTICS.range.UNDER;

  const violations: RedViolation[] = [];
  let fatal = false;
  let fatalReason: string | null = null;
  let risingOnLosingSide = false;

  const roles: Array<{ role: RedRole; digit: number | null; second: boolean }> = [
    { role: "RED", digit: state.red, second: false },
    { role: "2ND RED", digit: state.secondRed, second: true },
  ];

  for (const { role, digit, second } of roles) {
    if (digit === null) continue;

    // FATAL — excluded digit.
    if (digit === excluded) {
      fatal = true;
      fatalReason ??= `${role} sits on the forbidden digit ${excluded} for ${shape.side} psychology.`;
      violations.push({
        role,
        digit,
        rule: "EXCLUDED_DIGIT",
        classification: "FATAL",
        scorePenalty: 0,
        severity: 100,
        note: `${role} sits on the forbidden digit ${excluded} for ${shape.side} psychology — configuration is corrupt.`,
      });
      continue;
    }

    // STRUCTURAL_CONFLICT — out of range.
    if (digit < lo || digit > hi) {
      violations.push({
        role,
        digit,
        rule: "OUT_OF_RANGE",
        classification: "STRUCTURAL_CONFLICT",
        scorePenalty: second
          ? RED_SEMANTICS.penalty.SECOND_RED_OUT_OF_RANGE
          : RED_SEMANTICS.penalty.RED_OUT_OF_RANGE,
        severity: second ? 14 : 20,
        note: `${role} (digit ${digit}) sits outside ${lo}-${hi} for ${shape.side} contracts.`,
      });
    }

    // STRUCTURAL_CONFLICT — wrong parity (RED only, mirroring live rules).
    if (!second) {
      const parityOk = isOver ? digit % 2 === 1 : digit % 2 === 0;
      if (!parityOk) {
        violations.push({
          role,
          digit,
          rule: "WRONG_PARITY",
          classification: "STRUCTURAL_CONFLICT",
          scorePenalty: RED_SEMANTICS.penalty.RED_WRONG_PARITY,
          severity: 18,
          note: `${role} (digit ${digit}) has wrong parity for ${shape.side} psychology — expected ${isOver ? "ODD" : "EVEN"}.`,
        });
      }
    }

    // STRUCTURAL_CONFLICT — losing-side placement. Severity scales with the
    // digit's actual movement: a RISING losing-side RED is worse than a static
    // one, but it is still a conflict, never a veto.
    if (!winners.includes(digit)) {
      const deltaPp = state.deltaPp[digit] ?? 0;
      const rising = deltaPp > 0.3;
      if (rising) risingOnLosingSide = true;
      violations.push({
        role,
        digit,
        rule: "LOSING_SIDE_PLACEMENT",
        classification: "STRUCTURAL_CONFLICT",
        scorePenalty: second
          ? RED_SEMANTICS.penalty.SECOND_RED_LOSING_SIDE
          : RED_SEMANTICS.penalty.RED_LOSING_SIDE,
        severity: clamp((second ? 14 : 20) + (rising ? deltaPp * 6 : 0), 0, 40),
        note:
          `${role} (digit ${digit}) sits on the losing side for ${shape.side} psychology` +
          (rising ? ` and is RISING (+${deltaPp.toFixed(2)}pp) — actively hostile.` : "."),
      });
    }
  }

  if (state.change === "INVALIDATED") {
    fatal = true;
    fatalReason ??= `Digit psychology configuration is INVALIDATED: ${state.changeDetail}`;
  }

  const conflicts = violations.filter((v) => v.classification === "STRUCTURAL_CONFLICT");
  const conflictSeverity = Math.round(
    clamp(
      conflicts.reduce((a, v) => a + v.severity, 0),
      0,
      100,
    ),
  );

  // ── MANDATORY STRUCTURE — irreducible, non-compensable ────────────────
  // RED on winning side, 2ND RED on winning side, winning side gaining.
  // Computed independently of the scoring-penalty violations above so a
  // high PsychologyScore elsewhere can never buy these back.
  const redOnWinningSide = state.red === null ? null : winners.includes(state.red);
  const secondRedOnWinningSide =
    state.secondRed === null ? null : winners.includes(state.secondRed);

  const winningSideDeltaPp = winners.reduce((sum, d) => sum + (state.deltaPp[d] ?? 0), 0);
  const winningSideGainingPercentage = winningSideDeltaPp > 0;

  const mandatoryFailureReasons: string[] = [];
  if (redOnWinningSide === false) {
    mandatoryFailureReasons.push(
      `RED (digit ${state.red}) is on the losing side — mandatory RED structure requires RED on the winning side.`,
    );
  }
  if (secondRedOnWinningSide === false) {
    mandatoryFailureReasons.push(
      `2ND RED (digit ${state.secondRed}) is on the losing side — mandatory RED structure requires 2ND RED on the winning side.`,
    );
  }
  if (!winningSideGainingPercentage) {
    mandatoryFailureReasons.push(
      `Winning side is not gaining percentage (net ${winningSideDeltaPp >= 0 ? "+" : ""}${winningSideDeltaPp.toFixed(2)}pp across winning digits) — mandatory structure requires the winning side to be gaining.`,
    );
  }

  const mandatoryRedStructureFailed =
    redOnWinningSide === false ||
    secondRedOnWinningSide === false ||
    !winningSideGainingPercentage;

  return {
    fatal,
    fatalReason,
    violations,
    conflictSeverity,
    risingOnLosingSide,
    redOnWinningSide,
    secondRedOnWinningSide,
    winningSideGainingPercentage,
    mandatoryRedStructureFailed,
    mandatoryFailureReasons,
    summary: fatal
      ? `RED SEMANTICS — FATAL: ${fatalReason}`
      : mandatoryRedStructureFailed
        ? `RED SEMANTICS — MANDATORY STRUCTURE FAILED (not qualifiable): ${mandatoryFailureReasons.join(" ")}`
        : conflicts.length === 0
          ? "RED SEMANTICS — RED and 2ND RED are correctly placed (range, parity and winning-zone rules satisfied)."
          : `RED SEMANTICS — STRUCTURAL CONFLICT (severity ${conflictSeverity}/100, ${conflicts.length} violation${conflicts.length === 1 ? "" : "s"}${risingOnLosingSide ? ", losing-side RED RISING" : ""}): ${conflicts.map((v) => v.note).join(" ")}`,
  };
}
