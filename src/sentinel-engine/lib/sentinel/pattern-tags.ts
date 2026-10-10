// APEX SENTINEL — PATTERN TAG BUILDER (wiring layer).
//
// The governance engine (global-veto.ts) matches on unordered, stable tags.
// This module is the single place where a live signal is translated into that
// tag vocabulary, so the scanner, the operator feedback UI and the veto panel
// all describe the SAME pattern with the SAME tags.
import type { PatternSignature, PatternTag } from "./global-veto";
import type { RankedOpportunity } from "../apex/types";

export interface PatternTagInputs {
  contractId: string;
  side: "OVER" | "UNDER";
  entryDigit?: number | null;
  regime?: string | null;
  psychologyVerdict?: string | null;
  losingSideState?: string | null;
  alignment?: string | null;
  entryTriggerRule?: string | null;
}

function tag(name: string, value: string | number | null | undefined): PatternTag | null {
  if (value === null || value === undefined || value === "") return null;
  return `${name}:${String(value).toUpperCase().replace(/\s+/g, "_")}`;
}

/** Ordered-for-readability, matching is order-independent and case-insensitive. */
export function buildPatternTags(i: PatternTagInputs): PatternTag[] {
  return [
    tag("CONTRACT", i.contractId),
    tag("SIDE", i.side),
    tag("REGIME", i.regime),
    tag("PSY", i.psychologyVerdict),
    tag("LOSING_SIDE", i.losingSideState),
    tag("ALIGNMENT", i.alignment),
    tag("ENTRY", i.entryTriggerRule),
  ].filter((t): t is PatternTag => t !== null);
}

export function patternSignature(i: PatternTagInputs): PatternSignature {
  return {
    tags: buildPatternTags(i),
    contracts: [i.contractId],
    entryDigit: i.entryDigit ?? null,
  };
}

/** Tag inputs for an already-ranked opportunity (feedback + veto UI). */
export function patternInputsFromOpportunity(r: RankedOpportunity): PatternTagInputs {
  return {
    contractId: r.contract.id,
    side: r.contract.side,
    entryDigit: r.entryPoint?.preferred?.digit ?? null,
    regime: r.regimeReport?.currentRegime ?? r.intel.regime?.label ?? null,
    psychologyVerdict: r.digitPsychology?.verdict ?? null,
    losingSideState: r.contract.losingSidePressure?.state ?? null,
    alignment: r.priceAction?.alignment ?? null,
    entryTriggerRule: r.entryTrigger?.preferredTouch ?? null,
  };
}

export function patternSignatureFromOpportunity(r: RankedOpportunity): PatternSignature {
  return patternSignature(patternInputsFromOpportunity(r));
}
