// APEX INTEL agents. Ten specialised, DETERMINISTIC agents and a Chief that reconciles them. Honest scope: there is no
// learned model and no language model in this loop. "AI" here means statistical inference, evolutionary strategy search
// and a rule-based reconciler with structured outputs. A language-model explanation layer would need an API key and a
// server function and is not built. Nothing here runs per tick: the service calls it every few seconds.
//
// Confidence is never collapsed into one percentage. The decision carries four separate evidence blocks (statistical,
// historical, out-of-sample, suitability) and the Chief prefers NO TRADE whenever evidence is missing or the agents disagree.
import { winProbability } from '@/components/premium/sixfold/bot';
import { chiSquareSf } from '@/components/premium/sixfold/stats';
import { classifyRegime, FDR_Q, MIN_TICKS_FOR_REGIME, MIN_TRADES, type Regime } from './analysis';
import type { Forward } from './monitor';
import { contractOf, type Pick } from './picker';
import type { Strategy } from './registry';
import { compileRule } from './rules';
import { OVER_2 } from './sim';

export const MODEL_VERSION = 'apex-intel-rules-1';

export type AgentId = 'scanner' | 'sequence' | 'probability' | 'regime' | 'research' | 'validation' | 'competition' | 'live' | 'performance' | 'chief';
export type AgentReport = { id: AgentId; name: string; state: 'ok' | 'warn' | 'idle'; headline: string; findings: string[] };

// ---- measurements the agents share (pure) ----

/** Chi-square test that the next digit does not depend on the current one (10x10 transition table). */
export function transitionDependence(digits: readonly number[]): { n: number; p: number | null } {
    const n = digits.length - 1;
    if (n < 500) return { n, p: null };
    const t = Array.from({ length: 10 }, () => Array<number>(10).fill(0));
    for (let i = 0; i < n; i++) t[digits[i]][digits[i + 1]] += 1;
    const row = t.map(r => r.reduce((a, b) => a + b, 0));
    const col = Array.from({ length: 10 }, (_, j) => t.reduce((a, r) => a + r[j], 0));
    let stat = 0;
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
        const e = (row[i] * col[j]) / n;
        if (e > 0) stat += (t[i][j] - e) ** 2 / e;
    }
    return { n, p: chiSquareSf(stat, 81) };
}

/** Longest run of digits that win the contract, and of digits that lose it. */
export function longestRuns(digits: readonly number[], win: (d: number) => boolean): { win: number; lose: number } {
    let w = 0, l = 0, bw = 0, bl = 0;
    for (const d of digits) {
        if (win(d)) { w += 1; l = 0; } else { l += 1; w = 0; }
        bw = Math.max(bw, w);
        bl = Math.max(bl, l);
    }
    return { win: bw, lose: bl };
}

/** Approximate posterior probability that the true win rate exceeds `p0`, from Beta(1+wins, 1+losses) by normal approximation. */
export function probAbove(wins: number, n: number, p0: number): number | null {
    if (n < 20) return null;
    const a = 1 + wins, b = 1 + n - wins;
    const mean = a / (a + b), sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
    const z = (p0 - mean) / sd;
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? tail : 1 - tail;
}

/** Correlation of "this tick would win" between two markets over their latest `n` ticks (aligned by arrival order, so approximate). */
export function winCorrelation(a: readonly number[], b: readonly number[], win: (d: number) => boolean, n = 500): { r: number | null; n: number } {
    const m = Math.min(n, a.length, b.length);
    if (m < 200) return { r: null, n: m };
    const x = a.slice(-m).map(d => (win(d) ? 1 : 0)), y = b.slice(-m).map(d => (win(d) ? 1 : 0));
    const mx = x.reduce((s, v) => s + v, 0) / m, my = y.reduce((s, v) => s + v, 0) / m;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0, n: m };
}

// ---- the decision ----

export type Evidence = {
    /** Is the edge real after multiple-testing control? */
    statistical: { significant: boolean; q: number | null; intervalFloorOverChancePts: number | null; probAboveChance: number | null };
    /** What the entry did on the ticks seen. */
    historical: { trades: number; rate: number | null; chance: number };
    /** Evidence from ticks the rule never saw: lab validation and the forward test. null = none exists. */
    outOfSample: { validationRate: number | null; validationQ: number | null; forwardTrades: number; forwardRate: number | null } | null;
    /** Is the market in a state where past behaviour is a fair guide right now? */
    suitability: { regime: Regime; freshSeconds: number | null; ticks: number };
    /** There is no learned model, so there is no model confidence to report. */
    model: { version: string; learned: false };
};

