// APEX INTEL: the Entry Digit Lab. It replaces the old "work the digit out once, keep it for a minute" memory.
//
// Deriv moves on every tick, so one digit cannot be the entry for a stretch of trades. The lab is a shadow simulator that never
// stops (the idea of the Entry Condition Lab in the Sentinel Parity Hub, applied to entry digits):
//
//   * Every tick of every market goes in. For each market x contract it keeps ten candidate rules, "enter right after digit e
//     prints", and a ledger of how each rule's shadow entries ended.
//   * A shadow entry opened on tick t settles on the real digit `duration` ticks later and never before, so nothing here sees
//     the future. The history the feed already holds is replayed through the SAME step as live ticks, so a market is warm at once.
//   * Every candidate is re-scored on every tick. Recent entries weigh more than old ones (half-life HALF_LIFE entries), the
//     newest 40% must agree with the rest, and a digit that has just lost COLD_RUN times in a row is cooling and is not used.
//   * The digit in use is the best one that currently holds up. It is replaced when another is clearly better (hysteresis) or when
//     it stops holding up. When none holds up there is NO entry digit and the executor stands aside.
//   * Real and paper results feed back: BENCH_LOSSES losses in a row on one digit bench it on that market for BENCH_TICKS ticks.
//
// Honest limit: Deriv's synthetic digits are random. The best of ten digits always looks good in the past, so this chooses WHEN
// to enter from what the market is doing now. It cannot make a contract more likely to win.
import { SCAN_SPECS, type ScanSpec } from '@/components/premium/bulk-scan';

export type DigitState = 'confirmed' | 'leading' | 'weak' | 'cooling' | 'benched' | 'thin';

export type LabParams = {
    /** Shadow entries kept per digit (the oldest are dropped). */
    ledgerCap: number;
    /** An entry this many entries old counts half as much as the newest. */
    halfLife: number;
    /** Fewest shadow entries before a digit may be judged. */
    minN: number;
    /** Recency-weighted z a digit needs to be "leading" (usable). 1.28 is a one-sided 10%. */
    zLead: number;
    /** ...and to be "confirmed" (the best of ten digits beats luck, Bonferroni 5%). */
    zConfirm: number;
    /** The newest share of a digit's entries that must also beat the fair rate. */
    checkFraction: number;
    minCheckN: number;
    /** This many losses in a row on the digit's newest shadow entries: it is cooling. */
    coldRun: number;
    /** This many real/paper losses in a row on one digit: it is benched on that market. */
    benchLosses: number;
    /** ...for this many ticks of that market. */
    benchTicks: number;
    /** A challenger must beat the digit in use by this much z to replace it while that digit still holds up. */
    hysteresis: number;
    /** Ticks a market needs before the lab reads it. */
    minTicks: number;
    /** Ticks of history kept per market. */
    tailCap: number;
};

export const LAB_DEFAULTS: LabParams = {
    ledgerCap: 240,
    halfLife: 40,
    minN: 20,
    zLead: 1.28,
    zConfirm: 2.58,
    checkFraction: 0.4,
    minCheckN: 8,
    coldRun: 3,
    benchLosses: 2,
    benchTicks: 90,
    hysteresis: 0.35,
    minTicks: 300,
    tailCap: 2200,
};

export type DigitRead = {
    digit: number;
    /** Shadow entries in the ledger. */
    n: number;
    /** Recency-weighted win rate (0..1). */
    rate: number;
    /** Recency-weighted distance above the fair rate, in standard errors. */
    z: number;
    /** The newest share of entries, the check. */
    checkN: number;
    checkRate: number;
    state: DigitState;
    /** The digit the lab is using now. */
    current: boolean;
};

export type LabView = {
    market: string;
    label: string;
    fair: number;
    /** Ticks the lab has read on this market since it started (replayed history included). */
    ticks: number;
    rows: DigitRead[];
    /** The digit in use, or null when none holds up. */
    current: number | null;
    /** Ticks it has been the digit in use. */
    heldTicks: number;
    /** How many times the digit in use was replaced. */
    switches: number;
};

