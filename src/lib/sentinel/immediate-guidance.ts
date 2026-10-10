// APEX SENTINEL — CHANNEL 1: IMMEDIATE OPERATOR GUIDANCE.
//
// This is NOT statistical learning. It is a temporary, bounded, auditable
// overlay that lets an operator observation influence the NEXT ranking cycle
// without waiting for confirmed trades. Channel 2 (validated statistical
// learning in operator-learning.ts) is untouched and keeps its sample gating.
//
// Hard rules honoured here:
//   • A written note NEVER becomes a WIN or a LOSS.
//   • A directive is scoped to the exact market × contract (× entry digit when
//     the snapshot has one). Market A never influences market B.
//   • Every directive expires; nothing here can become a permanent hidden veto.
//   • Adjustments are bounded and attributed; they may penalise, prefer or
//     suppress, but they can never fabricate evidence or force ENTER NOW.
//   • A later operator note supersedes the earlier directive for the same
//     source, and for the same scope + directive type.
import type { FeedbackCategory, TradeOutcome, TradeSnapshot } from "./trade-feedback";

const KEY = "sentinel.immediate-guidance.v1";

/** Default life of an immediate directive: short, relevant to the next signals. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** No candidate may be moved by more than this by the immediate layer. */
export const MAX_GUIDANCE_RANKING_DELTA = 6;
/** No entry digit may be moved by more than this by the immediate layer. */
export const MAX_GUIDANCE_ENTRY_DELTA = 6;

export type DirectiveType =
  | "ENTRY_TIMING_LATE"
  | "ENTRY_TIMING_EARLY"
  | "DANGER_DIGIT"
  | "ENTRY_DIGIT_FAILING"
  | "ENTRY_DIGIT_WORKING"
  | "PRESSURE_REVERSAL"
  | "MARKET_ROTATION"
  | "MARKET_CHOPPINESS"
  | "OUTCOME_LOSS_CAUTION"
  | "OUTCOME_WIN_SUPPORT"
  | "CAUTION"
  | "SUPPORT"
  | "PAUSE_MARKET";

export interface OperatorDirective {
  id: string;
  /** Feedback/observation id this directive was derived from. */
  sourceId: string;
  ts: number;
  expiresAt: number;
  symbol: string;
  contract: string;
  contractLabel: string;
  /** Entry digit frozen in the feedback snapshot, when there was one. */
  entryDigit: number | null;
  /** Digit the operator explicitly named, when unambiguous. */
  targetDigit: number | null;
  type: DirectiveType;
  category: FeedbackCategory | null;
  outcome?: TradeOutcome | null;
  text: string;
  label: string;
  guidanceAdvice?: string;
  /** Bounded, undecayed ranking contribution in score points. */
  rankingAdjustment: number;
  /** Bounded, undecayed entry-digit contribution in entry-point points. */
  entryDigitAdjustment: number;
}

interface Store {
  version: 1;
  directives: OperatorDirective[];
}

let store: Store | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function blank(): Store {
  return { version: 1, directives: [] };
}

function load(): Store {
  if (store) return store;
  store = blank();
  if (typeof window === "undefined") return store;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (parsed && Array.isArray(parsed.directives)) {
        store = { version: 1, directives: parsed.directives.filter(Boolean) };
      }
    }
  } catch {
    store = blank();
  }
  return store;
}

function persist() {
  if (!store) return;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      /* storage full or unavailable — the in-memory overlay still applies */
    }
  }
  revision++;
  listeners.forEach((l) => l());
}

/** Monotonic revision — participates in every feedback-dependent cache key. */
export function guidanceRevision(): number {
  return revision;
}

export function subscribeGuidance(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearGuidance() {
  store = blank();
  persist();
}

/** Test/maintenance helper — drops persisted state without emitting storage. */
export function resetGuidanceForTests() {
  store = blank();
  revision++;
}

export function activeDirectives(now = Date.now()): OperatorDirective[] {
  const s = load();
  const live = s.directives.filter((d) => d.expiresAt > now);
  if (live.length !== s.directives.length) {
    s.directives = live;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(s));
      } catch {
        /* storage full or unavailable */
      }
    }
  }
  return [...live].sort((a, b) => b.ts - a.ts);
}

