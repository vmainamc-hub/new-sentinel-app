// SENTINEL AI (unified): the engine overlay for the Sixfold runner. Pure apart from the injected `read`.
//
// Each scan, the Sentinel AI engine and Insight Fusion are read once and merged (the Signal Zone merge, unchanged). The overlay then
// gives every scanner cell a verdict: vetoed when the engines do not back it (per mode), an easier bar when both agree, an ordering
// bonus by combined score, and the engine's own validated entry digit to wait for. The scanner, Meter, loss shield and money rules
// are Sixfold's. Neither engine can create an edge on random digits: they describe recent behaviour, and the app says so.
import { keyOf, mergeCandidates, type FusionCandidate, type SentinelCandidate, type ZoneCandidate } from '../signal-zone/signal-zone-merge';
import { normalizeSettings as normalizeZone, type MergeMode } from '../signal-zone/signal-zone-settings';
import type { RunnerOverlay } from '../sixfold/overlay';
import { contractsFor, type EngineSettings } from './settings';

export type Sources = { sentinel: SentinelCandidate[]; fusion: FusionCandidate[] };
export type OverlayView = { board: ZoneCandidate[]; at: number };

const zoneFor = (engine: EngineSettings, mergeMode: MergeMode) =>
    normalizeZone({ mergeMode, minScore: engine.minScore, maxDanger: engine.maxDanger, requireMomentum: engine.requireMomentum, skipBlocked: engine.skipBlocked });

/** The tradable board for a mode: only loadable candidates, restricted to the propositions switched on. */
export const buildBoard = (src: Sources, engine: EngineSettings, now: number): ZoneCandidate[] => {
    const on = new Set(engine.propositions);
    const keep = (c: ZoneCandidate) => c.loadable && on.has(`${c.contract === 'DIGITOVER' ? 'OVER' : 'UNDER'}:${c.barrier}`);
    const merged = (mode: MergeMode) => mergeCandidates(src.sentinel, src.fusion, zoneFor(engine, mode), now).filter(keep);
    if (engine.mode === 'careful') return merged('both');
    const byKey = new Map<string, ZoneCandidate>();
    for (const c of [...merged('fusion_leads'), ...merged('sentinel_only')]) {
        const prev = byKey.get(c.key);
        if (!prev || (c.source === 'both' && prev.source !== 'both') || (prev.entrySource === 'default' && c.entrySource === 'engine')) byKey.set(c.key, c);
    }
    return [...byKey.values()].sort((a, b) => Number(b.source === 'both') - Number(a.source === 'both') || b.rank - a.rank);
};

export const createSentinelOverlay = (opts: {
    getEngine: () => EngineSettings;
    read: (requireMomentum: boolean, now: number) => Sources;
    onBoard?: (view: OverlayView) => void;
}): RunnerOverlay & { board: () => ZoneCandidate[] } => {
    let board: ZoneCandidate[] = [];
    const index = new Map<string, ZoneCandidate>();
    const find = (symbol: string, side: string, param: number) => index.get(keyOf(symbol, side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER', param));

    return {
        moduleId: 'sentinel-ai',
        name: 'Sentinel AI',
        contracts: () => contractsFor(opts.getEngine()),
        refresh: now => {
            const engine = opts.getEngine();
            try {
                board = buildBoard(opts.read(engine.requireMomentum, now), engine, now);
            } catch {
                board = []; // an engine failure means no backing: the scanner will not trade on engine-gated modes
            }
            index.clear();
            for (const c of board) index.set(c.key, c);
            opts.onBoard?.({ board, at: now });
        },
        board: () => board,
        call: cell => {
            const mode = opts.getEngine().mode;
            const c = find(cell.symbol, cell.contract.side, cell.contract.param);
            if (!c) {
                return mode === 'active'
                    ? { allow: true, bump: 6, rank: 0, note: 'no engine backs it: higher bar' }
                    : { allow: false, bump: 0, rank: 0, note: mode === 'careful' ? 'both engines must back it' : 'neither engine backs it' };
            }
            const both = c.source === 'both';
            return {
                allow: true,
                bump: both ? -8 : 0,
                rank: Math.min(10, c.rank / 10) + (both ? 3 : 0),
                note: both ? 'both engines agree' : c.source === 'sentinel' ? 'Sentinel AI backs it' : 'Insight Fusion backs it',
            };
        },
        entryDigits: cell => {
            const c = find(cell.symbol, cell.contract.side, cell.contract.param);
            return c && c.entrySource === 'engine' && c.entryDigit !== null ? [c.entryDigit] : null;
        },
    };
};
