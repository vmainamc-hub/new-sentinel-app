// SIGNAL ZONE: builds a loadable candidate straight from the Sentinel AI pop-up's own signal. Pure (no React, no engine reads).
import { contractLabel, isAllowedContract } from '../over-under-engine';
import { keyOf, resolveEntry, type SentinelCandidate, type ZoneCandidate } from './signal-zone-merge';
import type { SignalZoneSettings } from './signal-zone-settings';

export type PopupSignal = {
    symbol: string; marketName?: string; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number; label?: string;
    entryDigit?: number | null; entryStatus?: string; entryWindow?: string; entryWinRate?: number | null; score?: number; danger?: number | null;
};

/**
 * The candidate for the signal ON the pop-up, built from that signal itself. It does not have to be found on the Signal Zone board:
 * the signal already surfaced in Sentinel AI, and re-matching it against a second scan was the reason Load kept failing.
 * The entry digit is Sentinel AI's own when validated, otherwise the Signal Zone default digit for the side.
 */
export const candidateFromSignal = (signal: PopupSignal, settings: SignalZoneSettings, now: number): { candidate: ZoneCandidate | null; reason: string | null } => {
    if (!isAllowedContract(signal.contractType, signal.barrier)) {
        return { candidate: null, reason: `${signal.contractType} ${signal.barrier} is not a contract the Masika bots trade.` };
    }
    const label = signal.label || contractLabel(signal.contractType, signal.barrier);
    const market = signal.marketName || signal.symbol;
    const sentinel: SentinelCandidate = {
        symbol: signal.symbol, market, contract: signal.contractType, barrier: signal.barrier, label,
        entryDigit: signal.entryDigit as number, entrySource: 'engine',
        entryStatus: signal.entryStatus ?? 'ARMED', entryWindow: signal.entryWindow ?? '', entryWinRate: signal.entryWinRate ?? null,
        score: signal.score ?? 0, danger: signal.danger ?? null, engineBlocked: false, momentumBlocked: false, receivedAt: now,
    };
    const entry = resolveEntry(sentinel, signal.contractType, settings);
    const key = keyOf(signal.symbol, signal.contractType, signal.barrier);
    return {
        candidate: {
            id: `${key}@${now}`, key, symbol: signal.symbol, market, contract: signal.contractType, barrier: signal.barrier, label,
            source: 'sentinel', sentinel, fusion: null, entryDigit: entry.digit, entrySource: entry.source,
            entryStatus: sentinel.entryStatus, entryWindow: sentinel.entryWindow, entryWinRate: sentinel.entryWinRate,
            rank: sentinel.score, danger: sentinel.danger, loadable: true, reason: null, entryNote: entry.note, createdAt: now,
        },
        reason: null,
    };
};
