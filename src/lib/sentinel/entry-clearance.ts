// APEX SENTINEL — STAGE 3: ENTRY CLEARANCE.
//
// The final gate. Direction (Stage 1) and Setup (Stage 2) say how good the
// opportunity looks; the danger composition (Stage 2a) says what is dangerous;
// combination learning (Stage 3.5) says whether this EXACT
// market × contract × regime × entry-condition has ever actually worked.
//
// This module returns exactly one of three verdicts:
//
//   CLEARED — every requirement is met and measured evidence supports entry.
//   WAIT    — nothing is dangerous enough to block, but a requirement is not
//             yet met (usually evidence or a trigger that is not firing).
//   BLOCKED — an auto-block danger component or failing evidence forbids entry.
//
// A BLOCKED or WAIT candidate is never deleted: it is returned with its exact
// unmet requirements so the operator can see what would change the verdict.
import type { ComboEvidence, ComboLookup } from "./combination-learning";
import type { DangerComponent, DangerComposition } from "./danger";
import type { SetupReport } from "./setup";
import type { LosingSidePressure } from "./losing-side-pressure";

export type EntryVerdict = "CLEARED" | "WAIT" | "BLOCKED";

export interface ClearanceRequirement {
  code: string;
  label: string;
  /** Was the requirement satisfied by measured evidence? */
  met: boolean;
  /** BLOCK requirements force BLOCKED; WAIT requirements force WAIT. */
  severity: "BLOCK" | "WAIT" | "INFO";
  detail: string;
}

export interface EntryClearanceReport {
  verdict: EntryVerdict;
  /** 0..100 — confidence in the verdict itself, driven by sample sizes. */
  confidence: number;
  requirements: ClearanceRequirement[];
  unmet: ClearanceRequirement[];
  blockers: ClearanceRequirement[];
  waiting: ClearanceRequirement[];
  /** The exact combination the verdict was measured on. */
  combination: ComboEvidence;
  /** Best entry condition measured in this market/contract/regime, if any. */
  bestEntryCondition: ComboEvidence | null;
  /** Auto-block danger components that forced a BLOCKED verdict. */
  autoBlock: DangerComponent[];
  /** True only for CLEARED — the only verdict a bot may act on unattended. */
  executable: boolean;
  summary: string;
}

export interface EntryClearanceInputs {
  setup: SetupReport;
  danger: DangerComposition;
  combo: ComboLookup;
  /** Is the chosen entry condition's trigger firing on the current tick? */
  triggerActive: boolean;
  /**
   * OPTIONAL. Aggregate losing-side digit pressure for this contract. Was
   * previously only applied as a soft score dampener (apex/contracts.ts);
   * now also enforced here as a hard gate — a HOSTILE losing side blocks
   * entry outright, and a PRESSURED + still-rising losing side forces WAIT,
   * so a signal cannot be cleared while the losing digits are gaining.
   */
  losingSidePressure?: LosingSidePressure | null;
  /** Minimum Stage 2 setup score required to clear. */
  minSetup?: number;
  /** Minimum weighted sample size required before a combination may clear. */
  minWeightedN?: number;
  /** Allow clearance on an untested combination (exploration mode). */
  allowUntested?: boolean;
}

export const DEFAULT_MIN_SETUP = 62;
export const DEFAULT_MIN_WEIGHTED_N = 12;

