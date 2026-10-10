/**
 * CELL IDENTITY — THE PERMANENT PSYCHOLOGICAL CONSTITUTION OF EACH CELL.
 * ========================================================================
 * Every one of the 90 observation cells (`ALL_CELL_IDS` = 15 markets × 6
 * `PROPOSITIONS`) is a concrete permanent identity instance. The six
 * canonical propositions provide immutable rule templates, while each of the
 * 90 cells receives its own frozen identity record containing its concrete
 * `cellId` and `marketId`. The market only supplies the *live state* a cell
 * is inspected against; it never supplies or rewrites the cell's identity.
 *
 * THIS MODULE DOES NOT RECOMPUTE ANY EXISTING MATH. Every rule below is a
 * declarative reflection of the OVER/UNDER edge rules already encoded and
 * documented at the top of `digit-psychology.ts` (`contractPsychology`) —
 * same parity sets, same excluded-red digit, same extreme-digit threshold
 * (`EXTREME_SHARE_MIN_PCT`), same edge-group ceiling (`EDGE_GROUP_MAX_PCT`).
 * This module exists purely to make that identity an explicit, immutable,
 * inspectable object attached to each cell — separate from the live
 * observation and separate from the raw score — rather than logic that is
 * only ever visible transiently inside one scoring function call.
 *
 * IDENTITY IS NEVER RECOMPUTED FROM A TICK. `CELL_IDENTITIES` is built once,
 * frozen, and keyed only by `Proposition`. `ObservationCell` reads its
 * identity once in its constructor and never reassigns it (see
 * `observationCell.ts`).
 */
import type { CellId, MarketId, Proposition } from "./constants";
import { PROPOSITIONS, propositionSide } from "./constants";
import {
  EXTREME_SHARE_MIN_PCT,
  EDGE_GROUP_MAX_PCT,
  MOVE_MIN_PP,
  type ContractPsychology,
  type CanonicalDigitState,
} from "@/lib/sentinel/digit-psychology";

const ALL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** The permanent, immutable psychological constitution of one proposition. */
export interface CellIdentity {
  /** Unique permanent identity key for this concrete observation cell. */
  readonly cellId: CellId;
  readonly marketId: MarketId;
  /** The canonical proposition template from which this cell identity is derived. */
  readonly proposition: Proposition;
  readonly side: "OVER" | "UNDER";
  readonly barrier: number;

  /** Digits that resolve a win for this proposition — permanent, never recomputed from live state. */
  readonly winningDigits: readonly number[];
  /** Everything not in `winningDigits`. */
  readonly losingDigits: readonly number[];

  /** GREEN and 2ND GREEN must sit on this parity (§12/§13 of the master spec). */
  readonly greenParity: "EVEN" | "ODD";
  readonly secondGreenParity: "EVEN" | "ODD";

  /** The digit GREEN/2ND GREEN sitting on triggers the exhaustion-pattern rule (0 for OVER, 9 for UNDER). */
  readonly extremeDigit: number;
  /** Share (%) the extreme digit must exceed, while decreasing, to count as a valid exhaustion pattern. */
  readonly extremeDigitSharePct: number;

  /** RED and 2ND RED must sit on this parity, strictly inside `redRange` (§14/§15). */
  readonly redParity: "EVEN" | "ODD";
  readonly redRange: readonly [number, number];
  /** RED/2ND RED may never sit here even if parity would otherwise qualify — also the digit-1-style stability watch digit (§17). */
  readonly redExcludedDigit: number;

  /** Suppressed-but-rising edge group that should stay lean (7/8/9 for OVER, 0/1/2 for UNDER) (§19). */
  readonly edgeGroup: readonly number[];
  readonly edgeGroupMaxPct: number;

  /** Broader group that should be gaining pace (5-9 for OVER, 0-4 for UNDER). */
  readonly paceGroup: readonly number[];

  /** The digit under permanent stability-watch for this identity — never rewritten by market state (§17). */
  readonly stabilityWatchDigit: number;
  /** Green digits that require active decay when they occupy GREEN for this side. */
  readonly greenDecayDigits: readonly number[];
}

