// The market-level object Apex Sentinel's staged engines read (core.ts MarketIntel), built once per scan from a deep history.
import type { BarStructure } from './bars';
import type { ContractBattle } from './battle';
import type { CriticalReport } from './critical';
import type { DigitIntel } from './digit-intel';
import type { FluctuationReport } from './fluctuation';
import type { PsychologyReport } from './psychology';
import type { SpecialDigitReport } from './special-digits';
import type {
    AnomalyOut,
    ContractEval,
    DataState,
    DigitStatsOut,
    EntropyOut,
    HiddenBuildupOut,
    MarketQualityOut,
    PersonalityOut,
    PressureOut,
    RegimeOut,
    SequenceOut,
    TransitionOut,
    TrendOut,
    VolatilityOut,
} from './types';

export interface MarketIntel {
    symbol: string;
    name: string;
    dataState: DataState;
    ticks: number;
    lastTickAt: number;
    ageMs: number;
    stats: DigitStatsOut | null;
    pressure: PressureOut | null;
    transition: TransitionOut | null;
    sequence: SequenceOut | null;
    entropy: EntropyOut | null;
    anomaly: AnomalyOut | null;
    volatility: VolatilityOut | null;
    trend: TrendOut | null;
    regime: RegimeOut | null;
    personality: PersonalityOut | null;
    buildup: HiddenBuildupOut | null;
    quality: MarketQualityOut | null;
    danger: number;
    contracts: ContractEval[];
    best: ContractEval | null;
    updatedAt: number;
    digitIntel: DigitIntel | null;
    bars: BarStructure | null;
    criticalReport: CriticalReport | null;
    battle: ContractBattle | null;
    deepTicks: number;
    psychology: PsychologyReport | null;
    specialDigits: SpecialDigitReport | null;
    fluctuation: FluctuationReport | null;
}
