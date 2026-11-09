// ORACLE OVER / UNDER ENGINE. Pure and framework-free.
//
// One contract on one market is read through the best engines of the four tools Oracle was built from:
//
//   SENTINEL AI  Pulse           four-window win rate against the fair rate (sentinel/pulse)
//                Kalman health   filtered win rate, drift and remaining life (sentinel/edge/kalman)
//                Special digits  digit 1 / digit 8 rule (sentinel/special-digits)
//   SIXFOLD      Losing side     pressure of the digits that lose the contract (sixfold/pressure)
//                Winning side    the winning digits must be gaining share across nested windows (sixfold/pressure)
//                Multi-window    60/120/240/480-tick consistency (sixfold/pressure)
//                Meter           COLD / HOT / TURNING regime of the last 30 ticks (sixfold/regime)
//                Viability       DBot-style simulated trades: TRAP / HOSTILE / VIABLE (sixfold/bot + viability)
//   APEX INTEL   Regime          shift test + CUSUM + uniformity: STABLE / CHANGING / UNUSUAL / UNSTABLE (ai-intel/analysis)
//   VANGUARD     Regime score    the 12-condition score of the Under 7 / Over 2 bot, for those two contracts (vanguard/bot-rules)
//
// Every layer returns ok / not ok, a 0-100 score and a plain-language reason. Some layers are HARD: when one of them
// says no (hostile losing side, cold meter, unstable regime, dying signal, trap) the contract is never signalled.
//   STRONG  every required layer is ok.
//   BEST    no hard layer objects; the contract is the best-scoring one available, but not every layer agrees.
//
// Honest limit: Deriv digits are generated randomly. A contract that has been winning is no more likely to win next, and
// every contract pays less than its fair odds. These engines rank how healthy a contract has been and avoid the moments
// the operator's tools flag as costly. They cannot create an edge.
import { type Contract, contractLabel, DEFAULT_BOT, simulateBot } from '../../sixfold/bot';
import {
    losingSidePressure,
    multiWindowGate,
    multiWindowHealth,
    pressureGate,
    winningSideGate,
    winningSidePressure,
} from '../../sixfold/pressure';
import { regimeCell } from '../../sixfold/regime';
import { assessRun } from '../../sixfold/viability';
import { classifyRegime } from '../../ai-intel/analysis';
import { judgeHealth, readHealth } from '../../sentinel/edge/kalman';
import { readContract } from '../../sentinel/pulse';
import { readSpecialDigits } from '../../sentinel/special-digits';
import { evaluateRules } from '../../vanguard/bot-rules';

/** Contracts Oracle trades: Over 1-4 and Under 5-8. */
export const OU_CONTRACTS: readonly Contract[] = [
    ...[1, 2, 3, 4].map(param => ({ side: 'OVER' as const, param })),
    ...[5, 6, 7, 8].map(param => ({ side: 'UNDER' as const, param })),
];

/** Pulse's own minimum; with fewer ticks no layer can be read. */
export const OU_MIN_TICKS = 300;
/** Longest history the simulator replays. */
const SIM_TICKS = 1000;

export type LayerKey =
    | 'pulse'
    | 'kalman'
    | 'special'
    | 'losing'
    | 'winning'
    | 'multi'
    | 'meter'
    | 'apex'
    | 'viability'
    | 'vanguard';

export type Layer = {
    key: LayerKey;
    engine: 'Sentinel AI' | 'Sixfold' | 'Apex Intel' | 'Vanguard';
    label: string;
    ok: boolean;
    /** When true and not ok, the contract is never signalled. */
    hard: boolean;
    /** Must be ok for a STRONG signal. */
    required: boolean;
    /** 0-100. */
    score: number;
    weight: number;
    detail: string;
};

export type Tier = 'STRONG' | 'BEST';

