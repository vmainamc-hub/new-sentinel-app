// SENTINEL AI — signal outcome log, pure logic.
//
// Paper outcomes only: nothing here trades, ranks or changes a signal. One record per SURFACED signal; the outcome of a
// 1-tick digit contract is the last digit of the FIRST tick printed AFTER the decision tick (never the decision tick).
import { breakEvenRate } from '@/components/premium/bulk-engine';

export type OutcomeContract = 'OVER' | 'UNDER' | 'EVEN' | 'ODD' | 'MATCH' | 'DIFFER';
export type OutcomeState = 'pending' | 'resolved' | 'unresolved';

export type SignalLogRecord = {
    id: string;
    surfacedAt: number;
    symbol: string;
    contract: OutcomeContract;
    barrier: number | null;
    label: string;
    /** Epoch (ms) of the latest tick of the market when the signal surfaced; null when no tick was available. */
    decisionTickEpoch: number | null;
    outcomeTickEpoch: number | null;
    outcomeDigit: number | null;
    won: boolean | null;
    state: OutcomeState;
    /** Digit-psychology score (0-100) of the surfaced candidate, when the engine provided one. */
    psychologyScore: number | null;
    momentumPass: boolean | null;
    momentumScore: number | null;
    /** True when the momentum switch was on and momentum failed. */
    momentumBlocked: boolean;
    /** True when the runner actually bought this signal. */
    traded: boolean;
};

export type SurfacedSignalInput = {
    symbol: string;
    contract: OutcomeContract;
    barrier: number | null;
    label: string;
    psychologyScore: number | null;
    momentumPass: boolean | null;
    momentumScore: number | null;
    momentumBlocked: boolean;
};

export type Tick = { t: number; price: number };

export const MAX_RECORDS = 5000;
export const UNRESOLVED_AFTER_MS = 30_000;
/** A signal must be absent this long before it counts as "gone", so a one-sample flicker is not logged twice. */
export const GONE_AFTER_MS = 3_000;
export const MIN_SIGNALS = 300;

// ── digits ─────────────────────────────────────────────────────────────────────────────────────
// Same derivation as src/components/premium/bulk-feed.ts (inferDecimals + lastDigit), so it matches Deriv's last digit.
export const inferDecimals = (prices: number[], fallback: number): number => {
    if (prices.length < 30) return fallback;
    let max = 0;
    for (const price of prices) {
        const text = String(price);
        if (!Number.isFinite(price) || text.includes('e')) continue;
        const dot = text.indexOf('.');
        if (dot >= 0) max = Math.max(max, text.length - dot - 1);
    }
    return Math.min(max, 6);
};

export const lastDigit = (price: number, decimals: number): number =>
    Number(Number(price).toFixed(Math.min(10, Math.max(0, decimals))).slice(-1));

// ── contracts ──────────────────────────────────────────────────────────────────────────────────
export const contractWins = (contract: OutcomeContract, barrier: number | null, digit: number): boolean => {
    switch (contract) {
        case 'OVER':
            return barrier !== null && digit > barrier;
        case 'UNDER':
            return barrier !== null && digit < barrier;
        case 'EVEN':
            return digit % 2 === 0;
        case 'ODD':
            return digit % 2 === 1;
        case 'MATCH':
            return barrier !== null && digit === barrier;
        case 'DIFFER':
            return barrier !== null && digit !== barrier;
        default:
            return false;
    }
};

/** Probability of winning on random digits (the "base rate"). */
export const baseRate = (contract: OutcomeContract, barrier: number | null): number => {
    const b = barrier ?? 0;
    switch (contract) {
        case 'OVER':
            return (9 - b) / 10;
        case 'UNDER':
            return b / 10;
        case 'EVEN':
        case 'ODD':
            return 0.5;
        case 'MATCH':
            return 0.1;
        case 'DIFFER':
            return 0.9;
        default:
            return 0.5;
    }
};

export const signalKey = (symbol: string, contract: OutcomeContract, barrier: number | null) =>
    `${symbol}|${contract}|${barrier ?? ''}`;

export const recordKey = (r: Pick<SignalLogRecord, 'symbol' | 'contract' | 'barrier'>) =>
    signalKey(r.symbol, r.contract, r.barrier);

// ── outcome resolution ─────────────────────────────────────────────────────────────────────────
/** First tick strictly AFTER the decision tick, or null. */
export const firstTickAfter = (ticks: readonly Tick[], decisionEpoch: number): Tick | null => {
    for (const tick of ticks) {
        if (Number.isFinite(tick.t) && Number.isFinite(tick.price) && tick.t > decisionEpoch) return tick;
    }
    return null;
};

