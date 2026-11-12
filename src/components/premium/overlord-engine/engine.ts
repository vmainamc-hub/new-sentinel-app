// OVERLORD OVER / UNDER ENGINE. Pure and framework-free: the backend that feeds Overlord's Find Market.
//
// One contract on one market is read through three groups of layers and combined into a single 0-100 score:
//
//   OVERLORD  the existing condition, unchanged: how often the contract's digits showed up in the last 50 ticks.
//   ORACLE    the Over / Under layers of Oracle (Pulse, Kalman, special digits 1/8, Sixfold pressure + meter + viability,
//             Apex Intel regime, Vanguard) exactly as Oracle computes them (hub360/oracle/over-under).
//   APEX      Apex Sentinel's engines ported from the Apex Sentinel tool: composite edge + fake-edge interrogation,
//             losing-digit threat, losing-digit exposure / burst risk, special-digit risk 0/1/8/9, statistics, walk-forward
//             models, digit psychology, ENGINE AGREEMENT, instability ("rogue market"), danger clearance, fluctuation and the
//             staged verdict (direction, composed danger). Not ported: the engines that need Apex's live paper-trade
//             ledger (simulator, entry-condition lab, market profiles, combination learning); a one-shot scan has none.
//
// Every layer returns ok / hard / required / 0-100 score / reason. A HARD layer that says no vetoes the contract:
//   STRONG   not vetoed and every required layer agrees.
//   BEST     not vetoed, the best-scoring contract available, but not every required layer agrees.
//   CAUTION  every contract on every market was vetoed; the least-bad one is returned and labelled, never hidden.
//   LEGACY   no market had enough history for the deeper engines: the original lowest-share rule decided.
//
// Honest limit: Deriv digits are random. A contract that has been winning is no more likely to win next, and every contract
// pays less than its fair odds. These engines rank how healthy a contract has been and avoid the moments the operator's tools
// flag as costly. They cannot create an edge, and no tier is a prediction.
import { OU_CONTRACTS, OU_MIN_TICKS, type OverUnderRead, readOverUnder } from '../hub360/oracle/over-under';
import type { Contract } from '../sixfold/bot';
import type { FluctuationReport } from './apex/fluctuation';
import { DEFAULT_REFINEMENT } from './apex/settings';
import {
    APEX_MIN_TICKS,
    apexEnsemble,
    type ApexMarket,
    type ApexRead,
    buildApexMarket,
    readApexContract,
} from './apex-read';
import { type ApexStages, readApexStages, replayFluctuation } from './apex-stages';
import { fairShare, legacyPercentage, type OuSide } from './legacy';

export type EngineName =
    | 'Overlord'
    | 'Oracle'
    | 'Sentinel AI'
    | 'Sixfold'
    | 'Apex Intel'
    | 'Vanguard'
    | 'Apex Sentinel';
export type OverlordTier = 'STRONG' | 'BEST' | 'CAUTION' | 'LEGACY';
export type ScanMode = 'selected' | 'smart';

export type OverlordLayer = {
    key: string;
    engine: EngineName;
    label: string;
    ok: boolean;
    /** When true and not ok, the contract is never signalled. */
    hard: boolean;
    /** Must be ok for a STRONG signal. */
    required: boolean;
    /** 0-100. */
    score: number;
    /** Share of the final score, after the three groups are balanced. */
    weight: number;
    detail: string;
};

export type ApexNotes = {
    agreement: string;
    instability: string;
    fluctuation: string;
    direction: string;
    psychology: string;
};

export type OverlordRead = {
    symbol: string;
    side: OuSide;
    barrier: number;
    label: string;
    layers: OverlordLayer[];
    /** 0-100, weighted across every layer that applies. */
    score: number;
    vetoed: boolean;
    vetoReason: string;
    tier: OverlordTier;
    /** Overlord's original number: share of the last 50 digits that would have won this contract. */
    legacyPct: number | null;
    /** True when the market had no deep history and only the original condition could be read. */
    thin: boolean;
    /** Ticks the deep engines read. */
    ticks: number;
    /** Short plain-language reasons for the card, best first. */
    reasons: string[];
    /** Number of layers that agree / that apply. */
    agree: number;
    applied: number;
    /** Apex Sentinel's agreement / stability / fluctuation / direction / psychology readings, in words. */
    apexNotes: ApexNotes | null;
};

