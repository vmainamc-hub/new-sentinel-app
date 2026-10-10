/**
 * RISK — PORTFOLIO EXPOSURE.
 *
 * Synthetic indices move in correlated families (all Volatility indices share
 * the same generator family, 1s variants share tick cadence). Taking several
 * "independent" positions inside one family is really one large position.
 * This engine caps combined exposure per correlation group and per portfolio.
 */

import type { OpportunityCandidate, PortfolioExposureReport } from "@/types/sentinel";

export const PORTFOLIO_CEILING = 60;
export const GROUP_CEILING = 25;

export interface HeldCandidate<T = any> {
  candidate: T;
  reason: string;
}

/** Map a market symbol to its correlation family. */
export function correlationGroup(market: string): string {
  const m = (market || "").toUpperCase();
  if (m.includes("1HZ")) return "VOLATILITY_1S";
  if (m.startsWith("R_")) return "VOLATILITY_STANDARD";
  if (m.includes("JD") || m.includes("JUMP")) return "JUMP";
  if (m.includes("BOOM") || m.includes("CRASH")) return "BOOM_CRASH";
  if (m.includes("STP") || m.includes("RANGE")) return "STEP_RANGE";
  return "OTHER";
}

function getCandidateKey(c: any): string {
  if (c.id) return String(c.id);
  const sym = c.symbol ?? c.market ?? "UNKNOWN";
  const contractId = typeof c.contract === "object" ? c.contract?.id : c.contract;
  return `${sym}:${contractId ?? "CONTRACT"}`;
}

function getCandidateMarket(c: any): string {
  return c.symbol ?? c.market ?? "";
}

function getCandidateScore(c: any): number {
  return c.score ?? c.opportunityScore ?? 0;
}

function getCandidateContractLabel(c: any): string {
  if (typeof c.contract === "object") {
    return c.contract?.label ?? c.contract?.id ?? "CONTRACT";
  }
  return String(c.contract ?? "CONTRACT");
}

/**
 * Validates whether a candidate is genuinely eligible/proposed for execution.
 * Non-executable candidates (WAIT, BLOCKED, HELD, NOT_READY, zero-stake) must
 * never contribute phantom exposure to group or portfolio totals.
 */
export function isCandidateEligibleForExposure(c: any): boolean {
  if (!c) return false;

  // If Stage 4 decision is present, only CLEARED candidates propose exposure
  if (c.finalDecision) {
    if (c.finalDecision.verdict !== "CLEARED") return false;
  }

  // Check Stage 3 entry clearance
  if (c.entryClearance && c.entryClearance.verdict !== "CLEARED") return false;

  // Check hard block states
  if (c.blocked === true || c.clearance?.state === "BLOCKED") return false;

  // Check legacy OpportunityCandidate signalState if present
  if (c.signalState && c.signalState !== "STRONG" && c.signalState !== "VALID" && c.signalState !== "EXECUTION_READY") {
    if (!c.finalDecision) return false;
  }

  const stake = c.recommendedStake?.drawdownAdjustedStake ?? 0;
  return stake > 0;
}

export class PortfolioExposureEngine {
  public static evaluateExposure<T = OpportunityCandidate>(
    candidates: T[],
    openPositions: { market: string; stake: number }[] = [],
  ): { report: PortfolioExposureReport; heldCandidates: HeldCandidate<T>[] } {
    const groups = new Map<
      string,
      { combined: number; members: string[]; candidates: T[] }
    >();

    const bump = (market: string, stake: number, member: string, cand?: T) => {
      const g = correlationGroup(market);
      const entry = groups.get(g) ?? { combined: 0, members: [], candidates: [] };
      entry.combined += stake;
      entry.members.push(member);
      if (cand) entry.candidates.push(cand);
      groups.set(g, entry);
    };

    for (const p of openPositions) bump(p.market, p.stake, `open:${p.market}`);

    // ONLY genuinely eligible/proposed candidates contribute to exposure totals
    for (const c of candidates as any[]) {
      if (!isCandidateEligibleForExposure(c)) continue;
      const stake = c.recommendedStake?.drawdownAdjustedStake ?? 0;
      const market = getCandidateMarket(c);
      const label = getCandidateContractLabel(c);
      bump(market, stake, `${market} ${label}`, c);
    }

    const heldCandidates: HeldCandidate<T>[] = [];
    const byCorrelationGroup = [...groups.entries()].map(([group, e]) => {
      const breached = e.combined > GROUP_CEILING;
      if (breached) {
        // Hold the weakest candidates in the group until the group fits.
        const ordered = [...e.candidates].sort((a, b) => getCandidateScore(a) - getCandidateScore(b));
        let running = e.combined;
        for (const cand of ordered) {
          if (running <= GROUP_CEILING) break;
          const stake = (cand as any).recommendedStake?.drawdownAdjustedStake ?? 0;
          running -= stake;
          heldCandidates.push({
            candidate: cand,
            reason: `Correlation group ${group} at $${e.combined.toFixed(2)} exceeds the $${GROUP_CEILING.toFixed(2)} ceiling; lowest-scoring member held.`,
          });
        }
      }
      return {
        group,
        combinedExposure: Math.round(e.combined * 100) / 100,
        ceiling: GROUP_CEILING,
        breached,
        members: e.members,
      };
    });

    const totalProposedExposure =
      Math.round(byCorrelationGroup.reduce((s, g) => s + g.combinedExposure, 0) * 100) / 100;

    const anyBreached = byCorrelationGroup.some((g) => g.breached);
    const recommendation: PortfolioExposureReport["recommendation"] =
      totalProposedExposure > PORTFOLIO_CEILING ? "BLOCK_NEW" : anyBreached ? "TRIM" : "OK";

    if (recommendation === "BLOCK_NEW") {
      for (const cand of candidates as any[]) {
        if (!isCandidateEligibleForExposure(cand)) continue;
        const key = getCandidateKey(cand);
        if (heldCandidates.some((h) => getCandidateKey(h.candidate) === key)) continue;
        heldCandidates.push({
          candidate: cand,
          reason: `Total proposed exposure $${totalProposedExposure.toFixed(2)} exceeds the $${PORTFOLIO_CEILING.toFixed(2)} portfolio ceiling.`,
        });
      }
    }

    return {
      report: {
        totalProposedExposure,
        byCorrelationGroup,
        recommendation,
        detail:
          recommendation === "OK"
            ? `Total exposure $${totalProposedExposure.toFixed(2)} across ${byCorrelationGroup.length} correlation group(s) is within all ceilings.`
            : recommendation === "TRIM"
              ? `Group ceiling breached in ${byCorrelationGroup.filter((g) => g.breached).map((g) => g.group).join(", ")}; weakest members held.`
              : `Portfolio ceiling breached at $${totalProposedExposure.toFixed(2)}; no new exposure accepted.`,
      },
      heldCandidates,
    };
  }
}
