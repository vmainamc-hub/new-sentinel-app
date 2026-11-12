// OVERLORD RISE / FALL. Six chart indicators read on 1-minute candles, each one voting RISE, FALL or nothing:
// Bollinger Bands (20, 2), Stochastic RSI (14, 14, 3, 3), RSI (14), MACD (12, 26, 9), Momentum (10) and Connors RSI (3, 2, 100).
// A vote needs two things: the indicator is on one side AND it is turning that way, so a stretched reading that is still
// stretching further does not vote. The market with the most indicators agreeing is the best available; how many agree is
// always shown.
//
// Honest limit: Deriv's synthetic indices are random. These indicators describe what price has just done; they do not
// predict the next tick, so a high agreement is a description of the market, not a promise.

export type Candle = { open: number; high: number; low: number; close: number; time: number };
export type Direction = 'RISE' | 'FALL';
export type Vote = { name: string; vote: Direction | null; detail: string };

export const INDICATOR_COUNT = 6;
export const MIN_CANDLES = 60;

const last = <T>(a: readonly T[], from = 1): T => a[a.length - from];

export const sma = (v: readonly number[], period: number): number[] => {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < v.length; i += 1) {
        sum += v[i];
        if (i >= period) sum -= v[i - period];
        if (i >= period - 1) out.push(sum / period);
    }
    return out;
};

export const ema = (v: readonly number[], period: number): number[] => {
    const k = 2 / (period + 1);
    const out: number[] = [];
    v.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
    return out;
};

/** Wilder's RSI. The first (period) values are skipped, so the output is shorter than the input. */
export const rsi = (v: readonly number[], period: number): number[] => {
    if (v.length <= period) return [];
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
        const d = v[i] - v[i - 1];
        if (d >= 0) gain += d;
        else loss -= d;
    }
    gain /= period;
    loss /= period;
    const toRsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
    const out = [toRsi()];
    for (let i = period + 1; i < v.length; i += 1) {
        const d = v[i] - v[i - 1];
        gain = (gain * (period - 1) + Math.max(0, d)) / period;
        loss = (loss * (period - 1) + Math.max(0, -d)) / period;
        out.push(toRsi());
    }
    return out;
};

export const bollinger = (closes: readonly number[], period = 20, mult = 2) => {
    const mid = sma(closes, period);
    return mid.map((m, i) => {
        const slice = closes.slice(i, i + period);
        const sd = Math.sqrt(slice.reduce((s, x) => s + (x - m) ** 2, 0) / period);
        return { mid: m, upper: m + mult * sd, lower: m - mult * sd };
    });
};

export const stochRsi = (closes: readonly number[], rsiLen = 14, stochLen = 14, kLen = 3, dLen = 3) => {
    const r = rsi(closes, rsiLen);
    const raw: number[] = [];
    for (let i = stochLen - 1; i < r.length; i += 1) {
        const w = r.slice(i - stochLen + 1, i + 1);
        const lo = Math.min(...w);
        const hi = Math.max(...w);
        raw.push(hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100);
    }
    const k = sma(raw, kLen);
    return { k, d: sma(k, dLen) };
};

export const macd = (closes: readonly number[], fast = 12, slow = 26, signal = 9) => {
    const slowEma = ema(closes, slow);
    const line = ema(closes, fast).map((f, i) => f - slowEma[i]);
    const sig = ema(line, signal);
    return { line, signal: sig, hist: line.map((l, i) => l - sig[i]) };
};

export const momentum = (closes: readonly number[], period = 10): number[] =>
    closes.slice(period).map((c, i) => c - closes[i]);

/** Connors RSI = average of RSI(close, 3), RSI(up/down streak, 2) and the percent rank of the 1-bar change over 100 bars. */
export const connorsRsi = (closes: readonly number[], rsiLen = 3, streakLen = 2, rankLen = 100): number[] => {
    const streak: number[] = [0];
    for (let i = 1; i < closes.length; i += 1) {
        const d = closes[i] - closes[i - 1];
        const prev = streak[i - 1];
        streak.push(d > 0 ? (prev > 0 ? prev + 1 : 1) : d < 0 ? (prev < 0 ? prev - 1 : -1) : 0);
    }
    const roc = closes.map((c, i) => (i === 0 ? 0 : (c - closes[i - 1]) / closes[i - 1]));
    const a = rsi(closes, rsiLen); // starts at index rsiLen
    const b = rsi(streak, streakLen); // starts at index streakLen
    const out: number[] = [];
    for (let i = Math.max(rsiLen, streakLen, rankLen); i < closes.length; i += 1) {
        const w = roc.slice(i - rankLen, i);
        const rank = (w.filter(x => x < roc[i]).length / rankLen) * 100;
        out.push((a[i - rsiLen] + b[i - streakLen] + rank) / 3);
    }
    return out;
};

const turning = (a: readonly number[], dir: 1 | -1) => a.length >= 2 && (last(a) - last(a, 2)) * dir > 0;