export type MarketSeries = { prices: readonly number[]; digits: readonly number[] };

export type OverlordInput = {
    series: Readonly<Record<string, MarketSeries>>;
    symbols: readonly string[];
    side: OuSide;
    barrier: number;
    /** selected: rank markets for the contract chosen on screen. smart: rank every contract on every market. */
    mode?: ScanMode;
    /** How many top candidates also get the (slow) walk-forward model ensemble. */
    ensembleTop?: number;
    /** How many leading markets get the fluctuation replay (default 4, 0 = off). */
    fluctuationTop?: number;
};

export type OverlordScan = {
    reads: OverlordRead[];
    best: OverlordRead | null;
    /** True when the result came from the original rule alone. */
    legacyOnly: boolean;
    evaluated: number;
};

// Balance between the three groups of layers. Overlord's original condition is deliberately small: it is a market-share
// count over 50 ticks, and the deeper layers exist because that count on its own is noisy.
export const GROUP_SHARE = { overlord: 0.1, oracle: 0.5, apex: 0.4 } as const;

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export const contractLabel = (side: OuSide, barrier: number) => `${side === 'OVER' ? 'Over' : 'Under'} ${barrier}`;

/** A contract Deriv can actually sell: Over 0-8, Under 1-9. */
export const isTradableBarrier = (side: OuSide, barrier: number) =>
    Number.isInteger(barrier) && (side === 'OVER' ? barrier >= 0 && barrier <= 8 : barrier >= 1 && barrier <= 9);

// ---------------------------------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------------------------------

const legacyLayer = (digits: readonly number[], side: OuSide, barrier: number): OverlordLayer => {
    const share = legacyPercentage(digits, side, barrier);
    const fair = fairShare(side, barrier);
    const n = Math.min(50, digits.length);
    if (share === null || n === 0) {
        return {
            key: 'overlord',
            engine: 'Overlord',
            label: 'Overlord: lowest share in 50 ticks',
            ok: false,
            hard: false,
            required: false,
            score: 50,
            weight: 0,
            detail: 'no ticks',
        };
    }
    const se = Math.sqrt((fair * (1 - fair)) / n) * 100;
    const below = (fair * 100 - share) / (se || 1);
    return {
        key: 'overlord',
        engine: 'Overlord',
        label: 'Overlord: contract digits quiet in the last 50 ticks',
        ok: share <= fair * 100,
        hard: false,
        // Not required: it points the opposite way to Pulse (which wants the contract winning above fair), so it can lift
        // or lower a score but it can never alone block or grant a STRONG.
        required: false,
        score: clamp(50 + 12 * below),
        weight: 0,
        detail: `${share.toFixed(1)}% of the last ${n} ticks won (fair ${(fair * 100).toFixed(0)}%)`,
    };
};

