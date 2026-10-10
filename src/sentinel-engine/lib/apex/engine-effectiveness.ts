// APEX SENTINEL — ENGINE EFFECTIVENESS.
//
// Every intelligence engine is measured independently against contract-resolved
// outcomes. An engine that produces attractive-looking signals with negative
// expectancy loses influence; a quiet but accurate engine gains it. No engine
// is permanently privileged, and no engine is measured on another market's
// trades unless the caller explicitly asks for the cross-market view.
import { apexSimulator, type SimTrade } from "./simulator";

export type EngineEffect = "EFFECTIVE" | "NEUTRAL" | "HARMFUL" | "INSUFFICIENT SAMPLE";

export interface EngineMarketRecord {
  symbol: string;
  market: string;
  n: number;
  wins: number;
  winRate: number;
  expectancy: number;
}

export interface EngineRecord {
  engine: string;
  /** Times the engine voted on an entry that was actually taken. */
  signals: number;
  /** Resolved contracts the engine supported. */
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Payout-adjusted P/L per stake unit on the trades this engine supported. */
  expectancy: number;
  netPnl: number;
  maxDrawdown: number;
  longestLosingStreak: number;
  /** Last-20 win rate minus lifetime win rate, in pp. Negative = degrading. */
  deteriorationPp: number;
  /** Mean vote weight the engine carried into those entries. */
  meanWeight: number;
  effect: EngineEffect;
  /** 0.5..1.4 multiplier the ranking layer may apply to this engine's evidence. */
  influence: number;
  byMarket: EngineMarketRecord[];
  note: string;
}

const MIN_N = 25;

/**
 * Historical trade outcomes undergo exponential half-life time decay.
 * Half-life is set to 24 hours (86,400,000 ms).
 * Rationale: In continuous synthetic volatility markets, digit regime dynamics and
 * micro-structural behavior shift over daily cycles. Trades older than 24h carry
 * half the weight of immediate trades, ensuring engine influence responds to current market regimes.
 */
export const EFFECTIVENESS_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

function drawdownAndStreak(trades: SimTrade[]) {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.result === "LOSS") {
      streak++;
      longest = Math.max(longest, streak);
    } else if (t.result === "WIN") {
      streak = 0;
    }
  }
  return { maxDrawdown: Math.round(maxDd * 1000) / 1000, longestLosingStreak: longest };
}

/**
 * Effectiveness of every engine that has voted on a taken entry.
 * @param trades Trades to measure. Pass one market's ledger for a
 *               market-scoped view; the default is the CROSS-MARKET view and
 *               must be labelled as such in the UI.
 * @param now Optional timestamp reference for time-decay calculations (defaults to Date.now()).
 */
