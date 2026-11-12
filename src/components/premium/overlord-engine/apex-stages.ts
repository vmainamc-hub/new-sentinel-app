// APEX SENTINEL STAGES for one market and one Over / Under contract: engine agreement, instability ("rogue market"),
// danger clearance, fluctuation, and the staged verdict (Stage 1 direction, Stage 2a danger). Stage 2 setup is not used: it is multiplied by how much
// paper-trade history exists, which a one-shot scan does not have, so it would read near zero for every contract.
//
// These are the same engines Apex Sentinel's scan ranks with (ported under ./apex), run once on the deep history that was
// just fetched. The engines that read Apex's live paper-trade ledger (simulator, entry-condition lab, market profiles,
// combination learning) are not here: a one-shot scan has no ledger, so they are given null, exactly as Apex does for a
// contract it has not traded yet.
import { type EngineAgreement, engineAgreement } from './apex/agreement';
import { assessClearance, type ClearanceReport } from './apex/clearance';
import { personalityEngine } from './apex/engines';
import { type FluctuationReport, newFluctuationTracker } from './apex/fluctuation';
import type { MarketIntel } from './apex/intel';
import { composeDanger, type DangerComposition } from './apex/stage-danger';
import { computeDirection, type DirectionReport } from './apex/stage-direction';
import type { ContractEval } from './apex/types';
import { type ApexMarket, type ApexRead, buildApexMarket, readApexContract } from './apex-read';
import type { OuSide } from './legacy';

/** Apex Sentinel's scan defaults (scan.ts DEFAULT_SCAN_OPTIONS / assessClearance call). */
const MAX_DANGER = 65;
const MAX_LOSING_THREAT = 82;

/** The eight contracts Overlord can trade; the intel object holds all of them, as Apex's market intel does. */
const CONTRACTS: readonly { side: OuSide; barrier: number }[] = [
    { side: 'OVER', barrier: 1 },
    { side: 'OVER', barrier: 2 },
    { side: 'OVER', barrier: 3 },
    { side: 'OVER', barrier: 4 },
    { side: 'UNDER', barrier: 5 },
    { side: 'UNDER', barrier: 6 },
    { side: 'UNDER', barrier: 7 },
    { side: 'UNDER', barrier: 8 },
];

const key = (side: OuSide, barrier: number) => `${side}${barrier}`;

/** Per-market cache: the eight contract evaluations (without the slow model ensemble) are reused by every contract. */
const evalCache = new WeakMap<ApexMarket, Map<string, ContractEval>>();

/** Same adjustments Apex's core applies after evaluating a contract: exposure and special-digit risk are attached. */
const withRisk = (read: ApexRead): ContractEval => {
    const e: ContractEval = { ...read.evaluation, exposure: read.exposure, specialRisk: read.special, danger: read.danger };
    if (read.exposure.state === 'SEVERE' || read.special.state === 'HOSTILE') {
        e.quality = Math.max(0, e.quality - 12);
        e.opportunity = Math.max(0, e.opportunity - 10);
    }
    return e;
};

const evalsFor = (market: ApexMarket): Map<string, ContractEval> => {
    let m = evalCache.get(market);
    if (!m) {
        m = new Map();
        for (const c of CONTRACTS) m.set(key(c.side, c.barrier), withRisk(readApexContract(market, c.side, c.barrier)));
        evalCache.set(market, m);
    }
    return m;
};

const intelFor = (symbol: string, market: ApexMarket, fluct: FluctuationReport | null): MarketIntel => {
    const contracts = [...evalsFor(market).values()].sort((a, b) => b.opportunity - a.opportunity);
    const best = contracts[0] ?? null;
    const n = market.digits.length;
    const danger = Math.round(
        Math.max(
            0,
            Math.min(
                100,
                market.anomaly.score * 0.3 +
                    (market.volatility.ratio > 1 ? (market.volatility.ratio - 1) * 50 : 0) +
                    (best?.threat ? best.threat.groupThreat * 0.2 : 0) +
                    (best?.exposure ? best.exposure.losingDigitExposure * 0.25 : 0) +
                    (fluct ? fluct.score * 0.18 : 0)
            )
        )
    );
    return {
        symbol,
        name: symbol,
        dataState: 'OK',
        ticks: n,
        lastTickAt: 0,
        ageMs: 0,
        stats: market.stats,
        pressure: market.pressure,
        transition: market.transition,
        sequence: null,
        entropy: market.entropy,
        anomaly: market.anomaly,
        volatility: market.volatility,
        trend: market.trend,
        regime: market.regime,
        personality: personalityEngine(market.digits as number[]),
        buildup: market.buildup,
        quality: market.quality,
        danger,
        contracts,
        best,
        updatedAt: 0,
        digitIntel: market.digitIntel,
        bars: market.bars,
        criticalReport: market.criticalReport,
        battle: null,
        deepTicks: n,
        psychology: market.psychology,
        specialDigits: null,
        fluctuation: fluct,
    };
};

export type ApexStages = {
    agreement: EngineAgreement;
    clearance: ClearanceReport;
    direction: DirectionReport;
    danger: DangerComposition;
    fluctuation: FluctuationReport | null;
};

/** Cheap: everything here is arithmetic on the already-computed market and contract evaluations. */
export const readApexStages = (
    symbol: string,
    market: ApexMarket,
    side: OuSide,
    barrier: number,
    fluct: FluctuationReport | null = null
): ApexStages | null => {
    const c = evalsFor(market).get(key(side, barrier));
    if (!c) return null;
    const intel = intelFor(symbol, market, fluct);
    const clearance = assessClearance({
        intel,
        contract: c,
        recent: null,
        lifetime: null,
        maxDanger: MAX_DANGER,
        maxLosingThreat: MAX_LOSING_THREAT,
    });
    const direction = computeDirection(intel, c);
    const danger = composeDanger({ intel, contract: c, lifetime: null, recent: null });
    return { agreement: engineAgreement(c), clearance, direction, danger, fluctuation: fluct };
};

/**
 * Apex's fluctuation engine watches the leading contract over ~90 consecutive observations. A one-shot scan has no
 * observations, so the last ~90 ticks are replayed: the market is re-read at 18 points five ticks apart and each
 * reading is fed to a fresh tracker. Slow (18 market reads), so the engine runs it for the leading markets only.
 */
export const REPLAY_POINTS = 18;
export const REPLAY_GAP = 5;
export const replayFluctuation = (prices: readonly number[], digits: readonly number[]): FluctuationReport | null => {
    const tracker = newFluctuationTracker();
    const n = digits.length;
    for (let i = 0; i < REPLAY_POINTS; i += 1) {
        const end = n - (REPLAY_POINTS - 1 - i) * REPLAY_GAP;
        const m = buildApexMarket(prices.slice(0, end), digits.slice(0, end));
        if (!m) continue;
        const ranked = CONTRACTS.map(c => withRisk(readApexContract(m, c.side, c.barrier))).sort(
            (a, b) => b.opportunity - a.opportunity
        );
        const best = ranked[0];
        tracker.observe('replay', {
            leader: best.id,
            edge: Math.round(best.compositeEdge * 10) / 10,
            confidence: Math.round(best.confidence),
            psychologyAligned: m.psychology.over.aligned || m.psychology.under.aligned,
            rank: 0,
        });
    }
    const report = tracker.report('replay');
    return report.n >= 6 ? report : null;
};