export function removeDirectivesBySource(sourceId: string) {
  const s = load();
  const before = s.directives.length;
  s.directives = s.directives.filter((d) => d.sourceId !== sourceId);
  if (s.directives.length !== before) persist();
}

// ── INTERPRETATION & TRADE REPORT SEMANTIC EXTRACTION ─────────────────────

const DIGIT_RE =
  /\b(?:digit|last digit|number|entry digit|barrier|on|avoid|picked|spotted|target)\s*#?\s*([0-9])\b/i;
const SHORT_DIGIT_RE = /\b[dD]\s*([0-9])\b/;

function explicitDigit(text: string): number | null {
  const m = DIGIT_RE.exec(text) || SHORT_DIGIT_RE.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 0 && d <= 9 ? d : null;
}

export interface DerivedDirective {
  type: DirectiveType;
  label: string;
  guidanceAdvice: string;
  rankingAdjustment: number;
  entryDigitAdjustment: number;
  targetDigit: number | null;
}

/**
 * Pure interpretation, exported so the reasoning is testable in isolation.
 * Interprets operator notes and post-trade reports against snapshot and trade outcome.
 */
export function interpretFeedback(
  text: string,
  category: FeedbackCategory | null,
  snapshot: Pick<TradeSnapshot, "entryDigit" | "symbol" | "contractLabel">,
  outcome?: TradeOutcome | null,
): DerivedDirective {
  const t = text.toLowerCase();
  const named = explicitDigit(text);
  const targetDigit = named ?? snapshot.entryDigit ?? null;
  const targetDigitStr = targetDigit !== null ? `digit ${targetDigit}` : "selected digit";

  // 1. Pause / Cool-down request
  const pause =
    (category === "OTHER" &&
      /pause|stop trading|cool down|cooldown|take a break|halt|avoid index|avoid market/.test(t)) ||
    /pause|stop trading|cool down|cooldown|take a break|halt/.test(t);
  if (pause) {
    return {
      type: "PAUSE_MARKET",
      label: "Operator directive: cooling down on this market",
      guidanceAdvice:
        "Subsequent signals on this asset will be suppressed/penalized until cooling completes.",
      rankingAdjustment: -5.0,
      entryDigitAdjustment: -6.0,
      targetDigit,
    };
  }

  // 2. Late Entry / Timing
  const late =
    category === "ENTRY TOO LATE" ||
    /too late|late entry|entered late|delayed click|slow click|missed the tick|lag|latency|hesitat/.test(
      t,
    );
  if (late) {
    return {
      type: "ENTRY_TIMING_LATE",
      label: `Operator report: late entry timing on ${targetDigitStr}`,
      guidanceAdvice: `Timing caution applied to ${targetDigitStr}; enforce tight validity-window discipline on next signals.`,
      rankingAdjustment: outcome === "LOSS" ? -3.5 : -2.0,
      entryDigitAdjustment: -3.5,
      targetDigit,
    };
  }

  // 3. Early / Premature Entry Timing
  const early = /too early|early entry|premature|rushed|jumped the gun|before signal formed/.test(
    t,
  );
  if (early) {
    return {
      type: "ENTRY_TIMING_EARLY",
      label: `Operator report: premature entry on ${targetDigitStr}`,
      guidanceAdvice: `Wait for complete signal confirmation before taking next signals on ${targetDigitStr}.`,
      rankingAdjustment: -2.0,
      entryDigitAdjustment: -3.0,
      targetDigit,
    };
  }

  // 4. Failing / Bursting / Bad Digit
  const failing =
    category === "ENTRY DIGIT" ||
    /fail|not work|stopped|bad|avoid|wrong digit|lost on|spiked|burst|hit barrier|repeated against/.test(
      t,
    ) ||
    (outcome === "LOSS" && (named !== null || /digit/.test(t)));
  if (failing && (outcome === "LOSS" || /fail|bad|avoid|wrong|spiked|burst|lost/.test(t))) {
    return {
      type: "ENTRY_DIGIT_FAILING",
      label: `Operator report: ${targetDigitStr} failing / adverse`,
      guidanceAdvice: `Penalizing ${targetDigitStr} for upcoming entries; Sentinel will prioritize safer runner-up digits.`,
      rankingAdjustment: -2.5,
      entryDigitAdjustment: -6.0,
      targetDigit,
    };
  }

  // 5. Pressure Reversal / Adverse Trend
  const pressureReversal =
    category === "PRESSURE REVERSAL" ||
    /pressure revers|losing side|trend revers|pressure against|flipped|opposite trend|momentum died/.test(
      t,
    );
  if (pressureReversal) {
    return {
      type: "PRESSURE_REVERSAL",
      label: "Operator report: losing-side pressure reversal",
      guidanceAdvice:
        "Adverse pressure noted; demanding strong pressure alignment before presenting continuation signals.",
      rankingAdjustment: -4.5,
      entryDigitAdjustment: -3.0,
      targetDigit,
    };
  }

  // 6. Market Choppiness / Volatility
  const choppy = /choppy|whipsaw|volatile|erratic|unstable|jumpy|wild swing|spread jump/.test(t);
  if (choppy) {
    return {
      type: "MARKET_CHOPPINESS",
      label: "Operator report: choppy / erratic market conditions",
      guidanceAdvice:
        "Applying volatility dampener across this market to guard against false breakouts.",
      rankingAdjustment: -4.0,
      entryDigitAdjustment: -2.0,
      targetDigit: null,
    };
  }

  // 7. Market Rotation
  const rotation = category === "MARKET ROTATION" || /rotat|regime change|behavior change/.test(t);
  if (rotation) {
    return {
      type: "MARKET_ROTATION",
      label: "Operator report: market rotation — fresh confirmation required",
      guidanceAdvice:
        "Regime or rotation change detected; subsequent signals require fresh structural proof.",
      rankingAdjustment: -3.5,
      entryDigitAdjustment: -1.5,
      targetDigit: null,
    };
  }

  // 8. Danger Reported
  const danger = category === "DANGER" || /danger|dangerous|risky|becoming active/.test(t);
  if (danger) {
    return {
      type: "DANGER_DIGIT",
      label:
        named !== null
          ? `Operator report: digit ${named} dangerous here`
          : "Operator report: heightened danger",
      guidanceAdvice:
        named !== null
          ? `Direct penalty applied to digit ${named} in upcoming recommendations.`
          : "Increased clearance conservatism applied to this setup.",
      rankingAdjustment: named !== null ? -4.0 : -2.5,
      entryDigitAdjustment: named !== null ? -5.0 : 0,
      targetDigit: named,
    };
  }

  // 9. Strong Signal / Clean Win Execution
  const strong =
    category === "STRONG SIGNAL" ||
    /clean|working well|good setup|good entry|reliable|perfect|accurate|solid|smooth|flawless/.test(
      t,
    ) ||
    (outcome === "WIN" && /good|great|clean|solid|nice|worked/.test(t));
  if (strong) {
    return {
      type: "SUPPORT",
      label: `Operator report: clean execution verified${targetDigit !== null ? ` (${targetDigitStr})` : ""}`,
      guidanceAdvice: `Positive reinforcement applied to ${snapshot.contractLabel || "this contract"}${targetDigit !== null ? ` on ${targetDigitStr}` : ""}.`,
      rankingAdjustment: 2.0,
      entryDigitAdjustment: 2.0,
      targetDigit,
    };
  }

  // 10. Weak Signal
  const weak =
    category === "WEAK SIGNAL" ||
    /weak|deterior|getting worse|unstable|false signal|fakeout/.test(t);
  if (weak) {
    return {
      type: "CAUTION",
      label: "Operator report: setup reported as weakening",
      guidanceAdvice: "Lowering ranking weight on this candidate due to observed signal fragility.",
      rankingAdjustment: -2.5,
      entryDigitAdjustment: 0,
      targetDigit: null,
    };
  }

  // 11. Outcome fallback when text is short or generic
  if (outcome === "LOSS") {
    return {
      type: "OUTCOME_LOSS_CAUTION",
      label: `Operator trade report: loss recorded on ${targetDigitStr}`,
      guidanceAdvice: `Applying precautionary dampening on ${targetDigitStr} for upcoming signals.`,
      rankingAdjustment: -2.5,
      entryDigitAdjustment: targetDigit !== null ? -4.0 : -1.5,
      targetDigit,
    };
  }

  if (outcome === "WIN") {
    return {
      type: "OUTCOME_WIN_SUPPORT",
      label: `Operator trade report: win recorded on ${targetDigitStr}`,
      guidanceAdvice: `Confirming positive execution bias for upcoming signals on ${targetDigitStr}.`,
      rankingAdjustment: 1.5,
      entryDigitAdjustment: 1.5,
      targetDigit,
    };
  }

  // 12. Ambiguous — a bounded attention marker on the exact snapshot only.
  return {
    type: "CAUTION",
    label: "Operator attention recorded on this setup",
    guidanceAdvice:
      "Observation active; conservative thresholding applied to upcoming candidate passes.",
    rankingAdjustment: -1.0,
    entryDigitAdjustment: 0,
    targetDigit: null,
  };
}

