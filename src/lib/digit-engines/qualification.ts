import type { Candidate, DigitContractType, EngineName, QuoteEconomics, ValidationReport } from "./types";
import { clamp, wilsonLowerBound } from "./stats";
export const MIN_VALIDATION_OBSERVATIONS = 100, VALIDATION_MARGIN = 0.002;
export function candidateKey(contractType: DigitContractType, barrier: string | null): string {
  return barrier === null ? contractType : contractType + ":" + barrier;
}
export interface CandidateDraft {
  engine: EngineName; symbol?: string; contractType: DigitContractType; barrier: string | null; label: string;
  candidateScore: number; estimatedWinProbability: number; empiricalWins: number; sampleSize: number; minSampleSize: number;
  quote?: QuoteEconomics; validation?: ValidationReport; strategyReasons: string[];
}
export function buildCandidate(d: CandidateDraft): Candidate {
  const reasons = [...d.strategyReasons], p = clamp(d.estimatedWinProbability, 0, 1), lower = wilsonLowerBound(d.empiricalWins, d.sampleSize);
  const q = d.quote, validQuote = Boolean(q && Number.isFinite(q.stake) && Number.isFinite(q.totalPayout) && q.stake > 0 && q.totalPayout > 0);
  const breakEven = validQuote ? q!.stake/q!.totalPayout : null, ev = validQuote ? p*q!.totalPayout-q!.stake : null;
  if (d.sampleSize < d.minSampleSize) reasons.push("Insufficient tick history for qualification.");
  if (!validQuote) reasons.push("A current Deriv proposal quote is required.");
  if (ev !== null && ev <= 0) reasons.push("Expected value is not positive at the quoted payout.");
  if (breakEven !== null && lower <= breakEven) reasons.push("The empirical lower confidence bound does not clear break-even.");
  const v = d.validation;
  const passed = Boolean(v && v.observations >= MIN_VALIDATION_OBSERVATIONS && Number.isFinite(v.modelBrier)
    && Number.isFinite(v.baselineBrier) && v.modelBrier + VALIDATION_MARGIN < v.baselineBrier);
  if (!passed) reasons.push("Walk-forward validation has not demonstrated improvement over baseline.");
  const qualified = d.sampleSize >= d.minSampleSize && validQuote && ev !== null && ev > 0 && breakEven !== null && lower > breakEven && passed;
  return { engine:d.engine, symbol:d.symbol, contractType:d.contractType, barrier:d.barrier, label:d.label,
    candidateScore:clamp(d.candidateScore), estimatedWinProbability:p, empiricalLowerBound:lower, sampleSize:d.sampleSize,
    breakEvenProbability:breakEven, expectedValuePerTrade:ev, qualification:qualified ? "QUALIFIED" : "UNQUALIFIED",
    canTrade:qualified, reasons:[...new Set(reasons)] };
}
export function sortCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a,b) => {
    if (a.candidateScore !== b.candidateScore) return b.candidateScore - a.candidateScore;
    if (a.qualification !== b.qualification) return a.qualification === "QUALIFIED" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}
/** Prequential ledger: forecasts must be recorded before their future outcomes are supplied. */
export class WalkForwardValidator {
  private pending = new Map<string, Array<{p:number; baseline:number}>>();
  private settled = new Map<string, Array<{p:number; baseline:number; outcome:number}>>();
  recordForecast(key:string, p:number, baseline:number):void {
    if (!Number.isFinite(p) || !Number.isFinite(baseline)) return;
    const rows=this.pending.get(key) ?? []; rows.push({p:clamp(p,0,1),baseline:clamp(baseline,0,1)}); this.pending.set(key,rows);
  }
  settleNext(key:string,outcome:boolean):boolean {
    const pending=this.pending.get(key); if (!pending?.length) return false;
    const forecast=pending.shift()!, rows=this.settled.get(key) ?? [];
    rows.push({...forecast,outcome:outcome?1:0}); this.settled.set(key,rows); return true;
  }
  report(key:string):ValidationReport {
    const rows=this.settled.get(key) ?? [];
    if (!rows.length) return {observations:0,modelBrier:1,baselineBrier:1};
    return {observations:rows.length,
      modelBrier:rows.reduce((s,r)=>s+(r.p-r.outcome)**2,0)/rows.length,
      baselineBrier:rows.reduce((s,r)=>s+(r.baseline-r.outcome)**2,0)/rows.length};
  }
  reset(key?:string):void { if(key){this.pending.delete(key);this.settled.delete(key);} else {this.pending.clear();this.settled.clear();} }
}
