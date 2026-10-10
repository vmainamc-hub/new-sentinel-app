// APEX SENTINEL — ONE EXECUTION INSTRUCTION (conflict resolver).
//
// ARCHITECTURE REPAIR (Entry Point vs Entry Trigger):
// Entry Point answers "WHICH digit do I wait for?" and Entry Trigger answers
// "WHICH print of that digit do I act on?". Both previously reached the UI
// independently, which allowed contradictory instructions such as
//   Entry Point = ENTER NOW  while  Entry Trigger = SKIP NEXT TOUCH.
//
// This module computes nothing new. It resolves the two existing states into
// exactly ONE instruction, and every surface (Best Opportunity, alert, DBot
// handoff, copyable plan) must render this and only this.
import type { EntryPointReport } from "./entry-point";
import type { EntryTriggerReport } from "./entry-trigger";
import type { TouchClass } from "./touch-classification";

export type ExecutionInstructionState =
  | "BLOCKED"
  | "WAIT FOR VALIDATED ENTRY DIGIT"
  | "INSUFFICIENT TRIGGER HISTORY"
  | "ENTER NOW"
  | "ARMED"
  | "WAIT FOR FIRST TOUCH"
  | "WAIT FOR SUBSEQUENT TOUCH"
  | "SKIP NEXT TOUCH";

export interface ExecutionInstruction {
  state: ExecutionInstructionState;
  /** The digit the operator waits for, or null when none is validated. */
  entryDigit: number | null;
  /** The touch class the measured evidence favours, when it favours one. */
  preferredTouch: TouchClass | null;
  /** True only when a bot may be started on the next qualifying print. */
  actionable: boolean;
  /** One line, safe to copy into the DBot plan. */
  headline: string;
  /** Why this instruction, in the vocabulary of the source engines. */
  detail: string;
  /** The unmodified source states, for attribution. */
  source: {
    entryStatus: EntryPointReport["status"];
    triggerVerdict: EntryTriggerReport["verdict"] | "NOT APPLICABLE";
  };
}

export interface ExecutionInstructionInputs {
  entryPoint: EntryPointReport;
  entryTrigger?: EntryTriggerReport | null;
  /** Hard block already decided by danger clearance / signal state. */
  blocked: boolean;
}

export function resolveExecutionInstruction(
  input: ExecutionInstructionInputs,
): ExecutionInstruction {
  const ep = input.entryPoint;
  const trig = input.entryTrigger ?? null;
  const digit = ep.preferred?.digit ?? null;
  const source = {
    entryStatus: ep.status,
    triggerVerdict: (trig?.verdict ?? "NOT APPLICABLE") as
      EntryTriggerReport["verdict"] | "NOT APPLICABLE",
  };

  if (input.blocked || ep.status === "INVALIDATED") {
    return {
      state: "BLOCKED",
      entryDigit: null,
      preferredTouch: null,
      actionable: false,
      headline: "BLOCKED — do not load or start a bot on this candidate.",
      detail:
        ep.status === "INVALIDATED"
          ? "The entry point is invalidated (danger clearance, exposure or fluctuation)."
          : "A blocking safety requirement is unmet, so no execution instruction is issued.",
      source,
    };
  }

  if (digit === null || ep.status === "UNVALIDATED") {
    return {
      state: "WAIT FOR VALIDATED ENTRY DIGIT",
      entryDigit: null,
      preferredTouch: null,
      actionable: false,
      headline: "WAIT — no entry digit is validated yet.",
      detail:
        "The Entry-Point Engine has not validated a digit, so there is no print to trigger on. No digit is fabricated.",
      source,
    };
  }

  const preferredTouch = trig?.preferredTouch ?? null;
  const nextIsFirst = trig?.nextTouchIsFirst ?? null;

  // No measured touch preference: the trigger layer defers to Entry Point.
  if (!trig || !preferredTouch) {
    const insufficient = trig?.verdict === "INSUFFICIENT TRIGGER HISTORY";
    const state: ExecutionInstructionState = insufficient
      ? "INSUFFICIENT TRIGGER HISTORY"
      : ep.status === "ENTER NOW"
        ? "ENTER NOW"
        : "ARMED";
    return {
      state,
      entryDigit: digit,
      preferredTouch: null,
      actionable: true,
      headline:
        state === "ENTER NOW"
          ? `ENTER NOW — digit ${digit} is printing; start the bot on this print.`
          : state === "INSUFFICIENT TRIGGER HISTORY"
            ? `ARMED (no trigger evidence) — wait for digit ${digit}, any qualifying print.`
            : `ARMED — wait for digit ${digit}, then start the bot on the next print.`,
      detail: insufficient
        ? "Trigger history is too small to prefer a first or a subsequent print, so no print is skipped."
        : trig
          ? trig.instruction
          : "No trigger evidence measured for this market · contract · entry digit.",
      source,
    };
  }

  // A touch preference exists. It now OWNS which print is acted on, and it
  // overrides an Entry Point "ENTER NOW" that points at the wrong cohort.
  const aligned = trig.nextTouchAligned === true;
  if (aligned) {
    const state: ExecutionInstructionState = ep.status === "ENTER NOW" ? "ENTER NOW" : "ARMED";
    return {
      state,
      entryDigit: digit,
      preferredTouch,
      actionable: true,
      headline:
        state === "ENTER NOW"
          ? `ENTER NOW — this print of digit ${digit} is the favoured ${preferredTouch.toLowerCase()} touch.`
          : `ARMED — the next print of digit ${digit} is the favoured ${preferredTouch.toLowerCase()} touch.`,
      detail: trig.instruction,
      source,
    };
  }

  // Misaligned: the next print is the WRONG cohort. One instruction only.
  const state: ExecutionInstructionState =
    ep.status === "ENTER NOW"
      ? "SKIP NEXT TOUCH"
      : preferredTouch === "FIRST"
        ? "WAIT FOR FIRST TOUCH"
        : "WAIT FOR SUBSEQUENT TOUCH";
  return {
    state,
    entryDigit: digit,
    preferredTouch,
    actionable: false,
    headline:
      state === "SKIP NEXT TOUCH"
        ? `SKIP THIS PRINT of digit ${digit} — wait for the ${preferredTouch.toLowerCase()} touch.`
        : `WAIT FOR ${preferredTouch} TOUCH of digit ${digit} before starting the bot.`,
    detail: `${trig.instruction} The next print would be a ${nextIsFirst ? "FIRST" : "SUBSEQUENT"} touch, which is not the cohort the measured evidence favours, so the Entry-Point status is deliberately not acted on.`,
    source,
  };
}
