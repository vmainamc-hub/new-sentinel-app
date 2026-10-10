// APEX SENTINEL — DYNAMIC ENTRY-POINT ENGINE.
//
// This layer answers a question none of the other engines answer: given that a
// market × contract is the best available opportunity, WHICH OBSERVED DIGIT
// should the external bot enter on, and for how long does that remain valid?
//
// Hard rules honoured here:
//   • Nothing is hardcoded. "OVER always enters on 7" / "UNDER always enters
//     on 2" does not exist. Every digit 0..9 is evaluated from the market's own
//     measured behaviour.
//   • The ENTRY DIGIT is the digit observed at the moment the bot initiates —
//     it is NOT the contract's resolution digit. They are reported separately.
//   • Causal only. Every probability is measured on digits that had already
//     printed before the resolution they predict. No look-ahead.
//   • Frequency alone never wins. A digit that prints constantly but does not
//     improve contract-resolved probability scores badly.
//   • Normal updates do not thrash the recommendation; only a material change
//     re-selects the preferred digit (§22 of the specification).
import type { ContractEval, MarketIntel } from "../apex/types";
import type { EntryRecommendation } from "../apex/entry-conditions";
import type { DangerComposition } from "./danger";
import type { OperatorLearningLookup, OperatorPattern } from "./operator-learning";
import type { ImmediateGuidanceLookup } from "./immediate-guidance";
import type { CanonicalDigitState, ContractPsychology } from "./digit-psychology";
import { entryDigitPsychologyBias } from "./digit-psychology";
import type { VariableOrderMarkovReport } from "./context-engine";
import type { RegimeReport } from "./regime-detector";
import { simulateAllEntryDigits, type EntryDigitSimResult } from "../precision-edge/bot/simulator";

export interface EntryDigitFactor {
  code: string;
  label: string;
  points: number;
  detail: string;
}

export interface EntryDigitScore {
  digit: number;
  /** 0..100 entry-point score. */
  score: number;
  /** P(contract wins on the next tick | this digit is showing now), observed. */
  pWin: number;
  /** Wilson 95% lower bound of pWin. */
  pWinLower: number;
  /** Number of observed occurrences of this digit that had a following tick. */
  n: number;
  /** pWin − theoretical, in percentage points. */
  edgePp: number;
  /** 0..100 — how consistent pWin is between the older and newer halves. */
  stability: number;
  /** Mean gap in ticks between appearances of this digit. */
  expectedWaitTicks: number;
  sinceSeen: number;
  /** True when this digit is one of the contract's losing digits. */
  isLoser: boolean;
  factors: EntryDigitFactor[];
  drivers: string[];
  cautions: string[];
  /** Exact DBot replay evidence for this entry digit. */
  dbotReplay?: EntryDigitSimResult;
  /** Candidate was rejected by the mandatory DBot replay validation stage. */
  dbotReplayRejected?: boolean;
  /** Human-readable DBot replay validation band. */
  dbotReplayStatus?: "STRONGLY_VALIDATED" | "VALIDATED" | "INSUFFICIENT" | "REJECTED";
}

export type EntryPointStatus =
  "ENTER NOW" | "ARMED" | "UNVALIDATED" | "INVALIDATED" | "NOT_READY" | "UNKNOWN";

export interface EntryWindow {
  kind: "OCCURRENCES" | "TICKS" | "UNVALIDATED";
  value: number;
  /** Estimated tick budget for the window, when it can be measured. */
  ticks?: number;
  label: string;
  basis: string;
}

export interface EntryPointReport {
  symbol: string;
  contract: string;
  contractLabel: string;
  status: EntryPointStatus;
  preferred: EntryDigitScore | null;
  alternative: EntryDigitScore | null;
  /**
   * REFINEMENT 3 — the already-computed separation between the preferred entry
   * digit and its closest runner-up, in entry-point score points. Positive means
   * the preferred digit dominates; near zero means the choice is a coin flip and
   * must not be presented with the same confidence.
   */
  entryMargin: number;
  /** The runner-up entry digit behind the preferred one (never a replacement). */
  runnerUpDigit: number | null;
  /** The runner-up entry digit's score, for the same reason. */
  runnerUpScore: number | null;
  /** Top three entry digits, strongest first. */
  ranking: EntryDigitScore[];
  all: EntryDigitScore[];
  /** 0..100 — confidence in the preferred entry digit. */
  confidence: number;
  window: EntryWindow;
  invalidation: string[];
  /** Provenance invariant: the preferred digit can only come from the six-stage DBot-validated pipeline. */
  selectionSource: "SIX_STAGE_DBOT_VALIDATED" | "NONE";
  /** Total conditional sample the ranking rests on. */
  sampleSize: number;
  /** Bounded ranking contribution, in score points. */
  rankingDelta: number;
  /** Was the preferred digit re-selected because evidence changed materially? */
  changeState: "HELD" | "MATERIAL CHANGE" | "NEW";
  /** The contract's own winning (resolution) digits — never the entry digit. */
  resolutionDigits: number[];
  summary: string;
  /** Operator-learning patterns that materially contributed, for transparency. */
  operatorLearning: OperatorPattern[];
  /** Bounded operator-learning points applied to the preferred entry digit. */
  operatorEntryAdjustment: number;
  whyPreferred: string[];
  whyNotAlternative: string[];
  /** ENGINE #4 — Context Markov report */
  contextMarkov?: VariableOrderMarkovReport | null;
  /**
   * TOUCH GUARD — hard invalidation, independent of every point-scored factor
   * above. If the PREFERRED entry digit is one of this contract's LOSING
   * digits and that digit's own pressure is currently BUILDING (dominant /
   * emerging / recovering — i.e. gaining share right now, not just present),
   * the report is forced to INVALIDATED regardless of score. This exists
   * specifically so that if the operator is watching this digit on DBot, a
   * rising losing digit flags the signal down before it gets touched, rather
   * than being outvoted by unrelated positive factors elsewhere in the score.
   */
  /** Six-stage entry selection audit. */
  dbotReplay: {
    enabled: boolean;
    candidateCount: number;
    validatedCount: number;
    rejectedCount: number;
    preferredDigit: number | null;
    preferredStatus: "STRONGLY_VALIDATED" | "VALIDATED" | "INSUFFICIENT" | "REJECTED" | "NOT_RUN";
    minimumTrades: number;
    minimumOosTrades: number;
    minimumWinRate: number;
    minimumOosWinRate: number;
    results: EntryDigitSimResult[];
  };
  touchGuard: {
    triggered: boolean;
    digit: number | null;
    lifecycle: string | null;
    reason: string;
  };
}