export type Decision = {
    at: number;
    market: string | null;
    direction: 'OVER_2' | 'UNDER_7' | null;
    barrier: number | null;
    strategy: string;
    strategyVersion: number | null;
    regime: Regime | null;
    entryCondition: string;
    entryMetNow: boolean;
    decision: 'ENTER' | 'NO_TRADE';
    explanation: string[];
    modelVersion: string;
    validationStatus: 'VALIDATED_STRATEGY' | 'BASELINE_ENTRY' | 'NONE';
    evidence: Evidence | null;
};

export type Rejected = { market: string; label: string; reasons: string[] };

export type IntelInput = {
    now: number;
    series: Readonly<Record<string, readonly number[]>>;
    lastTickAt: (market: string) => number | null;
    /** Ranked picks from the picker (evidenceOnly false) so rejected ones can be explained. */
    picks: readonly Pick[];
    strategies: readonly Strategy[];
    forward: readonly Forward[];
    lab: { state: string; note: string | null; results: number; passed: number };
    exec: { running: boolean; trades: number; pnl: number; market: string | null };
    duration: number;
};

export type IntelReport = { agents: AgentReport[]; decision: Decision; rejected: Rejected[] };

const entryText = (p: Pick) => (p.rule ? `rule: digit ${p.rule.digits.join('/')}${p.rule.prev.kind === 'ANY' ? '' : ` after ${p.rule.prev.k} ${p.rule.prev.kind === 'ALL_WIN' ? 'winning' : 'losing'} ticks`}` : p.entry === 'CUSTOM' ? `digits ${p.customDigits.join('/')}` : p.entry === 'ANY' ? 'any tick' : 'a digit that does not win the contract');

/** Would this pick fire on the latest tick of its market? */
export function entryMetNow(p: Pick, series: Readonly<Record<string, readonly number[]>>): boolean {
    const h = series[p.market];
    if (!h || !h.length) return false;
    const last = h[h.length - 1];
    const contract = contractOf(p.direction);
    if (p.rule) return compileRule(p.rule, contract)(h);
    if (p.entry === 'ANY') return true;
    if (p.entry === 'CUSTOM') return p.customDigits.includes(last);
    return !(p.direction === 'OVER_2' ? last > 2 : last < 7);
}

