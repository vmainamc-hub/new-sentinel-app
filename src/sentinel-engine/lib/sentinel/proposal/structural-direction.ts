// ═══════════════════════════════════════════════════════════════════════════
// ENGINE A — STRUCTURAL DIGIT PSYCHOLOGY → CONTRACT DIRECTION (1,000 TICKS)
//
// This engine is the ONLY owner of structural direction. It does not vote
// alongside pressure, models, crowd groups or regime; it DECIDES the
// directional hypothesis, which the other layers are then allowed to confirm,
// downgrade or veto.
//
// It reads only the canonical 1,000-tick state (roles + shares + the recency
// delta the canonical layer already produces). It never touches the
// 15/30/60/120 pressure field, and it never derives direction from a
// hard-coded digit: the roles come from the observed distribution.
//
// OPERATOR EDGE RULES (unchanged from digit-psychology.ts — restated as a
// per-side scoring rubric so both sides can be evaluated symmetrically):
//
//   OVER  : GREEN & 2ND GREEN on EVEN {0,2,4,6,8}; RED & 2ND RED on ODD
//           {3,5,7,9} and NEVER on digit 1; extreme GREEN 0 requires
//           >10.3% AND decay; 7/8/9 each <10% and rising; 5-9 gaining pace;
//           even declining / odd gaining share.
//   UNDER : mirror — GREEN & 2ND GREEN on ODD {9,7,5,3,1}; RED & 2ND RED on
//           EVEN {0,2,4,6} and NEVER on digit 8; extreme GREEN 9 requires
//           >10.3% AND decay; 0/1/2 each <10% and rising; 0-4 gaining pace;
//           odd declining / even gaining share.
//
//   HARD BLOCK (both sides): RED, 2ND RED, 2ND GREEN or MOST INCREASING on
//   the losing side of that side's psychology, or RED/2ND RED on the excluded
//   digit. A hard-blocked side can never be the structural direction.
// ═══════════════════════════════════════════════════════════════════════════
import {
  ALL_DIGITS,
  EVEN_DIGITS,
  ODD_DIGITS,
  type CanonicalStateLike,
  type Side,
  clamp,
  isEven,
  pp,
} from "./types";

/**
 * Minimum canonical ticks before digit structure is trusted.
 * Statistically justified at N=20: provides an expected frequency of E[X]=N/10=2.0
 * per digit across the 10 discrete buckets (0-9), preventing degenerate role ranking
 * on small-sample noise while aligning with MIN_OBSERVATION_SAMPLES_FOR_INTERESTING (20)
 * and avoiding artificial 300-tick lockouts.
 */
export const STRUCTURAL_MIN_TICKS = 20;
/** Minimum |pp| move before a digit's recency delta counts as a move. */
export const MOVE_MIN_PP = 0.5;
/** Extreme-digit (0 for OVER, 9 for UNDER) share requirement. */
export const EXTREME_SHARE_MIN_PCT = 10.3;
/** Edge-group (7/8/9 or 0/1/2) suppression ceiling. */
export const EDGE_GROUP_MAX_PCT = 10;
/** Side-score margin (0..100) required before one side owns the direction. */
export const DIRECTION_MARGIN_MIN = 8;

export type StructuralDirection = "OVER" | "UNDER" | "CONFLICT" | "UNKNOWN";

export interface StructuralRuleResult {
  rule:
    | "GREEN"
    | "2ND GREEN"
    | "RED"
    | "2ND RED"
    | "MOST INCREASING"
    | "MOST DECREASING"
    | "EDGE GROUP"
    | "PACE GROUP"
    | "PARITY TREND";
  digit: number | null;
  /** +1 supports this side, −1 contradicts it, 0 not evaluable. */
  support: -1 | 0 | 1;
  weight: number;
  /** True when this specific rule is an absolute block for the side. */
  blocking: boolean;
  note: string;
}

export interface SideStructure {
  side: Side;
  /** 0..100, 50 = neutral. Pure structure — no pressure input. */
  score: number;
  /** 0..100 — how much of the rubric could actually be measured. */
  confidence: number;
  hardBlock: boolean;
  hardBlockReasons: string[];
  rules: StructuralRuleResult[];
  supporting: string[];
  contradicting: string[];
  summary: string;
}