export type OverUnderRead = {
    symbol: string;
    contract: Contract;
    side: 'OVER' | 'UNDER';
    barrier: number;
    label: string;
    layers: Layer[];
    /** Weighted 0-100 across the layers that apply. */
    score: number;
    vetoed: boolean;
    vetoReason: string;
    /** null = vetoed. */
    tier: Tier | null;
};

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function readOverUnder(symbol: string, digits: readonly number[], contract: Contract): OverUnderRead | null {
    if (digits.length < OU_MIN_TICKS) return null;
    if (contract.side !== 'OVER' && contract.side !== 'UNDER') return null;
    const layers: Layer[] = [];

    // ---- Sentinel AI: Pulse
    const pulse = readContract(symbol, digits, contract);
    layers.push({
        key: 'pulse',
        engine: 'Sentinel AI',
        label: 'Pulse: winning above fair across windows',
        ok: pulse.tier !== null,
        hard: false,
        required: true,
        score: pulse.score,
        weight: 0.18,
        detail: pulse.tier
            ? `${pulse.tier}: ${pulse.agree} of 4 windows above ${pct(pulse.fair)}`
            : `only ${pulse.agree} of 4 windows above ${pct(pulse.fair)}`,
    });

    // ---- Sentinel AI: Kalman health
    const health = readHealth(digits, contract);
    const call = judgeHealth(health, { hunter: false, recovering: false });
    layers.push({
        key: 'kalman',
        engine: 'Sentinel AI',
        label: 'Kalman: filtered rate is healthy',
        ok: call.allow,
        hard: !call.allow,
        required: true,
        score: health.ready ? clamp(50 + call.rank * 12.5) : 50,
        weight: 0.12,
        detail: health.ready
            ? `filtered ${pct(health.level)} (fair ${pct(health.fair)}), ${health.trend}${call.note ? `; ${call.note}` : ''}`
            : `warming up (${health.blocks} blocks)`,
    });

    // ---- Sentinel AI: special digits 1 / 8
    const special = readSpecialDigits(digits, contract.side);
    layers.push({
        key: 'special',
        engine: 'Sentinel AI',
        label: `Digit ${special.watched} quiet, digit ${special.mirror} rising`,
        ok: special.ok,
        hard: false,
        required: true,
        score: special.ok ? 100 : 30,
        weight: 0.06,
        detail: special.note,
    });

    // ---- Sixfold: losing-side pressure
    const losing = losingSidePressure(digits, contract);
    const losingGate = pressureGate(losing);
    layers.push({
        key: 'losing',
        engine: 'Sixfold',
        label: 'Losing side is quiet',
        ok: losingGate.ok,
        hard: losing.verdict === 'SUPPRESS',
        required: true,
        score: losing.measurable ? clamp(100 - losing.index) : 50,
        weight: 0.12,
        detail: losing.measurable ? `pressure ${losing.index}/100 (${losing.state.toLowerCase()})` : losing.reason,
    });

    // ---- Sixfold: winning-side pressure
    const winning = winningSidePressure(digits, contract);
    const winningGate = winningSideGate(winning);
    layers.push({
        key: 'winning',
        engine: 'Sixfold',
        label: 'Winning side is building',
        ok: winningGate.ok,
        hard: false,
        required: true,
        score: !winning.measurable ? 50 : winning.state === 'RISING' ? 100 : winning.state === 'DORMANT' ? 45 : 10,
        weight: 0.12,
        detail: winning.measurable ? `${winning.state.toLowerCase()}: ${winning.groupPct.map(x => `${x.toFixed(0)}%`).join(' > ')}` : winning.reason,
    });

    // ---- Sixfold: multi-window health
    const multi = multiWindowHealth(digits, contract);
    const multiOk = multiWindowGate(multi);
    const multiScore: Record<string, number> = { CONSISTENT: 100, LOADING: 50, THRUST: 40, FADING: 30, WEAK: 10 };
    layers.push({
        key: 'multi',
        engine: 'Sixfold',
        label: 'Healthy across 60 to 480 ticks',
        ok: multiOk.ok,
        hard: false,
        required: true,
        score: multiScore[multi.verdict] ?? 50,
        weight: 0.12,
        detail: multi.verdict === 'LOADING' ? 'loading' : multi.verdict.toLowerCase(),
    });

    // ---- Sixfold: meter regime
    const meter = regimeCell(symbol, digits, contract);
    layers.push({
        key: 'meter',
        engine: 'Sixfold',
        label: 'Meter is not cold',
        ok: !meter || meter.state !== 'COLD',
        hard: !!meter && meter.state === 'COLD',
        required: true,
        score: meter ? meter.strength : 50,
        weight: 0.08,
        detail: meter ? `${meter.state.toLowerCase()}, last 30 ticks won ${pct(meter.rate)}` : 'not enough ticks',
    });

    // ---- Sixfold: viability of a simulated DBot
    const run = simulateBot(digits.slice(-SIM_TICKS), contract, DEFAULT_BOT);
    const viability = assessRun(run);
    const viabilityScore: Record<string, number> = { VIABLE: 100, STEADY: 60, WARMING: 50, UNSTABLE: 35, TRAP: 0, HOSTILE: 0 };
    layers.push({
        key: 'viability',
        engine: 'Sixfold',
        label: 'Simulated bot is not trapped or hostile',
        ok: viability.state !== 'TRAP' && viability.state !== 'HOSTILE' && viability.state !== 'UNSTABLE',
        hard: viability.state === 'TRAP' || viability.state === 'HOSTILE',
        required: true,
        score: viabilityScore[viability.state] ?? 50,
        weight: 0.08,
        detail: `${viability.state.toLowerCase()}${viability.reasons[0] ? `: ${viability.reasons[0]}` : ''}`,
    });

    // ---- Apex Intel: regime
    const regime = classifyRegime(digits, contract);
    const regimeScore: Record<string, number> = { STABLE: 100, CHANGING: 60, UNUSUAL: 50, INSUFFICIENT_DATA: 50, UNSTABLE: 0 };
    layers.push({
        key: 'apex',
        engine: 'Apex Intel',
        label: 'Regime is stable',
        ok: regime.regime === 'STABLE' || regime.regime === 'INSUFFICIENT_DATA',
        hard: regime.regime === 'UNSTABLE',
        required: true,
        score: regimeScore[regime.regime] ?? 50,
        weight: 0.06,
        detail: `${regime.regime.toLowerCase().replace('_', ' ')}: ${regime.reason}`,
    });

    // ---- Vanguard: 12-condition regime score, only for the two contracts the bot was written for
    const vanguardSide = contract.side === 'UNDER' && contract.param === 7 ? 'UNDER' : contract.side === 'OVER' && contract.param === 2 ? 'OVER' : null;
    if (vanguardSide) {
        const ev = evaluateRules(digits, null, { gateMin: 1, ticksSeen: digits.length, side: vanguardSide, historyLength: digits.length });
        layers.push({
            key: 'vanguard',
            engine: 'Vanguard',
            label: 'Vanguard regime score is high',
            ok: ev.regimeScore >= 9,
            hard: false,
            required: false,
            score: (ev.regimeScore / 12) * 100,
            weight: 0.06,
            detail: `${ev.regimeScore}/12 conditions${ev.entry ? ', entry rules met' : ''}`,
        });
    }

    const wTotal = layers.reduce((t, l) => t + l.weight, 0);
    const score = round1(layers.reduce((t, l) => t + l.weight * l.score, 0) / wTotal);
    const hard = layers.find(l => l.hard && !l.ok);
    const allRequired = layers.every(l => !l.required || l.ok);
    return {
        symbol,
        contract,
        side: contract.side,
        barrier: contract.param,
        label: contractLabel(contract),
        layers,
        score,
        vetoed: !!hard,
        vetoReason: hard ? `${hard.engine}: ${hard.label.toLowerCase()} failed (${hard.detail})` : '',
        tier: hard ? null : allRequired ? 'STRONG' : 'BEST',
    };
}

/** Every contract on every market that has enough ticks, best first (STRONG before BEST, then by score). */
export function scanOverUnder(
    series: Readonly<Record<string, readonly number[]>>,
    symbols: readonly string[],
    contracts: readonly Contract[] = OU_CONTRACTS
): OverUnderRead[] {
    const out: OverUnderRead[] = [];
    for (const symbol of symbols) {
        const digits = series[symbol];
        if (!digits) continue;
        for (const c of contracts) {
            const read = readOverUnder(symbol, digits, c);
            if (read) out.push(read);
        }
    }
    return out.sort((a, b) => Number(b.tier === 'STRONG') - Number(a.tier === 'STRONG') || b.score - a.score);
}

