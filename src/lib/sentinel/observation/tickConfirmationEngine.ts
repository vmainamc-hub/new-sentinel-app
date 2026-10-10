import { THRESHOLDS } from "./constants";
import type { EngineEvidenceInput } from "./engineAdapter";
import type { ConfirmationRead, ConfirmationState } from "./types";

export type { ConfirmationRead, ConfirmationState };

/**
 * Evaluates whether a single tick/sample provides supportive evidence for the setup.
 * A tick is supporting if psychology is SUPPORTING, an entry digit is forming or validated
 * (not WAITING), and losing-side pressure is DECLINING or STABLE.
 */
export function isSupportingTick(input: EngineEvidenceInput): boolean {
  return (
    input.psychology.support === "SUPPORTING" &&
    input.entryDigit.state !== "WAITING" &&
    (input.losingSidePressure.state === "DECLINING" || input.losingSidePressure.state === "STABLE")
  );
}

/**
 * §7.5 — Independent Tick Confirmation Engine.
 *
 * Maintains a per-cell rolling window (ring buffer) of supporting evidence reads.
 * Unlike rigid sequential streaks that instantly reset to zero on a single noisy tick,
 * this engine computes a rolling ratio over a fixed window (e.g. 20 ticks) to evaluate
 * statistical confluence and noise-resistant maturity.
 */
export class TickConfirmationEngine {
  private readonly windowSize: number;
  private readonly minSamples: number;
  private readonly ratioConfirmed: number;
  private readonly ratioConfirming: number;
  private buffer: boolean[] = [];

  constructor(
    windowSize: number = THRESHOLDS.TICK_CONFIRMATION_WINDOW,
    minSamples: number = THRESHOLDS.TICK_CONFIRMATION_MIN_SAMPLES,
    ratioConfirmed: number = THRESHOLDS.TICK_CONFIRMATION_RATIO_CONFIRMED,
    ratioConfirming: number = THRESHOLDS.TICK_CONFIRMATION_RATIO_CONFIRMING,
  ) {
    this.windowSize = windowSize;
    this.minSamples = minSamples;
    this.ratioConfirmed = ratioConfirmed;
    this.ratioConfirming = ratioConfirming;
  }

  /**
   * Ingest a new engine evidence sample and return the updated confirmation read.
   */
  record(input: EngineEvidenceInput): ConfirmationRead {
    const supporting = isSupportingTick(input);
    this.buffer.push(supporting);
    if (this.buffer.length > this.windowSize) {
      this.buffer.shift();
    }
    return this.getRead();
  }

  /**
   * Directly record a boolean support observation (useful for unit tests and simulation).
   */
  recordBoolean(supporting: boolean): ConfirmationRead {
    this.buffer.push(supporting);
    if (this.buffer.length > this.windowSize) {
      this.buffer.shift();
    }
    return this.getRead();
  }

  /**
   * Get the current confirmation state and ratio.
   */
  getRead(): ConfirmationRead {
    const sampleSize = this.buffer.length;
    if (sampleSize === 0) {
      return {
        state: "INSUFFICIENT_SAMPLES",
        ratio: 0,
        sampleSize: 0,
        windowSize: this.windowSize,
      };
    }

    const supportingCount = this.buffer.filter(Boolean).length;
    const ratio = Math.round((supportingCount / sampleSize) * 1000) / 1000;

    let state: ConfirmationState = "INSUFFICIENT_SAMPLES";
    if (sampleSize < this.minSamples) {
      state = "INSUFFICIENT_SAMPLES";
    } else if (ratio >= this.ratioConfirmed) {
      state = "CONFIRMED";
    } else if (ratio >= this.ratioConfirming) {
      state = "CONFIRMING";
    } else {
      state = "BUILDING";
    }

    return {
      state,
      ratio,
      sampleSize,
      windowSize: this.windowSize,
    };
  }

  /**
   * Reset the buffer.
   */
  reset(): void {
    this.buffer = [];
  }

  /**
   * Hydrate or inspect the raw buffer.
   */
  hydrate(entries: boolean[]): void {
    this.buffer = entries.slice(-this.windowSize);
  }

  getRawBuffer(): readonly boolean[] {
    return this.buffer;
  }
}