const apexLayers = (read: ApexRead, market: ApexMarket, side: OuSide): OverlordLayer[] => {
    const e = read.evaluation;
    const s = DEFAULT_REFINEMENT;
    const out: OverlordLayer[] = [];
    const phaseVeto = e.phase === 'INVALIDATING';
    out.push({
        key: 'apexEdge',
        engine: 'Apex Sentinel',
        label: 'Apex: opportunity score clears the bar',
        ok: e.opportunity >= s.opportunityThreshold && !phaseVeto,
        hard: phaseVeto,
        required: true,
        score: clamp(e.opportunity),
        weight: 0.22,
        detail: phaseVeto
            ? `invalidated: ${e.alerts[0] ?? 'threat veto or fake-edge rejection'}`
            : `opportunity ${e.opportunity.toFixed(0)} (bar ${s.opportunityThreshold}), edge ${(e.edge * 100).toFixed(1)}pp over fair`,
    });
    out.push({
        key: 'apexDanger',
        engine: 'Apex Sentinel',
        label: 'Apex: danger is low',
        ok: read.danger < s.dangerThreshold,
        hard: false,
        required: true,
        score: clamp(100 - read.danger),
        weight: 0.2,
        detail: `danger ${read.danger} (limit ${s.dangerThreshold}), quality ${e.quality.toFixed(0)}`,
    });
    out.push({
        key: 'apexExposure',
        engine: 'Apex Sentinel',
        label: 'Apex: losing digits are not bursting',
        ok: read.exposure.state === 'LOW' || read.exposure.state === 'MODERATE',
        hard: read.exposure.state === 'SEVERE',
        required: true,
        score: clamp(100 - read.exposure.losingDigitExposure),
        weight: 0.16,
        detail: `exposure ${read.exposure.losingDigitExposure.toFixed(0)} (${read.exposure.state.toLowerCase()})${read.exposure.bursting.length ? `, bursting: ${read.exposure.bursting.join(', ')}` : ''}`,
    });
    out.push({
        key: 'apexSpecial',
        engine: 'Apex Sentinel',
        label: 'Apex: special digits 0 / 1 / 8 / 9 are calm',
        ok: read.special.state === 'CALM' || read.special.state === 'WATCH',
        hard: read.special.state === 'HOSTILE',
        required: true,
        score: clamp(100 - read.special.exposureRisk),
        weight: 0.1,
        detail: `${read.special.state.toLowerCase()}, risk on the losing side ${read.special.exposureRisk.toFixed(0)}`,
    });
    out.push({
        key: 'apexEvidence',
        engine: 'Apex Sentinel',
        label: 'Apex: the win rate holds up statistically',
        ok: e.edgeLB > 0,
        hard: false,
        required: false,
        score: clamp(50 + e.edgeLB * 1000),
        weight: 0.08,
        detail: `95% lower bound ${(e.edgeLB * 100).toFixed(1)}pp against fair, ${e.n} ticks${e.stats ? `, evidence ${String(e.stats.grade).toLowerCase().replace(/_/g, ' ')}` : ''}`,
    });
    const validated = read.ensemble?.validated ?? 0;
    out.push({
        key: 'apexModels',
        engine: 'Apex Sentinel',
        label: 'Apex: a model beats its base rate out of sample',
        ok: validated > 0,
        hard: false,
        required: false,
        score: read.ensemble ? clamp(read.ensemble.validated > 0 ? 50 + read.ensemble.signal * 400 : 35) : 50,
        weight: 0.06,
        detail: read.ensemble
            ? validated > 0
                ? `${validated} model(s) validated, agreement ${read.ensemble.agreement.toFixed(0)}`
                : 'no model validated out of sample'
            : 'not run for this contract',
    });
    const pattern = side === 'OVER' ? market.psychology.over : market.psychology.under;
    out.push({
        key: 'apexPsychology',
        engine: 'Apex Sentinel',
        label: `Apex: ${side === 'OVER' ? 'Over' : 'Under'} digit configuration is formed`,
        ok: pattern.aligned,
        hard: false,
        required: false,
        score: clamp(
            pattern.score * (0.4 + 0.6 * (pattern.confidence / 100)) + (market.psychology.dominant === side ? 10 : 0)
        ),
        weight: 0.08,
        detail: `${pattern.score.toFixed(0)}/100 formed, confidence ${pattern.confidence.toFixed(0)}`,
    });
    out.push({
        key: 'apexRegime',
        engine: 'Apex Sentinel',
        label: 'Apex: regime supports the contract',
        ok: e.regimeCompatible,
        hard: false,
        required: false,
        score: e.regimeCompatible ? 80 : 30,
        weight: 0.1,
        detail: e.regimeNote,
    });
    return out;
};

