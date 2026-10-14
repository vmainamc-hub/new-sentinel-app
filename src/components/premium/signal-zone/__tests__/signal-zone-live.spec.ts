import type { FusionCandidate, SentinelCandidate, ZoneCandidate } from '../signal-zone-merge';
import { MAX_LIVE, EMPTY_LIVE, advanceLive, agreedNow, dismissLive, secondsLeft, type LiveState } from '../signal-zone-live';
import { DEFAULT_SETTINGS } from '../signal-zone-settings';
import { mergeCandidates } from '../signal-zone-merge';

const T0 = 1_700_000_000_000;
const LIFE = 60_000;
const settings = { ...DEFAULT_SETTINGS, excludedMarkets: [] as string[] };

const sent = (over: Partial<SentinelCandidate> = {}): SentinelCandidate => ({
    symbol: 'R_25', market: 'Volatility 25', contract: 'DIGITUNDER', barrier: 8, label: 'Under 8', entryDigit: 4, entryStatus: 'ARMED',
    entryWindow: '', entryWinRate: 90, score: 80, danger: 20, engineBlocked: false, momentumBlocked: false, receivedAt: T0, ...over,
});
const fus = (over: Partial<FusionCandidate> = {}): FusionCandidate => ({
    symbol: 'R_25', market: 'Volatility 25', contract: 'DIGITUNDER', barrier: 8, label: 'Under 8', action: 'EXECUTE', score: 70, danger: 25,
    confirmed: true, ripe: true, generatedAt: T0, ...over,
});
const agree = (symbol = 'R_25', now = T0, rank = 75): ZoneCandidate[] => {
    const [c] = mergeCandidates([sent({ symbol, market: symbol, score: rank })], [fus({ symbol, market: symbol, score: rank })], settings, now);
    return [c];
};
const step = (state: LiveState, agreed: ZoneCandidate[], now: number) => advanceLive(state, agreed, now, LIFE);

describe('agreedNow', () => {
    it('returns only loadable signals both engines agree on, whatever source mode is chosen', () => {
        const only = agreedNow([sent()], [fus()], { ...settings, mergeMode: 'sentinel_only' }, T0);
        expect(only).toHaveLength(1);
        expect(only[0].source).toBe('both');
    });
    it('does not return a signal only one engine reads, or where the barriers differ', () => {
        expect(agreedNow([sent()], [], settings, T0)).toHaveLength(0);
        expect(agreedNow([], [fus()], settings, T0)).toHaveLength(0);
        expect(agreedNow([sent()], [fus({ barrier: 7, label: 'Under 7' })], settings, T0)).toHaveLength(0);
    });
    it('still applies the gates and excluded markets', () => {
        expect(agreedNow([sent({ engineBlocked: true })], [fus()], settings, T0)).toHaveLength(0);
        expect(agreedNow([sent()], [fus()], { ...settings, excludedMarkets: ['R_25'] }, T0)).toHaveLength(0);
    });
    it('still gives an entry digit when Sentinel has none (the default)', () => {
        const [c] = agreedNow([sent({ entryDigit: null as unknown as number })], [fus()], settings, T0);
        expect(c.entryDigit).toBe(7);
        expect(c.entrySource).toBe('default');
    });
});