export function runAgents(input: IntelInput): IntelReport {
    const { series, now } = input;
    const markets = Object.keys(series);
    const agents: AgentReport[] = [];
    const fresh = (m: string) => { const at = input.lastTickAt(m); return at === null ? null : (now - at) / 1000; };

    // 1 Market Scanner
    const ready = markets.filter(m => series[m].length >= MIN_TICKS_FOR_REGIME && (fresh(m) ?? 1e9) <= 15);
    const stale = markets.filter(m => (fresh(m) ?? 1e9) > 15);
    agents.push({ id: 'scanner', name: 'Market Scanner', state: markets.length ? (ready.length ? 'ok' : 'warn') : 'idle', headline: markets.length ? `${ready.length} of ${markets.length} markets fresh with ${MIN_TICKS_FOR_REGIME}+ ticks` : 'No market data yet', findings: stale.length ? [`Stale: ${stale.slice(0, 6).join(', ')}${stale.length > 6 ? '…' : ''}`] : [] });

    // 2 Sequence Research (serial dependence + runs)
    const dep = markets.map(m => ({ m, ...transitionDependence(series[m]) })).filter(x => x.p !== null);
    const tested = dep.length;
    const hits = dep.filter(x => (x.p as number) < FDR_Q / Math.max(1, tested));
    const runs = markets.length ? longestRuns(series[markets[0]], d => d > OVER_2.param) : { win: 0, lose: 0 };
    agents.push({ id: 'sequence', name: 'Sequence Research', state: tested ? (hits.length ? 'warn' : 'ok') : 'idle', headline: tested ? (hits.length ? `Serial dependence signal in ${hits.length} of ${tested} markets (Bonferroni)` : `No digit-to-digit dependence in ${tested} markets after multiple-testing correction`) : 'Needs 500+ ticks per market', findings: [...hits.slice(0, 4).map(h => `${h.m}: transition chi-square p=${(h.p as number).toExponential(1)}`), ...(markets.length ? [`Longest run on ${markets[0]} (Over 2): ${runs.win} winning, ${runs.lose} losing digits`] : [])] });

    // 3 Probability
    const top = input.picks[0];
    const pa = top ? probAbove(Math.round((top.rate ?? 0) * top.trades), top.trades, winProbability(contractOf(top.direction))) : null;
    agents.push({ id: 'probability', name: 'Probability', state: top ? 'ok' : 'idle', headline: top ? `Top candidate: ${top.trades} trades, win rate ${top.rate === null ? '–' : (top.rate * 100).toFixed(1)}%, chance ${(winProbability(contractOf(top.direction)) * 100).toFixed(0)}%` : 'No candidate has data yet', findings: top ? [`Posterior P(true rate above chance) ≈ ${pa === null ? 'n/a (too few trades)' : (pa * 100).toFixed(0) + '% (flat prior, normal approximation)'}`, top.significant ? `Survives false-discovery control (q=${top.q?.toFixed(3)})` : 'Does NOT survive false-discovery control'] : [] });

    // 4 Regime
    const regs = markets.map(m => ({ m, r: classifyRegime(series[m], OVER_2).regime }));
    const bad = regs.filter(x => x.r === 'UNSTABLE' || x.r === 'CHANGING' || x.r === 'UNUSUAL');
    agents.push({ id: 'regime', name: 'Regime', state: regs.length ? (bad.length ? 'warn' : 'ok') : 'idle', headline: regs.length ? `${regs.filter(x => x.r === 'STABLE').length} stable, ${bad.length} changing/unusual/unstable` : 'No data', findings: bad.slice(0, 5).map(x => `${x.m}: ${x.r.toLowerCase()}`) });

    // 5 Strategy Research
    agents.push({ id: 'research', name: 'Strategy Research', state: input.lab.state === 'running' ? 'ok' : 'idle', headline: input.lab.state === 'running' ? 'Experiment running' : input.lab.results ? `Last experiment: ${input.lab.passed} of ${input.lab.results} finalists held up` : 'No experiment run yet', findings: input.lab.note ? [input.lab.note] : [] });

    // 6 Strategy Validation (re-checks the library against forward evidence)
    const live = input.strategies.filter(s => s.status === 'ACTIVE' || s.status === 'APPROVED');
    const weak = live.filter(s => { const f = input.forward.find(x => x.strategyId === s.id); return f && f.trades >= MIN_TRADES && f.hi < f.baseline; });
    agents.push({ id: 'validation', name: 'Strategy Validation', state: weak.length ? 'warn' : 'ok', headline: `${live.length} approved/active strategies; ${weak.length} failing their forward test`, findings: live.slice(0, 5).map(s => { const f = input.forward.find(x => x.strategyId === s.id); return `${s.name} v${s.version}: ${f ? `${f.trades} forward trades, ${f.rate === null ? '–' : (f.rate * 100).toFixed(1) + '%'}` : 'no forward trades yet'}`; }) });

    // 7 Competition
    agents.push({ id: 'competition', name: 'Competition', state: input.picks.length ? 'ok' : 'idle', headline: input.picks.length ? `${input.picks.length} candidates ranked by interval floor over chance` : 'Nothing to rank yet', findings: input.picks.slice(0, 3).map(p => `${p.market} ${p.label}: floor ${(p.score * 100).toFixed(1)} pts, ${p.trades} trades${p.significant ? ', significant' : ''}`) });

    // 8 Live Execution Intelligence
    const met = top ? entryMetNow(top, series) : false;
    agents.push({ id: 'live', name: 'Live Execution Intelligence', state: top ? 'ok' : 'idle', headline: top ? (met ? `Entry condition met now on ${top.market}` : `Waiting for ${entryText(top)} on ${top.market}`) : 'No candidate to watch', findings: [] });

    // 9 Performance Monitoring
    const fw = input.forward.reduce((a, f) => ({ t: a.t + f.trades, w: a.w + f.wins }), { t: 0, w: 0 });
    agents.push({ id: 'performance', name: 'Performance Monitoring', state: input.exec.running ? 'ok' : 'idle', headline: input.exec.running ? `Live session: ${input.exec.trades} trades, P/L ${input.exec.pnl >= 0 ? '+' : ''}${input.exec.pnl.toFixed(2)}` : 'No live session', findings: [`Forward paper trades since this page loaded: ${fw.t}${fw.t ? ` (${((fw.w / fw.t) * 100).toFixed(1)}% won)` : ''}`] });

    // 10 Chief
    const { decision, rejected } = chief(input, top, met, hits.length > 0);
    agents.push({ id: 'chief', name: 'Chief Intelligence', state: decision.decision === 'ENTER' ? 'ok' : 'warn', headline: decision.decision === 'ENTER' ? `ENTER: ${decision.market} ${decision.direction === 'UNDER_7' ? 'Under 7' : 'Over 2'}` : 'NO TRADE', findings: decision.explanation.slice(0, 3) });
    return { agents, decision, rejected };
}