export type LabChoice = {
    digit: number;
    state: DigitState;
    /** True when the digit holds up now (confirmed or leading): only then does the executor trade on it. */
    tradable: boolean;
    n: number;
    rate: number;
    z: number;
    checkN: number;
    checkRate: number;
    heldTicks: number;
    fair: number;
    note: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** One digit's ledger, read on the newest data. Pure. */
export const readOutcomes = (
    outcomes: readonly number[],
    fair: number,
    p: LabParams
): { n: number; rate: number; z: number; checkN: number; checkRate: number; cold: boolean } => {
    const n = outcomes.length;
    const decay = Math.pow(0.5, 1 / Math.max(1, p.halfLife));
    let w = 1;
    let sw = 0;
    let sww = 0;
    let sx = 0;
    for (let i = n - 1; i >= 0; i -= 1) {
        sw += w;
        sww += w * w;
        sx += w * outcomes[i];
        w *= decay;
    }
    const rate = sw > 0 ? sx / sw : 0;
    const neff = sww > 0 ? (sw * sw) / sww : 0;
    const sd = Math.sqrt((fair * (1 - fair)) / Math.max(1, neff));
    const z = neff > 0 ? (rate - fair) / sd : 0;
    const checkN = Math.floor(n * p.checkFraction);
    let cw = 0;
    for (let i = n - checkN; i < n; i += 1) cw += outcomes[i];
    const cold = n >= p.coldRun && outcomes.slice(n - p.coldRun).every(o => o === 0);
    return { n, rate, z, checkN, checkRate: checkN ? cw / checkN : 0, cold };
};

type Pending = { digit: number; due: number };
type Combo = {
    spec: ScanSpec;
    duration: number;
    ledger: number[][];
    pending: Pending[];
    /** Absolute market tick until which each digit is benched. */
    benchUntil: number[];
    /** Real/paper losses in a row per digit. */
    liveLosses: number[];
    incumbent: number | null;
    since: number;
    switches: number;
    cache: { version: number; value: LabChoice | null } | null;
};
type Market = { digits: number[]; tick: number; version: number; combos: Map<string, Combo> };

const specOf = (contract: { side: string; param: number }): ScanSpec | undefined => {
    if (contract.side !== 'OVER' && contract.side !== 'UNDER') return undefined; // the lab reads the six Over / Under contracts
    return SCAN_SPECS.find(
        s => s.contract === (contract.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER') && s.barrier === contract.param
    );
};

export class EntryDigitLab {
    readonly params: LabParams;
    private markets = new Map<string, Market>();

    constructor(params: Partial<LabParams> = {}) {
        this.params = { ...LAB_DEFAULTS, ...params };
    }

    has(market: string): boolean {
        return this.markets.has(market);
    }

    /** Ticks the lab has read on a market (0 when it has not seen it). */
    ticksOf(market: string): number {
        return this.markets.get(market)?.tick ?? 0;
    }

    /** True when the lab's own copy of a market ends with the same digits as `series` (so it has not missed or repeated a tick). */
    matches(market: string, series: readonly number[]): boolean {
        const m = this.markets.get(market);
        if (!m || m.digits.length === 0 || series.length === 0) return false;
        const k = Math.min(12, m.digits.length, series.length);
        for (let i = 1; i <= k; i += 1) if (m.digits[m.digits.length - i] !== series[series.length - i]) return false;
        return true;
    }

    /** Replace a market's history (first sight, or after a reconnect) and replay it. What was learned about it before is dropped. */
    load(market: string, series: readonly number[]): void {
        const digits = series.slice(-this.params.tailCap);
        const m: Market = { digits: [], tick: 0, version: 0, combos: new Map() };
        this.markets.set(market, m);
        for (const d of digits) {
            m.tick += 1;
            m.digits.push(d);
        }
        m.version += 1;
    }

    /** One new tick of a market the lab already holds: every watched contract's shadow entries move on. */
    observe(market: string, digit: number): void {
        const m = this.markets.get(market);
        if (!m || !Number.isInteger(digit) || digit < 0 || digit > 9) return;
        m.tick += 1;
        m.digits.push(digit);
        if (m.digits.length > this.params.tailCap + 100) m.digits.splice(0, m.digits.length - this.params.tailCap);
        for (const c of m.combos.values()) this.feed(c, m.tick, digit);
        m.version += 1;
    }

    /** The shared step: entries due on this tick settle on its digit, then this digit opens a new one. Live ticks and replay both use it. */
    private feed(c: Combo, tick: number, digit: number): void {
        while (c.pending.length > 0 && c.pending[0].due <= tick) {
            const e = c.pending.shift() as Pending;
            const ledger = c.ledger[e.digit];
            ledger.push(c.spec.winners.includes(digit) ? 1 : 0);
            if (ledger.length > this.params.ledgerCap) ledger.shift();
        }
        c.pending.push({ digit, due: tick + c.duration });
    }

    private combo(m: Market, spec: ScanSpec, duration: number): Combo {
        const key = `${spec.label}|${duration}`;
        const found = m.combos.get(key);
        if (found) return found;
        const c: Combo = {
            spec,
            duration,
            ledger: Array.from({ length: 10 }, () => []),
            pending: [],
            benchUntil: new Array(10).fill(0),
            liveLosses: new Array(10).fill(0),
            incumbent: null,
            since: m.tick,
            switches: 0,
            cache: null,
        };
        const first = m.tick - m.digits.length;
        m.digits.forEach((d, i) => this.feed(c, first + i + 1, d));
        m.combos.set(key, c);
        return c;
    }

    private readAll(m: Market, c: Combo): DigitRead[] {
        const p = this.params;
        return Array.from({ length: 10 }, (_, digit) => {
            const r = readOutcomes(c.ledger[digit], c.spec.fair, p);
            const checkOk = r.checkN >= p.minCheckN && r.checkRate >= c.spec.fair;
            const state: DigitState =
                m.tick < c.benchUntil[digit]
                    ? 'benched'
                    : r.n < p.minN
                      ? 'thin'
                      : r.cold
                        ? 'cooling'
                        : r.z >= p.zConfirm && checkOk
                          ? 'confirmed'
                          : r.z >= p.zLead && checkOk
                            ? 'leading'
                            : 'weak';
            return {
                digit,
                n: r.n,
                rate: r.rate,
                z: r.z,
                checkN: r.checkN,
                checkRate: r.checkRate,
                state,
                current: c.incumbent === digit,
            };
        });
    }

    /**
     * The entry digit for a contract on a market, weighed against everything up to the newest tick. Null while the market has too
     * little history. A digit with `tradable: false` is only the best of a poor lot, shown but not to be traded.
     */
    choose(market: string, contract: { side: string; param: number }, duration: number): LabChoice | null {
        const m = this.markets.get(market);
        const spec = specOf(contract);
        if (!m || !spec || m.digits.length < this.params.minTicks) return null;
        const c = this.combo(m, spec, clamp(Math.round(duration) || 1, 1, 10));
        if (c.cache && c.cache.version === m.version) return c.cache.value;
        const p = this.params;
        const reads = this.readAll(m, c);
        const usable = reads.filter(r => r.state === 'confirmed' || r.state === 'leading');
        let pick: DigitRead | null;
        if (usable.length > 0) {
            const best = usable.reduce((a, b) => (b.z > a.z ? b : a));
            const inc = c.incumbent === null ? undefined : usable.find(r => r.digit === c.incumbent);
            pick = inc && best.z < inc.z + p.hysteresis ? inc : best;
            if (c.incumbent !== pick.digit) {
                if (c.incumbent !== null) c.switches += 1;
                c.incumbent = pick.digit;
                c.since = m.tick;
            }
        } else {
            c.incumbent = null; // nothing holds up: the next digit that does starts fresh
            const shown = reads.filter(r => r.state !== 'thin' && r.state !== 'benched');
            pick = shown.length > 0 ? shown.reduce((a, b) => (b.z > a.z ? b : a)) : null;
        }
        let value: LabChoice | null = null;
        if (pick) {
            const tradable = pick.state === 'confirmed' || pick.state === 'leading';
            const held = tradable ? m.tick - c.since : 0;
            const why =
                pick.state === 'cooling'
                    ? `it just lost ${p.coldRun} entries in a row`
                    : pick.state === 'weak'
                      ? 'it does not beat the fair rate by enough, or the newest entries disagree'
                      : '';
            value = {
                digit: pick.digit,
                state: pick.state,
                tradable,
                n: pick.n,
                rate: pick.rate,
                z: pick.z,
                checkN: pick.checkN,
                checkRate: pick.checkRate,
                heldTicks: held,
                fair: spec.fair,
                note: tradable
                    ? `after a ${pick.digit} the contract won ${pct(pick.rate)} (newest entries weighted most, ${pick.n} kept, z ${pick.z.toFixed(1)}, fair ${pct(spec.fair)}) and ${pct(pick.checkRate)} of the newest ${pick.checkN}. In use for ${held} ticks, re-weighed every tick`
                    : `no digit holds up right now (best: ${pick.digit}, ${pct(pick.rate)} of ${pick.n}, z ${pick.z.toFixed(1)}; ${why}). Standing aside until one does`,
            };
        }
        c.cache = { version: m.version, value };
        return value;
    }

    /** All ten digits of a contract on a market, for the page. Reads the same state `choose` uses. */
    view(market: string, contract: { side: string; param: number }, duration: number): LabView | null {
        const m = this.markets.get(market);
        const spec = specOf(contract);
        if (!m || !spec || m.digits.length < this.params.minTicks) return null;
        const c = this.combo(m, spec, clamp(Math.round(duration) || 1, 1, 10));
        this.choose(market, contract, duration); // keeps the digit in use current
        return {
            market,
            label: spec.label,
            fair: spec.fair,
            ticks: m.tick,
            rows: this.readAll(m, c),
            current: c.incumbent,
            heldTicks: c.incumbent === null ? 0 : m.tick - c.since,
            switches: c.switches,
        };
    }

    /**
     * A real or paper trade that was entered on `digit` has settled. Its result counts against the digit on this market: the lab
     * benches a digit that keeps losing real entries. Returns a line for the log when it benched one, else null.
     */
    record(
        market: string,
        contract: { side: string; param: number },
        duration: number,
        digit: number,
        won: boolean
    ): string | null {
        const m = this.markets.get(market);
        const spec = specOf(contract);
        if (!m || !spec || !Number.isInteger(digit) || digit < 0 || digit > 9) return null;
        const c = this.combo(m, spec, clamp(Math.round(duration) || 1, 1, 10));
        if (won) {
            c.liveLosses[digit] = 0;
            return null;
        }
        c.liveLosses[digit] += 1;
        m.version += 1;
        if (c.liveLosses[digit] < this.params.benchLosses) return null;
        c.liveLosses[digit] = 0;
        c.benchUntil[digit] = m.tick + this.params.benchTicks;
        if (c.incumbent === digit) c.incumbent = null;
        return `Entry digit ${digit} benched on ${market} for ${this.params.benchTicks} ticks: ${this.params.benchLosses} ${spec.label} entries in a row on it lost. The lab picks again from the newest data.`;
    }

    reset(): void {
        this.markets.clear();
    }
}
