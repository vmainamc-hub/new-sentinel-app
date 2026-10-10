// APEX SENTINEL — UNIFIED SIGNAL STATE (translation layer only).
//
// REFINEMENT 1 + 2 + 4.
//
// This module DOES NOT compute anything new. Every underlying engine keeps its
// own vocabulary and its own maths:
//
//   EntryPointStatus   (entry-point.ts)
//   EntryVerdict       (entry-clearance.ts)
//   SetupGrade         (setup.ts)
//   RelativeEdgeLabel  (relative-edge.ts)
//
// It only normalises those existing states into ONE presentation vocabulary so
// the UI stops having to interpret four enums at once:
//
//   STRONG · VALID · WATCH · EXPLORATORY · BLOCKED
//
// plus the explicit REFINEMENT 2 sub-state "VALID — WAIT FOR ENTRY": the market
// and contract qualify, but the Entry-Point Engine has not validated a digit.
// In that case the entry digit is reported as WAIT. It is never fabricated.
import type { ApexContractId } from "../apex/types";
import { DEFAULT_MIN_SETUP, DEFAULT_MIN_WEIGHTED_N, type EntryVerdict } from "./entry-clearance";
import type { EntryPointReport } from "./entry-point";
import type { EntryTriggerReport, TouchClass } from "./entry-trigger";
import { resolveExecutionInstruction, type ExecutionInstruction } from "./execution-instruction";
import type { RelativeEdgeLabel } from "./relative-edge";
import type { SetupGrade } from "./setup";
import {
  classifySignalPackage,
  type ExecutionSurvivalReport,
  type SignalCompleteness,
} from "./execution-survival";

export type SentinelSignalState = "STRONG" | "VALID" | "WATCH" | "EXPLORATORY" | "BLOCKED";

export interface SentinelSignal {
  state: SentinelSignalState;
  /** True only for REFINEMENT 2: setup qualifies, entry digit does not yet. */
  waitForEntry: boolean;
  /** Presentation label, e.g. "VALID — WAIT FOR ENTRY". */
  label: string;
  /** What the operator should type into the ENTRY DIGIT field. */
  entryDigit: string;
  /** Short reason, built from the existing engine states. */
  reason: string;
  /**
   * LEVEL-2 execution evidence as a SEPARATE dimension. It never rewrites a
   * Level-1 result and it never invents an expectation: an immature sample is
   * reported as INSUFFICIENT HISTORY.
   */
  execution: {
    label: ExecutionSurvivalReport["label"] | "NOT APPLICABLE";
    sufficient: boolean;
    sequences: number;
    /** True when measured post-entry behaviour argues against execution. */
    fragile: boolean;
    note: string;
  };
  /**
   * LEVEL-2.5 ENTRY TRIGGER INTELLIGENCE as a SEPARATE dimension. It never
   * rewrites a Level-1 result and never changes the signal STATE: it only tells
   * the operator WHICH print of the entry digit to act on, and whether the next
   * print is the one the evidence favours.
   */
  trigger: {
    verdict: EntryTriggerReport["verdict"] | "NOT APPLICABLE";
    preferredTouch: TouchClass | null;
    /** True when the next print of the entry digit is the favoured cohort. */
    armed: boolean;
    /** True when the operator should deliberately skip the next print. */
    skipNextTouch: boolean;
    instruction: string;
  };
  /**
   * ARCHITECTURE REPAIR — the SINGLE execution instruction, resolved from the
   * Entry-Point status and the Entry-Trigger verdict. Every surface must render
   * this instead of interpreting the two engines independently.
   */
  instruction: ExecutionInstruction;
  /** Which of the three questions currently have an affirmative answer. */

  packageLevel: SignalCompleteness;
  /** The unchanged source states this was translated from. */
  source: {
    entryStatus: EntryPointReport["status"];
    verdict: EntryVerdict;
    grade: SetupGrade;
    relative: RelativeEdgeLabel;
  };
}

// ── REFINEMENT 4 — per-contract-family qualification thresholds ──────────
// The families share the current global defaults, so behaviour is unchanged.
// They exist so each family can be tuned independently later.
export type ContractFamily = "OVER1_UNDER8" | "OVER2_UNDER7" | "OVER3_UNDER6";

