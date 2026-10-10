// APEX SENTINEL — TRADER GLOBAL RISK RULE (VETO) ENGINE.
//
// CORE PRINCIPLE: EXPLICIT OPERATOR LOSS FEEDBACK ABOUT A *PATTERN* SHOULD
// IMMEDIATELY AND GLOBALLY BLOCK THAT PATTERN — NOT JUST ON THE MARKET WHERE
// IT WAS OBSERVED, AND NOT AFTER WAITING FOR 20–100 MORE EXAMPLES.
//
// This module is deliberately separate from:
//   • immediate-guidance.ts   — bounded, per market×contract, always TTL'd,
//                               nudges a ranking score by a few points.
//   • operator-learning.ts /
//     trade-feedback.ts       — statistical learning, market+contract
//                               isolated, gated on sample size.
// Neither of those can do what is being asked for here: an operator saying
// "this pattern caused me a loss, avoid it everywhere" needs to act as a
// hard, cross-market gate the instant it is recorded — not as one more
// point nudge that a high statistical score can outvote.
//
// Five-level governance hierarchy this module implements the top of:
//
//   LEVEL 1 — TRADER VETO           (this module: hard stop, cross-market)
//   LEVEL 2 — GLOBAL PATTERN RISK   (this module: soft, cross-market memory)
//   LEVEL 3 — Current market evidence   (existing engines: psychology,
//                                        pressure, regime, entry — untouched)
//   LEVEL 4 — Statistical learning      (existing: operator-learning.ts,
//                                        trade-feedback.ts — untouched)
//   LEVEL 5 — Ranking / Best Opportunity (existing ranking layer — untouched)
//
// A high statistical score at Level 4/5 can NEVER override a Level 1 veto.
// `evaluateSignalGovernance` below returns a verdict the ranking layer
// should short-circuit on; it does not replace or call into levels 3-5.
//
// SAFEGUARD: not every operator comment becomes an irreversible global veto.
// There are three distinct tiers of operator input:
//   • Observation — "I noticed digit 4 increasing."      → not handled here.
//   • Feedback    — "This setup lost."                    → immediate-guidance.ts.
//   • Global veto — "Never take this pattern again until I release it." → here.
// Only text that clears `isExplicitGlobalVetoRequest` below can create a
// Level 1 rule. Everything else must go through the existing, TTL-bounded
// feedback channel instead.

/**
 * A pattern is described as an unordered set of short, stable tags rather
 * than free text, so matching is exact and auditable. Callers (the wiring
 * layer) build these tags from whatever concrete signal fields they have —
 * e.g. contract side, digit colour/role, losing-side pressure direction,
 * entry rule, regime label. Examples:
 *   "CONTRACT:UNDER", "SIDE_DIGIT:RED", "LOSING_SIDE:RISING",
 *   "PRESSURE:INCREASING", "ENTRY:SUBSEQUENT_TOUCH", "REGIME:TRANSITION"
 */
export type PatternTag = string;

export interface PatternSignature {
  tags: PatternTag[];
  /** Optional: restrict matching to specific contracts (e.g. ["UNDER7"]). */
  contracts?: string[];
  /** Optional: restrict matching to a specific entry digit. */
  entryDigit?: number | null;
}

export type VetoScope = "GLOBAL" | "CONTRACT_TYPE" | "MARKET";

export interface GlobalVetoRule {
  id: string;
  sourceId: string;
  createdAt: number;
  releasedAt: number | null;
  active: boolean;
  scope: VetoScope;
  /** Only set when scope === "MARKET" — the single market this rule covers. */
  symbol: string | null;
  pattern: PatternSignature;
  reason: string;
  /** The exact operator words that created this rule (for audit only). */
  operatorText: string;
}

interface Store {
  version: 1;
  rules: GlobalVetoRule[];
  /** Cross-market, pattern-keyed occurrence ledger — Level 2 memory. */
  patternLedger: Record<string, PatternLedgerEntry>;
}

interface PatternLedgerEntry {
  key: string;
  tags: PatternTag[];
  n: number;
  losses: number;
  wins: number;
  symbols: string[]; // distinct markets this pattern has been seen on
  lastSeenAt: number;
}

const KEY = "sentinel.global-veto.v1";
const MAX_RULES = 200;

let store: Store | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function blank(): Store {
  return { version: 1, rules: [], patternLedger: {} };
}