/** The six votes for the candles as they stand (the last candle may still be forming). */
export const readVotes = (candles: readonly Candle[]): Vote[] | null => {
    if (candles.length < MIN_CANDLES) return null;
    const closes = candles.map(c => c.close);
    const votes: Vote[] = [];

    const bb = bollinger(closes);
    const band = last(bb);
    const pctB = band.upper === band.lower ? 0.5 : (last(closes) - band.lower) / (band.upper - band.lower);
    const up = last(closes) > last(closes, 2);
    votes.push({
        name: 'Bollinger',
        vote: pctB <= 0.3 && up ? 'RISE' : pctB >= 0.7 && !up ? 'FALL' : null,
        detail: `price at ${Math.round(pctB * 100)}% of the band`,
    });

    const st = stochRsi(closes);
    const k = last(st.k);
    const d = last(st.d);
    votes.push({
        name: 'Stoch RSI',
        vote: k < 30 && k > d ? 'RISE' : k > 70 && k < d ? 'FALL' : null,
        detail: `K ${k.toFixed(0)} / D ${d.toFixed(0)}`,
    });

    const r = rsi(closes, 14);
    const rv = last(r);
    votes.push({
        name: 'RSI',
        vote: rv < 45 && turning(r, 1) ? 'RISE' : rv > 55 && turning(r, -1) ? 'FALL' : null,
        detail: `RSI ${rv.toFixed(0)}`,
    });

    const m = macd(closes);
    const h = last(m.hist);
    votes.push({
        name: 'MACD',
        vote: h > 0 && turning(m.hist, 1) ? 'RISE' : h < 0 && turning(m.hist, -1) ? 'FALL' : null,
        detail: h > 0 ? 'above its signal line' : 'below its signal line',
    });

    const mo = momentum(closes, 10);
    const mv = last(mo);
    votes.push({
        name: 'Momentum',
        vote: mv > 0 && turning(mo, 1) ? 'RISE' : mv < 0 && turning(mo, -1) ? 'FALL' : null,
        detail: mv > 0 ? 'positive' : 'negative',
    });

    const cr = connorsRsi(closes);
    const cv = last(cr);
    votes.push({
        name: 'Connors RSI',
        vote: cv < 35 && turning(cr, 1) ? 'RISE' : cv > 65 && turning(cr, -1) ? 'FALL' : null,
        detail: `CRSI ${cv.toFixed(0)}`,
    });

    return votes;
};

export type RiseFallRead = {
    symbol: string;
    label: string;
    side: Direction;
    /** Indicators voting for `side`, and against it. */
    agree: number;
    against: number;
    total: number;
    votes: Vote[];
    score: number;
    /** Share of the live checks in which the same side had the same or more indicators. 1 before any live check. */
    steady: number;
    rounds: number;
    tier: 'STRONG' | 'BEST' | 'WEAK';
};

/** Pure: one market's read for one side. */
export const scoreSide = (votes: readonly Vote[], side: Direction) => {
    const agree = votes.filter(v => v.vote === side).length;
    const against = votes.filter(v => v.vote && v.vote !== side).length;
    return { agree, against, score: Math.max(0, Math.round(((agree - 0.5 * against) / votes.length) * 100)) };
};

const sideOf = (votes: readonly Vote[], only?: Direction | null): Direction => {
    if (only) return only;
    const rise = scoreSide(votes, 'RISE');
    const fall = scoreSide(votes, 'FALL');
    return rise.score >= fall.score ? 'RISE' : 'FALL';
};

export type RiseFallInput = {
    candles: Record<string, readonly Candle[]>;
    names?: Record<string, string>;
    /** RISE or FALL to be read only for that side, null for the engine to pick the side too. */
    side?: Direction | null;
};

export type RiseFallScan = { reads: RiseFallRead[]; best: RiseFallRead | null; evaluated: number };

export const compareRiseFall = (a: RiseFallRead, b: RiseFallRead) =>
    b.agree - a.agree || a.against - b.against || b.score - a.score || a.symbol.localeCompare(b.symbol);

export const scanRiseFall = (input: RiseFallInput): RiseFallScan => {
    const reads: RiseFallRead[] = [];
    for (const [symbol, candles] of Object.entries(input.candles)) {
        const votes = readVotes(candles);
        if (!votes) continue;
        const side = sideOf(votes, input.side);
        const s = scoreSide(votes, side);
        reads.push({
            symbol,
            label: side === 'RISE' ? 'Rise' : 'Fall',
            side,
            agree: s.agree,
            against: s.against,
            total: votes.length,
            votes,
            score: s.score,
            steady: 1,
            rounds: 0,
            tier: 'WEAK',
        });
    }
    reads.sort(compareRiseFall);
    return { reads, best: reads[0] ?? null, evaluated: reads.length };
};

/** Watches successive scans and re-ranks the final one by how steadily each market held its side and agreement. */
export class RiseFallAssessment {
    private n = 0;
    private held = new Map<string, number>();
    private first = new Map<string, { side: Direction; agree: number }>();

    get rounds() {
        return this.n;
    }

    observe(scan: RiseFallScan) {
        this.n += 1;
        for (const r of scan.reads) {
            const start = this.first.get(r.symbol);
            if (!start) this.first.set(r.symbol, { side: r.side, agree: r.agree });
            else if (r.side === start.side && r.agree >= start.agree - 1)
                this.held.set(r.symbol, (this.held.get(r.symbol) ?? 0) + 1);
        }
    }

    finalize(scan: RiseFallScan): RiseFallScan {
        const reads = scan.reads.map(r => {
            const rounds = Math.max(0, this.n - 1);
            const steady = rounds === 0 ? 1 : (this.held.get(r.symbol) ?? 0) / rounds;
            const score = Math.round(0.7 * r.score + 0.3 * steady * 100);
            const tier: RiseFallRead['tier'] =
                r.agree >= 5 && steady >= 0.6 ? 'STRONG' : r.agree >= 4 && steady >= 0.4 ? 'BEST' : 'WEAK';
            return { ...r, steady, rounds: this.n, score, tier };
        });
        reads.sort(compareRiseFall);
        return { reads, best: reads[0] ?? null, evaluated: reads.length };
    }
}