export interface EntryQualification {
  minSetup: number;
  minWeightedN: number;
}

export const entryQualificationByFamily: Record<ContractFamily, EntryQualification> = {
  OVER1_UNDER8: { minSetup: DEFAULT_MIN_SETUP, minWeightedN: DEFAULT_MIN_WEIGHTED_N },
  OVER2_UNDER7: { minSetup: DEFAULT_MIN_SETUP, minWeightedN: DEFAULT_MIN_WEIGHTED_N },
  OVER3_UNDER6: { minSetup: DEFAULT_MIN_SETUP, minWeightedN: DEFAULT_MIN_WEIGHTED_N },
};

const FAMILY_OF: Partial<Record<ApexContractId, ContractFamily>> = {
  OVER1: "OVER1_UNDER8",
  UNDER8: "OVER1_UNDER8",
  OVER2: "OVER2_UNDER7",
  UNDER7: "OVER2_UNDER7",
  OVER3: "OVER3_UNDER6",
  UNDER6: "OVER3_UNDER6",
};

export function contractFamilyOf(contract: string): ContractFamily | null {
  return FAMILY_OF[contract as ApexContractId] ?? null;
}

/** Thresholds for a contract; falls back to the existing global defaults. */
export function qualificationFor(contract: string): EntryQualification {
  const family = contractFamilyOf(contract);
  return family
    ? entryQualificationByFamily[family]
    : { minSetup: DEFAULT_MIN_SETUP, minWeightedN: DEFAULT_MIN_WEIGHTED_N };
}

export interface SignalStateInputs {
  entryPoint: EntryPointReport;
  verdict: EntryVerdict;
  grade: SetupGrade;
  relative: RelativeEdgeLabel;
  /** Hard invalidation / danger clearance already decided elsewhere. */
  blocked: boolean;
  /**
   * LEVEL-2 execution survival for THIS market × contract × entry digit, when
   * one has been measured. Optional by design: a candidate with no validated
   * entry digit has no survival object, and an immature one is not punished.
   */
  survival?: ExecutionSurvivalReport | null;
  /**
   * LEVEL-2.5 entry-trigger evidence for THIS market × contract × entry digit,
   * when one has been measured. Optional by design.
   */
  entryTrigger?: EntryTriggerReport | null;
}

/** A digit is validated only when the Entry-Point Engine says so. */
export function hasValidatedEntryDigit(ep?: EntryPointReport | null): boolean {
  if (!ep) return false;
  return ep.preferred !== null && (ep.status === "ENTER NOW" || ep.status === "ARMED");
}

/**
 * Translate the engine states into the unified vocabulary, then apply the
 * SEPARATE Level-2 execution dimension:
 *
 *   • unknown survival never upgrades and never downgrades a signal, it is
 *     only reported as INSUFFICIENT HISTORY;
 *   • measured FRAGILE survival downgrades STRONG → VALID and is labelled
 *     "GOOD MARKET / WEAK EXECUTION SURVIVAL";
 *   • measured STRONG survival is stated, but never turns a WATCH into a VALID
 *     signal — market and entry evidence still own that decision.
 */
