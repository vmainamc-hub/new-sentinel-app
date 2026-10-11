import {
    clampStake,
    initialStakeState,
    nextStakeState,
    requiredEntry,
    sessionStopReason,
    tradeBarrier,
} from '../sentinel-ai-money';
import { qualityVerdict } from '../sentinel-ai-quality';
import {
    DEFAULT_SETTINGS,
    MIN_STAKE,
    normalizeDigitList,
    normalizeSettings,
    parseDigitList,
    parseSymbolList,
    type SentinelAiSettings,
} from '../sentinel-ai-types';

const settings = (patch: Partial<SentinelAiSettings> = {}): SentinelAiSettings => ({
    ...DEFAULT_SETTINGS,
    stake: 1,
    martingaleMode: 'after_1',
    martingaleMultiplier: 2,
    martingaleMaxSteps: 0,
    maxStake: 0,
    recoverToBreakeven: false,
    ...patch,
});

describe('Sentinel AI stake logic', () => {
    it('clamps stakes to the minimum and to the optional cap', () => {
        expect(clampStake(0.01, settings())).toBe(MIN_STAKE);
        expect(clampStake(50, settings({ maxStake: 20 }))).toBe(20);
        expect(clampStake(1.005, settings())).toBeCloseTo(1.01, 2);
    });

    it('starts from the base stake with no losses', () => {
        expect(initialStakeState(settings({ stake: 2 }))).toEqual({
            currentStake: 2,
            consecutiveLosses: 0,
            martingaleStep: 0,
        });
    });

    it('doubles after a loss and resets after a win (martingale after 1 loss)', () => {
        const s = settings();
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s);
        expect(state).toEqual({ currentStake: 2, consecutiveLosses: 1, martingaleStep: 1 });
        state = nextStakeState(state, -2, -3, s);
        expect(state).toEqual({ currentStake: 4, consecutiveLosses: 2, martingaleStep: 2 });
        state = nextStakeState(state, 3.5, 0.5, s);
        expect(state).toEqual({ currentStake: 1, consecutiveLosses: 0, martingaleStep: 0 });
    });

    it('waits for two losses in "after 2 losses" mode', () => {
        const s = settings({ martingaleMode: 'after_2' });
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s);
        expect(state.currentStake).toBe(1);
        expect(state.consecutiveLosses).toBe(1);
        state = nextStakeState(state, -1, -2, s);
        expect(state.currentStake).toBe(2);
        expect(state.martingaleStep).toBe(1);
    });

    it('supports a custom loss trigger', () => {
        const s = settings({ martingaleMode: 'custom', martingaleCustomLosses: 3 });
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s);
        state = nextStakeState(state, -1, -2, s);
        expect(state.currentStake).toBe(1);
        state = nextStakeState(state, -1, -3, s);
        expect(state.currentStake).toBe(2);
    });

    it('never escalates when martingale is off', () => {
        const s = settings({ martingaleMode: 'off' });
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s);
        state = nextStakeState(state, -1, -2, s);
        expect(state.currentStake).toBe(1);
        expect(state.consecutiveLosses).toBe(2);
    });

    it('falls back to the base stake once the max steps are used', () => {
        const s = settings({ martingaleMaxSteps: 2 });
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s); // step 1 -> 2
        state = nextStakeState(state, -2, -3, s); // step 2 -> 4
        expect(state.currentStake).toBe(4);
        state = nextStakeState(state, -4, -7, s); // step 3 exceeds the ladder
        expect(state).toEqual({ currentStake: 1, consecutiveLosses: 3, martingaleStep: 0 });
    });

    it('respects the max stake cap while escalating', () => {
        const s = settings({ maxStake: 3 });
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s);
        state = nextStakeState(state, -2, -3, s);
        expect(state.currentStake).toBe(3);
    });

    it('keeps the recovery stake after a win until the session is back in profit', () => {
        const s = settings({ recoverToBreakeven: true });
        let state = initialStakeState(s);
        state = nextStakeState(state, -1, -1, s);
        state = nextStakeState(state, -2, -3, s);
        expect(state.currentStake).toBe(4);
        // A +3.7 win on a session at -3 leaves it at +0.7, so the recovery is complete.
        const recovered = nextStakeState(state, 3.7, 0.7, s);
        expect(recovered).toEqual({ currentStake: 1, consecutiveLosses: 0, martingaleStep: 0 });
        // Win of +1.5 leaves the session at -1.5 -> still recovering, stake held.
        const partial = nextStakeState(state, 1.5, -1.5, s);
        expect(partial.currentStake).toBe(4);
        expect(partial.consecutiveLosses).toBeGreaterThan(0);
    });

    it('treats a zero-profit settlement as a win', () => {
        const s = settings();
        const state = nextStakeState({ currentStake: 2, consecutiveLosses: 1, martingaleStep: 1 }, 0, 0, s);
        expect(state.consecutiveLosses).toBe(0);
        expect(state.currentStake).toBe(1);
    });
});