export interface EntryPointInputs {
  intel: MarketIntel;
  contract: ContractEval;
  /** Causal digit history, oldest → newest. */
  digits: number[];
  danger: DangerComposition;
  /** Entry-Condition Lab evidence for this market × contract, when available. */
  entry: EntryRecommendation | null;
  /** Danger clearance state from the safety layer. */
  clearanceBlocked: boolean;
  /**
   * OPTIONAL, BOUNDED. Validated operator learning for THIS market × contract.
   * It is one additional input to the existing ranking — never a replacement,
   * and it can never bypass hard invalidation below.
   */
  operator?: OperatorLearningLookup | null;
  /**
   * OPTIONAL, BOUNDED, EXPIRING. Channel-1 immediate operator guidance for THIS
   * market × contract. It differentiates candidate ENTRY DIGITS by what the
   * operator just reported; it can never fabricate an entry or bypass hard
   * invalidation, and every directive expires on its own.
   */
  guidance?: ImmediateGuidanceLookup | null;
  /**
   * OPTIONAL, BOUNDED. Canonical 1,000-tick digit-frequency psychology plus the
   * positional reading for THIS contract. It differentiates candidate digits by
   * their winning / losing / boundary position; it never fabricates an entry.
   */
  canonicalPsychology?: {
    state: CanonicalDigitState;
    contract: ContractPsychology;
  } | null;
  /**
   * OPTIONAL. Variable-Order Markov / Context Engine report for entry digit evaluation.
   */
  contextMarkov?: VariableOrderMarkovReport | null;
  /**
   * OPTIONAL. Regime / Changepoint report.
   */
  regimeReport?: RegimeReport | null;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function wilsonLower(w: number, n: number): number {
  if (!n) return 0;
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

/** 10×10 count matrix: rows = digit showing now, cols = digit on the next tick. */
function transitionMatrix(digits: number[]): number[][] {
  const m: number[][] = Array.from({ length: 10 }, () => new Array<number>(10).fill(0));
  for (let i = 0; i + 1 < digits.length; i++) {
    const a = digits[i];
    const b = digits[i + 1];
    if (a >= 0 && a < 10 && b >= 0 && b < 10) m[a][b] += 1;
  }
  return m;
}

interface MatrixCache {
  /** Content fingerprint of the buffer the matrices were built from. */
  fingerprint: string;
  full: number[][];
  older: number[][];
  newer: number[][];
}

const matrixCache = new Map<string, MatrixCache>();

/**
 * A length-only key is unsafe: a rolling buffer keeps its length while its
 * CONTENT changes every tick, so stale matrices would be served forever. The
 * key is therefore content-derived — length plus the head/tail of the buffer
 * plus a cheap rolling checksum, so any mutation invalidates it.
 */
function fingerprintDigits(digits: number[]): string {
  const n = digits.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum * 31 + digits[i]) % 2147483647;
  const head = digits.slice(0, 8).join("");
  const tail = digits.slice(-8).join("");
  return `${n}:${head}:${tail}:${sum}`;
}

function matricesFor(symbol: string, digits: number[]): MatrixCache {
  const fingerprint = fingerprintDigits(digits);
  const cached = matrixCache.get(symbol);
  if (cached && cached.fingerprint === fingerprint) return cached;
  const half = Math.floor(digits.length / 2);
  const built: MatrixCache = {
    fingerprint,
    full: transitionMatrix(digits),
    older: transitionMatrix(digits.slice(0, half + 1)),
    newer: transitionMatrix(digits.slice(half)),
  };
  matrixCache.set(symbol, built);
  return built;
}

function conditional(row: number[], winners: number[]): { n: number; wins: number } {
  let n = 0;
  let wins = 0;
  for (let d = 0; d < 10; d++) n += row[d];
  for (const w of winners) wins += row[w];
  return { n, wins };
}

/** Mean gap in ticks between appearances of `d`, measured on the buffer. */
function meanGap(digits: number[], d: number): { gap: number; sinceSeen: number } {
  let last = -1;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] !== d) continue;
    if (last >= 0) {
      sum += i - last;
      count += 1;
    }
    last = i;
  }
  return {
    gap: count ? sum / count : digits.length || 10,
    sinceSeen: last >= 0 ? digits.length - 1 - last : digits.length,
  };
}