/** Apex Sentinel's staged engines: engine agreement, instability, clearance, fluctuation, direction, danger. */
const stageLayers = (st: ApexStages | null): OverlordLayer[] => {
    if (!st) return [];
    const L = (l: Omit<OverlordLayer, 'engine'>): OverlordLayer => ({ engine: 'Apex Sentinel', ...l });
    const out: OverlordLayer[] = [];
    const ag = st.agreement;
    out.push(
        L({
            key: 'apexAgreement',
            label: 'Apex: the engines agree with each other',
            ok: ag === 'SUPPORT' || ag === 'NEUTRAL',
            hard: ag === 'STRONG CONFLICT',
            required: true,
            score: ag === 'SUPPORT' ? 88 : ag === 'NEUTRAL' ? 60 : ag === 'CONFLICT' ? 28 : 4,
            weight: 0.1,
            detail: `engine agreement ${ag}`,
        })
    );
    const inst = st.clearance.instability;
    out.push(
        L({
            key: 'apexStability',
            label: 'Apex: market is not unstable',
            ok: inst.label === 'CALM' || inst.label === 'NORMAL',
            hard: inst.label === 'ROGUE',
            required: false,
            score: clamp(100 - inst.score),
            weight: 0.08,
            detail: `${inst.label.toLowerCase()} (${inst.score}/100)${inst.drivers[0] ? `, ${inst.drivers[0]}` : ''}`,
        })
    );
    const blocked = st.clearance.state === 'BLOCKED';
    out.push(
        L({
            key: 'apexClearance',
            label: 'Apex: danger clearance',
            ok: !blocked && st.clearance.state !== 'UNSTABLE',
            hard: blocked,
            required: false,
            score: clamp(100 - st.clearance.risk),
            weight: 0.06,
            detail: st.clearance.blockers[0]?.text ?? st.clearance.cautions[0]?.text ?? `risk ${st.clearance.risk}/100`,
        })
    );
    const dir = st.direction;
    out.push(
        L({
            key: 'apexDirection',
            label: 'Apex: staged direction score',
            ok: dir.label === 'STRONG' || dir.label === 'MODERATE',
            hard: false,
            required: false,
            score: clamp(dir.score),
            weight: 0.1,
            detail: `${dir.label.toLowerCase()} ${dir.score.toFixed(0)}/100, ${dir.disagreement.toFixed(0)}% disagreement`,
        })
    );
    const autoBlock = st.danger.autoBlock[0];
    out.push(
        L({
            key: 'apexStageDanger',
            label: 'Apex: composed danger is acceptable',
            ok: !autoBlock && (st.danger.level === 'LOW' || st.danger.level === 'MILD' || st.danger.level === 'MODERATE'),
            hard: !!autoBlock,
            required: false,
            score: clamp(100 - st.danger.total),
            weight: 0.08,
            detail: autoBlock ? autoBlock.detail : `${st.danger.level.toLowerCase()} danger ${st.danger.total.toFixed(0)}/100`,
        })
    );
    if (st.fluctuation) {
        const f = st.fluctuation;
        out.push(
            L({
                key: 'apexFluctuation',
                label: 'Apex: evidence holds still',
                ok: f.state === 'CALM' || f.state === 'SETTLED',
                hard: false,
                required: false,
                score: clamp(100 - f.score),
                weight: 0.05,
                detail: `${f.state.toLowerCase()} ${f.score.toFixed(0)}/100, flicker ${(f.signalFlickerRate * 100).toFixed(0)}%`,
            })
        );
    }
    return out;
};

/** Rescales each group so the Overlord / Oracle / Apex shares hold whichever groups were available. */
const balance = (groups: { share: number; layers: OverlordLayer[] }[]): OverlordLayer[] => {
    const present = groups.filter(g => g.layers.length > 0);
    const shareSum = present.reduce((t, g) => t + g.share, 0) || 1;
    const out: OverlordLayer[] = [];
    for (const g of present) {
        const inner = g.layers.reduce((t, l) => t + l.weight, 0);
        for (const l of g.layers) {
            out.push({
                ...l,
                weight: inner > 0 ? (g.share / shareSum) * (l.weight / inner) : g.share / shareSum / g.layers.length,
            });
        }
    }
    return out;
};

const oracleLayers = (read: OverUnderRead): OverlordLayer[] =>
    read.layers.map(l => ({
        key: l.key,
        engine: l.engine,
        label: l.label,
        ok: l.ok,
        hard: l.hard,
        required: l.required,
        score: l.score,
        weight: l.weight,
        detail: l.detail,
    }));

