/**
 * CANONICAL PROPOSITION SPECIFICATION — single source of truth.
 *
 * The unified Sentinel x DigitPulse engine reasons over exactly six
 * Over/Under propositions. Every engine family, adapter, cell, ranking and UI
 * surface must read its digit groups, thresholds, entry characteristics and
 * invalidation conditions from here. Parity (EVEN/ODD) is not part of this
 * application and has no representation in this module.
 */
import type { ApexContractId } from "@/lib/apex/types";
import { APEX_CONTRACTS } from "@/lib/apex/types";
import { CONTRACT_SPECS } from "@/lib/constants";
import type { ContractType } from "@/types/sentinel";

/** The canonical proposition universe. Never extended at runtime. */
export type Proposition = ApexContractId;

export const PROPOSITIONS: readonly Proposition[] = [
  "OVER1",
  "OVER2",
  "OVER3",
  "UNDER8",
  "UNDER7",
  "UNDER6",
] as const;

/** Display order preferred by the operator surface (primary profiles first). */
export const PROPOSITION_SCAN_ORDER: readonly Proposition[] = APEX_CONTRACTS;

export type PropositionSide = "OVER" | "UNDER";

export interface PropositionSpec {
  id: Proposition;
  /** Legacy `OVER_2` style identifier used by the Sentinel contract specs. */
  contractType: ContractType;
  label: string;
  side: PropositionSide;
  /** Barrier digit the proposition is quoted against. */
  threshold: number;
  winningDigits: number[];
  losingDigits: number[];
  /** Digits immediately adjacent to the barrier on either side. */
  boundaryDigits: number[];
  /** Losing digits whose concentration most often invalidates the proposition. */
  dangerDigits: number[];
  theoreticalProbability: number;
  /** True for the operator's preferred risk profiles (Over 2 / Under 7). */
  primaryPreference: boolean;
  /** What a healthy entry looks like for this proposition. */
  entryCharacteristics: string[];
  /** Conditions that invalidate a developing opportunity on this proposition. */
  invalidationConditions: string[];
}

export function toContractType(p: Proposition): ContractType {
  return (p.startsWith("OVER") ? `OVER_${p.slice(4)}` : `UNDER_${p.slice(5)}`) as ContractType;
}

export function fromContractType(c: ContractType): Proposition {
  return c.replace("_", "") as Proposition;
}

export function propositionSide(p: Proposition): PropositionSide {
  return p.startsWith("OVER") ? "OVER" : "UNDER";
}

const ALL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function boundaryDigits(threshold: number, side: PropositionSide): number[] {
  return side === "OVER"
    ? ALL_DIGITS.filter((d) => d === threshold || d === threshold + 1)
    : ALL_DIGITS.filter((d) => d === threshold || d === threshold - 1);
}

function entryCharacteristics(side: PropositionSide, spec: PropositionSpecSeed): string[] {
  const opposing = spec.losingDigits.join("/");
  return [
    `Winning side ${spec.winningDigits[0]}-${spec.winningDigits[spec.winningDigits.length - 1]} carrying observed momentum`,
    `Losing digits ${opposing} exhausted or absorbed rather than freshly expanding`,
    `Structural ${side === "OVER" ? "upward" : "downward"} digit migration confirmed across the 15/30/60/120 pressure windows`,
    "Regime stable or transitioning in the proposition's favour, with no hard veto standing",
    "Observed liquidity sweep of the opposing side already released, not still building",
  ];
}

function invalidationConditions(spec: PropositionSpecSeed): string[] {
  return [
    `Fresh concentration or run building on the losing digits ${spec.losingDigits.join("/")}`,
    `Boundary digits ${spec.boundaryDigits.join("/")} attacking the barrier repeatedly`,
    "Regime shift or entropy shock removing the structural basis of the read",
    "Engine families moving into conflict (Sentinel and DigitPulse disagreeing on side)",
    "Feed becoming stale, disconnected or falling below the minimum observation sample",
    "Evidence decaying without confirmation ticks before the execution window opens",
  ];
}

interface PropositionSpecSeed {
  winningDigits: number[];
  losingDigits: number[];
  boundaryDigits: number[];
}

function build(p: Proposition): PropositionSpec {
  const contractType = toContractType(p);
  const base = CONTRACT_SPECS[contractType];
  const side = propositionSide(p);
  const winningDigits = base.winningDigits.map(Number);
  const losingDigits = base.losingDigits.map(Number);
  const seed: PropositionSpecSeed = {
    winningDigits,
    losingDigits,
    boundaryDigits: boundaryDigits(base.barrier, side),
  };
  return {
    id: p,
    contractType,
    label: base.label,
    side,
    threshold: base.barrier,
    winningDigits,
    losingDigits,
    boundaryDigits: seed.boundaryDigits,
    // The digits nearest the barrier on the losing side do the most damage.
    dangerDigits: side === "OVER" ? losingDigits.slice(-2) : losingDigits.slice(0, 2),
    theoreticalProbability: base.theoreticalProbability,
    primaryPreference: base.isPrimaryPreference,
    entryCharacteristics: entryCharacteristics(side, seed),
    invalidationConditions: invalidationConditions(seed),
  };
}

export const PROPOSITION_SPECS: Record<Proposition, PropositionSpec> = {
  OVER1: build("OVER1"),
  OVER2: build("OVER2"),
  OVER3: build("OVER3"),
  UNDER8: build("UNDER8"),
  UNDER7: build("UNDER7"),
  UNDER6: build("UNDER6"),
};

export function propositionSpec(p: Proposition): PropositionSpec {
  return PROPOSITION_SPECS[p];
}

export function isProposition(value: unknown): value is Proposition {
  return typeof value === "string" && (PROPOSITIONS as readonly string[]).includes(value);
}

/** `R_75::OVER_2` style human label; cell identity itself stays `market:PROP`. */
export function propositionLabel(market: string, p: Proposition): string {
  return `${market} · ${PROPOSITION_SPECS[p].label}`;
}