export function engineEffectiveness(trades?: SimTrade[], now = Date.now()): EngineRecord[] {
  const source = trades ?? apexSimulator.getLedger(5000);
  const map = new Map<string, { votes: { t: SimTrade; weight: number }[] }>();

  for (const t of source) {
    for (const v of t.state?.engineVotes ?? []) {
      const e = map.get(v.engine) ?? { votes: [] };
      e.votes.push({ t, weight: v.weight });
      map.set(v.engine, e);
    }
  }

  const records: EngineRecord[] = [];
  for (const [engine, { votes }] of map) {
    const resolved = votes
      .filter((v) => v.t.result !== "OPEN")
      .sort((a, b) => (a.t.resolvedAt ?? 0) - (b.t.resolvedAt ?? 0));
    const list = resolved.map((v) => v.t);
    const n = list.length;
    const wins = list.filter((t) => t.result === "WIN").length;
    const losses = n - wins;
    const winRate = n ? wins / n : 0;
    const stake = list.reduce((a, t) => a + t.stake, 0);
    const netPnl = list.reduce((a, t) => a + t.pnl, 0);
    const rawExpectancy = stake ? netPnl / stake : 0;

    // Time-decay weighted calculation
    let weightedWins = 0;
    let weightedN = 0;
    let weightedStake = 0;
    let weightedPnl = 0;

    for (const t of list) {
      const tradeTime = t.resolvedAt ?? t.openedAt ?? now;
      const ageMs = Math.max(0, now - tradeTime);
      const decayWeight = Math.exp(-Math.LN2 * (ageMs / EFFECTIVENESS_HALF_LIFE_MS));
      weightedN += decayWeight;
      if (t.result === "WIN") weightedWins += decayWeight;
      weightedStake += t.stake * decayWeight;
      weightedPnl += t.pnl * decayWeight;
    }

    const timeDecayedExpectancy = weightedStake > 0 ? weightedPnl / weightedStake : rawExpectancy;
    const expectancy = timeDecayedExpectancy;

    const { maxDrawdown, longestLosingStreak } = drawdownAndStreak(list);
    const last20 = list.slice(-20);
    const recentRate = last20.length
      ? last20.filter((t) => t.result === "WIN").length / last20.length
      : winRate;
    const deteriorationPp = Math.round((recentRate - winRate) * 1000) / 10;
    const meanWeight = votes.length
      ? Math.round((votes.reduce((a, v) => a + v.weight, 0) / votes.length) * 100) / 100
      : 0;

    const byMarketMap = new Map<string, SimTrade[]>();
    for (const t of list) {
      const arr = byMarketMap.get(t.symbol) ?? [];
      arr.push(t);
      byMarketMap.set(t.symbol, arr);
    }
    const byMarket: EngineMarketRecord[] = [...byMarketMap.entries()]
      .map(([symbol, ts]) => {
        const s = ts.reduce((a, t) => a + t.stake, 0);
        return {
          symbol,
          market: ts[0].market,
          n: ts.length,
          wins: ts.filter((t) => t.result === "WIN").length,
          winRate: ts.filter((t) => t.result === "WIN").length / ts.length,
          expectancy: s ? ts.reduce((a, t) => a + t.pnl, 0) / s : 0,
        };
      })
      .sort((a, b) => b.n - a.n);

    const effect: EngineEffect =
      n < MIN_N
        ? "INSUFFICIENT SAMPLE"
        : expectancy > 0.03
          ? "EFFECTIVE"
          : expectancy < -0.03
            ? "HARMFUL"
            : "NEUTRAL";

    // Adaptive contribution: evidence-weighted, bounded, and never zero so an
    // engine can always earn its way back.
    let influence = 1;
    if (effect === "EFFECTIVE") influence = 1 + Math.min(0.4, expectancy * 2);
    else if (effect === "HARMFUL") influence = Math.max(0.5, 1 + Math.max(-0.5, expectancy * 2));
    if (deteriorationPp < -8 && n >= MIN_N) influence *= 0.9;
    influence = Math.round(Math.max(0.5, Math.min(1.4, influence)) * 100) / 100;

    records.push({
      engine,
      signals: votes.length,
      n,
      wins,
      losses,
      winRate,
      expectancy,
      netPnl: Math.round(netPnl * 1000) / 1000,
      maxDrawdown,
      longestLosingStreak,
      deteriorationPp,
      meanWeight,
      effect,
      influence,
      byMarket,
      note:
        n < MIN_N
          ? `Only ${n} resolved contract(s) carry this engine's vote — no influence adjustment applied (needs N≥${MIN_N}).`
          : `${(winRate * 100).toFixed(1)}% over N=${n}, expectancy ${expectancy.toFixed(3)}, recent drift ${deteriorationPp.toFixed(1)}pp → influence ×${influence.toFixed(2)}.`,
    });
  }

  return records.sort((a, b) => b.n - a.n || b.expectancy - a.expectancy);
}

/** Adaptive weight for one engine, 1 when there is not enough evidence. */
export function engineInfluence(engine: string, trades?: SimTrade[], now?: number): number {
  const rec = engineEffectiveness(trades, now).find((r) => r.engine === engine);
  if (!rec || rec.effect === "INSUFFICIENT SAMPLE") return 1;
  return rec.influence;
}