export function assessEntryClearance(input: EntryClearanceInputs): EntryClearanceReport {
  const {
    setup,
    danger,
    combo,
    triggerActive,
    losingSidePressure = null,
    minSetup = DEFAULT_MIN_SETUP,
    minWeightedN = DEFAULT_MIN_WEIGHTED_N,
    allowUntested = false,
  } = input;

  const exact = combo.exact;
  const requirements: ClearanceRequirement[] = [];
  const req = (
    code: string,
    label: string,
    met: boolean,
    severity: ClearanceRequirement["severity"],
    detail: string,
  ) => requirements.push({ code, label, met, severity, detail });

  // ── 1. Auto-block danger components ──────────────────────────────────
  req(
    "NO_AUTO_BLOCK",
    "No auto-block danger component",
    danger.autoBlock.length === 0,
    "BLOCK",
    danger.autoBlock.length
      ? danger.autoBlock.map((a) => `${a.label} — ${a.detail}`).join(" · ")
      : "No auto-block component measured in the danger composition.",
  );

  // ── 1b. Losing-side digit pressure ───────────────────────────────────
  // Driven by the hard LOSING_SIDE_PRESSURE verdict rather than raw state:
  // SUPPRESS (HOSTILE + broad — 2+ losing digits rising at once) blocks
  // outright, the "flag down the signal" behaviour the bounded modifier
  // alone could never produce. CAUTION (HOSTILE-but-narrow, or PRESSURED)
  // still can't clear, but only forces WAIT — a single noisy digit is not
  // grounds for a hard block.
  const lsp = losingSidePressure;
  const lspSuppress = lsp?.verdict === "SUPPRESS";
  const lspCaution = lsp?.verdict === "CAUTION";
  req(
    "LOSING_SIDE_GUARD",
    "Losing-side digit pressure not suppressed",
    !lspSuppress,
    "BLOCK",
    lsp
      ? lsp.reason
      : "No losing-side pressure telemetry available — requirement passes by default.",
  );
  req(
    "LOSING_SIDE_CAUTION",
    "Losing-side digit pressure not elevated",
    !lspCaution,
    "WAIT",
    lsp
      ? lsp.reason
      : "No losing-side pressure telemetry available — requirement passes by default.",
  );

  // ── 2. Severe danger level ───────────────────────────────────────────
  req(
    "DANGER_LEVEL",
    "Danger below severe",
    danger.level !== "CRITICAL",
    "BLOCK",
    `Composed danger ${danger.total.toFixed(0)}/100 (${danger.level}) across ${danger.components.length} labelled component(s).`,
  );

  // ── 3. Setup quality ─────────────────────────────────────────────────
  req(
    "SETUP_SCORE",
    "Setup score threshold",
    (setup.score ?? 0) >= minSetup && !setup.autoBlocked,
    "WAIT",
    `Setup ${(setup.score ?? 0).toFixed(0)}/100 (${setup.grade ?? "UNKNOWN"}) against the ${minSetup} requirement — direction ${(setup.direction?.score ?? 0).toFixed(0)} (${setup.direction?.label ?? "UNKNOWN"}).`,
  );

  // ── 4. Direction must actually point at this contract ────────────────
  req(
    "DIRECTION_SIDE",
    "Direction supports this contract",
    setup.direction?.label !== "AGAINST",
    "BLOCK",
    setup.direction?.summary ?? "Direction evaluated.",
  );

  // ── 5. Combination evidence must not be failing ──────────────────────
  req(
    "COMBO_NOT_FAILING",
    "Combination not failing",
    exact.state !== "FAILING",
    "BLOCK",
    exact.note,
  );

  req(
    "COMBO_NOT_DETERIORATING",
    "Combination not deteriorating",
    exact.state !== "DETERIORATING",
    "WAIT",
    exact.state === "DETERIORATING"
      ? `Recent drift ${(exact.deteriorationPp ?? 0).toFixed(1)}pp on weighted N=${(exact.weightedN ?? 0).toFixed(1)} — this combination is losing effectiveness.`
      : `Drift ${(exact.deteriorationPp ?? 0) >= 0 ? "+" : ""}${(exact.deteriorationPp ?? 0).toFixed(1)}pp on weighted N=${(exact.weightedN ?? 0).toFixed(1)}.`,
  );

  // ── 6. Sample size for this exact combination ────────────────────────
  const sampleMet = allowUntested || exact.weightedN >= minWeightedN;
  req(
    "COMBO_SAMPLE",
    "Combination sample size",
    sampleMet,
    "WAIT",
    exact.n
      ? `N=${exact.n} raw / weighted N=${exact.weightedN.toFixed(1)} against the ${minWeightedN} requirement for ${exact.symbol} · ${exact.contract} · ${exact.regime} · ${exact.entryCondition}.`
      : `UNTESTED combination — no resolved entry yet for ${exact.symbol} · ${exact.contract} · regime ${exact.regime} · entry ${exact.entryCondition}. Evidence from other regimes or entry conditions is deliberately NOT borrowed.`,
  );

  // ── 7. Positive weighted expectancy once there is a sample ───────────
  req(
    "COMBO_EXPECTANCY",
    "Weighted expectancy positive",
    exact.weightedN < minWeightedN ? true : exact.weightedExpectancy > 0,
    "WAIT",
    exact.weightedN >= minWeightedN
      ? `Recency-weighted expectancy ${exact.weightedExpectancy.toFixed(3)}/unit, 95% LB ${(exact.lower * 100).toFixed(1)}%.`
      : "Sample too small to require an expectancy — not counted against the verdict.",
  );

  // ── 8. The entry trigger must actually be firing ─────────────────────
  req(
    "TRIGGER_ACTIVE",
    "Entry trigger firing now",
    triggerActive,
    "WAIT",
    triggerActive
      ? `Entry condition "${exact.entryCondition}" is triggering on the current tick.`
      : `Entry condition "${exact.entryCondition}" is not triggering on the current tick — waiting for the condition, not forcing an entry.`,
  );

  // ── 9. Losing-streak brake ───────────────────────────────────────────
  req(
    "STREAK_BRAKE",
    "No active losing streak on this combination",
    exact.currentStreak > -4,
    "WAIT",
    exact.currentStreak < 0
      ? `${Math.abs(exact.currentStreak)} consecutive loss(es) on this exact combination (longest ${exact.longestLosingStreak}).`
      : `Current streak ${exact.currentStreak >= 0 ? "+" : ""}${exact.currentStreak} on this combination.`,
  );

  // ── 10. Better sibling entry condition available ─────────────────────
  const better =
    combo.bestEntryCondition &&
    combo.bestEntryCondition.entryCondition !== exact.entryCondition &&
    combo.bestEntryCondition.weightedExpectancy > exact.weightedExpectancy + 0.05
      ? combo.bestEntryCondition
      : null;
  req(
    "BEST_CONDITION",
    "Using the best measured entry condition",
    !better,
    "INFO",
    better
      ? `"${better.entryCondition}" has measured better expectancy (${better.weightedExpectancy.toFixed(3)} vs ${exact.weightedExpectancy.toFixed(3)}) on weighted N=${better.weightedN.toFixed(1)} in regime ${better.regime}.`
      : "No sibling entry condition has measurably better expectancy in this regime.",
  );

  const unmet = requirements.filter((r) => !r.met);
  const blockers = unmet.filter((r) => r.severity === "BLOCK");
  const waiting = unmet.filter((r) => r.severity === "WAIT");

  const verdict: EntryVerdict = blockers.length ? "BLOCKED" : waiting.length ? "WAIT" : "CLEARED";

  const confidence = Math.round(
    Math.max(
      0,
      Math.min(100, setup.confidence * 0.45 + exact.confidence * 0.45 + (triggerActive ? 10 : 0)),
    ),
  );

  const summary =
    verdict === "BLOCKED"
      ? `BLOCKED — ${blockers.map((b) => b.label).join(" · ")}. ${blockers[0]?.detail ?? ""}`
      : verdict === "WAIT"
        ? `WAIT — ${waiting.length} requirement(s) unmet: ${waiting.map((w) => w.label).join(" · ")}. ${waiting[0]?.detail ?? ""}`
        : `CLEARED — setup ${setup.score.toFixed(0)}/100 (${setup.grade}), danger ${danger.total.toFixed(0)} (${danger.level}), combination ${exact.state} at ${(exact.weightedWinRate * 100).toFixed(1)}% weighted over N=${exact.n} (weighted ${exact.weightedN.toFixed(1)}), trigger active. Verdict confidence ${confidence}/100.`;

  return {
    verdict,
    confidence,
    requirements,
    unmet,
    blockers,
    waiting,
    combination: exact,
    bestEntryCondition: combo.bestEntryCondition,
    autoBlock: danger.autoBlock,
    executable: verdict === "CLEARED",
    summary,
  };
}
