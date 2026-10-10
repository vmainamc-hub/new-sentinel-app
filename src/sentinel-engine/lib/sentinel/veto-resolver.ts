/**
 * UNIFIED VETO RESOLUTION HIERARCHY (§5)
 * =====================================
 * This is the SINGLE CANONICAL RESOLVER for all veto verdicts across Sentinel.
 * No score, quality band, or ranking modifier may ever override a genuine hard VETO verdict.
 *
 * Four-State Governance:
 *   ALLOW    — clean signal, fully qualified
 *   CAUTION  — soft risk flag, penalty applied, signal survives
 *   SUPPRESS — severe risk or adverse pressure, held from execution, not hard vetoed
 *   VETO     — genuine hard invalidation, terminal block
 *
 * Evaluation order (strict cascading hierarchy):
 * 1. LOCAL ENGINE VETO   (digit-psychology hardBlock, price-action veto, danger auto-block, etc.)
 *         ↓
 * 2. OBSERVATION VETO STATE (aggregates cell-level maturity, vetoed/rejected states for this specific cell)
 *         ↓
 * 3. GLOBAL GOVERNANCE   (global-veto.ts rules — account/operator/cross-market pattern level)
 *         ↓
 * 4. FINAL VETO VERDICT
 */

export interface LocalVetoFlags {
  digitPsychologyHardBlock?: boolean;
  digitPsychologyReason?: string | null;
  priceActionVeto?: boolean;
  priceActionReason?: string | null;
  losingSideSuppressed?: boolean;
  losingSideVeto?: boolean;
  losingSideReason?: string | null;
  spineVeto?: boolean;
  spineVetoVerdict?: "ALLOW" | "CAUTION" | "SUPPRESS" | "VETO";
  spineVetoReason?: string | null;
  dangerHardBlocked?: boolean;
  dangerReason?: string | null;
  customLocalReasons?: string[];
}

export interface ObservationVetoState {
  isVetoed?: boolean;
  isHardBlocked?: boolean;
  isSuppressed?: boolean;
  isUnqualified?: boolean;
  state?: string | null;
  liveHealth?: string | null;
  reason?: string | null;
}

export interface GlobalVetoRules {
  vetoed?: boolean;
  suppressed?: boolean;
  rule?: string | null;
  reason?: string | null;
  suggestedPenalty?: number;
}

export type GovernanceVerdict = "ALLOW" | "CAUTION" | "SUPPRESS" | "VETO";
export type VetoVerdict = "CLEAR" | "BLOCKED" | "ALLOW" | "CAUTION" | "SUPPRESS" | "VETO";
export type VetoSource = "LOCAL_ENGINE" | "OBSERVATION" | "GLOBAL_GOVERNANCE" | "NONE";

export interface VetoResolution {
  cellId: string;
  verdict: VetoVerdict;
  governanceVerdict: GovernanceVerdict;
  isBlocked: boolean;
  isSuppressed: boolean;
  source: VetoSource;
  reason: string | null;
  details: string[];
  suggestedPenalty: number;
}

/**
 * Resolves all veto sources in strict hierarchical order:
 * 1. Local engine hard blocks (digit psychology, price action veto, danger block, confirmed takeover)
 * 2. Observation cell state (vetoed, rejected, unqualified, invalidated)
 * 3. Global governance rules (operator rules, streak caps, volatility limits)
 */
