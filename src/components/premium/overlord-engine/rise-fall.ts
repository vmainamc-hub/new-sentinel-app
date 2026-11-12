// OVERLORD RISE / FALL. Six chart indicators read on 1-minute candles, each one voting RISE, FALL or nothing:
// Bollinger Bands (20, 2), Stochastic RSI (14, 14, 3, 3), RSI (14), MACD (12, 26, 9), Momentum (10) and Connors RSI (3, 2, 100).
// A vote needs two things: the indicator is on one side AND it is turning that way, so a stretched reading that is still
// stretching further does not vote. The market with the most indicators agreeing is the best available; how many agree is
// always shown.
//
// With `requireEvidence` a side is also only a signal when the latest ticks already show it dominating (6 of the last 10 ticks
// were falls for a Fall, rises for a Rise; see evidence.ts). The indicators can say what they like: without that there is no signal.
//
// Honest limit: Deriv's synthetic indices are random. These indicators describe what price has just done; they do not
// predict the next tick, so a high agreement is a description of the market, not a promise.

import { type Evidence, moveEvidence } from './evidence';

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

export type RiseFallStyle = 'trend' | 'reversal';

const opposite = (d: Direction): Direction => (d === 'RISE' ? 'FALL' : 'RISE');

/** Fewer candles than this carry no trend to reverse. */
const TREND_BARS = 9;
/** The move over TREND_BARS must be at least this many average candle ranges for there to be something to reverse. */
const TREND_ATR = 1.5;

/**
 * REVERSAL votes. The prevailing move is found first (what price did over the last candles, in units of the average candle
 * range). Every indicator then votes for the OPPOSITE side only when it shows that move running out of steam, and for the
 * move's own side when it is still gathering strength (that counts against a reversal). Seven readings:
 *  - MACD: the histogram still on the move's side but shrinking (the bars fading), or already across the zero line;
 *  - Momentum: still positive on an up move, but lower than a bar ago;
 *  - RSI, Stoch RSI, Connors RSI: still on the move's side of the middle but turning down from it (the same, mirrored, for a fall);
 *  - Bollinger: price in the move's half of the band but the last candle closed back against the move;
 *  - Candle slowing: the latest candles are small next to the candles of the move, or closed against it.
 * Returns null prior when there is no move to reverse.
 */
