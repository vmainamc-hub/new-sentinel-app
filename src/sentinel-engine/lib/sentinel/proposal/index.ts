// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR — THE PROPOSED SENTINEL DECISION SPINE
//
//        1,000 TICKS · STRUCTURAL DIGIT PSYCHOLOGY   (structural-direction.ts)
//                          │  decides
//                          ▼
//                    OVER / UNDER
//                          │
//                          ▼
//        15 / 30 / 60 / 120 · PRESSURE FIELD          (pressure-windows.ts)
//                          │  judges
//                          ▼
//            CONFIRM / NEUTRAL / MIXED / REJECT       (pressure-validator.ts)
//                          │
//                          ▼
//        ALLOW / CAUTION / SUPPRESS / VETO            (veto-engine.ts)
//                          │
//                          ▼
//        EXISTING SENTINEL ENTRY / TRIGGER / RANKING
//
// No engine votes on anything outside its own job. Structure owns direction;
// pressure owns movement; the veto engine owns permission.
// ═══════════════════════════════════════════════════════════════════════════
export * from "./types";
export * from "./structural-direction";
export * from "./pressure-windows";
export * from "./pressure-validator";
export * from "./veto-engine";

import { computePressureField, type PressureField } from "./pressure-windows";
import { validateDirectionWithPressure, type PressureValidation } from "./pressure-validator";
import { structuralDirection, type StructuralDirectionReport } from "./structural-direction";
import {
  DEFAULT_MIN_CONVICTION,
  runVetoEngine,
  type OperatorVetoInput,
  type VetoReport,
} from "./veto-engine";
import { clamp, type CanonicalStateLike, type ContractShapeLike, type Side } from "./types";

export interface SentinelSpineInputs {
  /** Canonical 1,000-tick state from the existing digit-psychology layer. */
  canonical: CanonicalStateLike;
  /** Raw tick digits, oldest → newest. Only the last 120 are used by Engine B. */
  digits: readonly number[];
  /** Optional contract under evaluation — used only to flag side mismatch. */
  contract?: ContractShapeLike | null;
  operator?: OperatorVetoInput | null;
  minConviction?: number;
}

export interface SentinelSpineReport {
  structure: StructuralDirectionReport;
  pressure: PressureField;
  validation: PressureValidation | null;
  veto: VetoReport;
  /** The direction the pipeline is willing to act on, if any. */
  direction: Side | null;
  /** True when the evaluated contract's side matches the structural direction. */
  contractAligned: boolean | null;
  /**
   * 0..100 — structural conviction after pressure and veto adjustment. This is
   * NOT a blend of engine opinions: it is one number (structure) scaled by two
   * gates (pressure, veto).
   */
  score: number;
  tradeable: boolean;
  headline: string;
  lines: string[];
}

/** Run the whole spine for one market (and, optionally, one contract). */
export function evaluateSentinelSpine(input: SentinelSpineInputs): SentinelSpineReport {
  const structure = structuralDirection(input.canonical);
  const pressure = computePressureField(input.digits, input.canonical.pct);

  const direction: Side | null =
    structure.direction === "OVER" || structure.direction === "UNDER" ? structure.direction : null;

  const validation = direction
    ? validateDirectionWithPressure(input.digits, direction, pressure)
    : null;

  const veto = runVetoEngine({
    structure,
    validation,
    field: pressure,
    operator: input.operator ?? null,
    minConviction: input.minConviction ?? DEFAULT_MIN_CONVICTION,
  });

  const contractAligned = input.contract && direction ? input.contract.side === direction : null;

  const score = Math.round(
    clamp(structure.conviction * (validation?.modifier ?? 1) * veto.modifier, 0, 100),
  );

  const tradeable =
    Boolean(direction) &&
    veto.verdict !== "VETO" &&
    veto.verdict !== "SUPPRESS" &&
    contractAligned !== false;

  const lines = [
    structure.summary,
    pressure.summary,
    validation?.summary ?? "No pressure validation — structure has no direction to validate.",
    veto.summary,
  ];
  if (contractAligned === false && input.contract) {
    lines.push(
      `Contract ${input.contract.label} is ${input.contract.side} while structure says ${direction} — do not take it on this structure.`,
    );
  }

  return {
    structure,
    pressure,
    validation,
    veto,
    direction,
    contractAligned,
    score,
    tradeable,
    headline: direction
      ? `${direction} · structure ${structure.conviction}/100 · pressure ${validation?.verdict ?? "—"} · ${veto.verdict} · score ${score}/100`
      : `NO DIRECTION · ${structure.direction} · ${veto.verdict}`,
    lines,
  };
}