export function resolveSignalState(input: SignalStateInputs): SentinelSignal {
  const base = translateSignalState(input);
  const s = input.survival ?? null;
  const packageLevel = classifySignalPackage({
    marketQualifies: base.state === "STRONG" || base.state === "VALID",
    entryValidated: hasValidatedEntryDigit(input.entryPoint) && !base.waitForEntry,
    survival: s,
  }).level;

  const execution: SentinelSignal["execution"] = !s
    ? {
        label: "NOT APPLICABLE",
        sufficient: false,
        sequences: 0,
        fragile: false,
        note: "No validated entry digit, so post-entry survival is undefined here.",
      }
    : !s.sufficient
      ? {
          label: "INSUFFICIENT EXECUTION HISTORY",
          sufficient: false,
          sequences: s.sequences,
          fragile: false,
          note: `EXECUTION SURVIVAL: INSUFFICIENT HISTORY — ${s.sequences} observed post-entry sequence(s). Multi-run evidence is immature; nothing is being assumed about it.`,
        }
      : {
          label: s.label,
          sufficient: true,
          sequences: s.sequences,
          fragile: s.label === "FRAGILE" || s.lossOnFirstRunRate > 0.5,
          note: s.summary,
        };

  // LEVEL 2.5 — trigger selection. Presentation and instruction only: it never
  // changes the signal STATE, because which print you act on is a different
  // question from whether the market and contract qualify at all.
  const t = input.entryTrigger ?? null;
  const armed = !t || !t.preferredTouch ? true : t.nextTouchAligned === true;
  const trigger: SentinelSignal["trigger"] = {
    verdict: t ? t.verdict : "NOT APPLICABLE",
    preferredTouch: t?.preferredTouch ?? null,
    armed,
    skipNextTouch: Boolean(t?.preferredTouch) && !armed,
    instruction: t
      ? t.instruction
      : "No validated entry digit, so there is no trigger print to select yet.",
  };

  const instruction = resolveExecutionInstruction({
    entryPoint: input.entryPoint,
    entryTrigger: t,
    blocked: input.blocked || base.state === "BLOCKED",
  });

  let signal: SentinelSignal = { ...base, execution, packageLevel, trigger, instruction };

  if (trigger.skipNextTouch && signal.state !== "BLOCKED") {
    signal = {
      ...signal,
      reason: `${signal.reason} LEVEL 2.5: ${trigger.instruction}`,
    };
  }

  if (
    execution.sufficient &&
    execution.fragile &&
    (signal.state === "STRONG" || signal.state === "VALID")
  ) {
    signal = {
      ...signal,
      state: signal.state === "STRONG" ? "VALID" : signal.state,
      label: signal.waitForEntry ? signal.label : "GOOD MARKET / WEAK EXECUTION SURVIVAL",
      reason: `${signal.reason} Downgraded on LEVEL-2 evidence: ${execution.note}`,
    };
  } else if (execution.sufficient && (s!.label === "STRONG" || s!.label === "MODERATE")) {
    signal = {
      ...signal,
      reason: `${signal.reason} Post-entry evidence is supportive (${s!.label}, ${s!.sequences} sequences).`,
    };
  } else if (!execution.sufficient && !signal.waitForEntry && signal.state !== "BLOCKED") {
    signal = { ...signal, reason: `${signal.reason} ${execution.note}` };
  }

  return signal;
}