export interface StructuralDirectionReport {
  /** The directional hypothesis handed downstream. */
  direction: StructuralDirection;
  /** 0..100 — how strongly structure commits to `direction`. */
  conviction: number;
  /** 0..100 — measurability of the structure behind the verdict. */
  confidence: number;
  /** Score margin between the two sides, in points. */
  margin: number;
  over: SideStructure;
  under: SideStructure;
  /** Canonical roles echoed for downstream explanation. */
  roles: {
    green: number | null;
    secondGreen: number | null;
    red: number | null;
    secondRed: number | null;
    mostIncreasing: number | null;
    mostDecreasing: number | null;
  };
  /** Canonical stability classification, passed through untouched. */
  change: string;
  /** True when structure is unusable (insufficient / invalidated / both blocked). */
  unusable: boolean;
  reasons: string[];
  summary: string;
}

interface SideSpec {
  side: Side;
  /** Parity set GREEN / 2ND GREEN must occupy. */
  greenSet: number[];
  /** Parity set RED / 2ND RED must occupy. */
  redSet: number[];
  /** Digit RED / 2ND RED may never occupy. */
  excludedRedDigit: number;
  /** Digit whose exhaustion the extreme-GREEN rule watches. */
  extremeDigit: number;
  /** Suppressed-but-rising edge group. */
  edgeGroup: number[];
  /** Broader group that should be picking up pace. */
  paceGroup: number[];
  /** Digits that structurally favour this side (the "winning parity"). */
  favouring: readonly number[];
  /** Digits that structurally oppose this side (the "losing parity"). */
  opposing: readonly number[];
}

export function sideSpec(side: Side): SideSpec {
  return side === "OVER"
    ? {
        side,
        greenSet: [0, 2, 4, 6, 8],
        redSet: [5, 7, 9],
        excludedRedDigit: 1,
        extremeDigit: 0,
        edgeGroup: [7, 8, 9],
        paceGroup: [5, 6, 7, 8, 9],
        favouring: EVEN_DIGITS,
        opposing: ODD_DIGITS,
      }
    : {
        side,
        greenSet: [9, 7, 5, 3, 1],
        redSet: [0, 2, 4],
        excludedRedDigit: 8,
        extremeDigit: 9,
        edgeGroup: [0, 1, 2],
        paceGroup: [0, 1, 2, 3, 4],
        favouring: ODD_DIGITS,
        opposing: EVEN_DIGITS,
      };
}

const groupPct = (state: CanonicalStateLike, digits: readonly number[]) =>
  digits.reduce((a, d) => a + (state.pct[d] ?? 0), 0);
const groupDelta = (state: CanonicalStateLike, digits: readonly number[]) =>
  digits.reduce((a, d) => a + (state.deltaPp[d] ?? 0), 0);

/**
 * Score one side of the market against the operator rubric, using structure
 * only. Pure.
 */
