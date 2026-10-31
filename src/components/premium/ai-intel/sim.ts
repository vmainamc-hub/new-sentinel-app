// AI Intel virtual contract simulator, Sixfold-compatible and deterministic. Pure functions and classes, no I/O.
//
// It follows the rules that `sixfold/entry-lab.ts` (`walkForward`) and the runner's virtual trades already use:
//   1. A trigger digit prints at tick i (the "setup"). A setup is NOT a trade and can never be a loss.
//   2. The contract is bought after tick i, so it ENTERS on the next tick, i + 1.
//   3. It stays open for `duration` ticks and SETTLES on tick i + duration (for a 1-tick contract the entry tick and the
//      settlement tick are the same tick).
//   4. The settlement tick is consumed: it can never be the trigger of the next contract. The next trigger is looked for
//      from tick i + duration + 1.
//   5. Only the settlement digit decides WIN or LOSS (OVER 2 wins on 3-9, UNDER 7 wins on 0-6).
//   6. One contract per stream at a time. Many streams (strategies, markets) run side by side and never share state.
// Decisions only ever see ticks up to and including the trigger tick, so nothing here can leak future data.
import { type Contract, losingDigits, winningDigits } from '@/components/premium/sixfold/bot';

export type Tick = { digit: number; epoch: number };

export const OVER_2: Contract = { side: 'OVER', param: 2 };
export const UNDER_7: Contract = { side: 'UNDER', param: 7 };

export type EntryMethod = 'SETUP' | 'ANY' | 'CUSTOM' | 'SMART';

export type EntryRule =
    /** Trigger on a digit that does NOT win the contract (Sixfold's SETUP). */
    | { method: 'SETUP' }
    /** Trigger on the first tick after the stream is free. */
    | { method: 'ANY' }
    /** Trigger on any digit of an explicit set. */
    | { method: 'CUSTOM'; digits: readonly number[] }
    /**
     * Evidence-driven entry. `trigger` receives the digits up to and including the current tick (never beyond it) and
     * decides if this tick arms a contract. Generated strategies use this form.
     */
    | { method: 'SMART'; trigger: (history: readonly number[]) => boolean };

export const MAX_DURATION = 10;
/** Same bounds as Sixfold's walkForward. */
export const clampDuration = (duration: number): number => Math.max(1, Math.min(MAX_DURATION, Math.trunc(duration) || 1));

export type SimTrade = {
    /** 0-based sequence number of the trade in its stream. */
    seq: number;
    contract: Contract;
    method: EntryMethod;
    duration: number;
    triggerIndex: number;
    triggerDigit: number;
    triggerEpoch: number;
    entryIndex: number;
    entryDigit: number;
    entryEpoch: number;
    settleIndex: number;
    settleDigit: number;
    settleEpoch: number;
    won: boolean;
};

export type SimEvent =
    | { kind: 'triggered'; triggerIndex: number; triggerDigit: number; entryIndex: number; settleIndex: number }
    | { kind: 'entered'; entryIndex: number; entryDigit: number }
    | { kind: 'settled'; trade: SimTrade };

type Open = {
    triggerIndex: number;
    triggerDigit: number;
    triggerEpoch: number;
    entryIndex: number;
    settleIndex: number;
    entryDigit: number | null;
    entryEpoch: number | null;
};

/** Ticks of history a SMART trigger can read. */
export const SIM_HISTORY = 600;

export class SimStream {
    readonly duration: number;
    private readonly winning: ReadonlySet<number>;
    private readonly triggers: ReadonlySet<number> | null;
    private index = -1;
    private open: Open | null = null;
    private hist: number[] = [];
    private seq = 0;