/** Interactive helper for UI to preview guidance in real time before saving. */
export function interpretFeedbackPreview(
  text: string,
  category: FeedbackCategory | null,
  snapshot: Pick<TradeSnapshot, "entryDigit" | "symbol" | "contractLabel">,
  outcome?: TradeOutcome | null,
): DerivedDirective {
  return interpretFeedback(text, category, snapshot, outcome);
}

export interface RecordDirectiveInput {
  sourceId: string;
  text: string;
  category: FeedbackCategory | null;
  snapshot: TradeSnapshot;
  outcome?: TradeOutcome | null;
  ttlMs?: number;
  now?: number;
}

/**
 * Derive and store the immediate directive for one operator note or post-trade report.
 * Re-recording the same `sourceId` (the operator corrected or expanded the report) SUPERSEDES the old one.
 */
export function recordFeedbackDirective(input: RecordDirectiveInput): OperatorDirective | null {
  const clean = input.text.trim();
  if (!clean) return null;
  const now = input.now ?? Date.now();
  const derived = interpretFeedback(clean, input.category, input.snapshot, input.outcome);
  const s = load();
  // Supersede: same source, and same scope + type from an earlier note.
  s.directives = s.directives.filter(
    (d) =>
      d.sourceId !== input.sourceId &&
      !(
        d.symbol === input.snapshot.symbol &&
        d.contract === input.snapshot.contract &&
        d.type === derived.type &&
        d.targetDigit === derived.targetDigit
      ),
  );
  const directive: OperatorDirective = {
    id: `dir-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sourceId: input.sourceId,
    ts: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    symbol: input.snapshot.symbol,
    contract: input.snapshot.contract,
    contractLabel: input.snapshot.contractLabel,
    entryDigit: input.snapshot.entryDigit,
    targetDigit: derived.targetDigit,
    type: derived.type,
    category: input.category,
    outcome: input.outcome ?? null,
    text: clean,
    label: derived.label,
    guidanceAdvice: derived.guidanceAdvice,
    rankingAdjustment: derived.rankingAdjustment,
    entryDigitAdjustment: derived.entryDigitAdjustment,
  };
  s.directives.push(directive);
  persist();
  return directive;
}

export interface RecordOutcomeInput {
  sourceId: string;
  outcome: "WIN" | "LOSS";
  snapshot: TradeSnapshot;
  ttlMs?: number;
  now?: number;
}

/**
 * Record immediate directive directly from trade outcome (WIN/LOSS) even before text report.
 */
export function recordOutcomeDirective(input: RecordOutcomeInput): OperatorDirective {
  const now = input.now ?? Date.now();
  const isLoss = input.outcome === "LOSS";
  const s = load();
  // Remove existing outcome directive for this trade to avoid duplicates
  s.directives = s.directives.filter((d) => d.sourceId !== input.sourceId);

  const targetDigit = input.snapshot.entryDigit;
  const type: DirectiveType = isLoss ? "OUTCOME_LOSS_CAUTION" : "OUTCOME_WIN_SUPPORT";
  const label = isLoss
    ? `Operator: recent trade loss${targetDigit !== null ? ` on digit ${targetDigit}` : ""} (${input.snapshot.contractLabel})`
    : `Operator: recent trade win${targetDigit !== null ? ` on digit ${targetDigit}` : ""} (${input.snapshot.contractLabel})`;
  const guidanceAdvice = isLoss
    ? `Applying caution to subsequent signals on ${input.snapshot.contractLabel}${targetDigit !== null ? ` (entry digit ${targetDigit})` : ""}.`
    : `Supporting subsequent signals on ${input.snapshot.contractLabel}${targetDigit !== null ? ` (entry digit ${targetDigit})` : ""}.`;

  const directive: OperatorDirective = {
    id: `dir-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sourceId: input.sourceId,
    ts: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    symbol: input.snapshot.symbol,
    contract: input.snapshot.contract,
    contractLabel: input.snapshot.contractLabel,
    entryDigit: targetDigit,
    targetDigit,
    type,
    category: null,
    outcome: input.outcome,
    text: isLoss ? "Confirmed trade loss outcome" : "Confirmed trade win outcome",
    label,
    guidanceAdvice,
    rankingAdjustment: isLoss ? -3.0 : 1.5,
    entryDigitAdjustment: isLoss ? (targetDigit !== null ? -4.5 : -2.0) : 1.5,
  };
  s.directives.push(directive);
  persist();
  return directive;
}