/** True identity derivation — pure function of the proposition, nothing else. */
export function buildCellIdentity(proposition: Proposition): Omit<CellIdentity, "cellId" | "marketId"> {
  const side = propositionSide(proposition);
  const barrier = Number(proposition.replace(/\D/g, ""));
  const isOver = side === "OVER";

  const winningDigits = isOver
    ? ALL_DIGITS.filter((d) => d > barrier)
    : ALL_DIGITS.filter((d) => d < barrier);
  const losingDigits = ALL_DIGITS.filter((d) => !winningDigits.includes(d));

  const extremeDigit = isOver ? 0 : 9;
  /** RED may never sit on digit 1 for OVER, or digit 8 for UNDER — this is also the
   *  identity's stability-watch digit (§17): the one digit each identity keeps a
   *  permanent eye on regardless of what the live market currently shows. */
  const redExcludedDigit = isOver ? 1 : 8;
  const edgeGroup = isOver ? [7, 8, 9] : [0, 1, 2];
  const paceGroup = isOver ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4];
  const redRange: readonly [number, number] = isOver ? [5, 9] : [0, 4];

  return Object.freeze({
    proposition,
    side,
    barrier,
    winningDigits: Object.freeze(winningDigits) as readonly number[],
    losingDigits: Object.freeze(losingDigits) as readonly number[],
    greenParity: isOver ? "EVEN" : "ODD",
    secondGreenParity: isOver ? "EVEN" : "ODD",
    extremeDigit,
    extremeDigitSharePct: EXTREME_SHARE_MIN_PCT,
    redParity: isOver ? "ODD" : "EVEN",
    redRange,
    redExcludedDigit,
    edgeGroup: Object.freeze(edgeGroup) as readonly number[],
    edgeGroupMaxPct: EDGE_GROUP_MAX_PCT,
    paceGroup: Object.freeze(paceGroup) as readonly number[],
    stabilityWatchDigit: redExcludedDigit,
    // The operator's explicit OVER identity requires GREEN 0 or 2 to be
    // decreasing; the UNDER mirror requires GREEN 9 or 7 to be decreasing.
    greenDecayDigits: Object.freeze(isOver ? [0, 2] : [9, 7]) as readonly number[],
  });
}

/**
 * Canonical proposition templates. These are immutable rule templates, not
 * the 90 concrete cell identities.
 */
export const CELL_IDENTITY_TEMPLATES: Readonly<Record<Proposition, Omit<CellIdentity, "cellId" | "marketId">>> = Object.freeze(
  Object.fromEntries(PROPOSITIONS.map((p) => [p, buildCellIdentity(p)])) as Record<
    Proposition,
    Omit<CellIdentity, "cellId" | "marketId">
  >,
);

/**
 * Materialise the permanent identity of ONE concrete observation cell.
 *
 * This deliberately creates a distinct frozen object per cell. Two cells may
 * share the same proposition template, but they do not share a mutable or
 * ambiguous identity record: each identity carries its own immutable cellId
 * and marketId. No live market state is consulted.
 */
export function createCellIdentity(
  marketId: MarketId,
  proposition: Proposition,
  concreteCellId: CellId,
): CellIdentity {
  const template = CELL_IDENTITY_TEMPLATES[proposition];
  return Object.freeze({
    ...template,
    cellId: concreteCellId,
    marketId,
    winningDigits: Object.freeze([...template.winningDigits]) as readonly number[],
    losingDigits: Object.freeze([...template.losingDigits]) as readonly number[],
    edgeGroup: Object.freeze([...template.edgeGroup]) as readonly number[],
    paceGroup: Object.freeze([...template.paceGroup]) as readonly number[],
  });
}

/**
 * The proposition templates remain exported for callers/tests that need to
 * inspect the canonical six rule definitions. They are not used as the
 * concrete identity of a 90-cell instance.
 *
 * `CELL_IDENTITIES` is intentionally kept as a compatibility alias to the
 * immutable proposition templates. New cell code must use `createCellIdentity`
 * so each of the 90 concrete cells receives its own identity record.
 */
export const CELL_IDENTITIES = CELL_IDENTITY_TEMPLATES;

// ---------------------------------------------------------------------------
// IDENTITY CONFORMANCE — "Are you currently behaving like your own name?"
// A pure re-interpretation of evidence the engines already computed
// (`ContractPsychology.positions`, `CanonicalDigitState.pct/deltaPp`). No
// digit math is duplicated here; this only asks whether that already-computed
// evidence satisfies the permanent identity above, and — where the existing
// engine has no separate check yet (the digit-0-independent-of-GREEN rule,
// and the digit stability watch) — reads the same canonical percentages the
// engine already produced rather than recomputing anything from raw ticks.
// ---------------------------------------------------------------------------

