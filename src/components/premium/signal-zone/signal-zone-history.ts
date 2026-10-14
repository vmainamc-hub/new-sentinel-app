// SIGNAL ZONE: a small local log of every loaded signal and how its run ended, so the user can compare merge modes with their own
// results. Pure functions plus guarded localStorage. It draws no conclusion; it only counts.
import type { ZoneCandidate, ZoneSource } from './signal-zone-merge';
import type { MergeMode } from './signal-zone-settings';

export type HistoryEntry = {
    id: string;
    at: number;
    symbol: string;
    market: string;
    label: string;
    entryDigit: number | null;
    /** Whether the digit came from Sentinel AI or the default digits. */
    entrySource?: 'engine' | 'default';
    source: ZoneSource;
    mode: MergeMode;
    sentinelScore: number | null;
    fusionScore: number | null;
    /** Profit/loss of the run that followed the load; null until that run ends. */
    pnl: number | null;
    stoppedBy: string | null;
    finished: boolean;
};

export const HISTORY_KEY = 'signalzone.history.v1';
export const MAX_HISTORY = 100;

export const entryFor = (candidate: ZoneCandidate, mode: MergeMode, at: number): HistoryEntry => ({
    id: `${candidate.id}#${at}`,
    at,
    symbol: candidate.symbol,
    market: candidate.market,
    label: candidate.label,
    entryDigit: candidate.entryDigit,
    entrySource: candidate.entrySource,
    source: candidate.source,
    mode,
    sentinelScore: candidate.sentinel ? Math.round(candidate.sentinel.score) : null,
    fusionScore: candidate.fusion ? Math.round(candidate.fusion.score) : null,
    pnl: null,
    stoppedBy: null,
    finished: false,
});

/** Newest first, capped. */
export const addEntry = (list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] => [entry, ...list].slice(0, MAX_HISTORY);

/** A run ended: close the newest entry that is still open. A run with no open entry (a bot loaded some other way) is ignored. */
export const finishLatest = (list: HistoryEntry[], pnl: number, stoppedBy: string | null): HistoryEntry[] => {
    const index = list.findIndex(item => !item.finished);
    if (index < 0) return list;
    return list.map((item, i) => (i === index ? { ...item, pnl, stoppedBy, finished: true } : item));
};

export type HistoryGroup = { key: string; mode: MergeMode; source: ZoneSource; loads: number; finished: number; wins: number; net: number };

/** Counts finished runs by merge mode and by source. */
export const summarize = (list: HistoryEntry[]): HistoryGroup[] => {
    const groups = new Map<string, HistoryGroup>();
    for (const item of list) {
        const key = `${item.mode}|${item.source}`;
        const group = groups.get(key) ?? { key, mode: item.mode, source: item.source, loads: 0, finished: 0, wins: 0, net: 0 };
        group.loads += 1;
        if (item.finished && item.pnl !== null) {
            group.finished += 1;
            group.wins += item.pnl > 0 ? 1 : 0;
            group.net = Math.round((group.net + item.pnl) * 100) / 100;
        }
        groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key));
};

export const loadHistory = (): HistoryEntry[] => {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]');
        return Array.isArray(parsed) ? (parsed as HistoryEntry[]).slice(0, MAX_HISTORY) : [];
    } catch {
        return [];
    }
};

export const saveHistory = (list: HistoryEntry[]): void => {
    try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
    } catch {
        // Storage can be unavailable; the log then lives for this session only.
    }
};
