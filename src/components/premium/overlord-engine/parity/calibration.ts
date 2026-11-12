// §17 / §111 Confidence Calibration — Precision Parity side.
//
// Mirrors edge/calibration.ts but reads the parity journal.

import { listParityJournal, type ParityJournalEntry } from "./journal";

export interface ParityCalibrationResult {
  delta: number;
  sampleSize: number;
  hitRate: number;
  meanConfidence: number;
  narrative: string;
}

const MIN_SAMPLES = 15;
const CAP = 15;

export function parityCalibrationForMarket(
  market: string,
  entries: ParityJournalEntry[] = listParityJournal(),
): ParityCalibrationResult {
  const decided = entries.filter(
    (e) => e.market === market && (e.outcome === "win" || e.outcome === "loss"),
  );
  if (decided.length < MIN_SAMPLES) {
    return {
      delta: 0,
      sampleSize: decided.length,
      hitRate: 0,
      meanConfidence: 0,
      narrative: `Parity calibration inactive (${decided.length}/${MIN_SAMPLES}).`,
    };
  }
  const wins = decided.filter((e) => e.outcome === "win").length;
  const hit = wins / decided.length;
  const meanConf = decided.reduce((a, e) => a + e.pModel, 0) / decided.length;
  const gap = hit - meanConf;
  const delta = Math.max(-CAP, Math.min(CAP, gap * 40));
  const narrative =
    Math.abs(delta) < 1
      ? `Parity confidence well-calibrated on ${market}.`
      : delta > 0
        ? `Parity boost +${delta.toFixed(1)} (hit ${(hit * 100).toFixed(0)}% vs claim ${(meanConf * 100).toFixed(0)}%).`
        : `Parity dampen ${delta.toFixed(1)} (hit ${(hit * 100).toFixed(0)}% vs claim ${(meanConf * 100).toFixed(0)}%).`;
  return { delta, sampleSize: decided.length, hitRate: hit, meanConfidence: meanConf, narrative };
}

export function calibrateParityConfidence(
  claimedPct: number,
  market: string,
  entries?: ParityJournalEntry[],
): { calibrated: number; result: ParityCalibrationResult } {
  const result = parityCalibrationForMarket(market, entries);
  const calibrated = Math.max(0, Math.min(100, claimedPct + result.delta));
  return { calibrated, result };
}