function load(): Store {
  if (store) return store;
  store = blank();
  if (typeof window === "undefined") return store;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (parsed && Array.isArray(parsed.rules)) {
        store = {
          version: 1,
          rules: parsed.rules.filter(Boolean),
          patternLedger:
            parsed.patternLedger && typeof parsed.patternLedger === "object"
              ? parsed.patternLedger
              : {},
        };
      }
    }
  } catch {
    store = blank();
  }
  return store;
}

function persist() {
  if (!store) return;
  if (store.rules.length > MAX_RULES) {
    store.rules.splice(0, store.rules.length - MAX_RULES);
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      /* storage full or unavailable — in-memory rule still applies this session */
    }
  }
  revision++;
  listeners.forEach((l) => l());
}

export function globalVetoRevision(): number {
  return revision;
}

export function subscribeGlobalVeto(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test/maintenance helper — drops persisted state without touching storage. */
export function resetGlobalVetoForTests() {
  store = blank();
  revision++;
}

// ── TIER CLASSIFICATION ─────────────────────────────────────────────────
//
// Distinguishes an ordinary comment/loss report from an explicit, durable
// veto instruction. Deliberately conservative: absent a clear "never / avoid
// permanently / global / until I say so" signal, this returns false and the
// caller should route the note through the existing bounded feedback channel
// instead.

const EXPLICIT_VETO_RE =
  /\b(never (take|trade|enter|do) this (again|pattern|setup)|avoid this pattern (permanently|globally|everywhere|for good)|global(ly)? (veto|block|ban)|veto this pattern|block this pattern (everywhere|globally|on all markets)|do not (take|trade) this (pattern|setup) (again|anymore)|until i (release|say|lift)|permanently avoid)\b/i;

export function isExplicitGlobalVetoRequest(text: string): boolean {
  return EXPLICIT_VETO_RE.test(text.trim());
}

const RELEASE_RE = /\b(release|lift|remove|cancel|clear) (the )?(global )?veto\b/i;

export function isExplicitVetoReleaseRequest(text: string): boolean {
  return RELEASE_RE.test(text.trim());
}

// ── PATTERN MATCHING ────────────────────────────────────────────────────

function normaliseTags(tags?: PatternTag[]): PatternTag[] {
  if (!tags || !Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => (typeof t === "string" ? t.trim().toUpperCase() : "")))]
    .filter(Boolean)
    .sort();
}

export function patternKey(pattern: PatternSignature): string {
  return normaliseTags(pattern?.tags).join("+");
}

/**
 * A candidate matches a veto pattern when every tag in the rule's pattern is
 * present in the candidate's tags (subset match) AND the optional contract /
 * entry-digit / market constraints are satisfied. A loss on one market must
 * never veto every conceivable signal — only the same underlying pattern.
 */
function patternMatches(
  rule: GlobalVetoRule,
  candidate: {
    tags?: PatternTag[];
    patternTags?: PatternTag[];
    contract?: string;
    entryDigit?: number | null;
    symbol?: string;
    market?: string;
  },
): boolean {
  const ruleTags = normaliseTags(rule.pattern?.tags);
  const candidateTags = normaliseTags(candidate.tags ?? candidate.patternTags);
  const tagsMatch = ruleTags.every((t) => candidateTags.includes(t));
  if (!tagsMatch) return false;

  if (rule.pattern.contracts && rule.pattern.contracts.length) {
    if (!candidate.contract || !rule.pattern.contracts.includes(candidate.contract)) return false;
  }
  if (rule.pattern.entryDigit != null) {
    if (candidate.entryDigit == null || candidate.entryDigit !== rule.pattern.entryDigit) {
      return false;
    }
  }
  if (rule.scope === "MARKET") {
    const sym = candidate.symbol ?? candidate.market;
    if (!sym || sym !== rule.symbol) return false;
  }
  return true;
}

// ── LEVEL 1 — TRADER VETO ───────────────────────────────────────────────

export interface CreateGlobalVetoInput {
  sourceId: string;
  operatorText: string;
  pattern: PatternSignature;
  reason: string;
  scope?: VetoScope;
  /** Required when scope === "MARKET". */
  symbol?: string | null;
  now?: number;
}

/**
 * Create a persistent, cross-market veto rule from EXPLICIT operator intent.
 * Callers must have already confirmed `isExplicitGlobalVetoRequest` (or an
 * equivalent explicit UI action, e.g. a dedicated "Veto this pattern"
 * button) before calling this — this function does not itself gate on
 * wording, so a deliberate UI action can also create a rule directly.
 */
