// VANGUARD BOT RULES: the entry rules of the "Sentinel Under 7 Psychology" bot, run on every market's own digit history.
//
// This is a port of the bot's Blockly logic, not a re-interpretation of it. Every number below is the bot's number. The comments name
// the bot's own variables so each rule can be checked against the XML. What changes is only WHERE it runs: the bot watched one market;
// here every market is read separately and the first one to meet the rules is bought, through Sixfold's trade machinery.
//
// Per market, per tick (k = 1 is the newest digit, as `digit[-k]` is in the bot):
//   Recent_d   = how many of ticks 1..10 were digit d          Previous_d = ticks 11..30
//   Fast_d     = ticks 1..5                                    Slow_d     = ticks 6..10
//   Pressure_d = Recent_d/10 - Previous_d/20                   Momentum_d = Fast_d/5 - Slow_d/5
//   "Winning" digits are 0..6 (they win Under 7), "Losing" digits are 7, 8, 9.
//   Timing:  of ticks 1..8, how many were <= 6, how many >= 7, how many were an 8.
// Regime score (0..12): one point per true condition (see REGIME below). Entry needs ALL of:
//   score >= 10, Pressure Signal, no Attack Veto, Winning Active, Digit 8 Threat <= -0.1, last digit <= 6, psychology gate.
//
// Honest framing: these are descriptions of how the last 30 digits have looked. Deriv digits are generated randomly, so the rules
// choose WHEN to trade, not whether a trade is likely to win.
import type { RuleRow, RulesEngine, RuleOutcome } from '../sixfold/runner';

export const MIN_DIGITS = 31; // the windows reach back 30 ticks, and the gate reads the tick before the newest
export const GATE_HISTORY = 1000; // "P1000Ready": the bot waits for 1000 digits of history (or 1000 ticks counted)

/** How many of ticks `from..to` (1 = newest) were each digit. */
function count(digits: readonly number[], from: number, to: number): number[] {
    const out = new Array<number>(10).fill(0);
    const n = digits.length;
    for (let k = from; k <= to; k++) {
        const d = digits[n - k];
        if (d !== undefined && d >= 0 && d <= 9) out[d] += 1;
    }
    return out;
}
const sum = (a: readonly number[], ds: readonly number[]) => ds.reduce((t, d) => t + a[d], 0);
const WIN: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
const LOSE: readonly number[] = [7, 8, 9];

/** Values the bot carries from one tick to the next (V6 Prev ...). null = none yet, so every "change" comparison is false. */
export type Carry = { lp: number; lm: number; wm: number; d8: number } | null;

export type RuleCheck = { key: string; label: string; ok: boolean };

export type Evaluation = {
    /** Not enough digits yet to read anything. */
    ready: boolean;
    regimeScore: number;
    checks: RuleCheck[];
    /** True when every entry condition holds on this tick (the bot's before_purchase condition, minus the virtual-pending check). */
    entry: boolean;
    /** What to carry into the next tick. */
    next: Carry;
    /** The first thing that is not true, in plain words. */
    waitingOn: string;
    detail: { winningPressure: number; losingPressure: number; d8Threat: number; timingD8: number; winningRecent: number };
};

const BLANK: Evaluation['detail'] = { winningPressure: 0, losingPressure: 0, d8Threat: 0, timingD8: 0, winningRecent: 0 };

/** The 12 conditions that make the regime score. Order and thresholds are the bot's. */
export const REGIME = [
    'Winning Pressure above 0.05',
    'Winning Momentum above 0',
    'Losing Pressure below 0',
    'Losing Momentum below 0',
    'Relative Momentum above 0',
    'Digit 7 Threat at or below 0',
    'Digit 8 Threat at or below 0',
    'Digit 9 Threat at or below 0',
    'At least 5 of the last 8 ticks at 6 or lower',
    'At most 3 of the last 8 ticks at 7 or higher',
    'At most one 8 in the last 8 ticks',
    'At least 5 winning digits in the last 10 ticks',
] as const;

