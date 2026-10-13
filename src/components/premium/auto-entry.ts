// Dynamic entry rules for the Auto Trader. Pure and framework-free.
//
// What this does and does NOT do: if the digits are random, none of these rules changes the probability that the digit settling
// a contract is a winner. They change WHEN the auto trader buys, HOW OFTEN it buys, and therefore how much it risks in bad spells.
//
//   1. Adaptive strictness   the number of confirming ticks grows or shrinks with the signal's strength, the market's danger
//                            reading and the session's losing streak.
//   2. Time-based window     how long a fired signal may wait for its entry depends on its score and its remaining life.
//   3. Risk-aware entry      after a loss the rule is stricter; after several losses in a row the auto trader rests (see
//                            `lossPauseAfter` / `lossPauseSec` in auto-trader.ts); after a win it goes back to the normal rule.
//   4. Digit pressure        optional: skip the entry while the digits that would lose the contract are over-represented in
//                            the last few dozen ticks. Small effect: a short window is mostly noise.
//   5. Danger ceiling        skip signals while the engine's danger reading is too high.
//
// In recovery every measurement uses the barrier of the contract that will actually be traded (the recovery digit): after losing
// on Over 1 and switching to Over 3, a tick is "O" only if it is above 3, and a 3 is neither O nor U.

import type { OverUnderContract, Recommendation } from './over-under-engine';

export type EntryMode = 'FIXED' | 'DYNAMIC';

/** Bounds the adaptive tick requirement can move within. */
export const DYNAMIC_TICKS = { min: 2, max: 6 } as const;
/** A signal that cannot wait at least this long for its entry is skipped instead of traded late. */
export const MIN_ENTRY_WINDOW_SEC = 5;
/** Digit pressure looks at this many latest ticks... */
export const PRESSURE_WINDOW = 40;
/** ...and refuses the entry when the losing digits exceed their expected share by more than this factor. */
export const PRESSURE_TOLERANCE = 1.35;

export type EntryRule = {
    mode: EntryMode;
    /** How many of the latest ticks must all show the traded side. 0 = no entry filter. */
    ticks: number;
    /** How long the signal may wait for that entry before it is skipped. */
    windowSec: number;
    /** The configured base values the rule started from. */
    baseTicks: number;
    baseWaitSec: number;
    /** Plain-English list of what moved the numbers (empty for the plain rule). */
    reasons: string[];
};

const clampInt = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/**
 * The number of confirming ticks for a signal. DYNAMIC: starts from the base and moves with the signal and the session.
 * Never below 2 or above 6 when dynamic, and 0 (filter off) stays 0.
 */
export const requiredTicks = (baseTicks: number, rec: Recommendation, lossStreak: number): { ticks: number; reasons: string[] } => {
    if (baseTicks <= 0) return { ticks: 0, reasons: [] };
    let ticks = baseTicks;
    const reasons: string[] = [];
    if (rec.score >= 85 && rec.danger <= 25) { ticks -= 1; reasons.push('strong, calm signal -1'); }
    if (rec.danger >= 70) { ticks += 2; reasons.push(`high danger (${Math.round(rec.danger)}) +2`); }
    else if (rec.danger >= 50) { ticks += 1; reasons.push(`raised danger (${Math.round(rec.danger)}) +1`); }
    if (lossStreak >= 2) { ticks += 2; reasons.push(`${lossStreak} losses in a row +2`); }
    else if (lossStreak === 1) { ticks += 1; reasons.push('after a loss +1'); }
    return { ticks: clampInt(ticks, DYNAMIC_TICKS.min, DYNAMIC_TICKS.max), reasons };
};

/**
 * How long a fired signal may wait for its entry. A strong, fresh signal gets longer; a weak one shorter. The window never
 * extends past the signal's own remaining life (a locked signal has no expiry). Returns 0 when the signal has too little life
 * left to be worth entering.
 */