export function createGlobalVetoRule(input: CreateGlobalVetoInput): GlobalVetoRule {
  const now = input.now ?? Date.now();
  const s = load();
  const rule: GlobalVetoRule = {
    id: `veto-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sourceId: input.sourceId,
    createdAt: now,
    releasedAt: null,
    active: true,
    scope: input.scope ?? "GLOBAL",
    symbol: input.scope === "MARKET" ? (input.symbol ?? null) : null,
    pattern: { ...input.pattern, tags: normaliseTags(input.pattern.tags) },
    reason: input.reason,
    operatorText: input.operatorText,
  };
  s.rules.push(rule);
  persist();
  return rule;
}

export function releaseGlobalVetoRule(id: string, now = Date.now()): boolean {
  const s = load();
  const rule = s.rules.find((r) => r.id === id && r.active);
  if (!rule) return false;
  rule.active = false;
  rule.releasedAt = now;
  persist();
  return true;
}

export function releaseAllGlobalVetoRules(now = Date.now()): number {
  const s = load();
  let count = 0;
  for (const r of s.rules) {
    if (r.active) {
      r.active = false;
      r.releasedAt = now;
      count++;
    }
  }
  if (count) persist();
  return count;
}

export function activeGlobalVetoRules(): GlobalVetoRule[] {
  return load().rules.filter((r) => r.active);
}

export function allGlobalVetoRules(): GlobalVetoRule[] {
  return [...load().rules].sort((a, b) => b.createdAt - a.createdAt);
}

export interface VetoCandidate {
  tags?: PatternTag[];
  patternTags?: PatternTag[];
  contract?: string;
  entryDigit?: number | null;
  symbol?: string;
  market?: string;
  [key: string]: any;
}

export interface VetoCheckResult {
  vetoed: boolean;
  rule: GlobalVetoRule | null;
  reason: string;
}

/**
 * LEVEL 1 CHECK. If this returns `vetoed: true`, the candidate must not
 * become — or remain — the Best Opportunity, regardless of how strong its
 * statistical score is at Levels 3-5.
 */
export function checkGlobalVeto(candidate: VetoCandidate): VetoCheckResult {
  const rules = activeGlobalVetoRules();
  for (const rule of rules) {
    if (patternMatches(rule, candidate)) {
      return {
        vetoed: true,
        rule,
        reason: `VETOED — TRADER GLOBAL RISK RULE. Pattern matches a previously reported loss condition (${rule.reason}). Signal cannot become Best Opportunity.`,
      };
    }
  }
  return { vetoed: false, rule: null, reason: "No active trader veto matches this pattern." };
}

// ── LEVEL 2 — GLOBAL PATTERN RISK (cross-market long-term learning) ─────
//
// Independent of any explicit veto: every time a resolved outcome is
// recorded, the underlying pattern's cross-market track record accumulates
// here. This is what lets Sentinel eventually judge how strong and
// persistent a rule *should* be, and prevents "Volatility 10 1s lost, but
// Volatility 25 hasn't learned it yet, so let's try it" — the ledger is
// keyed by pattern, not by market.

export function recordPatternOutcome(
  pattern: PatternSignature,
  result: "WIN" | "LOSS",
  symbol: string,
  now = Date.now(),
): PatternLedgerEntry {
  const s = load();
  const key = patternKey(pattern);
  const entry: PatternLedgerEntry = s.patternLedger[key] ?? {
    key,
    tags: normaliseTags(pattern.tags),
    n: 0,
    wins: 0,
    losses: 0,
    symbols: [],
    lastSeenAt: now,
  };
  entry.n += 1;
  if (result === "WIN") entry.wins += 1;
  else entry.losses += 1;
  if (!entry.symbols.includes(symbol)) entry.symbols.push(symbol);
  entry.lastSeenAt = now;
  s.patternLedger[key] = entry;
  persist();
  return entry;
}

export type PatternRiskLevel = "NONE" | "WATCH" | "ELEVATED" | "SEVERE";

export interface PatternRiskStats {
  key: string;
  tags: PatternTag[];
  n: number;
  wins: number;
  losses: number;
  lossRate: number;
  /** Distinct markets this pattern has recurred on — cross-market signal. */
  marketBreadth: number;
  riskLevel: PatternRiskLevel;
  note: string;
}

const RISK_MIN_SAMPLE = 5;

export function patternRiskStats(pattern: PatternSignature): PatternRiskStats {
  const s = load();
  const key = patternKey(pattern);
  const entry = s.patternLedger[key];
  if (!entry || entry.n === 0) {
    return {
      key,
      tags: normaliseTags(pattern.tags),
      n: 0,
      wins: 0,
      losses: 0,
      lossRate: 0,
      marketBreadth: 0,
      riskLevel: "NONE",
      note: "No cross-market history recorded for this pattern yet.",
    };
  }
  const lossRate = entry.losses / entry.n;
  const breadth = entry.symbols.length;

  let riskLevel: PatternRiskLevel = "NONE";
  if (entry.n >= RISK_MIN_SAMPLE) {
    if (lossRate >= 0.7 && breadth >= 2) riskLevel = "SEVERE";
    else if (lossRate >= 0.6) riskLevel = "ELEVATED";
    else if (lossRate >= 0.45) riskLevel = "WATCH";
  } else if (entry.losses >= 2) {
    riskLevel = "WATCH";
  }

  const note =
    entry.n < RISK_MIN_SAMPLE
      ? `Pattern seen ${entry.n} time(s) across ${breadth} market(s) — too early for a statistical rule, but ${entry.losses} loss(es) recorded.`
      : `Pattern lost ${(lossRate * 100).toFixed(0)}% of the time over N=${entry.n} across ${breadth} market(s).`;

  return {
    key,
    tags: entry.tags,
    n: entry.n,
    wins: entry.wins,
    losses: entry.losses,
    lossRate,
    marketBreadth: breadth,
    riskLevel,
    note,
  };
}

export function allPatternRiskStats(): PatternRiskStats[] {
  const s = load();
  return Object.keys(s.patternLedger)
    .map((key) => patternRiskStats({ tags: s.patternLedger[key].tags }))
    .sort((a, b) => b.lossRate - a.lossRate || b.n - a.n);
}

// ── COMBINED GOVERNANCE CHECK (Levels 1 + 2) ────────────────────────────

export type GovernanceVerdict = "VETOED" | "ELEVATED_RISK" | "WATCH" | "CLEAR";

export interface SignalGovernanceResult {
  verdict: GovernanceVerdict;
  /** Hard stop — mirrors checkGlobalVeto. When true, stop here; do not rank. */
  vetoed: boolean;
  vetoRule: GlobalVetoRule | null;
  patternRisk: PatternRiskStats;
  /** Suggested bounded ranking penalty for Level 2 risk (points, 0..12). Only
   *  meaningful when `vetoed` is false — a veto already removes the signal. */
  suggestedPenalty: number;
  reasons: string[];
}

/**
 * Top of the hierarchy (Levels 1 & 2 only). The caller chains this in front
 * of the existing current-market-evidence / statistical-learning / ranking
 * layers (Levels 3-5): if `vetoed` is true, stop — no statistical score can
 * promote this candidate to Best Opportunity. Otherwise, apply
 * `suggestedPenalty` (bounded, like every other Sentinel modifier) before
 * Levels 3-5 run as they already do today.
 */
export function evaluateSignalGovernance(candidate: VetoCandidate): SignalGovernanceResult {
  const resolvedCandidate: VetoCandidate = {
    ...candidate,
    tags: candidate.tags ?? candidate.patternTags ?? [],
    symbol: candidate.symbol ?? candidate.market,
  };
  const vetoCheck = checkGlobalVeto(resolvedCandidate);
  const risk = patternRiskStats({ tags: resolvedCandidate.tags ?? [] });

  if (vetoCheck.vetoed) {
    return {
      verdict: "VETOED",
      vetoed: true,
      vetoRule: vetoCheck.rule,
      patternRisk: risk,
      suggestedPenalty: 0,
      reasons: [vetoCheck.reason],
    };
  }

  let verdict: GovernanceVerdict = "CLEAR";
  let suggestedPenalty = 0;
  const reasons = [vetoCheck.reason];

  if (risk.riskLevel === "SEVERE") {
    verdict = "ELEVATED_RISK";
    suggestedPenalty = 12;
  } else if (risk.riskLevel === "ELEVATED") {
    verdict = "ELEVATED_RISK";
    suggestedPenalty = 7;
  } else if (risk.riskLevel === "WATCH") {
    verdict = "WATCH";
    suggestedPenalty = 3;
  }
  if (risk.n > 0) reasons.push(risk.note);

  return {
    verdict,
    vetoed: false,
    vetoRule: null,
    patternRisk: risk,
    suggestedPenalty,
    reasons,
  };
}
