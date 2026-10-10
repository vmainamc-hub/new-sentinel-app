// APEX SENTINEL — canonical market universe.
//
// One source of truth for which symbols may reach ANY Sentinel layer
// (analysis, simulator, ranking, memory, models, UI). Volatility 150 (1s) and
// Volatility 250 (1s) are permanently excluded from the traded scope: they must
// never re-enter through a fallback list, cached state or old configuration.
//
// NOTE: the numbers 150 / 250 are also legitimate ANALYSIS WINDOW sizes
// elsewhere in the engine. This exclusion is about market SYMBOLS only.
import { DERIV_SYMBOLS, type DerivSymbol } from "@/hooks/useDerivStream";

/** Market symbols banned from Sentinel entirely. */
export const APEX_EXCLUDED_SYMBOLS = ["1HZ150V", "1HZ250V"] as const;

/** Human labels of the banned markets, used to catch name-based re-entry. */
export const APEX_EXCLUDED_NAMES = ["Volatility 150 (1s)", "Volatility 250 (1s)"] as const;

const EXCLUDED = new Set<string>(APEX_EXCLUDED_SYMBOLS);

/** Digit contracts exist for Volatility / 1s / Jump families only. */
const DIGIT_GROUPS = new Set(["Standard", "1s", "Jump"]);

/** True when the symbol is allowed to participate in Sentinel. */
export function isApexSymbol(symbol: string): boolean {
  if (EXCLUDED.has(symbol)) return false;
  const meta = DERIV_SYMBOLS.find((s) => s.symbol === symbol);
  return Boolean(meta && DIGIT_GROUPS.has(meta.group));
}

/** Hard filter applied to any symbol list before it reaches the engine. */
export function sanitiseUniverse<T extends { symbol: string }>(list: T[]): T[] {
  return list.filter((s) => !EXCLUDED.has(s.symbol));
}

/** The validated Sentinel universe. Every layer derives its markets from here. */
export const APEX_UNIVERSE: DerivSymbol[] = sanitiseUniverse(
  DERIV_SYMBOLS.filter((s) => DIGIT_GROUPS.has(s.group)),
);

export const APEX_UNIVERSE_SYMBOLS: string[] = APEX_UNIVERSE.map((s) => s.symbol);
