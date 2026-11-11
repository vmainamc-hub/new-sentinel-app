// APEX SENTINEL INTELLIGENCE — core data contracts.
// Every field in here is produced by a real quantitative engine from live
// Deriv tick data. Nothing is simulated. When data is missing the state is
// explicitly marked UNAVAILABLE / STALE / THIN instead of being invented.
import type { FakeEdgeCheck } from './battle';
import type { CriticalConflict } from './critical';
import type { ForwardState } from './forward';
import type { EnsembleResult } from './ml';
import type { RateEstimate, StatReport } from './statistics';
import type { ThreatReport } from './threat';

export type ApexContractId = `OVER${number}` | `UNDER${number}`;

export type DataState = 'OK' | 'THIN' | 'STALE' | 'UNAVAILABLE';

export type SetupPhase = 'FORMING' | 'FRESH' | 'MATURE' | 'WEAKENING' | 'INVALIDATING';

export type RegimeLabel = 'BALANCED' | 'SKEWED' | 'TRENDING' | 'COMPRESSED' | 'CHAOTIC';

export type DigitLifecycle = 'emerging' | 'dominant' | 'exhausting' | 'suppressed' | 'recovering' | 'neutral';

export interface Evidence {
    engine: string;
    label: string;
    detail: string;
    /** −1 .. +1 — how strongly this supports the contract. */
    weight: number;
    /** Sample size behind the measurement (0 = not sample based). */
    n: number;
}

export interface DigitStatsOut {
    n: number;
    freq: number[]; // counts, length 10
    pct: number[]; // base window share
    midPct: number[];
    recentPct: number[];
    microPct: number[];
    z: number[]; // z-score of base share vs uniform
    lastDigit: number;
    dominant: number;
    suppressed: number;
}

export interface PressureOut {
    /** recentPct − basePct per digit. */
    pressure: number[];
    /** micro vs recent — the fast component. */
    impulse: number[];
    lifecycle: DigitLifecycle[];
    exhaustion: number[]; // 0..1 how exhausted each digit looks
    zoneAShare: number; // digits 0-4 recent share
    zoneBShare: number;
    migration: number; // + = mass moving to high digits
}

export interface TransitionOut {
    n: number;
    /** P(next digit = d | current digit) from the observed chain. */
    nextDist: number[];
    /** Sample count behind nextDist. */
    rowN: number;
    /** Normalised divergence of the chain from an i.i.d. process, 0..1. */
    dependency: number;
}

export interface SequenceOut {
    repeatRate: number;
    alternationRate: number;
    maxRunWinners: number;
    currentRun: number;
    runDigit: number;
}

export interface EntropyOut {
    entropy: number; // 0..1 normalised Shannon
    chi2: number;
    uniformityFail: boolean; // chi2 beyond 5% critical value (16.92, df=9)
}

export interface AnomalyOut {
    score: number; // 0..100
    reasons: string[];
}

export interface VolatilityOut {
    base: number;
    recent: number;
    ratio: number; // recent / base
    label: 'calm' | 'normal' | 'elevated' | 'violent';
}

export interface TrendOut {
    slopePctPer100: number;
    greenRate: number; // share of up ticks in recent window
    momentum: number; // −1..1
    label: 'up' | 'down' | 'flat';
}

export interface RegimeOut {
    label: RegimeLabel;
    confidence: number; // 0..100
    detail: string;
}

export interface PersonalityOut {
    /** Mean gap between appearances per digit (uniform expectation = 10). */
    meanGap: number[];
    /** Ticks since the digit last appeared. */
    sinceSeen: number[];
    /** Stickiness: P(d | d) / base P(d). */
    stickiness: number[];
}

export interface HiddenBuildupOut {
    score: number; // 0..100
    digits: number[];
    detail: string;
}

export interface MarketQualityOut {
    score: number; // 0..100
    detail: string;
}

export interface ContractEval {
    id: ApexContractId;
    label: string;
    side: 'UNDER' | 'OVER';
    barrier: number;
    winners: number[];
    theoretical: number; // 0..1
    empirical: number; // 0..1 base window
    recent: number; // 0..1 recent window
    micro: number; // 0..1 micro window
    n: number;
    edge: number; // empirical − theoretical (fraction)
    edgeLB: number; // Wilson 95% lower bound of edge
    pressureAsymmetry: number; // −1..1
    transitionSupport: number; // −1..1 from Markov chain
    compositeEdge: number; // −100..100
    stability: number; // 0..100
    freshness: number; // 0..100
    quality: number; // 0..100
    danger: number; // 0..100
    confidence: number; // 0..100
    opportunity: number; // 0..100
    phase: SetupPhase;
    supports: Evidence[];
    conflicts: Evidence[];
    contradiction: number; // 0..100
    ageTicks: number;

    // ---- Deep-reasoning refinement layers (null when the engine had no data) ----
    /** Losing-digit threat analysis for this contract's losing side. */
    threat: ThreatReport | null;
    /** Critical digit structures pointing at losing digits. */
    critical: CriticalConflict | null;
    /** Statistical validation of the observed pattern. */
    stats: StatReport | null;
    /** Shrunk, interval-bounded win-rate estimate. */
    rate: RateEstimate | null;
    /** Walk-forward validated model ensemble. */
    ensemble: EnsembleResult | null;
    /** Constrained forward state projection. */
    forward: ForwardState | null;
    /** Terminal-observed historical analogue for the current state. */
    analogue: { n: number; rate: number } | null;
    /** Structured "why this is not a fake edge" interrogation. */
    fakeEdge: FakeEdgeCheck | null;
    /** Whether the current regime supports this contract. */
    regimeCompatible: boolean;
    regimeNote: string;
    /** Penalty applied by the threat + critical layers, 0..100. */
    threatPenalty: number;
    /** Operator-facing alerts raised for this contract. */
    alerts: string[];

    // ---- Losing-side risk layers (attached by the core after evaluation) ----
    /** LOSING_DIGIT_RISK / LOSING_DIGIT_EXPOSURE for this contract's losing digits. */
    exposure?: import('./exposure').ExposureReport | null;
    /** SPECIAL DIGIT RISK (0/1/8/9) scoped to this contract's losing side. */
    specialRisk?: import('./special-digits').SpecialDigitReport | null;
}