/** Linear decay to a 0.25 floor over the directive's lifetime. */
function decay(d: OperatorDirective, now: number): number {
  const life = d.expiresAt - d.ts;
  if (life <= 0) return 0;
  const remaining = (d.expiresAt - now) / life;
  if (remaining <= 0) return 0;
  return Math.max(0.25, Math.min(1, remaining));
}

export interface GuidanceEffect {
  /** Bounded ranking contribution for this market × contract, in score points. */
  points: number;
  /** Directives currently in force for this scope. */
  directives: OperatorDirective[];
  /** Compact, attributed explanation for the score factor and the UI chip. */
  detail: string;
  /** Actionable bullet points explaining what guidance is steering signals. */
  adviceList: string[];
  active: boolean;
}

const round = (v: number) => Math.round(v * 10) / 10;

export interface ImmediateGuidanceLookup {
  revision: number;
  /** Ranking effect for a market × contract candidate. */
  forCandidate: (symbol: string, contract: string) => GuidanceEffect;
  /** Bounded entry-point adjustment for one candidate entry digit. */
  entryAdjustment: (symbol: string, contract: string, digit: number) => number;
  /** Directives touching one entry digit, for transparency in the entry report. */
  forDigit: (symbol: string, contract: string, digit: number) => OperatorDirective[];
  /** All live active directives across all markets. */
  allDirectives: () => OperatorDirective[];
}