/** Sticky memory so ordinary ticks cannot flip the recommended entry digit. */
interface Sticky {
  digit: number;
  score: number;
  regime: string;
  at: number;
}
const sticky = new Map<string, Sticky>();
/** A challenger must beat the held digit by this margin to take over. */
const MATERIAL_MARGIN = 5;

export function resetEntryPointMemory(): void {
  sticky.clear();
  matrixCache.clear();
}

function usableForDbotReplay(digits: number[]): boolean {
  return digits.length >= 40;
}

const DBOT_ENTRY_MIN_TRADES = 20;
const DBOT_ENTRY_MIN_OOS_TRADES = 8;
const DBOT_ENTRY_STRONG_TRADES = 40;

interface DbotEntryValidation {
  status: "STRONGLY_VALIDATED" | "VALIDATED" | "INSUFFICIENT" | "REJECTED";
  accepted: boolean;
}

/**
 * Stage 2-4 of the entry hierarchy: exact DBot replay is a validation gate,
 * not another additive score. Thresholds are deliberately tied to the bot's
 * own theoretical fresh barrier probability, with a small tolerance for
 * sampling noise. No digit is accepted merely because its generic entry score
 * is high.
 */
export function validateDbotEntryReplay(
  result: EntryDigitSimResult,
  theoretical: number,
): DbotEntryValidation {
  if (result.trades < DBOT_ENTRY_MIN_TRADES || result.outOfSample.trades < DBOT_ENTRY_MIN_OOS_TRADES) {
    return { status: "INSUFFICIENT", accepted: false };
  }

  const tolerance = 0.05;
  const minimum = Math.max(0.5, theoretical - tolerance);
  const accepted =
    result.winRate >= minimum &&
    result.outOfSample.winRate >= minimum &&
    result.expectancy >= 0;

  if (!accepted) return { status: "REJECTED", accepted: false };

  const strong =
    result.trades >= DBOT_ENTRY_STRONG_TRADES &&
    result.outOfSample.trades >= DBOT_ENTRY_MIN_OOS_TRADES * 2 &&
    result.winRate >= theoretical &&
    result.outOfSample.winRate >= theoretical &&
    result.expectancy > 0 &&
    result.longestLossStreak <= 4;

  return { status: strong ? "STRONGLY_VALIDATED" : "VALIDATED", accepted: true };
}

function dbotReplayTieScore(result: EntryDigitSimResult): number {
  const oosWeight = Math.min(1, result.outOfSample.trades / 20);
  const runEvidence = Math.min(10, result.fourWinRuns) * 0.5;
  const expectancy = clamp(50 + result.expectancy * 100, 0, 100);
  const winRate = result.winRate * 100;
  const oosWinRate = result.outOfSample.winRate * 100;
  return winRate * 0.35 + oosWinRate * 0.35 * oosWeight + expectancy * 0.2 + runEvidence;
}