// ---------------------------------------------------------------------------------------------------------------------
// One contract on one market
// ---------------------------------------------------------------------------------------------------------------------

export function assessContract(
    symbol: string,
    series: MarketSeries,
    side: OuSide,
    barrier: number,
    market: ApexMarket | null,
    withEnsemble = false,
    fluct: FluctuationReport | null = null
): OverlordRead {
    const digits = series.digits;
    const contract: Contract = { side, param: barrier };
    const overlord = legacyLayer(digits, side, barrier);
    const oracle =
        isTradableBarrier(side, barrier) && digits.length >= OU_MIN_TICKS
            ? readOverUnder(symbol, digits, contract)
            : null;
    const apex =
        market && isTradableBarrier(side, barrier)
            ? readApexContract(market, side, barrier, withEnsemble ? apexEnsemble(digits, side, barrier) : null)
            : null;

    const stages = apex && market ? readApexStages(symbol, market, side, barrier, fluct) : null;
    const layers = balance([
        { share: GROUP_SHARE.overlord, layers: [overlord] },
        { share: GROUP_SHARE.oracle, layers: oracle ? oracleLayers(oracle) : [] },
        { share: GROUP_SHARE.apex, layers: apex && market ? [...apexLayers(apex, market, side), ...stageLayers(stages)] : [] },
    ]);

    const thin = !oracle && !apex;
    const wTotal = layers.reduce((t, l) => t + l.weight, 0) || 1;
    const score = round1(layers.reduce((t, l) => t + l.weight * l.score, 0) / wTotal);
    const hard = layers.find(l => l.hard && !l.ok);
    const allRequired = layers.every(l => !l.required || l.ok);
    const applicable = layers.filter(l => l.weight > 0);
    const agree = applicable.filter(l => l.ok).length;
    const tier: OverlordTier = thin ? 'LEGACY' : hard ? 'CAUTION' : allRequired ? 'STRONG' : 'BEST';

    const reasons: string[] = [];
    if (hard) reasons.push(`${hard.engine}: ${hard.label.toLowerCase()} failed (${hard.detail})`);
    const ordered = [...applicable].sort((a, b) => b.score - a.score);
    for (const l of ordered.filter(x => x.ok).slice(0, 3)) reasons.push(`${l.engine}: ${l.detail}`);
    if (!hard) {
        const worst = ordered.filter(x => !x.ok).slice(-1)[0];
        if (worst) reasons.push(`watch: ${worst.engine} ${worst.label.toLowerCase()} (${worst.detail})`);
    }

    return {
        symbol,
        side,
        barrier,
        label: contractLabel(side, barrier),
        layers,
        score,
        vetoed: !!hard,
        vetoReason: hard ? `${hard.engine}: ${hard.label.toLowerCase()} failed (${hard.detail})` : '',
        tier,
        legacyPct: legacyPercentage(digits, side, barrier),
        thin,
        ticks: digits.length,
        reasons,
        agree,
        applied: applicable.length,
        apexNotes:
            stages && market
                ? {
                      agreement: stages.agreement.toLowerCase(),
                      instability: `${stages.clearance.instability.label.toLowerCase()} (${stages.clearance.instability.score}/100)`,
                      fluctuation: stages.fluctuation
                          ? `${stages.fluctuation.state.toLowerCase()} (${stages.fluctuation.score.toFixed(0)}/100)`
                          : 'not measured',
                      direction: `${stages.direction.label.toLowerCase()} ${stages.direction.score.toFixed(0)}/100`,
                      psychology: (() => {
                          const p = side === 'OVER' ? market.psychology.over : market.psychology.under;
                          return `${p.score.toFixed(0)}/100 formed, confidence ${p.confidence.toFixed(0)}`;
                      })(),
                  }
                : null,
    };
}

const tierRank: Record<OverlordTier, number> = { STRONG: 3, BEST: 2, CAUTION: 1, LEGACY: 0 };