function chief(input: IntelInput, top: Pick | undefined, met: boolean, dependence: boolean): { decision: Decision; rejected: Rejected[] } {
    const base = { at: input.now, modelVersion: MODEL_VERSION, evidence: null as Evidence | null };
    const none = (why: string[]): Decision => ({ ...base, market: null, direction: null, barrier: null, strategy: '–', strategyVersion: null, regime: null, entryCondition: '–', entryMetNow: false, decision: 'NO_TRADE', explanation: why, validationStatus: 'NONE' });
    if (!top) return { decision: none(['No market has enough fresh data to evaluate.']), rejected: [] };

    const strat = top.strategyId ? input.strategies.find(s => s.id === top.strategyId) ?? null : null;
    const fw = strat ? input.forward.find(f => f.strategyId === strat.id) ?? null : null;
    const chance = winProbability(contractOf(top.direction));
    const pa = probAbove(Math.round((top.rate ?? 0) * top.trades), top.trades, chance);
    const secs = input.lastTickAt(top.market) === null ? null : (input.now - (input.lastTickAt(top.market) as number)) / 1000;
    const evidence: Evidence = {
        statistical: { significant: top.significant, q: top.q, intervalFloorOverChancePts: top.trades >= MIN_TRADES ? top.score * 100 : null, probAboveChance: pa },
        historical: { trades: top.trades, rate: top.rate, chance },
        outOfSample: strat ? { validationRate: strat.validationPeriod.rate, validationQ: strat.validationPeriod.q, forwardTrades: fw?.trades ?? 0, forwardRate: fw?.rate ?? null } : null,
        suitability: { regime: top.regime, freshSeconds: secs, ticks: input.series[top.market]?.length ?? 0 },
        model: { version: MODEL_VERSION, learned: false },
    };
    const why: string[] = [];
    const block: string[] = [];
    if (!top.significant) block.push('No proven edge: it does not beat chance after false-discovery control, so there is no statistical reason to prefer this entry over any other.');
    if (top.trades < MIN_TRADES) block.push(`Only ${top.trades} past trades (needs ${MIN_TRADES}).`);
    if (top.regime !== 'STABLE') block.push(`Market regime is ${top.regime.toLowerCase().replace('_', ' ')}, so past behaviour is a poor guide right now.`);
    if (secs === null || secs > 15) block.push('Market data is stale.');
    if (!strat && top.significant) why.push('Baseline entry with statistical evidence but no validated strategy behind it.');
    if (strat) {
        if (strat.status !== 'ACTIVE') block.push(`Strategy ${strat.name} is ${strat.status.toLowerCase()}, not active.`);
        if (fw && fw.trades >= MIN_TRADES && fw.hi < fw.baseline) block.push('Its forward test is failing.');
    }
    if (dependence) why.push('Sequence agent saw serial dependence somewhere: treat pattern-based entries with extra caution.');
    if (!met) block.push(`Entry condition (${entryText(top)}) is not met on the latest tick.`);
    const enter = block.length === 0;
    const decision: Decision = {
        ...base,
        market: top.market,
        direction: top.direction,
        barrier: contractOf(top.direction).param,
        strategy: strat ? strat.name : `${top.entry} (baseline)`,
        strategyVersion: strat?.version ?? null,
        regime: top.regime,
        entryCondition: entryText(top),
        entryMetNow: met,
        decision: enter ? 'ENTER' : 'NO_TRADE',
        explanation: enter ? ['All gates passed: significant after false-discovery control, stable regime, fresh data, entry condition met now.', ...why, 'This is a measured edge on past ticks, not a prediction of the next digit.'] : [...block, ...why],
        validationStatus: strat ? 'VALIDATED_STRATEGY' : top.significant ? 'BASELINE_ENTRY' : 'NONE',
        evidence,
    };
    const rejected: Rejected[] = input.picks.slice(0, 8).filter(p => p !== top || !enter).map(p => {
        const r: string[] = [];
        if (!p.significant) r.push('not significant after false-discovery control');
        if (p.trades < MIN_TRADES) r.push(`only ${p.trades} trades`);
        if (p.regime !== 'STABLE') r.push(`regime ${p.regime.toLowerCase()}`);
        if (!entryMetNow(p, input.series)) r.push('entry not met on the latest tick');
        return { market: p.market, label: p.label, reasons: r.length ? r : ['outranked'] };
    });
    return { decision, rejected };
}
