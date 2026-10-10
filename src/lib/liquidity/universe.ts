/**
 * Market universe + contract universe for the Deriv Liquidity Intelligence platform.
 * Read-only public market data. No authentication, no trading, no DBot logic.
 */

export const WS_PRIMARY = "wss://ws.derivws.com/websockets/v3?app_id=1089";
export const WS_LEGACY = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

export type MarketGroup = "STANDARD" | "1S" | "JUMP";

export interface MarketDef {
  symbol: string;
  name: string;
  group: MarketGroup;
  pip_size: number;
}

export const UNIVERSE: MarketDef[] = [
  { symbol: "R_10", name: "Volatility 10", group: "STANDARD", pip_size: 3 },
  { symbol: "R_25", name: "Volatility 25", group: "STANDARD", pip_size: 3 },
  { symbol: "R_50", name: "Volatility 50", group: "STANDARD", pip_size: 4 },
  { symbol: "R_75", name: "Volatility 75", group: "STANDARD", pip_size: 4 },
  { symbol: "R_100", name: "Volatility 100", group: "STANDARD", pip_size: 2 },
  { symbol: "1HZ10V", name: "Volatility 10 (1s)", group: "1S", pip_size: 2 },
  { symbol: "1HZ25V", name: "Volatility 25 (1s)", group: "1S", pip_size: 2 },
  { symbol: "1HZ50V", name: "Volatility 50 (1s)", group: "1S", pip_size: 2 },
  { symbol: "1HZ75V", name: "Volatility 75 (1s)", group: "1S", pip_size: 2 },
  { symbol: "1HZ100V", name: "Volatility 100 (1s)", group: "1S", pip_size: 2 },
  { symbol: "JD10", name: "Jump 10", group: "JUMP", pip_size: 2 },
  { symbol: "JD25", name: "Jump 25", group: "JUMP", pip_size: 2 },
  { symbol: "JD50", name: "Jump 50", group: "JUMP", pip_size: 2 },
  { symbol: "JD75", name: "Jump 75", group: "JUMP", pip_size: 2 },
  { symbol: "JD100", name: "Jump 100", group: "JUMP", pip_size: 2 },
];

export function getMarketPipSize(symbol: string): number {
  const m = UNIVERSE.find((u) => u.symbol === symbol);
  return m ? m.pip_size : 2;
}

export const MARKET_GROUPS: MarketGroup[] = ["STANDARD", "1S", "JUMP"];

export const WINDOWS = [10, 20, 30, 60, 120, 240, 500, 1000] as const;
export const HISTORY_CAP = 1000;

export type ContractKind = "OVER" | "UNDER";

export interface ContractDef {
  id: string;
  label: string;
  kind: ContractKind;
  barrier: number;
}

// EXACTLY six propositions exist in this build — OVER 1/2/3 and UNDER 8/7/6.
// Upstream DigitPulse also scanned OVER 4 and UNDER 5; they are removed so that
// no seventh/eighth family can ever enter scoring, ranking or the UI.
export const CONTRACTS: ContractDef[] = [
  { id: "OVER1", label: "OVER 1", kind: "OVER", barrier: 1 },
  { id: "OVER2", label: "OVER 2", kind: "OVER", barrier: 2 },
  { id: "OVER3", label: "OVER 3", kind: "OVER", barrier: 3 },
  { id: "UNDER8", label: "UNDER 8", kind: "UNDER", barrier: 8 },
  { id: "UNDER7", label: "UNDER 7", kind: "UNDER", barrier: 7 },
  { id: "UNDER6", label: "UNDER 6", kind: "UNDER", barrier: 6 },
];

export const LIQUIDITY_STATES = [
  "NO_LIQUIDITY",
  "ABSENT",
  "FORMING",
  "BUILDING",
  "MATURE",
  "EXHAUSTION_WATCH",
  "EXHAUSTION_CONFIRMED",
  "DELIVERY",
  "DELIVERY_ACCELERATING",
  "ABSORBING",
  "EXHAUSTING",
  "RELEASE_WATCH",
  "RELEASE",
  "RELEASED",
  "DIRECTIONAL MOVE",
  "RIPE",
  "CONFIRMED",
  "CONFLICTED",
  "BLOCKED",
  "INVALIDATED",
] as const;

export type LiquidityState = (typeof LIQUIDITY_STATES)[number];

export const LIQUIDITY_LAWS = [
  "NO LIQUIDITY WITHOUT OBSERVED CREATION",
  "NO RIPE STATUS WITHOUT MATURATION",
  "NO RELEASE WITHOUT OBSERVED STRUCTURAL CHANGE",
  "NO CONFIRMATION WITHOUT MULTI-DIMENSIONAL SUPPORT",
  "RIPE IS NOT CONFIRMED",
  "CONFLICTED STRUCTURES ARE NEVER FORCED INTO A DIRECTION",
  "NO CLAIM OF HIDDEN ORDER FLOW OR TRADER MANIPULATION",
];

export const ANALYSIS_VERSION = "v3";
