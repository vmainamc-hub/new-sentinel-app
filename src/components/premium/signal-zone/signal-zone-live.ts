// SIGNAL ZONE: live agreed signals. Pure and framework-free.
//
// Every few seconds the page hands this module the signals on which Sentinel AI and Insight Fusion currently AGREE (same market, same
// side, same barrier). A new agreement is pushed onto the list by itself, stays for a set lifetime, then disappears. An agreement that
// is still standing when its time runs out is not pushed again until the engines have stopped agreeing at least once, so the same signal
// does not keep re-appearing.

import { mergeCandidates, type FusionCandidate, type SentinelCandidate, type ZoneCandidate } from './signal-zone-merge';
import type { SignalZoneSettings } from './signal-zone-settings';

/** Most signals kept on screen at once. */
export const MAX_LIVE = 12;

export type LiveSignal = {
    key: string;
    /** The latest snapshot while the engines still agree; the last one seen once they stop. */
    candidate: ZoneCandidate;
    firstSeen: number;
    lastSeen: number;
    expiresAt: number;
    /** False once the engines stopped agreeing on it; it stays visible (greyed) until it expires, but cannot be loaded. */
    agreed: boolean;
};

export type LiveState = {
    signals: LiveSignal[];
    /** Keys that expired or were dismissed while the engines still agreed; they come back only after agreement breaks. */
    suppressed: string[];
};

export const EMPTY_LIVE: LiveState = { signals: [], suppressed: [] };

/** The loadable signals on which both engines agree right now, using the user's gates (score, danger, momentum, excluded markets). */
export const agreedNow = (
    sentinel: SentinelCandidate[], fusion: FusionCandidate[], settings: SignalZoneSettings, now: number,
): ZoneCandidate[] => mergeCandidates(sentinel, fusion, { ...settings, mergeMode: 'both' }, now).filter(item => item.source === 'both' && item.loadable);

/** What the Live list shows: Sentinel AI's own loadable signals in "Sentinel AI only" mode, otherwise the signals both engines agree on. */
export const liveNow = (
    sentinel: SentinelCandidate[], fusion: FusionCandidate[], settings: SignalZoneSettings, now: number,
): ZoneCandidate[] => settings.mergeMode === 'sentinel_only'
    ? mergeCandidates(sentinel, fusion, settings, now).filter(item => item.loadable)
    : agreedNow(sentinel, fusion, settings, now);

const order =(a: LiveSignal, b: LiveSignal) =>
    Number(b.agreed) - Number(a.agreed) || b.candidate.rank - a.candidate.rank || b.firstSeen - a.firstSeen || a.key.localeCompare(b.key);

/**
 * Moves the list forward to `now`. `agreed` is what both engines agree on at this moment.
 * Returns the new state and the signals that were pushed for the first time during this step.
 */
export const advanceLive = (
    state: LiveState, agreed: ZoneCandidate[], now: number, lifetimeMs: number,
): { state: LiveState; fresh: LiveSignal[] } => {
    const agreedByKey = new Map(agreed.map(item => [item.key, item] as const));
    // A suppressed key is released as soon as the engines stop agreeing on it.
    const suppressed = state.suppressed.filter(key => agreedByKey.has(key));

    let signals: LiveSignal[] = [];
    for (const signal of state.signals) {
        if (now >= signal.expiresAt) {
            if (agreedByKey.has(signal.key) && !suppressed.includes(signal.key)) suppressed.push(signal.key);
            continue;
        }
        const current = agreedByKey.get(signal.key);
        signals.push(current ? { ...signal, candidate: current, lastSeen: now, agreed: true } : { ...signal, agreed: false });
    }

    const fresh: LiveSignal[] = [];
    for (const item of agreed) {
        if (suppressed.includes(item.key) || signals.some(signal => signal.key === item.key)) continue;
        const signal: LiveSignal = { key: item.key, candidate: item, firstSeen: now, lastSeen: now, expiresAt: now + lifetimeMs, agreed: true };
        signals.push(signal);
        fresh.push(signal);
    }

    signals.sort(order);
    if (signals.length > MAX_LIVE) {
        for (const dropped of signals.slice(MAX_LIVE)) if (agreedByKey.has(dropped.key) && !suppressed.includes(dropped.key)) suppressed.push(dropped.key);
        signals = signals.slice(0, MAX_LIVE);
    }
    const kept = new Set(signals.map(signal => signal.key));
    return { state: { signals, suppressed }, fresh: fresh.filter(signal => kept.has(signal.key)) };
};

/** Removes a signal by hand. It does not come back until the engines have stopped agreeing on it. */
export const dismissLive = (state: LiveState, key: string): LiveState => ({
    signals: state.signals.filter(signal => signal.key !== key),
    suppressed: state.suppressed.includes(key) ? state.suppressed : [...state.suppressed, key],
});

export const secondsLeft = (signal: LiveSignal, now: number): number => Math.max(0, Math.ceil((signal.expiresAt - now) / 1000));
