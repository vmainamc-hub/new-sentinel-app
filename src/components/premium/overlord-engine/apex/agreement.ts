// PORTED from the Apex Sentinel tool (precisionapex6) apex/simulator.ts engineAgreement. Pure: the label is derived from the contract's own evidence stack.
import type { ContractEval } from "./types";

/** Engine-agreement label derived from the contract's own evidence stack. */
export function engineAgreement(c: ContractEval): "SUPPORT" | "NEUTRAL" | "CONFLICT" | "STRONG CONFLICT" {
  const supports = c.supports.length;
  const conflicts = c.conflicts.length;
  const severe =
    (c.threat && (c.threat.state === "HIGH" || c.threat.state === "CRITICAL")) ||
    (c.critical && c.critical.conflicts.length >= 2) ||
    c.contradiction >= 60;
  if (severe) return "STRONG CONFLICT";
  if (conflicts > supports) return "CONFLICT";
  if (supports >= conflicts + 2 && c.contradiction < 35) return "SUPPORT";
  return "NEUTRAL";
}

export type EngineAgreement = ReturnType<typeof engineAgreement>;