function translateSignalState(
  input: SignalStateInputs,
): Omit<SentinelSignal, "execution" | "packageLevel" | "trigger" | "instruction"> {
  const { entryPoint: ep, verdict, grade, relative, blocked } = input;
  const source = { entryStatus: ep.status, verdict, grade, relative: relative };

  if (blocked || verdict === "BLOCKED" || ep.status === "INVALIDATED") {
    return {
      state: "BLOCKED",
      waitForEntry: false,
      label: "BLOCKED",
      entryDigit: "—",
      reason:
        ep.status === "INVALIDATED"
          ? "Hard invalidation on the entry point (danger clearance, severe exposure or chaotic fluctuation)."
          : "A blocking requirement is unmet in the entry-clearance stage.",
      source,
    };
  }

  const digit = hasValidatedEntryDigit(ep);
  // "Meaningful setup" reuses the existing grades and relative-edge labels; no
  // new scoring is introduced here.
  const setupQualifies = grade === "PRIME" || grade === "GOOD";
  const edgeSufficient =
    relative === "STRONG" || relative === "MODERATE" || relative === "MARGINAL";

  if (setupQualifies && edgeSufficient && !digit) {
    // REFINEMENT 2 — valid setup, no validated entry digit. Not BLOCKED, and
    // not "no opportunity". Wait for the Entry-Point Engine to validate a digit.
    return {
      state: "VALID",
      waitForEntry: true,
      label: "VALID — WAIT FOR ENTRY",
      entryDigit: "WAIT",
      reason:
        "Setup and relative edge qualify, but no entry digit has sufficient conditional evidence yet. Wait for a validated entry digit — none will be fabricated.",
      source,
    };
  }

  if (
    digit &&
    setupQualifies &&
    (relative === "STRONG" || relative === "MODERATE") &&
    verdict === "CLEARED"
  ) {
    return {
      state: "STRONG",
      waitForEntry: false,
      label: "STRONG",
      entryDigit: String(ep.preferred!.digit),
      reason: `Entry cleared with a validated digit and ${relative.toLowerCase()} relative edge (margin ${ep.entryMargin >= 0 ? "+" : ""}${ep.entryMargin} over runner-up ${ep.runnerUpDigit ?? "—"}).`,
      source,
    };
  }

  if (digit && (setupQualifies || edgeSufficient)) {
    return {
      state: "VALID",
      waitForEntry: false,
      label: "VALID",
      entryDigit: String(ep.preferred!.digit),
      reason: `Validated entry digit ${ep.preferred!.digit} with entry margin ${ep.entryMargin >= 0 ? "+" : ""}${ep.entryMargin} over the runner-up.`,
      source,
    };
  }

  if (grade === "MARGINAL" || relative === "LEVEL") {
    return {
      state: "WATCH",
      waitForEntry: !digit,
      label: digit ? "WATCH" : "WATCH — NO VALIDATED ENTRY",
      entryDigit: digit ? String(ep.preferred!.digit) : "WAIT",
      reason: `Setup ${grade} with ${relative} relative edge — monitored, not actionable.`,
      source,
    };
  }

  return {
    state: "EXPLORATORY",
    waitForEntry: !digit,
    label: "EXPLORATORY",
    entryDigit: digit ? String(ep.preferred!.digit) : "WAIT",
    reason: `Evidence is immature for this candidate (setup ${grade}, relative edge ${relative}) — exploratory only.`,
    source,
  };
}

export interface SignalLifecycleMapping {
  phase: "EVALUATING" | "INCUBATING" | "ACTIONABLE" | "EXPIRED" | "BLOCKED";
  isActionable: boolean;
  isWaitingForTrigger: boolean;
  displayLabel: string;
}

/**
 * Maps the 8 canonical states without collapsing:
 * WATCH, DEVELOPING, QUALIFIED, VALID_WAIT_ENTRY, STRONG, EXECUTION_READY, BLOCKED/INVALIDATED, EXPIRED
 */
export function mapObservationStateToSignalLifecycle(
  state: string,
): SignalLifecycleMapping {
  switch (state) {
    case "RIPE":
    case "EXECUTION_READY":
    case "STRONG":
      return {
        phase: "ACTIONABLE",
        isActionable: true,
        isWaitingForTrigger: false,
        displayLabel: state,
      };
    case "VALID_WAIT_ENTRY":
    case "CONFIRMING":
      return {
        phase: "INCUBATING",
        isActionable: false,
        isWaitingForTrigger: true,
        displayLabel: "QUALIFIED — WAITING FOR ENTRY",
      };
    case "QUALIFIED":
      return {
        phase: "INCUBATING",
        isActionable: false,
        isWaitingForTrigger: true,
        displayLabel: "QUALIFIED",
      };
    case "DEVELOPING":
    case "INTERESTING":
      return {
        phase: "EVALUATING",
        isActionable: false,
        isWaitingForTrigger: false,
        displayLabel: "DEVELOPING",
      };
    case "EXPIRED":
    case "DECAYING":
      return {
        phase: "EXPIRED",
        isActionable: false,
        isWaitingForTrigger: false,
        displayLabel: "EXPIRED",
      };
    case "BLOCKED":
    case "VETOED":
    case "REJECTED":
    case "INVALIDATED":
      return {
        phase: "BLOCKED",
        isActionable: false,
        isWaitingForTrigger: false,
        displayLabel: "BLOCKED / INVALIDATED",
      };
    case "WATCH":
    case "WATCHING":
    default:
      return {
        phase: "EVALUATING",
        isActionable: false,
        isWaitingForTrigger: false,
        displayLabel: "WATCH",
      };
  }
}