/**
 * Resolves one pending record. Returns the same record when it stays pending, or an updated copy. A record becomes
 * "unresolved" (excluded from statistics) when no usable tick arrives within UNRESOLVED_AFTER_MS of the decision.
 */
export const resolveRecord = (
    record: SignalLogRecord,
    ticks: readonly Tick[],
    decimals: number,
    now: number
): SignalLogRecord => {
    if (record.state !== 'pending') return record;
    if (record.decisionTickEpoch === null) return { ...record, state: 'unresolved' };
    const next = firstTickAfter(ticks, record.decisionTickEpoch);
    if (next && next.t - record.decisionTickEpoch <= UNRESOLVED_AFTER_MS) {
        const digit = lastDigit(next.price, decimals);
        return {
            ...record,
            state: 'resolved',
            outcomeTickEpoch: next.t,
            outcomeDigit: digit,
            won: contractWins(record.contract, record.barrier, digit),
        };
    }
    if (next || now - record.surfacedAt > UNRESOLVED_AFTER_MS) return { ...record, state: 'unresolved' };
    return record;
};

// ── logging with de-duplication ────────────────────────────────────────────────────────────────
export type LogState = {
    records: SignalLogRecord[];
    /** key -> last time the signal was seen surfaced. In memory only. */
    live: Record<string, number>;
    seq: number;
};

export const emptyLogState = (records: SignalLogRecord[] = []): LogState => ({ records, live: {}, seq: records.length });

/**
 * Registers what is surfaced right now. A signal is logged when it is not already live; it is live until it has been
 * absent for GONE_AFTER_MS. Newest records are last; the oldest are dropped beyond MAX_RECORDS. Never mutates the input.
 */
export const logSurfaced = (
    state: LogState,
    inputs: readonly SurfacedSignalInput[],
    now: number,
    decisionEpochOf: (symbol: string) => number | null
): LogState => {
    const live: Record<string, number> = {};
    for (const [key, seen] of Object.entries(state.live)) {
        if (now - seen <= GONE_AFTER_MS) live[key] = seen;
    }
    const added: SignalLogRecord[] = [];
    let seq = state.seq;
    const seenNow = new Set<string>();
    for (const input of inputs) {
        const key = signalKey(input.symbol, input.contract, input.barrier);
        if (seenNow.has(key)) continue;
        seenNow.add(key);
        const alreadyLive = key in live;
        live[key] = now;
        if (alreadyLive) continue;
        const decision = decisionEpochOf(input.symbol);
        seq += 1;
        added.push({
            id: `${now}-${seq}`,
            surfacedAt: now,
            symbol: input.symbol,
            contract: input.contract,
            barrier: input.barrier,
            label: input.label,
            decisionTickEpoch: decision,
            outcomeTickEpoch: null,
            outcomeDigit: null,
            won: null,
            state: decision === null ? 'unresolved' : 'pending',
            psychologyScore: input.psychologyScore,
            momentumPass: input.momentumPass,
            momentumScore: input.momentumScore,
            momentumBlocked: input.momentumBlocked,
            traded: false,
        });
    }
    let records = added.length ? [...state.records, ...added] : state.records;
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
    return { records, live, seq };
};

/** Marks the newest record of that signal as traded. Returns the same array when nothing matches. */
export const markTraded = (records: SignalLogRecord[], key: string): SignalLogRecord[] => {
    for (let i = records.length - 1; i >= 0; i -= 1) {
        if (recordKey(records[i]) === key) {
            if (records[i].traded) return records;
            const copy = records.slice();
            copy[i] = { ...records[i], traded: true };
            return copy;
        }
    }
    return records;
};

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────
export const CSV_COLUMNS = [
    'id',
    'surfacedAt',
    'symbol',
    'contract',
    'barrier',
    'label',
    'decisionTickEpoch',
    'outcomeTickEpoch',
    'outcomeDigit',
    'won',
    'state',
    'psychologyScore',
    'momentumPass',
    'momentumScore',
    'momentumBlocked',
    'traded',
] as const;

export const csvCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (records: readonly SignalLogRecord[]): string => {
    const lines = [CSV_COLUMNS.join(',')];
    for (const record of records) {
        lines.push(CSV_COLUMNS.map(column => csvCell(record[column])).join(','));
    }
    return lines.join('\r\n');
};

// ── statistics ─────────────────────────────────────────────────────────────────────────────────
/** 95% Wilson score interval for a proportion, as fractions. */
export const wilson95 = (wins: number, n: number): { low: number; high: number } | null => {
    if (n <= 0) return null;
    const z = 1.959964;
    const p = wins / n;
    const denominator = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denominator;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
    return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
};