/** Snapshot the overlay once per ranking pass so a pass is internally consistent. */
export function immediateGuidanceLookup(now = Date.now()): ImmediateGuidanceLookup {
  const live = activeDirectives(now);

  const scoped = (symbol: string, contract: string) =>
    live.filter((d) => d.symbol === symbol && d.contract === contract);

  return {
    revision,
    forCandidate(symbol, contract) {
      const ds = scoped(symbol, contract);
      if (!ds.length)
        return {
          points: 0,
          directives: [],
          adviceList: [],
          detail: "No immediate operator guidance is active for this market and contract.",
          active: false,
        };
      const raw = ds.reduce((a, d) => a + d.rankingAdjustment * decay(d, now), 0);
      const points = round(
        Math.max(-MAX_GUIDANCE_RANKING_DELTA, Math.min(MAX_GUIDANCE_RANKING_DELTA, raw)),
      );
      const adviceList = ds.map((d) => d.guidanceAdvice || d.label).filter(Boolean);

      return {
        points,
        directives: ds,
        adviceList,
        active: true,
        detail:
          `IMMEDIATE OPERATOR GUIDANCE — ` +
          ds
            .map(
              (d) =>
                `${d.label}${d.targetDigit !== null ? ` (digit ${d.targetDigit})` : ""}; expires ${new Date(d.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            )
            .join(" · "),
      };
    },
    entryAdjustment(symbol, contract, digit) {
      const ds = scoped(symbol, contract).filter(
        (d) => d.entryDigitAdjustment !== 0 && (d.targetDigit ?? d.entryDigit) === digit,
      );
      if (!ds.length) return 0;
      const raw = ds.reduce((a, d) => a + d.entryDigitAdjustment * decay(d, now), 0);
      return round(Math.max(-MAX_GUIDANCE_ENTRY_DELTA, Math.min(MAX_GUIDANCE_ENTRY_DELTA, raw)));
    },
    forDigit(symbol, contract, digit) {
      return scoped(symbol, contract).filter((d) => (d.targetDigit ?? d.entryDigit) === digit);
    },
    allDirectives() {
      return live;
    },
  };
}