export const readReversalVotes = (candles: readonly Candle[]): { votes: Vote[]; prior: Direction | null } | null => {
    if (candles.length < MIN_CANDLES) return null;
    const closes = candles.map(c => c.close);
    const n = closes.length;
    const atr = candles.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14 || 1e-9;
    // The move is read as it stood three candles ago too, so a move that has already started to stall is still seen.
    const now = closes[n - 1] - closes[n - 1 - TREND_BARS];
    const before = closes[n - 4] - closes[n - 4 - TREND_BARS];
    const net = Math.abs(before) > Math.abs(now) ? before : now;
    const prior: Direction | null = Math.abs(net) >= TREND_ATR * atr ? (net > 0 ? 'RISE' : 'FALL') : null;
    const s = net >= 0 ? 1 : -1; // +1: the move was up, so a reversal is a fall
    const rev = opposite(net >= 0 ? 'RISE' : 'FALL');
    const cont: Direction = net >= 0 ? 'RISE' : 'FALL';
    const pick = (exhausted: boolean, continuing: boolean): Direction | null => (exhausted ? rev : continuing ? cont : null);
    const votes: Vote[] = [];

    const m = macd(closes);
    const h = s * last(m.hist);
    const hp = s * last(m.hist, 2);
    votes.push({
        name: 'MACD',
        vote: pick(h < hp || h <= 0, h > hp && h > 0),
        detail: h <= 0 ? 'crossed against the move' : h < hp ? 'bars fading' : 'bars growing',
    });

    const mo = momentum(closes, 10);
    const mv = s * last(mo);
    const mp = s * last(mo, 2);
    votes.push({
        name: 'Momentum',
        vote: pick(mv < mp, mv > mp && mv > 0),
        detail: mv < mp ? 'slowing' : 'still gaining',
    });

    const osc = (name: string, series: readonly number[], hiLine: number, hot = 60) => {
        const v = s > 0 ? last(series) : 100 - last(series);
        const p = s > 0 ? last(series, 2) : 100 - last(series, 2);
        votes.push({
            name,
            vote: pick(v > hiLine - 5 && v < p, v >= hot && v > p),
            detail: `${name === 'RSI' ? 'RSI' : name === 'Connors RSI' ? 'CRSI' : 'K'} ${last(series).toFixed(0)} ${v < p ? 'turning back' : 'still pushing'}`,
        });
    };
    osc('RSI', rsi(closes, 14), 55);
    const st = stochRsi(closes);
    {
        const k = s > 0 ? last(st.k) : 100 - last(st.k);
        const d = s > 0 ? last(st.d) : 100 - last(st.d);
        votes.push({
            name: 'Stoch RSI',
            vote: pick(k > 55 && k < d, k > d && k >= 60),
            detail: `K ${last(st.k).toFixed(0)} / D ${last(st.d).toFixed(0)}`,
        });
    }
    osc('Connors RSI', connorsRsi(closes), 60);

    const band = last(bollinger(closes));
    const pctB = band.upper === band.lower ? 0.5 : (last(closes) - band.lower) / (band.upper - band.lower);
    const p = s > 0 ? pctB : 1 - pctB;
    const stepped = s * (last(closes) - last(closes, 2));
    votes.push({
        name: 'Bollinger',
        vote: pick(p >= 0.6 && stepped < 0, p >= 0.6 && stepped > 0),
        detail: `price at ${Math.round(pctB * 100)}% of the band`,
    });

    const body = (c: Candle) => Math.abs(c.close - c.open);
    const moveBodies = candles.slice(-TREND_BARS - 1, -3).map(body);
    const avgBody = moveBodies.reduce((a, b) => a + b, 0) / Math.max(1, moveBodies.length) || 1e-9;
    const recent = candles.slice(-2);
    const recentBody = recent.reduce((a, c) => a + body(c), 0) / 2;
    const lastC = last(candles);
    const against = s * (lastC.close - lastC.open) < 0;
    votes.push({
        name: 'Candle slowing',
        vote: pick(recentBody < 0.6 * avgBody || against, recentBody >= avgBody && !against),
        detail: against ? 'last candle closed against the move' : recentBody < 0.6 * avgBody ? 'candles shrinking' : 'candles full size',
    });

    return { votes, prior };
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
    style: RiseFallStyle;
    /** Reversal style: the move being reversed (null when the market is not moving), and whether there is a reversal point. */
    prior: Direction | null;
    setup: boolean;
    /** What the latest ticks show for `side`; null when evidence was not asked for. */
    evidence: Evidence | null;
    /** The indicators found a setup but the latest ticks do not show `side` dominating, so it is not a signal. */
    blockedByEvidence: boolean;
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
    /** 'trend' (the default) votes with the indicators; 'reversal' looks for the move running out of steam. */
    style?: RiseFallStyle;
    /** The latest ticks (prices, oldest first) of each market. Only needed with requireEvidence. */
    ticks?: Record<string, readonly number[]>;
    /** A side is only a signal when the latest ticks already show it dominating. */
    requireEvidence?: boolean;
    /** How many of the last 10 ticks must be the side; defaults to EVIDENCE_MIN. */
    evidenceMin?: number;
};

export type RiseFallScan = { reads: RiseFallRead[]; best: RiseFallRead | null; evaluated: number };

export const compareRiseFall = (a: RiseFallRead, b: RiseFallRead) =>
    Number(b.setup) - Number(a.setup) ||
    b.agree - a.agree || a.against - b.against || b.score - a.score || a.symbol.localeCompare(b.symbol);

export const scanRiseFall = (input: RiseFallInput): RiseFallScan => {
    const reads: RiseFallRead[] = [];
    const style = input.style ?? 'trend';
    for (const [symbol, candles] of Object.entries(input.candles)) {
        let votes: Vote[] | null;
        let prior: Direction | null = null;
        let side: Direction;
        if (style === 'reversal') {
            const r = readReversalVotes(candles);
            if (!r) continue;
            votes = r.votes;
            prior = r.prior;
            // The side of a reversal is the opposite of the move. A forced side that is not that is simply not a reversal point.
            side = input.side ?? (prior ? opposite(prior) : sideOf(votes));
        } else {
            votes = readVotes(candles);
            if (!votes) continue;
            side = sideOf(votes, input.side);
        }
        let s = scoreSide(votes, side);
        const reversalHere = style === 'reversal' && prior !== null && side === opposite(prior);
        if (style === 'reversal' && !reversalHere) s = { agree: 0, against: s.against, score: 0 };
        const evidence = input.requireEvidence ? moveEvidence(input.ticks?.[symbol] ?? [], side, input.evidenceMin) : null;
        const indicatorsSetup = style === 'trend' ? true : reversalHere && s.agree >= 3 && s.agree > s.against;
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
            style,
            prior,
            setup: indicatorsSetup && (evidence ? evidence.ok : true),
            evidence,
            blockedByEvidence: indicatorsSetup && evidence !== null && !evidence.ok,
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
                !r.setup
                    ? 'WEAK'
                    : r.agree >= 5 && steady >= 0.6
                      ? 'STRONG'
                      : r.agree >= 4 && steady >= 0.4
                        ? 'BEST'
                        : 'WEAK';
            return { ...r, steady, rounds: this.n, score, tier };
        });
        reads.sort(compareRiseFall);
        return { reads, best: reads[0] ?? null, evaluated: reads.length };
    }
}