    constructor(
        readonly contract: Contract,
        readonly rule: EntryRule,
        duration: number
    ) {
        if (contract.dynamic) throw new Error('SimStream supports fixed-barrier contracts only');
        this.duration = clampDuration(duration);
        this.winning = new Set(winningDigits(contract));
        this.triggers =
            rule.method === 'SETUP'
                ? new Set(losingDigits(contract))
                : rule.method === 'CUSTOM'
                  ? new Set(rule.digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9))
                  : null;
    }

    get hasOpenContract(): boolean {
        return this.open !== null;
    }

    /** The open contract, if any (entry fields are null until the entry tick has printed). */
    get openContract(): Readonly<Open> | null {
        return this.open;
    }

    get ticksSeen(): number {
        return this.index + 1;
    }

    private fires(digit: number): boolean {
        switch (this.rule.method) {
            case 'ANY':
                return true;
            case 'SMART':
                return this.rule.trigger(this.hist);
            default:
                return this.triggers?.has(digit) ?? false;
        }
    }

    /** Feed one tick. Returns what happened on it, in order. */
    push(tick: Tick): SimEvent[] {
        if (!Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9) throw new Error(`Invalid digit ${tick.digit}`);
        this.index += 1;
        this.hist.push(tick.digit);
        if (this.hist.length > SIM_HISTORY) this.hist.shift();
        const events: SimEvent[] = [];
        const o = this.open;
        if (o) {
            if (this.index === o.entryIndex) {
                o.entryDigit = tick.digit;
                o.entryEpoch = tick.epoch;
                events.push({ kind: 'entered', entryIndex: o.entryIndex, entryDigit: tick.digit });
            }
            if (this.index === o.settleIndex) {
                const trade: SimTrade = {
                    seq: this.seq++,
                    contract: this.contract,
                    method: this.rule.method,
                    duration: this.duration,
                    triggerIndex: o.triggerIndex,
                    triggerDigit: o.triggerDigit,
                    triggerEpoch: o.triggerEpoch,
                    entryIndex: o.entryIndex,
                    entryDigit: o.entryDigit ?? tick.digit,
                    entryEpoch: o.entryEpoch ?? tick.epoch,
                    settleIndex: o.settleIndex,
                    settleDigit: tick.digit,
                    settleEpoch: tick.epoch,
                    won: this.winning.has(tick.digit),
                };
                this.open = null;
                events.push({ kind: 'settled', trade });
            }
            // Open contract or the settlement tick: this tick is never a trigger.
            return events;
        }
        if (this.fires(tick.digit)) {
            this.open = {
                triggerIndex: this.index,
                triggerDigit: tick.digit,
                triggerEpoch: tick.epoch,
                entryIndex: this.index + 1,
                settleIndex: this.index + this.duration,
                entryDigit: null,
                entryEpoch: null,
            };
            events.push({
                kind: 'triggered',
                triggerIndex: this.index,
                triggerDigit: tick.digit,
                entryIndex: this.index + 1,
                settleIndex: this.index + this.duration,
            });
        }
        return events;
    }
}

export type SimResult = {
    trades: SimTrade[];
    /** A contract still open when the ticks ran out. It is not a result and is never counted. */
    pending: Readonly<Open> | null;
};

/** Replay a tick list through one stream. */
export function simulate(ticks: readonly Tick[], contract: Contract, rule: EntryRule, duration: number): SimResult {
    const stream = new SimStream(contract, rule, duration);
    const trades: SimTrade[] = [];
    for (const t of ticks) for (const e of stream.push(t)) if (e.kind === 'settled') trades.push(e.trade);
    return { trades, pending: stream.openContract ? { ...stream.openContract } : null };
}

/** Digits only, with the tick index as a stand-in epoch. For tests and for analysis that has no clock. */
export const ticksFromDigits = (digits: readonly number[], startEpoch = 0): Tick[] =>
    digits.map((digit, i) => ({ digit, epoch: startEpoch + i }));

export type SimStats = { trades: number; wins: number; losses: number; rate: number | null };
export const tally = (trades: readonly SimTrade[]): SimStats => {
    const wins = trades.filter(t => t.won).length;
    return { trades: trades.length, wins, losses: trades.length - wins, rate: trades.length ? wins / trades.length : null };
};

/**
 * Many independent streams over live ticks (strategies x markets x directions). Each stream owns its state, so one
 * strategy's open contract never affects another's.
 */
export class SimBook {
    private streams = new Map<string, { market: string; stream: SimStream }>();

    add(id: string, market: string, stream: SimStream): void {
        if (this.streams.has(id)) throw new Error(`Stream ${id} already exists`);
        this.streams.set(id, { market, stream });
    }

    remove(id: string): boolean {
        return this.streams.delete(id);
    }

    has(id: string): boolean {
        return this.streams.has(id);
    }

    get(id: string): SimStream | undefined {
        return this.streams.get(id)?.stream;
    }

    get size(): number {
        return this.streams.size;
    }

    /** Route one tick of `market` to every stream on that market. */
    push(market: string, tick: Tick): Array<{ id: string; event: SimEvent }> {
        const out: Array<{ id: string; event: SimEvent }> = [];
        for (const [id, s] of this.streams) {
            if (s.market !== market) continue;
            for (const event of s.stream.push(tick)) out.push({ id, event });
        }
        return out;
    }
}