/** STRONG before BEST before CAUTION before LEGACY, then score, then Overlord's original number (lower share first). */
export const compareReads = (a: OverlordRead, b: OverlordRead): number =>
    tierRank[b.tier] - tierRank[a.tier] || b.score - a.score || (a.legacyPct ?? 101) - (b.legacyPct ?? 101);

// ---------------------------------------------------------------------------------------------------------------------
// Whole scan
// ---------------------------------------------------------------------------------------------------------------------

export function scanOverlord(input: OverlordInput): OverlordScan {
    const mode = input.mode ?? 'selected';
    const ensembleTop = input.ensembleTop ?? 6;
    const targets: { side: OuSide; barrier: number }[] = [];
    const add = (side: OuSide, barrier: number) => {
        if (!isTradableBarrier(side, barrier)) return;
        if (!targets.some(t => t.side === side && t.barrier === barrier)) targets.push({ side, barrier });
    };
    add(input.side, input.barrier);
    if (mode === 'smart')
        for (const c of OU_CONTRACTS) if (c.side === 'OVER' || c.side === 'UNDER') add(c.side, c.param);

    const markets = new Map<string, ApexMarket | null>();
    let reads: OverlordRead[] = [];
    for (const symbol of input.symbols) {
        const series = input.series[symbol];
        if (!series || series.digits.length === 0) continue;
        const market = series.digits.length >= APEX_MIN_TICKS ? buildApexMarket(series.prices, series.digits) : null;
        markets.set(symbol, market);
        for (const t of targets) reads.push(assessContract(symbol, series, t.side, t.barrier, market));
    }

    // Second pass: the walk-forward model ensemble is the slow engine, so only the leaders are given it.
    const ensembleKeys: string[] = [];
    if (ensembleTop > 0) {
        const leaders = new Set(
            [...reads]
                .filter(r => !r.thin)
                .sort(compareReads)
                .slice(0, ensembleTop)
                .map(r => `${r.symbol}:${r.side}:${r.barrier}`)
        );
        for (const k of leaders) ensembleKeys.push(k);
        reads = reads.map(r =>
            leaders.has(`${r.symbol}:${r.side}:${r.barrier}`)
                ? assessContract(
                      r.symbol,
                      input.series[r.symbol],
                      r.side,
                      r.barrier,
                      markets.get(r.symbol) ?? null,
                      true
                  )
                : r
        );
    }

    // Third pass: fluctuation replays the market ~18 times, so only the leading markets get it, and each market once.
    const fluctTop = input.fluctuationTop ?? 4;
    if (fluctTop > 0) {
        const marketsByLead: string[] = [];
        for (const r of [...reads].filter(x => !x.thin).sort(compareReads)) {
            if (!marketsByLead.includes(r.symbol)) marketsByLead.push(r.symbol);
            if (marketsByLead.length >= fluctTop) break;
        }
        const fluct = new Map<string, FluctuationReport | null>();
        for (const symbol of marketsByLead) {
            const s = input.series[symbol];
            fluct.set(symbol, replayFluctuation(s.prices, s.digits));
        }
        const ens = new Set(ensembleKeys);
        reads = reads.map(r =>
            fluct.get(r.symbol)
                ? assessContract(
                      r.symbol,
                      input.series[r.symbol],
                      r.side,
                      r.barrier,
                      markets.get(r.symbol) ?? null,
                      ens.has(`${r.symbol}:${r.side}:${r.barrier}`),
                      fluct.get(r.symbol) ?? null
                  )
                : r
        );
    }

    reads.sort(compareReads);
    const deep = reads.filter(r => !r.thin);
    if (deep.length > 0) return { reads, best: deep[0], legacyOnly: false, evaluated: reads.length };

    // No market had enough history for the deeper engines: behave exactly as Overlord always did.
    const legacy = [...reads]
        .filter(r => r.legacyPct !== null)
        .sort((a, b) => (a.legacyPct as number) - (b.legacyPct as number));
    return { reads: legacy, best: legacy[0] ?? null, legacyOnly: true, evaluated: reads.length };
}

export { pct as formatShare };