describe('pushing agreed signals', () => {
    it('pushes a new agreement by itself, once', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        expect(first.fresh).toHaveLength(1);
        expect(first.state.signals).toHaveLength(1);
        expect(first.state.signals[0]).toMatchObject({ firstSeen: T0, expiresAt: T0 + LIFE, agreed: true });
        const second = step(first.state, agree('R_25', T0 + 2000), T0 + 2000);
        expect(second.fresh).toHaveLength(0);
        expect(second.state.signals).toHaveLength(1);
        expect(second.state.signals[0].expiresAt).toBe(T0 + LIFE);
    });
    it('keeps the latest snapshot while the engines still agree', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        const later = agreedNow([sent({ entryDigit: 6 })], [fus()], settings, T0 + 2000);
        const next = step(first.state, later, T0 + 2000);
        expect(next.state.signals[0].candidate.entryDigit).toBe(6);
        expect(next.state.signals[0].lastSeen).toBe(T0 + 2000);
    });
    it('removes a signal when its lifetime is over', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        expect(step(first.state, [], T0 + LIFE - 1).state.signals).toHaveLength(1);
        expect(step(first.state, [], T0 + LIFE).state.signals).toHaveLength(0);
    });
    it('marks a signal as no longer agreed, but keeps it until it expires', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        const lost = step(first.state, [], T0 + 10_000);
        expect(lost.state.signals).toHaveLength(1);
        expect(lost.state.signals[0].agreed).toBe(false);
        const back = step(lost.state, agree('R_25', T0 + 20_000), T0 + 20_000);
        expect(back.state.signals[0].agreed).toBe(true);
        expect(back.fresh).toHaveLength(0);
    });
});

describe('not pushing the same agreement again', () => {
    it('does not re-push an agreement that outlives its lifetime', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        const expired = step(first.state, agree('R_25', T0 + LIFE), T0 + LIFE);
        expect(expired.state.signals).toHaveLength(0);
        expect(expired.fresh).toHaveLength(0);
        const still = step(expired.state, agree('R_25', T0 + LIFE + 2000), T0 + LIFE + 2000);
        expect(still.state.signals).toHaveLength(0);
        expect(still.fresh).toHaveLength(0);
    });
    it('pushes it again after the engines have stopped agreeing at least once', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        const expired = step(first.state, agree('R_25', T0 + LIFE), T0 + LIFE);
        const gap = step(expired.state, [], T0 + LIFE + 2000);
        const again = step(gap.state, agree('R_25', T0 + LIFE + 4000), T0 + LIFE + 4000);
        expect(again.fresh).toHaveLength(1);
        expect(again.state.signals).toHaveLength(1);
    });
    it('keeps a dismissed signal away until agreement breaks', () => {
        const first = step(EMPTY_LIVE, agree(), T0);
        const dismissed = dismissLive(first.state, first.state.signals[0].key);
        expect(dismissed.signals).toHaveLength(0);
        expect(step(dismissed, agree('R_25', T0 + 2000), T0 + 2000).fresh).toHaveLength(0);
        const gap = step(dismissed, [], T0 + 4000);
        expect(step(gap.state, agree('R_25', T0 + 6000), T0 + 6000).fresh).toHaveLength(1);
    });
});

describe('ordering and limits', () => {
    it('lists agreed signals first, then by rank', () => {
        const a = agree('R_10', T0, 60)[0];
        const b = agree('R_50', T0, 90)[0];
        const first = step(EMPTY_LIVE, [a, b], T0);
        expect(first.state.signals.map(s => s.candidate.symbol)).toEqual(['R_50', 'R_10']);
        const lost = step(first.state, [a], T0 + 2000);
        expect(lost.state.signals.map(s => s.candidate.symbol)).toEqual(['R_10', 'R_50']);
    });
    it('never holds more than the limit', () => {
        const many = Array.from({ length: MAX_LIVE + 4 }, (_, i) => agree(`R_${i}`, T0, 50 + i)[0]);
        const out = step(EMPTY_LIVE, many, T0);
        expect(out.state.signals).toHaveLength(MAX_LIVE);
        expect(out.fresh).toHaveLength(MAX_LIVE);
    });
});

describe('countdown', () => {
    it('counts whole seconds down to zero', () => {
        const [signal] = step(EMPTY_LIVE, agree(), T0).state.signals;
        expect(secondsLeft(signal, T0)).toBe(60);
        expect(secondsLeft(signal, T0 + 500)).toBe(60);
        expect(secondsLeft(signal, T0 + 59_001)).toBe(1);
        expect(secondsLeft(signal, T0 + 70_000)).toBe(0);
    });
});