export function evaluateRules(digits: readonly number[], carry: Carry, opts: { gateMin: number; ticksSeen: number }): Evaluation {
    if (digits.length < MIN_DIGITS) {
        return {
            ready: false,
            regimeScore: 0,
            checks: [],
            entry: false,
            next: carry,
            waitingOn: `Collecting digits (${digits.length}/${MIN_DIGITS})`,
            detail: BLANK,
        };
    }
    const recent = count(digits, 1, 10);
    const previous = count(digits, 11, 30);
    const fast = count(digits, 1, 5);
    const slow = count(digits, 6, 10);
    const at = (k: number) => digits[digits.length - k];

    // Timing, over the last 8 ticks
    let timingWinning = 0;
    let timingLosing = 0;
    let timingD8 = 0;
    for (let k = 1; k <= 8; k++) {
        const d = at(k);
        if (d <= 6) timingWinning += 1;
        if (d >= 7) timingLosing += 1;
        if (d === 8) timingD8 += 1;
    }

    const winningRecent = sum(recent, WIN);
    const winningPrevious = sum(previous, WIN);
    const losingRecent = sum(recent, LOSE);
    const losingPrevious = sum(previous, LOSE);
    const pressure = (d: number) => recent[d] / 10 - previous[d] / 20;
    const momentum = (d: number) => fast[d] / 5 - slow[d] / 5;
    const winningPressure = winningRecent / 10 - winningPrevious / 20;
    const winningMomentum = sum(fast, WIN) / 35 - sum(slow, WIN) / 35;
    const losingPressure = losingRecent / 10 - losingPrevious / 20;
    const losingMomentum = sum(fast, LOSE) / 15 - sum(slow, LOSE) / 15;
    const relativeMomentum = winningMomentum - losingMomentum;
    const threat = (d: number) => pressure(d) + momentum(d) * 2;
    const t7 = threat(7);
    const t8 = threat(8);
    const t9 = threat(9);

    // Regime score: one point for each condition that holds
    const conditions = [
        winningPressure > 0.05,
        winningMomentum > 0,
        losingPressure < 0,
        losingMomentum < 0,
        relativeMomentum > 0,
        t7 <= 0,
        t8 <= 0,
        t9 <= 0,
        timingWinning >= 5,
        timingLosing <= 3,
        timingD8 <= 1,
        winningRecent >= 5,
    ];
    const regimeScore = conditions.filter(Boolean).length;
    const pressureSignal = regimeScore >= 9 && t8 <= 0.1 && timingD8 <= 1;

    // V6 changes against the previous tick. With no previous tick every comparison is false, as the bot's undefined values make it.
    const lpc = carry ? losingPressure - carry.lp : null;
    const lmc = carry ? losingMomentum - carry.lm : null;
    const wmc = carry ? winningMomentum - carry.wm : null;
    const d8c = carry ? t8 - carry.d8 : null;
    const gt = (x: number | null, y: number) => x !== null && x > y;

    const winningActive = winningPressure >= 0.05 && winningMomentum > 0 && wmc !== null && wmc >= 0 && winningRecent >= 5 && timingWinning >= 5;
    const attackVeto = t8 > 0.1 || (gt(d8c, 0) && momentum(8) > 0) || gt(lpc, 0.05) || (gt(lmc, 0) && losingPressure > -0.05);

    // Psychology gate. The bot reads the Fast/Slow counts left by the PREVIOUS tick, so they are taken one tick back here.
    const fastP = count(digits, 2, 6);
    const slowP = count(digits, 7, 11);
    const evenRise = [0, 2, 4, 6].filter(d => fastP[d] > slowP[d]).length;
    const oddWeak = [1, 3, 5].filter(d => fastP[d] < slowP[d]).length;
    const oddRise = [1, 3, 5, 7, 9].filter(d => fastP[d] > slowP[d]).length;
    const eightSafe = fastP[8] <= slowP[8];
    const historyReady = digits.length >= GATE_HISTORY || opts.ticksSeen >= GATE_HISTORY;
    const gate = historyReady && evenRise >= opts.gateMin && oddWeak >= opts.gateMin && oddRise >= opts.gateMin && eightSafe;

    const checks: RuleCheck[] = [
        { key: 'regime', label: `Regime score ${regimeScore}/12, needs 10`, ok: regimeScore >= 10 },
        { key: 'pressure', label: 'Pressure signal', ok: pressureSignal },
        { key: 'veto', label: 'No attack veto', ok: !attackVeto },
        { key: 'winning', label: 'Winning digits active', ok: winningActive },
        { key: 'd8', label: 'Digit 8 threat at or below -0.1', ok: t8 <= -0.1 },
        { key: 'last', label: 'Last digit 6 or lower', ok: at(1) <= 6 },
        { key: 'gate', label: historyReady ? 'Psychology gate' : 'Psychology gate (waiting for 1,000 digits)', ok: gate },
    ];
    const first = checks.find(c => !c.ok);
    return {
        ready: true,
        regimeScore,
        checks,
        entry: !first,
        next: { lp: losingPressure, lm: losingMomentum, wm: winningMomentum, d8: t8 },
        waitingOn: first ? first.label : 'All conditions met',
        detail: { winningPressure, losingPressure, d8Threat: t8, timingD8, winningRecent },
    };
}