export function evaluateSideStructure(state: CanonicalStateLike, side: Side): SideStructure {
  const spec = sideSpec(side);
  const rules: StructuralRuleResult[] = [];
  const supporting: string[] = [];
  const contradicting: string[] = [];
  const hardBlockReasons: string[] = [];
  let gained = 0;
  let weightTotal = 0;
  let measurable = 0;
  let measured = 0;

  const enough = state.n >= STRUCTURAL_MIN_TICKS;
  const delta = (d: number) => state.deltaPp[d] ?? 0;
  const share = (d: number) => state.pct[d] ?? 0;
  const favours = (d: number) => spec.favouring.includes(d);

  const add = (
    rule: StructuralRuleResult["rule"],
    digit: number | null,
    weight: number,
    evaluate: (d: number) => { support: -1 | 0 | 1; note: string; blocking?: boolean },
  ) => {
    measurable += 1;
    if (!enough || digit === null) {
      rules.push({
        rule,
        digit,
        support: 0,
        weight,
        blocking: false,
        note: enough ? "Role not measurable yet." : `Only ${state.n} canonical tick(s).`,
      });
      return;
    }
    measured += 1;
    const { support, note, blocking } = evaluate(digit);
    rules.push({ rule, digit, support, weight, blocking: Boolean(blocking), note });
    weightTotal += weight;
    gained += support * weight;
    if (support > 0) supporting.push(`${rule} ${digit} — ${note}`);
    if (support < 0) contradicting.push(`${rule} ${digit} — ${note}`);
    if (blocking && support < 0) hardBlockReasons.push(`${rule} ${digit} — ${note}`);
  };

  // ── GREEN — parity, plus the extreme-digit exhaustion requirement ──────
  add("GREEN", state.green, 26, (d) => {
    if (!spec.greenSet.includes(d)) {
      return {
        support: -1,
        note: `wrong parity for ${side}: GREEN must sit on ${spec.greenSet.join("/")}.`,
      };
    }
    if (d === spec.extremeDigit) {
      const highEnough = share(d) > EXTREME_SHARE_MIN_PCT;
      const decaying = delta(d) < -MOVE_MIN_PP;
      if (!highEnough || !decaying) {
        return {
          support: -1,
          note: `extreme digit ${d} needs >${EXTREME_SHARE_MIN_PCT}% and active decay (currently ${share(d).toFixed(2)}%, ${pp(delta(d))}).`,
        };
      }
      return {
        support: 1,
        note: `extreme digit ${d} at ${share(d).toFixed(2)}% and decaying (${pp(delta(d))}) — correct ${side} exhaustion.`,
      };
    }
    return { support: 1, note: `correct ${side} parity at ${share(d).toFixed(2)}%.` };
  });

  // ── 2ND GREEN — parity, and never on the opposing parity ──────────────
  add("2ND GREEN", state.secondGreen, 12, (d) => {
    if (!favours(d)) {
      return {
        support: -1,
        note: `sits on the ${side} losing side — structural penalty.`,
      };
    }
    if (!spec.greenSet.includes(d)) {
      return { support: -1, note: `outside the ${side} GREEN set ${spec.greenSet.join("/")}.` };
    }
    return { support: 1, note: `confirmed on the ${side} winning side.` };
  });

  // ── RED — parity, excluded digit (hard), never on the losing side ──────
  add("RED", state.red, 20, (d) => {
    if (d === spec.excludedRedDigit) {
      return {
        support: -1,
        blocking: true,
        note: `RED may never sit on forbidden digit ${spec.excludedRedDigit} for ${side}.`,
      };
    }
    if (!spec.redSet.includes(d)) {
      return {
        support: -1,
        note: `RED must sit on ${spec.redSet.join("/")} for ${side} — losing-side RED penalty.`,
      };
    }
    return { support: 1, note: `lowest-frequency digit correctly on the ${side} sacrificed set.` };
  });

  // ── 2ND RED — same rubric, lighter weight ─────────────────────────────
  add("2ND RED", state.secondRed, 10, (d) => {
    if (d === spec.excludedRedDigit) {
      return {
        support: -1,
        blocking: true,
        note: `2ND RED may never sit on forbidden digit ${spec.excludedRedDigit} for ${side}.`,
      };
    }
    if (!spec.redSet.includes(d)) {
      return {
        support: -1,
        note: `2ND RED outside ${spec.redSet.join("/")} — losing-side penalty for ${side}.`,
      };
    }
    return { support: 1, note: `correctly placed for ${side}.` };
  });

  // ── MOST INCREASING — never on the losing side (structural conflict) ───
  add("MOST INCREASING", state.mostIncreasing, 14, (d) => {
    if (!favours(d)) {
      return {
        support: -1,
        note: `strongest structural gain is on the ${side} losing side (${pp(delta(d))}) — structural conflict.`,
      };
    }
    return { support: 1, note: `strongest structural gain favours ${side} (${pp(delta(d))}).` };
  });

  // ── MOST DECREASING — fading out of the opposing side is supportive; winning side is contextual ─
  add("MOST DECREASING", state.mostDecreasing, 8, (d) => {
    if (favours(d)) {
      return {
        support: 0,
        note: `digit ${d} is decreasing (${pp(delta(d))}) — contextual evidence.`,
      };
    }
    return { support: 1, note: `opposing side is bleeding share (${pp(delta(d))}) — supportive.` };
  });

  // ── EDGE GROUP — each member suppressed under 10% and rising ──────────
  add("EDGE GROUP", spec.edgeGroup[0] ?? null, 8, () => {
    const suppressed = spec.edgeGroup.filter((d) => share(d) < EDGE_GROUP_MAX_PCT);
    const rising = spec.edgeGroup.filter((d) => delta(d) > 0);
    const detail = spec.edgeGroup
      .map((d) => `${d}:${share(d).toFixed(1)}%/${pp(delta(d))}`)
      .join(" ");
    if (suppressed.length === spec.edgeGroup.length && rising.length >= 2) {
      return { support: 1, note: `${spec.edgeGroup.join("/")} suppressed and rising — ${detail}.` };
    }
    if (suppressed.length <= 1) {
      return { support: -1, note: `${spec.edgeGroup.join("/")} no longer suppressed — ${detail}.` };
    }
    return { support: 0, note: `${spec.edgeGroup.join("/")} partially aligned — ${detail}.` };
  });

  // ── PACE GROUP — the side's group should be picking up pace ───────────
  add("PACE GROUP", spec.paceGroup[0] ?? null, 10, () => {
    const drift = groupDelta(state, spec.paceGroup) / spec.paceGroup.length;
    if (drift > 0.15) {
      return {
        support: 1,
        note: `${spec.paceGroup.join("/")} picking up pace (${pp(drift)} avg).`,
      };
    }
    if (drift < -0.15) {
      return { support: -1, note: `${spec.paceGroup.join("/")} losing pace (${pp(drift)} avg).` };
    }
    return { support: 0, note: `${spec.paceGroup.join("/")} flat (${pp(drift)} avg).` };
  });

  // ── PARITY TREND — winning parity should be gaining share ────────────
  add("PARITY TREND", spec.favouring[0] ?? null, 12, () => {
    const favDrift = groupDelta(state, spec.favouring);
    const oppDrift = groupDelta(state, spec.opposing);
    const net = favDrift - oppDrift;
    const detail = `${side} side ${pp(favDrift)} vs opposing ${pp(oppDrift)}`;
    if (net > 0.8) return { support: 1, note: `winning parity is absorbing share — ${detail}.` };
    if (net < -0.8) return { support: -1, note: `winning parity is being displaced — ${detail}.` };
    return { support: 0, note: `parity drift inconclusive — ${detail}.` };
  });

  const hardBlock = hardBlockReasons.length > 0;
  const raw = weightTotal ? gained / weightTotal : 0;
  const score = hardBlock ? 0 : Math.round(clamp(50 + raw * 50, 0, 100) * 10) / 10;
  const confidence = Math.round(
    clamp(
      (measurable ? (measured / measurable) * 60 : 0) + clamp(state.n / 1000, 0, 1) * 40,
      0,
      100,
    ),
  );

  const summary = !enough
    ? `${side}: structure not measurable (${state.n} canonical ticks).`
    : hardBlock
      ? `${side}: HARD BLOCK — ${hardBlockReasons[0]}`
      : `${side}: structural score ${score.toFixed(0)}/100 (confidence ${confidence}) — ${supporting[0] ?? contradicting[0] ?? "no decisive role evidence"}`;

  return {
    side,
    score,
    confidence,
    hardBlock,
    hardBlockReasons,
    rules,
    supporting,
    contradicting,
    summary,
  };
}

