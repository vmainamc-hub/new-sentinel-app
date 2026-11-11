// APEX SENTINEL READ for one market and one Over / Under contract.
//
// This runs the same engines Apex Sentinel's data core runs (ported under ./apex, pure), but once, on a deep history that
// has just been fetched, instead of continuously on a live feed. Nothing here is invented: every number comes from the
// ticks passed in.
import { barEngine } from './apex/bars';
import { contractSpec, evaluateContract, winnersFor } from './apex/contracts';
import { criticalDigits } from './apex/critical';
import { digitIntelligence } from './apex/digit-intel';
import {
    anomalyEngine,
    digitPressure,
    digitStatistics,
    entropyEngine,
    hiddenBuildup,
    marketQuality,
    regimeEngine,
    sequencePattern,
    tail,
    transitions,
    trendEngine,
    volatilityEngine,
    WINDOW_BASE,
} from './apex/engines';
import { type ExposureReport, losingDigitExposure } from './apex/exposure';
import { type EnsembleResult, runEnsemble } from './apex/ml';
import { psychologyEngine, type PsychologyReport } from './apex/psychology';
import { DEFAULT_REFINEMENT } from './apex/settings';
import { type SpecialDigitReport, specialDigitRisk } from './apex/special-digits';
import type { ContractEval } from './apex/types';
import type { OuSide } from './legacy';

/** Apex Sentinel's own minimum (core.ts MIN_TICKS): below this it reports THIN and scores nothing. */
export const APEX_MIN_TICKS = 200;

type Shared = ReturnType<typeof buildShared>;

export type ApexMarket = Shared & {
    digits: readonly number[];
    psychology: PsychologyReport;
};

const buildShared = (prices: readonly number[], digits: readonly number[]) => {
    const d = digits as number[];
    const stats = digitStatistics(d);
    const pressure = digitPressure(stats);
    const transition = transitions(d);
    const entropy = entropyEngine(stats);
    const sequence = sequencePattern(d, winnersFor(contractSpec('UNDER', 7)));
    const anomaly = anomalyEngine(stats, entropy, sequence);
    const windowPrices = tail(prices as number[], WINDOW_BASE);
    const volatility = volatilityEngine(windowPrices);
    const trend = trendEngine(windowPrices);
    const regime = regimeEngine(entropy, volatility, trend, pressure);
    const quality = marketQuality(stats, entropy, volatility, anomaly);
    const buildup = hiddenBuildup(stats, pressure);
    const digitIntel = digitIntelligence(d, transition.nextDist);
    const bars = barEngine(prices.length >= windowPrices.length ? (prices as number[]) : windowPrices, d);
    const criticalReport = criticalDigits(digitIntel, bars);
    return {
        stats,
        pressure,
        transition,
        entropy,
        anomaly,
        volatility,
        trend,
        regime,
        quality,
        buildup,
        digitIntel,
        bars,
        criticalReport,
    };
};

/** Market-level Apex read: shared by every contract on the market. Null when the market is too thin. */
export const buildApexMarket = (prices: readonly number[], digits: readonly number[]): ApexMarket | null => {
    if (digits.length < APEX_MIN_TICKS) return null;
    const shared = buildShared(prices, digits);
    const psychology = psychologyEngine(shared.stats, shared.pressure, shared.bars, shared.digitIntel);
    return { ...shared, digits, psychology };
};

/** Walk-forward validated model ensemble for one contract (Apex core's ensembleFor, without its cache). */
export const apexEnsemble = (digits: readonly number[], side: OuSide, barrier: number): EnsembleResult | null => {
    const s = DEFAULT_REFINEMENT;
    if (digits.length < 210 + s.wfTrain + s.wfTest) return null;
    const winners = winnersFor(contractSpec(side, barrier));
    const winSet = new Set(winners);
    let w = 0;
    for (const d of digits) if (winSet.has(d)) w += 1;
    const theoretical = winners.length / 10;
    return runEnsemble({
        digits: digits as number[],
        winners,
        theoretical,
        wfTrain: s.wfTrain,
        wfTest: s.wfTest,
        wfStep: s.wfStep,
        analogue: null,
        rule: (w + theoretical * s.shrinkageStrength) / (digits.length + s.shrinkageStrength),
        ruleN: digits.length,
    });
};

export type ApexRead = {
    evaluation: ContractEval;
    exposure: ExposureReport;
    special: SpecialDigitReport;
    ensemble: EnsembleResult | null;
    /** Apex Sentinel's contract danger after exposure and special-digit risk are applied (0-100). */
    danger: number;
};

/** One contract on one market. `ensemble` is optional because it is the expensive part. */
export const readApexContract = (
    market: ApexMarket,
    side: OuSide,
    barrier: number,
    ensemble: EnsembleResult | null = null
): ApexRead => {
    const spec = contractSpec(side, barrier);
    const winners = winnersFor(spec);
    const evaluation = evaluateContract(spec, {
        digits: market.digits as number[],
        stats: market.stats,
        pressure: market.pressure,
        transition: market.transition,
        sequence: sequencePattern(market.digits as number[], winners),
        entropy: market.entropy,
        anomaly: market.anomaly,
        volatility: market.volatility,
        trend: market.trend,
        regime: market.regime,
        quality: market.quality,
        prev: undefined,
        edgeHistory: [],
        dataAgeMs: 0,
        intel: market.digitIntel,
        bars: market.bars,
        criticalReport: market.criticalReport,
        ensemble,
        analogue: null,
        entropyDelta: 0,
        settings: DEFAULT_REFINEMENT,
    });
    const exposure = losingDigitExposure(
        market.digits as number[],
        winners,
        market.digitIntel,
        market.bars,
        spec.label
    );
    const special = specialDigitRisk(market.digitIntel, market.bars, exposure.losers, {});
    // Same rule as Apex Sentinel's core: a good aggregate rate never overrides a dangerous losing digit.
    const danger = Math.round(
        Math.max(evaluation.danger, Math.min(100, exposure.losingDigitExposure * 0.75 + special.exposureRisk * 0.35))
    );
    return { evaluation, exposure, special, ensemble, danger };
};