const over = (entryDigit: number | null) => ({ entryDigit, contractType: 'DIGITOVER' as const });
const under = (entryDigit: number | null) => ({ entryDigit, contractType: 'DIGITUNDER' as const });

describe('Sentinel AI entry digits', () => {
    it("uses the engine's own entry digit when it has one", () => {
        const s = settings();
        expect(requiredEntry(under(4), s)).toEqual({ digits: [4], source: 'engine' });
        expect(requiredEntry(over(9), s)).toEqual({ digits: [9], source: 'engine' });
    });

    it('falls back to the default digits of the signal side: Over 2/4, Under 5/7', () => {
        const s = settings();
        expect(requiredEntry(over(null), s)).toEqual({ digits: [2, 4], source: 'default' });
        expect(requiredEntry(under(null), s)).toEqual({ digits: [5, 7], source: 'default' });
    });

    it('honours custom default digits, and an empty list means nothing is traded', () => {
        const s = settings({ defaultOverDigits: [3], defaultUnderDigits: [] });
        expect(requiredEntry(over(null), s).digits).toEqual([3]);
        expect(requiredEntry(under(null), s).digits).toEqual([]);
    });
});

describe('Sentinel AI recovery barrier (separate for Over and Under)', () => {
    const s = settings({ recoveryBarrierEnabled: true, recoveryOverBarrier: 3, recoveryUnderBarrier: 6 });
    const sig = (type: 'DIGITOVER' | 'DIGITUNDER', barrier: number) => ({
        contractType: type,
        barrier,
        label: `${type === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`,
    });

    it('keeps the signal barrier before any loss and after a win', () => {
        expect(tradeBarrier(sig('DIGITUNDER', 8), 0, s)).toEqual({ barrier: 8, label: 'Under 8', recovery: false });
    });

    it('Under 8 loses -> trade Under 6; Over signal -> Over 3', () => {
        expect(tradeBarrier(sig('DIGITUNDER', 8), 1, s)).toEqual({ barrier: 6, label: 'Under 6', recovery: true });
        expect(tradeBarrier(sig('DIGITOVER', 1), 2, s)).toEqual({ barrier: 3, label: 'Over 3', recovery: true });
    });

    it('does nothing when recovery is off', () => {
        const off = settings({ recoveryBarrierEnabled: false });
        expect(tradeBarrier(sig('DIGITUNDER', 8), 3, off).barrier).toBe(8);
    });

    it('never changes the entry digit', () => {
        expect(requiredEntry(under(5), s)).toEqual({ digits: [5], source: 'engine' });
    });
});

describe('Sentinel AI digit lists', () => {
    it('normalises to unique ascending digits 0-9', () => {
        expect(normalizeDigitList([7, 5, 5, 12, -1, 'x', '3', 2.5], [])).toEqual([3, 5, 7]);
        expect(normalizeDigitList('nope', [1, 2])).toEqual([1, 2]);
        expect(normalizeDigitList([], [1, 2])).toEqual([]);
    });

    it('parses typed text and rejects anything that is not a digit', () => {
        expect(parseDigitList('2, 4')).toEqual([2, 4]);
        expect(parseDigitList('7 5;5')).toEqual([5, 7]);
        expect(parseDigitList('')).toEqual([]);
        expect(parseDigitList('2, x')).toBeNull();
        expect(parseDigitList('12')).toBeNull();
        expect(parseDigitList('-1')).toBeNull();
    });
});

describe('Sentinel AI session stops', () => {
    const base = { pnl: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, currentStake: 1, martingaleStep: 0 };

    it('stops at take profit and stop loss', () => {
        const s = settings({ takeProfit: 10, stopLoss: 20 });
        expect(sessionStopReason({ ...base, pnl: 10 }, s)).toMatch(/Take profit/);
        expect(sessionStopReason({ ...base, pnl: -20 }, s)).toMatch(/Stop loss/);
        expect(sessionStopReason({ ...base, pnl: 9.99 }, s)).toBeNull();
    });

    it('stops at max trades and max consecutive losses', () => {
        const s = settings({ takeProfit: 0, stopLoss: 0, maxTrades: 5, maxConsecutiveLosses: 3 });
        expect(sessionStopReason({ ...base, trades: 5 }, s)).toMatch(/Max trades/);
        expect(sessionStopReason({ ...base, consecutiveLosses: 3 }, s)).toMatch(/consecutive losses/);
        expect(sessionStopReason({ ...base, trades: 4, consecutiveLosses: 2 }, s)).toBeNull();
    });

    it('treats 0 as "off" for every limit', () => {
        const s = settings({ takeProfit: 0, stopLoss: 0, maxTrades: 0, maxConsecutiveLosses: 0 });
        expect(sessionStopReason({ ...base, pnl: -9999, trades: 9999, consecutiveLosses: 99 }, s)).toBeNull();
    });
});

