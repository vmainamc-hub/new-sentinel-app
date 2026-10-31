// SENTINEL AI (unified): the engine overlay for the Sixfold runner. Pure apart from the injected `read`.
//
// Each scan, the Sentinel AI engine and Insight Fusion are read once. Every scanner cell then gets a verdict: vetoed when the engines
// do not back it (per mode) or Fusion stands down on it, an easier bar when both agree, an ordering bonus by combined score, and the
// engine's own validated entry digit to wait for. The scanner, Meter, loss shield and money rules are Sixfold's. Neither engine can
// create an edge on random digits: they describe recent behaviour, and the app says so.
import type { OverUnderContract } from '../over-under-engine';
import type { RunnerOverlay } from '../sixfold/overlay';
import type { SignalTier } from './producer';
import { contractsFor, type EngineSettings } from './settings';

/** What the Sentinel engine says about one contract, already through its quality gates. */
export type SentinelRead = {
    symbol: string;
    market: string;
    contract: OverUnderContract;
    barrier: number;
    label: string;
    score: number;
    danger: number | null;
    /** How sure the engine is (see producer.ts). */
    tier: SignalTier;
    entryDigit: number | null;
    /** True when Sentinel's entry digit is validated (ENTER NOW or ARMED). */
    entryUsable: boolean;
};
export type FusionRow = {
    symbol: string;
    market: string;
    contract: OverUnderContract;
    barrier: number;
    label: string;
    score: number;
};
export type Sources = { sentinel: SentinelRead[]; fusion: FusionRow[]; standDown: ReadonlySet<string> };

export type BoardRow = {
    key: string;
    symbol: string;
    market: string;
    contract: OverUnderContract;
    barrier: number;
    label: string;
    source: 'both' | 'sentinel' | 'fusion';
    score: number;
    tier: SignalTier | null;
    entryDigit: number | null;
};

export const keyOf = (symbol: string, contract: OverUnderContract, barrier: number) =>
    `${symbol}|${contract}|${barrier}`;
const sideOf = (side: string): OverUnderContract => (side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER');

/** The contracts the engines back right now, restricted to the propositions switched on. Best first. */
export const buildBoard = (src: Sources, engine: EngineSettings): BoardRow[] => {
    const on = new Set(engine.propositions);
    const allowed = (c: OverUnderContract, b: number) => on.has(`${c === 'DIGITOVER' ? 'OVER' : 'UNDER'}:${b}`);
    const rows = new Map<string, BoardRow>();
    const s = new Map(
        src.sentinel.filter(x => allowed(x.contract, x.barrier)).map(x => [keyOf(x.symbol, x.contract, x.barrier), x])
    );
    const f = new Map(
        src.fusion.filter(x => allowed(x.contract, x.barrier)).map(x => [keyOf(x.symbol, x.contract, x.barrier), x])
    );
    for (const key of new Set([...s.keys(), ...f.keys()])) {
        const a = s.get(key);
        const b = f.get(key);
        // Fusion actively standing down is a veto, except in Active mode where the scanner trades on its own judgement.
        if (engine.mode !== 'active' && src.standDown.has(key)) continue;
        if (engine.mode === 'careful' && !(a && b && a.tier !== 'leading')) continue;
        // Sentinel leads: Insight Fusion alone cannot start a trade unless Active mode is chosen. Fusion agreeing eases the bar,
        // Fusion standing down vetoes.
        if (engine.mode === 'balanced' && !a) continue;
        const base = (a ?? b)!;
        const scores = [a?.score, b?.score].filter((v): v is number => typeof v === 'number');
        rows.set(key, {
            key,
            symbol: base.symbol,
            market: base.market,
            contract: base.contract,
            barrier: base.barrier,
            label: base.label,
            source: a && b ? 'both' : a ? 'sentinel' : 'fusion',
            score: Math.round((scores.reduce((x, y) => x + y, 0) / Math.max(1, scores.length)) * 10) / 10,
            tier: a?.tier ?? null,
            entryDigit: a && a.entryUsable ? a.entryDigit : null,
        });
    }
    return [...rows.values()].sort(
        (x, y) => Number(y.source === 'both') - Number(x.source === 'both') || y.score - x.score
    );
};

export const createSentinelOverlay = (opts: {
    getEngine: () => EngineSettings;
    read: (engine: EngineSettings, now: number) => Sources;
    onBoard?: (rows: BoardRow[]) => void;
}): RunnerOverlay & { board: () => BoardRow[]; blocked: () => ReadonlySet<string> } => {
    let board: BoardRow[] = [];
    let standDown: ReadonlySet<string> = new Set();
    const index = new Map<string, BoardRow>();
    const find = (symbol: string, side: string, param: number) => index.get(keyOf(symbol, sideOf(side), param));

    return {
        moduleId: 'sentinel-ai',
        name: 'Sentinel AI',
        contracts: () => contractsFor(opts.getEngine()),
        refresh: now => {
            const engine = opts.getEngine();
            try {
                const src = opts.read(engine, now);
                standDown = src.standDown;
                board = buildBoard(src, engine);
            } catch {
                board = []; // an engine failure means no backing: engine-gated modes will not trade
                standDown = new Set();
            }
            index.clear();
            for (const row of board) index.set(row.key, row);
            opts.onBoard?.(board);
        },
        board: () => board,
        blocked: () => standDown,
        call: cell => {
            const mode = opts.getEngine().mode;
            const row = find(cell.symbol, cell.contract.side, cell.contract.param);
            if (!row) {
                if (mode !== 'active') {
                    const stood = standDown.has(keyOf(cell.symbol, sideOf(cell.contract.side), cell.contract.param));
                    return {
                        allow: false,
                        bump: 0,
                        rank: 0,
                        note: stood
                            ? 'Insight Fusion stands down'
                            : mode === 'careful'
                              ? 'both engines must back it'
                              : 'Sentinel AI does not back it',
                    };
                }
                return { allow: true, bump: 6, rank: 0, note: 'no engine backs it: higher bar' };
            }
            const both = row.source === 'both';
            // A weaker Sentinel tier asks for a higher bar: more signals never means lower standards for a trade.
            const tierBump = row.tier === 'confirmed' ? -6 : row.tier === 'building' ? 0 : row.tier === 'leading' ? 4 : 6;
            const tierText = row.tier ? `Sentinel ${row.tier}` : 'Insight Fusion alone';
            return {
                allow: true,
                bump: tierBump + (both ? -6 : 0),
                rank:
                    Math.min(10, row.score / 10) +
                    (both ? 3 : 0) +
                    (row.tier === 'confirmed' ? 2 : row.tier === 'building' ? 1 : 0),
                note: both ? `${tierText}, Fusion agrees` : tierText,
            };
        },
        entryDigits: cell => {
            const row = find(cell.symbol, cell.contract.side, cell.contract.param);
            return row && row.entryDigit !== null ? [row.entryDigit] : null;
        },
    };
};