export function computeEntryPoint(inputs: EntryPointInputs): EntryPointReport {
  const { intel, contract, digits, danger, entry, clearanceBlocked, operator } = inputs;
  const guidance = inputs.guidance ?? null;
  const canonicalPsychology = inputs.canonicalPsychology ?? null;
  const key = `${intel.symbol}:${contract.id}`;
  const winners = contract.winners;
  const losers = Array.from({ length: 10 }, (_, d) => d).filter((d) => !winners.includes(d));
  const theoretical = contract.theoretical;
  const regimeLabel = intel.regime?.label ?? "UNKNOWN";

  // Six-stage hierarchy: the existing engines still generate all ten digit
  // candidates. Exact DBot replay is then run for every digit and acts as a
  // mandatory validation gate. Only replay survivors can become preferred.
  const dbotReplayResults = usableForDbotReplay(digits)
    ? simulateAllEntryDigits(digits, contract.side, { collectTrades: true })
    : [];
  const dbotValidation = new Map<number, DbotEntryValidation>();
  for (const result of dbotReplayResults) {
    dbotValidation.set(result.entryDigit, validateDbotEntryReplay(result, theoretical));
  }

  const usable = digits.length >= 30 ? digits : digits.length >= 10 ? digits : [];
  const matrices = usable.length ? matricesFor(intel.symbol, usable) : null;
  const profiles = intel.digitIntel?.profiles ?? null;
  const pressure = intel.pressure;
  const exposure = contract.exposure ?? null;
  const psy = intel.psychology
    ? contract.side === "OVER"
      ? intel.psychology.over
      : intel.psychology.under
    : null;

  const scores: EntryDigitScore[] = [];

  for (let d = 0; d < 10; d++) {
    const factors: EntryDigitFactor[] = [];
    const drivers: string[] = [];
    const cautions: string[] = [];

    // ── 1. Conditional contract probability (the causal core) ───────────
    const cond = matrices ? conditional(matrices.full[d], winners) : { n: 0, wins: 0 };
    const pWin = cond.n ? cond.wins / cond.n : theoretical;
    const lower = cond.n ? wilsonLower(cond.wins, cond.n) : 0;
    const edgePp = (pWin - theoretical) * 100;
    // Authority scales with sample size so a 6-observation digit cannot win.
    const authority =
      cond.n >= 200 ? 1 : cond.n >= 80 ? 0.75 : cond.n >= 30 ? 0.45 : cond.n >= 12 ? 0.2 : 0;
    const condPoints = Math.round(clamp(edgePp * 1.5, -26, 26) * authority * 10) / 10;
    factors.push({
      code: "CONDITIONAL",
      label: "Conditional contract probability",
      points: condPoints,
      detail: cond.n
        ? `P(${contract.label} wins on the next tick | entry digit ${d}) = ${(pWin * 100).toFixed(1)}% (lower bound ${(lower * 100).toFixed(1)}%) vs theoretical ${(theoretical * 100).toFixed(1)}% over N=${cond.n} observed occurrences. Authority ×${authority.toFixed(2)}.`
        : `No usable conditional sample for entry digit ${d} — no influence.`,
    });
    if (condPoints >= 4)
      drivers.push(
        `favourable transition into the winning side (+${edgePp.toFixed(1)}pp over N=${cond.n})`,
      );
    if (condPoints <= -4)
      cautions.push(
        `transition works against the contract (${edgePp.toFixed(1)}pp over N=${cond.n})`,
      );

    // ── 2. Stability of that probability across the buffer halves ────────
    let stability = 50;
    if (matrices && cond.n >= 10) {
      const older = conditional(matrices.older[d], winners);
      const newer = conditional(matrices.newer[d], winners);
      if (older.n >= 4 && newer.n >= 4) {
        const drift = Math.abs(older.wins / older.n - newer.wins / newer.n);
        stability = Math.round(clamp(100 - drift * 320));
        const pts = Math.round(((stability - 55) / 45) * 6 * 10) / 10;
        factors.push({
          code: "STABILITY",
          label: "Conditional stability (older vs newer half)",
          points: pts,
          detail: `Older half ${((older.wins / older.n) * 100).toFixed(1)}% (N=${older.n}) vs newer half ${((newer.wins / newer.n) * 100).toFixed(1)}% (N=${newer.n}) — drift ${(drift * 100).toFixed(1)}pp, stability ${stability}/100.`,
        });
        if (stability >= 75) drivers.push(`stable recent behaviour (${stability}/100)`);
        if (stability <= 40) cautions.push(`unstable conditional probability (${stability}/100)`);
      }
    }

    // ── 3. Pressure confirmation on the digit itself ─────────────────────
    const prof = profiles?.[d] ?? null;
    if (prof) {
      const press = prof.pressure * 100; // fast − baseline, in points
      const winnerSide = winners.includes(d);
      // Pressure on a WINNING digit confirms the side is being fed. Pressure on
      // a LOSING digit is a warning, not a confirmation.
      const pts = Math.round(clamp((winnerSide ? press : -press) * 0.55, -6, 6) * 10) / 10;
      factors.push({
        code: "PRESSURE",
        label: "Pressure confirmation",
        points: pts,
        detail: `Digit ${d} fast share ${(prof.fast * 100).toFixed(1)}% vs baseline ${(prof.baseline * 100).toFixed(1)}% (pressure ${press >= 0 ? "+" : ""}${press.toFixed(1)}pp, state ${prof.state}). ${winnerSide ? "Winning-side digit" : "Losing-side digit"}.`,
      });
      if (pts >= 3) drivers.push("pressure confirmation on the correct side");
      if (pts <= -3) cautions.push("pressure building on the wrong side");

      // ── 4. Crowding / exhaustion of the entry digit ────────────────────
      const crowd =
        (prof.clusterDensity > 1.6 ? -(prof.clusterDensity - 1.6) * 4 : 0) +
        (prof.consecutive >= 2 ? -prof.consecutive * 1.6 : 0) +
        (prof.exhaustion > 0.6 ? -(prof.exhaustion - 0.6) * 10 : 0);
      const crowdPts = Math.round(clamp(crowd, -8, 0) * 10) / 10;
      factors.push({
        code: "CROWDING",
        label: "Digit crowding / exhaustion",
        points: crowdPts,
        detail: `Cluster density ${prof.clusterDensity.toFixed(2)}× expected, ${prof.consecutive} consecutive print(s), exhaustion ${(prof.exhaustion * 100).toFixed(0)}%.`,
      });
      if (crowdPts <= -3) cautions.push("entry digit is crowded or exhausted right now");
    }

    // ── 5. Lifecycle support ─────────────────────────────────────────────
    if (pressure) {
      const life = pressure.lifecycle[d];
      const winnerSide = winners.includes(d);
      const map: Record<string, number> = {
        emerging: winnerSide ? 3 : -2,
        dominant: winnerSide ? 1.5 : -3,
        exhausting: winnerSide ? -2 : 2,
        suppressed: winnerSide ? -1 : 1.5,
        recovering: winnerSide ? 2 : -1.5,
        neutral: 0,
      };
      const pts = map[life] ?? 0;
      factors.push({
        code: "LIFECYCLE",
        label: "Digit lifecycle",
        points: pts,
        detail: `Digit ${d} lifecycle is ${life} (${winnerSide ? "winning" : "losing"} side).`,
      });
    }

    // ── 6. Losing-digit safety ───────────────────────────────────────────
    const isLoser = losers.includes(d);
    const expo = exposure?.digits.find((x) => x.digit === d) ?? null;
    let safety = 0;
    if (isLoser) {
      safety -= 3;
      if (expo) {
        safety -= (expo.risk / 100) * 7;
        if (expo.burstCount >= 2) safety -= 3;
      }
    } else {
      safety += 1.5;
    }
    const safetyPts = Math.round(clamp(safety, -12, 2) * 10) / 10;
    factors.push({
      code: "LOSER_SAFETY",
      label: "Losing-digit safety",
      points: safetyPts,
      detail: isLoser
        ? `Entry digit ${d} is one of this contract's LOSING digits${expo ? ` — exposure risk ${expo.risk}/100 (${expo.state}), ${expo.burstCount} print(s) in the last 10 ticks` : ""}. Entering while a losing digit is on screen is penalised.`
        : `Entry digit ${d} sits on the contract's winning side — no losing-digit penalty.`,
    });
    if (safetyPts <= -5) cautions.push("entry digit is an active losing digit");
    if (!isLoser && expo === null) drivers.push("low losing-digit exposure at entry");

    // ── 7. Psychology alignment (bounded hypothesis layer) ───────────────
    if (psy) {
      const pts =
        Math.round(clamp(((psy.score - 55) / 45) * 3 * (psy.confidence / 100), -3, 3) * 10) / 10;
      factors.push({
        code: "PSYCHOLOGY",
        label: "Psychology alignment",
        points: pts,
        detail: `${psy.side} configuration ${psy.score}/100 at confidence ${psy.confidence}/100 — applied equally to every candidate digit, so it never manufactures a winner.`,
      });
    }

    // ── 8. Feasibility: how often does this entry actually trigger? ──────
    const gap = usable.length ? meanGap(usable, d) : { gap: 10, sinceSeen: 0 };
    const feasPts = gap.gap > 22 ? -Math.min(5, (gap.gap - 22) * 0.25) : 0;
    factors.push({
      code: "FEASIBILITY",
      label: "Trigger feasibility",
      points: Math.round(feasPts * 10) / 10,
      detail: `Digit ${d} appears every ${gap.gap.toFixed(1)} ticks on average (uniform expectation 10); last seen ${gap.sinceSeen} tick(s) ago.`,
    });
    if (feasPts <= -2) cautions.push(`entry rarely triggers (~1 in ${gap.gap.toFixed(0)} ticks)`);

    // ── 9. Entry-Condition Lab evidence (shared, never per-digit invented) ─
    if (entry?.best && entry.best.n >= 20) {
      const pts = Math.round(clamp(entry.best.expectancy * 12, -4, 4) * 10) / 10;
      factors.push({
        code: "LAB",
        label: "Entry-Condition Lab evidence",
        points: pts,
        detail: `Validated condition "${entry.best.label}" (${entry.best.state}) — expectancy ${(entry.best.expectancy * 100).toFixed(1)}% over N=${entry.best.n}. Applied to all digits equally.`,
      });
    }

    // ── 10. Validated operator learning (bounded, market/contract/digit
    //         specific, and NEVER able to bypass invalidation below) ───────
    const opPatterns: OperatorPattern[] = operator
      ? operator.forDigit(intel.symbol, contract.id, d)
      : [];
    if (opPatterns.length) {
      const pts = operator!.entryAdjustment(intel.symbol, contract.id, d);
      if (Math.abs(pts) >= 0.5) {
        const top = opPatterns[0];
        factors.push({
          code: "OPERATOR",
          label: "Validated operator learning",
          points: pts,
          detail: `${top.status} operator pattern${top.category ? ` (${top.category})` : ""} on ${intel.symbol} · ${contract.label}${top.entryDigit !== null ? ` · entry ${top.entryDigit}` : ""} — ${top.observations} observation(s), ${top.relatedTrades} related confirmed trade(s) (${top.wins}W/${top.losses}L), feedback confidence ${top.feedbackConfidence}/100. ${top.reason}`,
        });
        if (pts <= -0.5)
          cautions.push(
            `validated operator feedback reports a repeated problem here (${top.category ?? "operator note"}, confidence ${top.feedbackConfidence}/100)`,
          );
        if (pts >= 0.5)
          drivers.push(
            `validated operator feedback supports this entry (confidence ${top.feedbackConfidence}/100)`,
          );
      }
    }

    // ── 10b. IMMEDIATE operator guidance for this entry digit (Channel 1) ──
    // Bounded (±6), decaying, expiring, and clearly labelled as operator intent
    // rather than validated statistics.
    if (guidance) {
      const gPts = guidance.entryAdjustment(intel.symbol, contract.id, d);
      const gDirectives = guidance.forDigit(intel.symbol, contract.id, d);
      if (gPts !== 0 && gDirectives.length) {
        factors.push({
          code: "GUIDANCE",
          label: "Immediate operator guidance",
          points: gPts,
          detail:
            `Temporary operator directive(s) on ${intel.symbol} · ${contract.label} · entry digit ${d}: ` +
            gDirectives.map((x) => `${x.label} ("${x.text}")`).join(" · ") +
            `. Operator intent, not statistical proof — it decays and expires.`,
        });
        if (gPts <= -0.5)
          cautions.push(`the operator has just reported a problem with entry digit ${d}`);
        if (gPts >= 0.5) drivers.push(`the operator has just reported this entry digit as working`);
      }
    }

    // ── 11. Canonical 1,000-tick digit psychology (bounded ±3, positional) ──
    if (canonicalPsychology) {
      const bias = entryDigitPsychologyBias(
        canonicalPsychology.state,
        canonicalPsychology.contract,
        d,
      );
      if (Math.abs(bias.points) >= 0.1) {
        factors.push({
          code: "DIGIT_PSYCHOLOGY",
          label: "Digit psychology (1,000 ticks)",
          points: bias.points,
          detail: bias.detail,
        });
        if (bias.points <= -0.5) cautions.push(bias.detail);
        if (bias.points >= 0.5) drivers.push(bias.detail);
      }
    }

    // ── 12. Variable-Order Markov Context Engine (bounded ±3) ───────────────
    if (inputs.contextMarkov) {
      const evalMatch = inputs.contextMarkov.evaluations.find((e) => e.digit === d);
      if (evalMatch) {
        const mPts = evalMatch.rankingDelta;
        if (Math.abs(mPts) >= 0.2) {
          factors.push({
            code: "CONTEXT_MARKOV",
            label: `Markov context (Order-${evalMatch.orderSelected})`,
            points: mPts,
            detail: evalMatch.notes.join(" "),
          });
          if (mPts <= -0.5) cautions.push(`Markov context penalised (${evalMatch.notes[0] ?? ""})`);
          if (mPts >= 0.5) drivers.push(`Markov context support (${evalMatch.notes[0] ?? ""})`);
        }
      }
    }

    const total = factors.reduce((a, f) => a + f.points, 0);
    scores.push({
      digit: d,
      score: Math.round(clamp(50 + total) * 10) / 10,
      pWin,
      pWinLower: lower,
      n: cond.n,
      edgePp: Math.round(edgePp * 10) / 10,
      stability,
      expectedWaitTicks: Math.round(gap.gap * 10) / 10,
      sinceSeen: gap.sinceSeen,
      isLoser,
      factors,
      drivers,
      cautions,
      dbotReplay: dbotReplayResults.find((r) => r.entryDigit === d),
      dbotReplayRejected: dbotReplayResults.length > 0 ? !dbotValidation.get(d)?.accepted : false,
      dbotReplayStatus: dbotReplayResults.length > 0
        ? dbotValidation.get(d)?.status
        : "INSUFFICIENT",
    });
  }

  const ordered = [...scores].sort((a, b) => b.score - a.score || b.pWinLower - a.pWinLower);
  const sampleSize = scores.reduce((a, s) => a + s.n, 0);

  const validated = ordered.filter((s) => {
    const replay = dbotValidation.get(s.digit);
    return replay?.accepted === true;
  });

  // Stage 1: existing engines generate candidates.
  // Stage 2: exact DBot replay validates every candidate.
  // Stage 3: replay-poor digits are rejected, never merely down-scored.
  // Stage 4: strongly validated replay survivors are preferred.
  // Stage 5: the existing statistical score breaks ties among replay survivors.
  // Stage 6: the selected digit is exposed through EntryPointReport.
  const replayOrdered = [...validated].sort((a, b) => {
    const ar = a.dbotReplay!;
    const br = b.dbotReplay!;
    const av = dbotReplayTieScore(ar);
    const bv = dbotReplayTieScore(br);
    const aStrong = a.dbotReplayStatus === "STRONGLY_VALIDATED" ? 1 : 0;
    const bStrong = b.dbotReplayStatus === "STRONGLY_VALIDATED" ? 1 : 0;
    return bStrong - aStrong || bv - av || b.score - a.score || b.pWinLower - a.pWinLower;
  });

  let changeState: EntryPointReport["changeState"] = "NEW";
  let chosen = replayOrdered[0] ?? null;
  const held = sticky.get(key);
  if (chosen && held) {
    const heldNow = replayOrdered.find((s) => s.digit === held.digit) ?? null;
    const regimeChanged = held.regime !== regimeLabel;
    if (
      heldNow &&
      !regimeChanged &&
      heldNow.digit !== chosen.digit &&
      chosen.dbotReplay &&
      heldNow.dbotReplay &&
      dbotReplayTieScore(chosen.dbotReplay) - dbotReplayTieScore(heldNow.dbotReplay) < MATERIAL_MARGIN &&
      heldNow.dbotReplayStatus !== "REJECTED"
    ) {
      chosen = heldNow;
      changeState = "HELD";
    } else if (heldNow && heldNow.digit === chosen.digit) {
      changeState = "HELD";
    } else {
      changeState = "MATERIAL CHANGE";
    }
  }
  if (chosen)
    sticky.set(key, {
      digit: chosen.digit,
      score: chosen.score,
      regime: regimeLabel,
      at: Date.now(),
    });

  const alternative = replayOrdered.find((s) => chosen && s.digit !== chosen.digit) ?? null;
  // Runner-up = the strongest candidate that is not the preferred digit. This is
  // the value the sticky selection already compares against; it is only being
  // exposed here, not recomputed.
  const runnerUp = alternative;
  const entryMargin =
    chosen && runnerUp ? Math.round((chosen.score - runnerUp.score) * 10) / 10 : 0;
  const lastDigit = intel.stats?.lastDigit ?? -1;

  // ── Status ────────────────────────────────────────────────────────────
  const severeExposure = (exposure?.state ?? "LOW") === "SEVERE";
  const chaotic = (intel.fluctuation?.state ?? "CALM") === "CHAOTIC";

  // ── Touch guard: rising losing digit hard-blocks regardless of score ────
  // BUILDING = gaining probability right now (dominant / emerging / recovering).
  // Deliberately mirrors precision-edge-v2's BUILDING_STATES so "rising" means
  // the same thing everywhere in the app, not a locally-invented definition.
  const BUILDING_LIFECYCLE = new Set(["dominant", "emerging", "recovering"]);
  const chosenLifecycle = chosen && pressure ? pressure.lifecycle[chosen.digit] : null;
  const touchGuardTriggered =
    !!chosen &&
    losers.includes(chosen.digit) &&
    !!chosenLifecycle &&
    BUILDING_LIFECYCLE.has(chosenLifecycle);
  const touchGuard = {
    triggered: touchGuardTriggered,
    digit: chosen?.digit ?? null,
    lifecycle: chosenLifecycle,
    reason: touchGuardTriggered
      ? `Entry digit ${chosen!.digit} is a LOSING digit for ${contract.label} and its own pressure is ${chosenLifecycle} (gaining share right now) — forced INVALIDATED so this signal cannot be touched while it is building against the contract.`
      : chosen && losers.includes(chosen.digit)
        ? `Entry digit ${chosen.digit} is a losing digit but its pressure is ${chosenLifecycle ?? "unmeasured"} (not building) — no touch-guard block.`
        : "Preferred entry digit is not on the losing side, or pressure is unavailable — no touch-guard block.",
  };

  const invalidated =
    clearanceBlocked ||
    severeExposure ||
    chaotic ||
    danger.autoBlock.length > 0 ||
    touchGuardTriggered;

  const hasValidEdge =
    !!chosen &&
    !!dbotValidation.get(chosen.digit)?.accepted &&
    ((chosen.n >= 10 && chosen.edgePp > 0) ||
      (chosen.n >= 6 && chosen.edgePp >= -0.5 && chosen.score >= 51) ||
      (chosen.score >= 52 && chosen.drivers.length > 0 && chosen.pWin >= theoretical) ||
      (chosen.score >= 48 && chosen.edgePp >= 0));

  let status: EntryPointStatus;
  if (invalidated) status = "INVALIDATED";
  else if (!chosen || !hasValidEdge) status = "UNVALIDATED";
  else if (chosen.digit === lastDigit) status = "ENTER NOW";
  else status = "ARMED";

  // ── Confidence ────────────────────────────────────────────────────────
  const confidence = chosen
    ? Math.round(
        clamp(
          22 +
            Math.min(30, chosen.n / 8) +
            Math.min(20, Math.max(0, chosen.edgePp) * 2.2) +
            (chosen.stability - 50) * 0.28 +
            (validated.length ? 6 : -6) -
            (invalidated ? 25 : 0) -
            Math.max(0, danger.total - 45) * 0.25,
          10,
          100,
        ),
      )
    : 0;

  // ── Validity window — only ever from measured behaviour ───────────────
  let window: EntryWindow;
  if (invalidated) {
    const psyBlockReason = inputs.canonicalPsychology?.contract?.hardBlock
      ? inputs.canonicalPsychology.contract.hardBlockReason
      : null;
    const reason = touchGuardTriggered
      ? touchGuard.reason
      : danger.autoBlock.length > 0
        ? `Blocked by danger auto-block: ${danger.autoBlock.map((a) => a.label).join("; ")}`
        : danger.total >= 70
          ? `Blocked by critical danger score (${danger.total}/100: ${danger.summary})`
          : psyBlockReason
            ? `Digit psychology hard block: ${psyBlockReason}`
            : severeExposure
              ? `Losing-digit exposure on ${contract.label} is SEVERE (${exposure?.losingDigitExposure.toFixed(0)}/100)`
              : chaotic
                ? `Market fluctuation is CHAOTIC (${intel.fluctuation?.score}/100)`
                : clearanceBlocked
                  ? "Entry clearance temporarily blocked by active governance veto or structural safety rule"
                  : "Entry point temporarily invalidated by risk clearance.";
    window = {
      kind: "UNVALIDATED",
      value: 0,
      label: "ENTRY WINDOW: TEMPORARILY BLOCKED / INVALIDATED",
      basis: reason,
    };
  } else if (!chosen || !hasValidEdge) {
    window = {
      kind: "UNVALIDATED",
      value: 0,
      label: "ENTRY WINDOW: FORMING / LOW SAMPLE",
      basis: chosen
        ? `Conditional sample N=${chosen.n} (edge ${chosen.edgePp >= 0 ? "+" : ""}${chosen.edgePp.toFixed(1)}pp, score ${chosen.score.toFixed(0)}/100) is still forming; awaiting clearer directional edge.`
        : "No entry evidence available for this market × contract yet.",
    };
  } else {
    const occurrences = chosen.stability >= 75 ? 3 : chosen.stability >= 45 ? 2 : 1;
    const avgWait = Math.max(4, Math.round(chosen.expectedWaitTicks || 10));
    const estimatedTicks = Math.round(occurrences * avgWait);
    const isEnterNow = status === "ENTER NOW";
    window = {
      kind: "OCCURRENCES",
      value: occurrences,
      ticks: estimatedTicks,
      label: isEnterNow
        ? `ACTIVE TRIGGER · DIGIT ${chosen.digit} ON SCREEN (${occurrences} OCCURRENCE${occurrences > 1 ? "S" : ""} / ~${estimatedTicks} TICKS)`
        : `VALID FOR THE NEXT ${occurrences} QUALIFYING OCCURRENCE${occurrences > 1 ? "S" : ""} OF DIGIT ${chosen.digit} (~${estimatedTicks} TICKS)`,
      basis: `Measured conditional edge (${chosen.edgePp >= 0 ? "+" : ""}${chosen.edgePp.toFixed(1)}pp over N=${chosen.n}, P=${(chosen.pWin * 100).toFixed(1)}% vs ${(theoretical * 100).toFixed(1)}%) with stability ${chosen.stability}/100. Expected trigger every ~${avgWait} ticks.`,
    };
  }

  const invalidation = [
    "Danger clearance turning BLOCKED on this market × contract",
    `Losing-digit exposure on ${contract.label} reaching SEVERE${exposure ? ` (currently ${exposure.losingDigitExposure.toFixed(0)}/100, ${exposure.state})` : ""}`,
    `Fluctuation becoming CHAOTIC${intel.fluctuation ? ` (currently ${intel.fluctuation.score}/100, ${intel.fluctuation.state})` : ""}`,
    "Relative edge against the alternatives collapsing to zero or below",
    chosen
      ? `Entry digit ${chosen.digit} losing conditional support (edge falling to ≤ 0pp from ${chosen.edgePp.toFixed(1)}pp)`
      : "No entry digit gaining measured support",
    `Regime transition away from ${regimeLabel}`,
    "A genuine hard invalidation raised by the engine-conflict layer",
    "TOUCH GUARD: the preferred entry digit is a losing digit whose pressure turns BUILDING (dominant / emerging / recovering)",
  ];

  const whyPreferred = chosen
    ? [
        `Entry digit ${chosen.digit} — score ${chosen.score.toFixed(0)}/100.`,
        ...(touchGuardTriggered ? [`⛔ ${touchGuard.reason}`] : []),
        ...chosen.drivers.map((x) => `+ ${x}`),
        ...chosen.cautions.map((x) => `− ${x}`),
      ]
    : ["No qualifying entry digit could be measured for this candidate."];

  const whyNotAlternative =
    chosen && alternative
      ? [
          `Digit ${alternative.digit} is the next DBot-replay survivor; its existing entry-engine score is ${alternative.score.toFixed(0)}/100 vs ${chosen.score.toFixed(0)}/100.`,
          alternative.dbotReplay
            ? `DBot replay: ${(alternative.dbotReplay.winRate * 100).toFixed(1)}% overall, ${(alternative.dbotReplay.outOfSample.winRate * 100).toFixed(1)}% OOS, ${alternative.dbotReplay.trades} runs.`
            : "DBot replay evidence unavailable.",
          `Conditional edge ${alternative.edgePp.toFixed(1)}pp (N=${alternative.n}) vs ${chosen.edgePp.toFixed(1)}pp (N=${chosen.n}).`,
          `Stability ${alternative.stability}/100 vs ${chosen.stability}/100.`,
          ...alternative.cautions.slice(0, 2).map((x) => `− ${x}`),
          ...(operator
            ? operator
                .forDigit(intel.symbol, contract.id, alternative.digit)
                .map(
                  (p) =>
                    `− Digit ${alternative.digit}: ${p.status.toLowerCase()} operator pattern (${p.category ?? "operator note"}) — ${p.observations} observation(s), ${p.relatedTrades} related trade(s), confidence ${p.feedbackConfidence}/100.`,
                )
            : []),
        ]
      : [];

  const rankingDelta = chosen
    ? Math.round(
        clamp(
          (chosen.dbotReplayStatus === "STRONGLY_VALIDATED"
            ? 3
            : chosen.dbotReplayStatus === "VALIDATED"
              ? 1.5
              : -6) + clamp(chosen.edgePp * 0.35, -3, 3),
          -7,
          6,
        ) * 10,
      ) / 10
    : -1;

  const operatorLearning =
    chosen && operator ? operator.forDigit(intel.symbol, contract.id, chosen.digit) : [];
  const operatorEntryAdjustment =
    chosen && operator ? operator.entryAdjustment(intel.symbol, contract.id, chosen.digit) : 0;

  const summary = chosen
    ? touchGuardTriggered
      ? `INVALIDATED (TOUCH GUARD) — digit ${chosen.digit} is a losing digit on ${contract.label} and is currently ${chosenLifecycle} (building). Do not touch this signal on ${intel.name} until the digit's pressure fades.`
      : `${status} — enter ${contract.label} on ${intel.name} when digit ${chosen.digit} is showing (confidence ${confidence}/100, conditional ${(chosen.pWin * 100).toFixed(1)}% vs theoretical ${(theoretical * 100).toFixed(1)}% over N=${chosen.n}). ${window.label}.`
    : `No entry digit has passed the mandatory exact-DBot replay validation for ${contract.label} on ${intel.name} yet.`;

  return {
    symbol: intel.symbol,
    contract: contract.id,
    contractLabel: contract.label,
    status,
    preferred: chosen,
    alternative,
    entryMargin,
    runnerUpDigit: runnerUp ? runnerUp.digit : null,
    runnerUpScore: runnerUp ? runnerUp.score : null,
    ranking: (replayOrdered.length ? replayOrdered : ordered).slice(0, 3),
    all: ordered,
    confidence,
    window,
    invalidation,
    selectionSource: chosen ? "SIX_STAGE_DBOT_VALIDATED" : "NONE",
    sampleSize,
    rankingDelta,
    changeState,
    resolutionDigits: winners,
    summary,
    operatorLearning,
    operatorEntryAdjustment,
    whyPreferred,
    whyNotAlternative,
    contextMarkov: inputs.contextMarkov ?? null,
    dbotReplay: {
      enabled: dbotReplayResults.length > 0,
      candidateCount: scores.length,
      validatedCount: validated.length,
      rejectedCount: dbotReplayResults.filter((r) => dbotValidation.get(r.entryDigit)?.status === "REJECTED").length,
      preferredDigit: chosen?.digit ?? null,
      preferredStatus: chosen
        ? (chosen.dbotReplayStatus ?? "INSUFFICIENT")
        : dbotReplayResults.length > 0
          ? "REJECTED"
          : "NOT_RUN",
      minimumTrades: DBOT_ENTRY_MIN_TRADES,
      minimumOosTrades: DBOT_ENTRY_MIN_OOS_TRADES,
      minimumWinRate: Math.max(0.5, theoretical - 0.05),
      minimumOosWinRate: Math.max(0.5, theoretical - 0.05),
      results: dbotReplayResults,
    },
    touchGuard,
  };
}