export function resolveVeto(
  cellIdOrKey: string,
  localFlags?: LocalVetoFlags | null,
  observationVetoState?: ObservationVetoState | null,
  globalRules?: GlobalVetoRules | null,
): VetoResolution {
  const details: string[] = [];

  // 1. LOCAL ENGINE HARD VETO
  if (localFlags) {
    if (localFlags.digitPsychologyHardBlock) {
      const reason = `DIGIT PSYCHOLOGY BLOCK — ${localFlags.digitPsychologyReason || "Structural digit violation"}`;
      details.push(reason);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "LOCAL_ENGINE",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }

    if (localFlags.dangerHardBlocked) {
      const reason = `DANGER HARD BLOCK — ${localFlags.dangerReason || "Extreme danger composition component"}`;
      details.push(reason);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "LOCAL_ENGINE",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }

    if (localFlags.priceActionVeto) {
      const reason = `PRICE ACTION VETO — ${localFlags.priceActionReason || "Lower-timeframe losing-side takeover"}`;
      details.push(reason);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "LOCAL_ENGINE",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }

    if (localFlags.losingSideVeto) {
      const reason = `LOSING SIDE TAKEOVER VETO — ${localFlags.losingSideReason || "Losing side pressure hostile takeover"}`;
      details.push(reason);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "LOCAL_ENGINE",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }

    if (localFlags.spineVeto && localFlags.spineVetoVerdict === "VETO") {
      const reason = `DECISION SPINE VETO — ${localFlags.spineVetoReason || "Structural invalidation"}`;
      details.push(reason);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "LOCAL_ENGINE",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }

    if (localFlags.customLocalReasons && localFlags.customLocalReasons.length > 0) {
      const reason = `LOCAL ENGINE VETO — ${localFlags.customLocalReasons[0]}`;
      details.push(...localFlags.customLocalReasons);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "LOCAL_ENGINE",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }
  }

  // 2. OBSERVATION VETO STATE (hard state)
  if (observationVetoState) {
    const isObsHardBlocked = Boolean(
      observationVetoState.isHardBlocked ||
      observationVetoState.state === "VETOED" ||
      observationVetoState.state === "REJECTED" ||
      observationVetoState.liveHealth === "INVALIDATED",
    );

    if (isObsHardBlocked) {
      const reason = `OBSERVATION VETO — ${observationVetoState.reason || `Observation state: ${observationVetoState.state || "REJECTED"}`}`;
      details.push(reason);
      return {
        cellId: cellIdOrKey,
        verdict: "BLOCKED",
        governanceVerdict: "VETO",
        isBlocked: true,
        isSuppressed: false,
        source: "OBSERVATION",
        reason,
        details,
        suggestedPenalty: 100,
      };
    }
  }

  // 3. GLOBAL GOVERNANCE HARD VETO
  if (globalRules?.vetoed) {
    const reason = `GLOBAL GOVERNANCE VETO — ${globalRules.reason || globalRules.rule || "Pattern explicitly vetoed by operator"}`;
    details.push(reason);
    return {
      cellId: cellIdOrKey,
      verdict: "BLOCKED",
      governanceVerdict: "VETO",
      isBlocked: true,
      isSuppressed: false,
      source: "GLOBAL_GOVERNANCE",
      reason,
      details,
      suggestedPenalty: globalRules.suggestedPenalty ?? 100,
    };
  }

  // 4. SOFT GOVERNANCE: SUPPRESSION (Held from execution, but NOT hard blocked)
  if (
    localFlags?.losingSideSuppressed ||
    localFlags?.spineVetoVerdict === "SUPPRESS" ||
    observationVetoState?.isSuppressed ||
    globalRules?.suppressed
  ) {
    const reason =
      localFlags?.losingSideReason ||
      localFlags?.spineVetoReason ||
      observationVetoState?.reason ||
      globalRules?.reason ||
      "Signal suppressed by soft governance";
    details.push(reason);
    return {
      cellId: cellIdOrKey,
      verdict: "SUPPRESS",
      governanceVerdict: "SUPPRESS",
      isBlocked: false,
      isSuppressed: true,
      source: localFlags?.losingSideSuppressed ? "LOCAL_ENGINE" : "GLOBAL_GOVERNANCE",
      reason,
      details,
      suggestedPenalty: 45,
    };
  }

  // 5. CLEAR / ALLOW
  return {
    cellId: cellIdOrKey,
    verdict: "CLEAR",
    governanceVerdict: "ALLOW",
    isBlocked: false,
    isSuppressed: false,
    source: "NONE",
    reason: null,
    details: [],
    suggestedPenalty: globalRules?.suggestedPenalty ?? 0,
  };
}