describe('Sentinel AI settings validation', () => {
    it('clamps bad or hand-edited values', () => {
        const s = normalizeSettings({
            stake: -5,
            martingaleMultiplier: 0,
            recoveryOverBarrier: 42,
            recoveryUnderBarrier: 0,
            runsPerSignal: 99,
            martingaleMode: 'nonsense',
            alertVisual: 'yes',
        });
        expect(s.stake).toBe(MIN_STAKE);
        expect(s.martingaleMultiplier).toBeCloseTo(1.01, 2);
        expect(s.recoveryOverBarrier).toBe(8); // Over barrier tops out at 8
        expect(s.recoveryUnderBarrier).toBe(1); // Under barrier starts at 1
        expect(s.runsPerSignal).toBe(10);
        expect(s.martingaleMode).toBe(DEFAULT_SETTINGS.martingaleMode);
        expect(s.alertVisual).toBe(DEFAULT_SETTINGS.alertVisual);
    });

    it('defaults: entry digits Over 2/4 and Under 5/7, target profit 100', () => {
        expect(DEFAULT_SETTINGS.defaultOverDigits).toEqual([2, 4]);
        expect(DEFAULT_SETTINGS.defaultUnderDigits).toEqual([5, 7]);
        expect(DEFAULT_SETTINGS.takeProfit).toBe(100);
    });

    it('accepts the touch-once execution mode', () => {
        expect(normalizeSettings({ executionMode: 'touch_once' }).executionMode).toBe('touch_once');
        expect(normalizeSettings({ executionMode: 'bogus' }).executionMode).toBe(DEFAULT_SETTINGS.executionMode);
    });

    it('falls back to defaults for empty input', () => {
        expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings({ stake: '' }).stake).toBe(DEFAULT_SETTINGS.stake);
    });
});

describe('Sentinel AI quality gate', () => {
    const gate = { minScore: 70, maxDanger: 45, skipBlocked: true };
    const opp = (patch: Record<string, unknown> = {}) =>
        ({ score: 80, blocked: false, dangerComposition: { total: 20, isHardBlocked: false }, ...patch }) as any;

    it('passes a healthy signal', () => {
        expect(qualityVerdict(opp(), gate)).toEqual({ ok: true, reason: null });
    });
    it('rejects score 0 / blocked, low score and high danger with the reason', () => {
        expect(qualityVerdict(opp({ score: 0, blocked: true }), gate).reason).toMatch(/blocked/);
        expect(qualityVerdict(opp({ score: 0 }), gate).reason).toMatch(/score 0 is below 70/);
        expect(qualityVerdict(opp({ dangerComposition: { total: 46 } }), gate).reason).toMatch(/danger 46/);
        expect(qualityVerdict(opp({ dangerComposition: { total: 45 } }), gate).ok).toBe(true); // limit is inclusive
    });
    it('falls back to the raw market danger and ignores missing danger', () => {
        expect(qualityVerdict(opp({ dangerComposition: undefined, intel: { danger: 70 } }), gate).ok).toBe(false);
        expect(qualityVerdict(opp({ dangerComposition: undefined, intel: undefined }), gate).ok).toBe(true);
    });
    it('can be switched off', () => {
        const off = { minScore: 0, maxDanger: 0, skipBlocked: false };
        expect(qualityVerdict(opp({ score: 0, blocked: true, dangerComposition: { total: 100 } }), off).ok).toBe(true);
    });
});

describe('Sentinel AI market lists', () => {
    it('parses symbols and rejects junk', () => {
        expect(parseSymbolList('jd100, 1hz100v')).toEqual(['JD100', '1HZ100V']);
        expect(parseSymbolList('JD100 JD100')).toEqual(['JD100']);
        expect(parseSymbolList('JD 100!')).toBeNull();
        expect(parseSymbolList('')).toEqual([]);
    });
    it('defaults to excluding JD100 and clamps score/danger', () => {
        expect(DEFAULT_SETTINGS.excludedMarkets).toEqual(['JD100']);
        const s = normalizeSettings({ minScore: 500, maxDanger: -3, excludedMarkets: ['x y', 'jd75'] });
        expect(s.minScore).toBe(100);
        expect(s.maxDanger).toBe(0);
        expect(s.excludedMarkets).toEqual(['JD75']);
    });
});