export const entryWindowSec = (baseWaitSec: number, rec: Recommendation, now: number): { sec: number; reasons: string[] } => {
    const reasons: string[] = [];
    let sec = baseWaitSec;
    if (rec.score >= 85) { sec = baseWaitSec * 1.5; reasons.push('strong signal: longer window'); }
    else if (rec.score < 70) { sec = baseWaitSec * 0.6; reasons.push('weak signal: shorter window'); }
    sec = Math.round(sec);
    const lifeSec = Number.isFinite(rec.expiresAt) ? (rec.expiresAt - now) / 1000 - 2 : Infinity;
    if (lifeSec < sec) { sec = Math.floor(Math.max(0, lifeSec)); reasons.push(`limited by the signal's remaining life (${sec}s)`); }
    return { sec: sec < MIN_ENTRY_WINDOW_SEC ? 0 : sec, reasons };
};

/** The entry rule for a signal right now. `fixed` mode is exactly the configured numbers. */
export const entryRule = (
    config: { entryMode: EntryMode; entryTicks: number; entryWaitSec: number },
    rec: Recommendation,
    lossStreak: number,
    now: number,
): EntryRule => {
    const base = { baseTicks: config.entryTicks, baseWaitSec: config.entryWaitSec };
    if (config.entryMode !== 'DYNAMIC') return { mode: 'FIXED', ticks: config.entryTicks, windowSec: config.entryWaitSec, reasons: [], ...base };
    const ticks = requiredTicks(config.entryTicks, rec, lossStreak);
    const window = entryWindowSec(config.entryWaitSec, rec, now);
    return { mode: 'DYNAMIC', ticks: ticks.ticks, windowSec: window.sec, reasons: [...ticks.reasons, ...window.reasons], ...base };
};

/** Short text for the panel and the log, e.g. "need 4 ticks, 18s window (base 3: after a loss +1)". */
export const ruleText = (rule: EntryRule): string => {
    if (rule.ticks === 0) return 'no entry filter';
    const head = `need ${rule.ticks} tick${rule.ticks === 1 ? '' : 's'}, ${rule.windowSec}s window`;
    if (rule.mode === 'FIXED') return `${head} (fixed)`;
    return rule.reasons.length ? `${head} (base ${rule.baseTicks}: ${rule.reasons.join(', ')})` : `${head} (base ${rule.baseTicks})`;
};

// ---------------------------------------------------------------------------
// Digit pressure (option 4)
// ---------------------------------------------------------------------------

/** Share of digits that LOSE the contract if the digits were uniform. A digit equal to the barrier loses both Over and Under. */
export const expectedLosingShare = (contract: OverUnderContract, barrier: number): number =>
    contract === 'DIGITOVER' ? (barrier + 1) / 10 : (10 - barrier) / 10;

export type PressureReading = { observed: number; expected: number; ok: boolean; sample: number };

/**
 * Compares how often losing digits appeared in the last PRESSURE_WINDOW ticks with how often they should. Uses the barrier of
 * the contract being traded. Fewer than PRESSURE_WINDOW digits available means there is nothing to judge, so it passes.
 */
export const pressureReading = (digits: number[], contract: OverUnderContract, barrier: number): PressureReading => {
    const sample = digits.slice(-PRESSURE_WINDOW);
    const expected = expectedLosingShare(contract, barrier);
    if (sample.length < PRESSURE_WINDOW) return { observed: 0, expected, ok: true, sample: sample.length };
    const losing = sample.filter(digit => (contract === 'DIGITOVER' ? digit <= barrier : digit >= barrier)).length;
    const observed = losing / sample.length;
    return { observed, expected, ok: observed <= Math.min(1, expected * PRESSURE_TOLERANCE), sample: sample.length };
};

/** Signals are skipped while the engine reads the market as this dangerous. 0 turns the ceiling off. */
export const tooHostile = (rec: Recommendation, ceiling: number): boolean => ceiling > 0 && rec.danger >= ceiling;