/**
 * ENGINE A entry point. Produces the single directional hypothesis for the
 * whole pipeline.
 */
export function structuralDirection(state: CanonicalStateLike): StructuralDirectionReport {
  const over = evaluateSideStructure(state, "OVER");
  const under = evaluateSideStructure(state, "UNDER");
  const reasons: string[] = [];

  const insufficient = state.n < STRUCTURAL_MIN_TICKS;
  const invalidated = state.change === "INVALIDATED";
  const bothBlocked = over.hardBlock && under.hardBlock;

  let direction: StructuralDirection = "UNKNOWN";
  let margin = 0;

  if (insufficient) {
    reasons.push(`Only ${state.n}/1000 canonical ticks — no structural direction.`);
  } else if (bothBlocked) {
    direction = "CONFLICT";
    reasons.push(
      `Both sides hard-blocked: OVER — ${over.hardBlockReasons[0]}; UNDER — ${under.hardBlockReasons[0]}`,
    );
  } else if (over.hardBlock && !under.hardBlock) {
    direction = "UNDER";
    margin = under.score - over.score;
    reasons.push(`OVER is hard-blocked (${over.hardBlockReasons[0]}) — structure points UNDER.`);
  } else if (under.hardBlock && !over.hardBlock) {
    direction = "OVER";
    margin = over.score - under.score;
    reasons.push(`UNDER is hard-blocked (${under.hardBlockReasons[0]}) — structure points OVER.`);
  } else {
    margin = Math.abs(over.score - under.score);
    if (margin < DIRECTION_MARGIN_MIN) {
      direction = "CONFLICT";
      reasons.push(
        `OVER ${over.score.toFixed(0)} vs UNDER ${under.score.toFixed(0)} — margin ${margin.toFixed(1)} below ${DIRECTION_MARGIN_MIN}; structure has no direction.`,
      );
    } else {
      direction = over.score > under.score ? "OVER" : "UNDER";
      reasons.push(
        `Structure favours ${direction}: OVER ${over.score.toFixed(0)} vs UNDER ${under.score.toFixed(0)} (margin ${margin.toFixed(1)}).`,
      );
    }
  }

  if (invalidated && (direction === "OVER" || direction === "UNDER")) {
    reasons.push(
      `Canonical configuration is INVALIDATED — ${state.changeDetail ?? "leadership collapsed"}.`,
    );
  }

  const winner = direction === "OVER" ? over : direction === "UNDER" ? under : null;
  const loser = direction === "OVER" ? under : direction === "UNDER" ? over : null;
  const stabilityFactor =
    state.change === "STRENGTHENING"
      ? 1.1
      : state.change === "STABLE"
        ? 1
        : state.change === "WEAKENING"
          ? 0.85
          : state.change === "ROTATING"
            ? 0.7
            : state.change === "INVALIDATED"
              ? 0.4
              : 0.6;

  const conviction = winner
    ? Math.round(
        clamp(
          (clamp((winner.score - 50) * 1.6, 0, 60) + clamp(margin * 1.4, 0, 40)) * stabilityFactor,
          0,
          100,
        ),
      )
    : 0;

  const confidence = Math.round((over.confidence + under.confidence) / 2);
  const unusable = insufficient || direction === "UNKNOWN" || direction === "CONFLICT";

  const summary = winner
    ? `STRUCTURAL DIRECTION ${direction} — conviction ${conviction}/100, ${state.change} structure (GREEN ${state.green ?? "—"} · 2ND GREEN ${state.secondGreen ?? "—"} · RED ${state.red ?? "—"} · 2ND RED ${state.secondRed ?? "—"} · ↑ ${state.mostIncreasing ?? "—"} · ↓ ${state.mostDecreasing ?? "—"}). Opposing side scored ${loser?.score.toFixed(0) ?? "—"}.`
    : `STRUCTURAL DIRECTION ${direction} — ${reasons[0] ?? "structure unavailable"}`;

  return {
    direction,
    conviction,
    confidence,
    margin: Math.round(margin * 10) / 10,
    over,
    under,
    roles: {
      green: state.green,
      secondGreen: state.secondGreen,
      red: state.red,
      secondRed: state.secondRed,
      mostIncreasing: state.mostIncreasing,
      mostDecreasing: state.mostDecreasing,
    },
    change: state.change,
    unusable,
    reasons,
    summary,
  };
}

/** Digits that structurally favour / oppose a direction (parity psychology). */
export function directionGroups(direction: Side): { supports: number[]; opposes: number[] } {
  const spec = sideSpec(direction);
  return { supports: [...spec.favouring], opposes: [...spec.opposing] };
}

/** All digits, exported for callers that need the board. */
export const BOARD = [...ALL_DIGITS];
export { isEven };
