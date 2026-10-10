import { MarketSymbol, ContractType, Digit } from "../types/sentinel";

/**
 * Valid supported 15-market universe for Apex Sentinel.
 * Exactly 15 markets:
 * - 5 Plain Volatility Indices: 10, 25, 50, 75, 100
 * - 5 Volatility (1s) Indices: 10 (1s), 25 (1s), 50 (1s), 75 (1s), 100 (1s)
 * - 5 Jump Indices: 10, 25, 50, 75, 100
 * NOTE: Volatility 150 (1s) `1HZ150V`, Volatility 250 (1s) `1HZ250V`, `R_150`, `R_250` are strictly excluded.
 */
export const SUPPORTED_MARKETS: MarketSymbol[] = [
  // 1. Plain Volatility Indices (5 Markets)
  {
    symbol: "R_10",
    displayName: "Volatility 10 Index",
    category: "Volatility",
    pipSize: 3,
    isActive: true,
  },
  {
    symbol: "R_25",
    displayName: "Volatility 25 Index",
    category: "Volatility",
    pipSize: 3,
    isActive: true,
  },
  {
    symbol: "R_50",
    displayName: "Volatility 50 Index",
    category: "Volatility",
    pipSize: 4,
    isActive: true,
  },
  {
    symbol: "R_75",
    displayName: "Volatility 75 Index",
    category: "Volatility",
    pipSize: 4,
    isActive: true,
  },
  {
    symbol: "R_100",
    displayName: "Volatility 100 Index",
    category: "Volatility",
    pipSize: 2,
    isActive: true,
  },

  // 2. 1-Second Volatility Indices (5 Markets)
  {
    symbol: "1HZ10V",
    displayName: "Volatility 10 (1s) Index",
    category: "Volatility_1s",
    pipSize: 2,
    isActive: true,
  },
  {
    symbol: "1HZ25V",
    displayName: "Volatility 25 (1s) Index",
    category: "Volatility_1s",
    pipSize: 2,
    isActive: true,
  },
  {
    symbol: "1HZ50V",
    displayName: "Volatility 50 (1s) Index",
    category: "Volatility_1s",
    pipSize: 2,
    isActive: true,
  },
  {
    symbol: "1HZ75V",
    displayName: "Volatility 75 (1s) Index",
    category: "Volatility_1s",
    pipSize: 2,
    isActive: true,
  },
  {
    symbol: "1HZ100V",
    displayName: "Volatility 100 (1s) Index",
    category: "Volatility_1s",
    pipSize: 2,
    isActive: true,
  },

  // 3. Jump Indices (5 Markets) - Deriv official pipSize is 2
  { symbol: "JD10", displayName: "Jump 10 Index", category: "Jump", pipSize: 2, isActive: true },
  { symbol: "JD25", displayName: "Jump 25 Index", category: "Jump", pipSize: 2, isActive: true },
  { symbol: "JD50", displayName: "Jump 50 Index", category: "Jump", pipSize: 2, isActive: true },
  { symbol: "JD75", displayName: "Jump 75 Index", category: "Jump", pipSize: 2, isActive: true },
  { symbol: "JD100", displayName: "Jump 100 Index", category: "Jump", pipSize: 2, isActive: true },
];

export const EXCLUDED_MARKET_SYMBOLS = ["1HZ150V", "1HZ250V", "R_150", "R_250"];

export interface ContractSpecification {
  type: ContractType;
  direction: "OVER" | "UNDER";
  barrier: number;
  label: string;
  winningDigits: Digit[];
  losingDigits: Digit[];
  theoreticalProbability: number;
  estimatedPayoutMultiplier: number;
  isPrimaryPreference: boolean;
}

export const CONTRACT_SPECS: Record<ContractType, ContractSpecification> = {
  OVER_1: {
    type: "OVER_1",
    direction: "OVER",
    barrier: 1,
    label: "Over 1",
    winningDigits: [2, 3, 4, 5, 6, 7, 8, 9],
    losingDigits: [0, 1],
    theoreticalProbability: 0.8,
    estimatedPayoutMultiplier: 1.22,
    isPrimaryPreference: false,
  },
  OVER_2: {
    type: "OVER_2",
    direction: "OVER",
    barrier: 2,
    label: "Over 2",
    winningDigits: [3, 4, 5, 6, 7, 8, 9],
    losingDigits: [0, 1, 2],
    theoreticalProbability: 0.7,
    estimatedPayoutMultiplier: 1.38,
    isPrimaryPreference: true, // Preferred profile
  },
  OVER_3: {
    type: "OVER_3",
    direction: "OVER",
    barrier: 3,
    label: "Over 3",
    winningDigits: [4, 5, 6, 7, 8, 9],
    losingDigits: [0, 1, 2, 3],
    theoreticalProbability: 0.6,
    estimatedPayoutMultiplier: 1.6,
    isPrimaryPreference: false,
  },
  UNDER_8: {
    type: "UNDER_8",
    direction: "UNDER",
    barrier: 8,
    label: "Under 8",
    winningDigits: [0, 1, 2, 3, 4, 5, 6, 7],
    losingDigits: [8, 9],
    theoreticalProbability: 0.8,
    estimatedPayoutMultiplier: 1.22,
    isPrimaryPreference: false,
  },
  UNDER_7: {
    type: "UNDER_7",
    direction: "UNDER",
    barrier: 7,
    label: "Under 7",
    winningDigits: [0, 1, 2, 3, 4, 5, 6],
    losingDigits: [7, 8, 9],
    theoreticalProbability: 0.7,
    estimatedPayoutMultiplier: 1.38,
    isPrimaryPreference: true, // Preferred profile
  },
  UNDER_6: {
    type: "UNDER_6",
    direction: "UNDER",
    barrier: 6,
    label: "Under 6",
    winningDigits: [0, 1, 2, 3, 4, 5],
    losingDigits: [6, 7, 8, 9],
    theoreticalProbability: 0.6,
    estimatedPayoutMultiplier: 1.6,
    isPrimaryPreference: false,
  },
};

export const CONTRACT_LIST: ContractType[] = [
  "UNDER_7",
  "OVER_2",
  "UNDER_8",
  "OVER_1",
  "UNDER_6",
  "OVER_3",
];

export const DEFAULT_CONFIG = {
  derivAppId: 1089,
  derivWsUrl: "wss://ws.derivws.com/websockets/v3",
  canonicalTickWindow: 1000,
  minSampleForValidSignal: 80,
  minSampleForExecutionSurvival: 15,
  minScoreForStrong: 85, // Strict Institutional Grade (was 80)
  minScoreForValid: 75, // Strict Positive Mathematical EV Edge (was 65)
  minScoreForWatch: 50, // Incubation / Watch
  maxDangerForStrong: 35, // Strict Danger Cap (was 45)
  maxDangerForValid: 42, // Strict Danger Cap (was 65)
  primaryPreferenceBonus: 4, // Bounded tie-breaker window for Over 2 / Under 7
  maxScanHistory: 10,
  defaultStake: 2.0,
  targetRuns: 3,
};