export type SummaryRow = {
    key: string;
    label: string;
    resolved: number;
    wins: number;
    winPct: number | null;
    /** Average random-digit win % of the signals in this row. */
    baseRatePct: number | null;
    breakEvenPct: number | null;
    low: number | null;
    high: number | null;
    /** "too few signals to judge" below MIN_SIGNALS; otherwise a neutral description of the interval. */
    note: string;
};

const pct1 = (x: number) => Math.round(x * 1000) / 10;

export const describeRow = (resolved: number, wins: number, breakEvenFraction: number | null): string => {
    if (resolved < MIN_SIGNALS) return 'too few signals to judge';
    const interval = wilson95(wins, resolved);
    if (!interval || breakEvenFraction === null) return 'no estimate';
    if (interval.low > breakEvenFraction) return 'interval is above break-even';
    if (interval.high < breakEvenFraction) return 'interval is below break-even';
    return 'interval includes break-even';
};

const rowOf = (key: string, label: string, group: SignalLogRecord[]): SummaryRow => {
    const resolved = group.filter(r => r.state === 'resolved');
    const wins = resolved.filter(r => r.won).length;
    const n = resolved.length;
    const meanBase = n ? resolved.reduce((sum, r) => sum + baseRate(r.contract, r.barrier), 0) / n : null;
    const breakEven = meanBase === null ? null : breakEvenRate(meanBase);
    const interval = wilson95(wins, n);
    return {
        key,
        label,
        resolved: n,
        wins,
        winPct: n ? pct1(wins / n) : null,
        baseRatePct: meanBase === null ? null : pct1(meanBase),
        breakEvenPct: breakEven === null ? null : pct1(breakEven),
        low: interval ? pct1(interval.low) : null,
        high: interval ? pct1(interval.high) : null,
        note: describeRow(n, wins, breakEven),
    };
};

export type OutcomeSummary = {
    total: number;
    pending: number;
    unresolved: number;
    traded: number;
    byType: SummaryRow[];
    overall: SummaryRow;
    momentumPassed: SummaryRow;
    momentumFailed: SummaryRow;
};

export const summarize = (records: readonly SignalLogRecord[]): OutcomeSummary => {
    const groups = new Map<string, SignalLogRecord[]>();
    for (const record of records) {
        const key = `${record.contract}|${record.barrier ?? ''}`;
        const list = groups.get(key);
        if (list) list.push(record);
        else groups.set(key, [record]);
    }
    const byType = Array.from(groups.entries())
        .map(([key, group]) => rowOf(key, group[0].label.replace(/\s+/g, ' '), group))
        .sort((a, b) => a.label.localeCompare(b.label));
    return {
        total: records.length,
        pending: records.filter(r => r.state === 'pending').length,
        unresolved: records.filter(r => r.state === 'unresolved').length,
        traded: records.filter(r => r.traded).length,
        byType,
        overall: rowOf('all', 'All signals', records.slice()),
        momentumPassed: rowOf('pass', 'Momentum passed', records.filter(r => r.momentumPass === true)),
        momentumFailed: rowOf('fail', 'Momentum failed', records.filter(r => r.momentumPass === false)),
    };
};

// ── storage format ─────────────────────────────────────────────────────────────────────────────
const CONTRACTS: OutcomeContract[] = ['OVER', 'UNDER', 'EVEN', 'ODD', 'MATCH', 'DIFFER'];
const STATES: OutcomeState[] = ['pending', 'resolved', 'unresolved'];
const nullableNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nullableBool = (v: unknown) => (typeof v === 'boolean' ? v : null);

/** Keeps only well-formed records (storage can be stale or hand-edited). Never throws. */
export const parseStoredRecords = (raw: unknown): SignalLogRecord[] => {
    if (!Array.isArray(raw)) return [];
    const out: SignalLogRecord[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.symbol !== 'string' || typeof r.label !== 'string') continue;
        if (!CONTRACTS.includes(r.contract as OutcomeContract) || !STATES.includes(r.state as OutcomeState)) continue;
        const surfacedAt = nullableNumber(r.surfacedAt);
        if (surfacedAt === null) continue;
        out.push({
            id: r.id,
            surfacedAt,
            symbol: r.symbol,
            contract: r.contract as OutcomeContract,
            barrier: nullableNumber(r.barrier),
            label: r.label,
            decisionTickEpoch: nullableNumber(r.decisionTickEpoch),
            outcomeTickEpoch: nullableNumber(r.outcomeTickEpoch),
            outcomeDigit: nullableNumber(r.outcomeDigit),
            won: nullableBool(r.won),
            state: r.state as OutcomeState,
            psychologyScore: nullableNumber(r.psychologyScore),
            momentumPass: nullableBool(r.momentumPass),
            momentumScore: nullableNumber(r.momentumScore),
            momentumBlocked: r.momentumBlocked === true,
            traded: r.traded === true,
        });
    }
    return out.slice(-MAX_RECORDS);
};