// ---------------- the engine the runner calls ----------------

export type RulesConfig = { virtualMode: boolean; virtualLosses: number; gateMin: number };

type MarketState = { carry: Carry; ticksSeen: number; last: Evaluation | null; lastDigit: number | null };

/** A paper trade waiting for the next tick of its market, as the bot's V7 Virtual Pending. */
const PENDING_TIMEOUT_MS = 30_000;

export class BotRules implements RulesEngine {
    private markets = new Map<string, MarketState>();
    private paper = true; // the bot starts by paper-trading
    private paperLosses = 0;
    private pending: { symbol: string; prediction: number; at: number } | null = null;

    constructor(private config: () => RulesConfig = () => ({ virtualMode: true, virtualLosses: 2, gateMin: 1 })) {}

    /** Point the engine at live settings (done once the runner that owns them exists). */
    useConfig(config: () => RulesConfig) {
        this.config = config;
    }

    private state(symbol: string): MarketState {
        let s = this.markets.get(symbol);
        if (!s) {
            s = { carry: null, ticksSeen: 0, last: null, lastDigit: null };
            this.markets.set(symbol, s);
        }
        return s;
    }

    reset() {
        this.markets.clear();
        this.paper = this.config().virtualMode;
        this.paperLosses = 0;
        this.pending = null;
    }

    onTick(symbol: string, series: readonly number[], ctx: { live: boolean; idle: boolean; prediction: number; now: number }): RuleOutcome {
        const cfg = this.config();
        const st = this.state(symbol);
        st.ticksSeen += 1;
        const ev = evaluateRules(series, st.carry, { gateMin: cfg.gateMin, ticksSeen: st.ticksSeen });
        st.carry = ev.next;
        st.last = ev;
        st.lastDigit = series.length ? series[series.length - 1] : null;
        const events: string[] = [];
        if (!ctx.live) return { enter: false, events };

        // Resolve a waiting paper trade on its own market's next tick (the bot's "V7 Virtual Pending" block).
        if (this.pending) {
            if (ctx.now - this.pending.at > PENDING_TIMEOUT_MS) {
                events.push(`Paper trade on ${this.pending.symbol} timed out without a tick; cleared.`);
                this.pending = null;
            } else if (this.pending.symbol === symbol && st.lastDigit !== null) {
                const lost = st.lastDigit >= this.pending.prediction;
                const waiting = this.pending;
                this.pending = null;
                if (lost) {
                    this.paperLosses += 1;
                    events.push(`Paper trade on ${symbol} lost (digit ${st.lastDigit}, needed under ${waiting.prediction}). Paper losses ${this.paperLosses}/${cfg.virtualLosses}.`);
                    if (this.paperLosses >= cfg.virtualLosses) {
                        this.paper = false;
                        this.paperLosses = 0;
                        events.push('Enough paper losses: the next signal is bought for real.');
                    }
                } else {
                    events.push(`Paper trade on ${symbol} won (digit ${st.lastDigit}).`);
                }
            }
        }

        if (!ev.ready || !ev.entry || !ctx.idle || this.pending) return { enter: false, events };

        if (cfg.virtualMode && this.paper) {
            this.pending = { symbol, prediction: ctx.prediction, at: ctx.now };
            events.push(`Signal on ${symbol}: taken as a paper trade (under ${ctx.prediction}), not bought.`);
            return { enter: false, events };
        }
        return { enter: true, events };
    }

    /** A real trade finished. A win sends the bot back to paper mode, as the bot does. */
    onResult(won: boolean) {
        if (won && this.config().virtualMode) {
            this.paper = true;
            this.paperLosses = 0;
            this.pending = null;
        }
    }

    board(symbols: readonly string[], nameOf: (s: string) => string): RuleRow[] {
        return symbols.map(symbol => {
            const st = this.markets.get(symbol);
            const ev = st?.last ?? null;
            return {
                symbol,
                name: nameOf(symbol),
                ready: Boolean(ev?.ready),
                score: ev?.ready ? ev.regimeScore : null,
                checks: ev?.checks ?? [],
                entry: Boolean(ev?.entry),
                waitingOn: ev ? ev.waitingOn : 'Waiting for ticks',
                lastDigit: st?.lastDigit ?? null,
            };
        });
    }

    paperState() {
        return { paper: this.paper && this.config().virtualMode, losses: this.paperLosses, needed: this.config().virtualLosses, pending: this.pending?.symbol ?? null };
    }
}