export type IdentityConformanceLabel = "FAILED" | "WEAK" | "PARTIAL" | "DEVELOPING" | "STRONG" | "FULL";

export type CellIdentityRules = Omit<CellIdentity, "cellId" | "marketId">;

export interface IdentityConformance {
  readonly proposition: Proposition;
  readonly greenPass: boolean | null;
  readonly secondGreenPass: boolean | null;
  readonly redPass: boolean | null;
  readonly secondRedPass: boolean | null;
  readonly mostIncreasingSupportsIdentity: boolean | null;
  readonly mostDecreasingSupportsIdentity: boolean | null;
  readonly edgeGroupPass: boolean | null;
  readonly paceGroupPass: boolean | null;
  readonly greenDecayPass: boolean | null;
  /** Independent of GREEN: when GREEN isn't on the extreme digit, is the extreme digit still
   *  above threshold and decreasing? Distinct from the GREEN-role check inside contractPsychology. */
  readonly extremeDigitDecayPass: boolean | null;
  readonly stabilityWatch: "STABLE" | "RAPIDLY_INCREASING" | "RAPIDLY_DECREASING" | "UNKNOWN";
  readonly edgeGroupAvgPct: number | null;
  readonly hardBlocked: boolean;
  readonly label: IdentityConformanceLabel;
  readonly explanation: string[];
}

function supportOf(psych: ContractPsychology, role: string): boolean | null {
  const pos = psych.positions.find((p) => p.role === role);
  if (!pos || pos.digit === null) return null;
  return pos.support === 1;
}

/** Reads the same `CanonicalDigitState` fields already used elsewhere — no recomputation. */
function evaluateExtremeDigitDecay(
  identity: CellIdentityRules,
  state: CanonicalDigitState,
): boolean | null {
  if (state.green === null) return null;
  // Only meaningful when GREEN is NOT already sitting on the extreme digit —
  // that case is already fully evaluated by the GREEN role itself.
  if (state.green === identity.extremeDigit) return null;
  const pct = state.pct[identity.extremeDigit];
  const decreasing = state.deltaPp[identity.extremeDigit] < 0;
  return pct > identity.extremeDigitSharePct && decreasing;
}

function evaluateStabilityWatch(
  identity: CellIdentityRules,
  state: CanonicalDigitState,
): IdentityConformance["stabilityWatch"] {
  if (state.n === 0) return "UNKNOWN";
  const move = state.deltaPp[identity.stabilityWatchDigit] ?? 0;
  const rapidThreshold = MOVE_MIN_PP * 2;
  if (move >= rapidThreshold) return "RAPIDLY_INCREASING";
  if (move <= -rapidThreshold) return "RAPIDLY_DECREASING";
  return "STABLE";
}

/**
 * "You claim to be OVER2 — are you currently behaving like OVER2?"
 * Pure function of an identity (permanent) + already-computed evidence
 * (live). Produces an explicit, auditable conformance result that is kept
 * separate from both the raw score and qualification — see §34/§35 of the
 * identity spec: this is NOT a second ranking, only an admissibility/
 * explanation layer riding alongside the one existing ranking.
 */
export function deriveIdentityConformance(
  identity: CellIdentityRules,
  psychology: ContractPsychology,
  state: CanonicalDigitState,
): IdentityConformance {
  const greenPass = supportOf(psychology, "GREEN");
  const secondGreenPass = supportOf(psychology, "2ND GREEN");
  const redPass = supportOf(psychology, "RED");
  const secondRedPass = supportOf(psychology, "2ND RED");
  const mostIncreasingSupportsIdentity = supportOf(psychology, "MOST INCREASING");
  const mostDecreasingSupportsIdentity = supportOf(psychology, "MOST DECREASING");
  const edgeGroupPass = supportOf(psychology, "EDGE GROUP");
  const paceGroupPass = supportOf(psychology, "PACE GROUP");
  const greenDecayPass =
    state.green === null
      ? null
      : identity.greenDecayDigits.includes(state.green)
        ? (state.deltaPp[state.green] ?? 0) < 0
        : true;
  const extremeDigitDecayPass = evaluateExtremeDigitDecay(identity, state);
  const stabilityWatch = evaluateStabilityWatch(identity, state);
  const edgeGroupAvgPct =
    state.n > 0
      ? identity.edgeGroup.reduce((sum, d) => sum + (state.pct[d] ?? 0), 0) / identity.edgeGroup.length
      : null;

  const hardBlocked = Boolean(psychology.hardBlock || psychology.redSemantics?.mandatoryRedStructureFailed);

  const checks: (boolean | null)[] = [
    greenPass,
    secondGreenPass,
    redPass,
    secondRedPass,
    mostIncreasingSupportsIdentity,
    mostDecreasingSupportsIdentity,
    edgeGroupPass,
    paceGroupPass,
    greenDecayPass,
    extremeDigitDecayPass,
    stabilityWatch === "STABLE" ? true : stabilityWatch === "UNKNOWN" ? null : false,
  ];
  const measured = checks.filter((c) => c !== null) as boolean[];
  const passed = measured.filter(Boolean).length;
  const total = measured.length;

  let label: IdentityConformanceLabel;
  if (hardBlocked) {
    label = "FAILED";
  } else if (total === 0) {
    label = "WEAK";
  } else {
    const ratio = passed / total;
    if (ratio >= 0.95) label = "FULL";
    else if (ratio >= 0.75) label = "STRONG";
    else if (ratio >= 0.5) label = "DEVELOPING";
    else if (ratio >= 0.25) label = "PARTIAL";
    else label = "WEAK";
  }

  const explanation: string[] = [];
  explanation.push(`IDENTITY: ${identity.proposition} — ${identity.side} ${identity.barrier}`);
  if (hardBlocked) explanation.push("HARD BLOCK: mandatory RED structure failed — identity cannot be fulfilled this tick.");
  explanation.push(`GREEN: ${greenPass === null ? "not measurable" : greenPass ? "identity-conforming" : "identity conflict"}`);
  explanation.push(`2ND GREEN: ${secondGreenPass === null ? "not measurable" : secondGreenPass ? "identity-conforming" : "identity conflict"}`);
  explanation.push(`RED: ${redPass === null ? "not measurable" : redPass ? "identity-conforming" : "identity conflict"}`);
  explanation.push(`2ND RED: ${secondRedPass === null ? "not measurable" : secondRedPass ? "identity-conforming" : "identity conflict"}`);
  explanation.push(
    `MOST DECREASING: ${
      mostDecreasingSupportsIdentity === null
        ? "not measurable"
        : mostDecreasingSupportsIdentity
          ? "supports the losing side releasing"
          : "does not support the losing side releasing"
    }`,
  );
  explanation.push(`EDGE GROUP: ${edgeGroupPass === null ? "not measurable" : edgeGroupPass ? "identity-conforming" : "identity conflict"}`);
  explanation.push(`PACE GROUP: ${paceGroupPass === null ? "not measurable" : paceGroupPass ? "identity-conforming" : "identity conflict"}`);
  explanation.push(`GREEN DECAY RULE: ${greenDecayPass === null ? "not measurable" : greenDecayPass ? "satisfied" : "not satisfied"}`);
  explanation.push(
    `MOST INCREASING: ${
      mostIncreasingSupportsIdentity === null
        ? "not measurable"
        : mostIncreasingSupportsIdentity
          ? "belongs to my winning side"
          : "does not belong to my winning side"
    }`,
  );
  explanation.push(
    `DIGIT ${identity.extremeDigit} (exhaustion rule): ${
      extremeDigitDecayPass === null ? "not applicable this tick" : extremeDigitDecayPass ? "satisfied" : "not satisfied"
    }`,
  );
  explanation.push(`DIGIT ${identity.stabilityWatchDigit} (stability watch): ${stabilityWatch.toLowerCase().replace(/_/g, " ")}`);
  if (edgeGroupAvgPct !== null) {
    explanation.push(
      `EDGE GROUP ${identity.edgeGroup.join("/")}: avg ${edgeGroupAvgPct.toFixed(2)}% (preferred < ${identity.edgeGroupMaxPct}%)`,
    );
  }

  return {
    proposition: identity.proposition,
    greenPass,
    secondGreenPass,
    redPass,
    secondRedPass,
    mostIncreasingSupportsIdentity,
    mostDecreasingSupportsIdentity,
    edgeGroupPass,
    paceGroupPass,
    greenDecayPass,
    extremeDigitDecayPass,
    stabilityWatch,
    edgeGroupAvgPct,
    hardBlocked,
    label,
    explanation,
  };
}
