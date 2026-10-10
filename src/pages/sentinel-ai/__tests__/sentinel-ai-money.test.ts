import {
    clampStake,
    initialStakeState,
    nextStakeState,
    requiredEntryDigit,
    sessionStopReason,
} from '../sentinel-ai-money';
import { DEFAULT_SETTINGS, MIN_STAKE, normalizeSettings, type SentinelAiSettings } from '../sentinel-ai-types';

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

describe('Sentinel AI recovery digit', () => {
    it("uses the signal's own digit normally and the recovery digit while recovering", () => {
        const s = settings({ recoveryDigitEnabled: true, recoveryDigit: 8 });
        expect(requiredEntryDigit(4, 0, s)).toBe(4);
        expect(requiredEntryDigit(4, 1, s)).toBe(8);
        expect(requiredEntryDigit(null, 1, s)).toBe(8);
    });

    it('ignores the recovery digit when it is disabled', () => {
        const s = settings({ recoveryDigitEnabled: false, recoveryDigit: 8 });
        expect(requiredEntryDigit(4, 3, s)).toBe(4);
        expect(requiredEntryDigit(null, 3, s)).toBeNull();
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
            recoveryDigit: 42,
            runsPerSignal: 99,
            martingaleMode: 'nonsense',
            alertVisual: 'yes',
        });
        expect(s.stake).toBe(MIN_STAKE);
        expect(s.martingaleMultiplier).toBeCloseTo(1.01, 2);
        expect(s.recoveryDigit).toBe(9);
        expect(s.runsPerSignal).toBe(10);
        expect(s.martingaleMode).toBe(DEFAULT_SETTINGS.martingaleMode);
        expect(s.alertVisual).toBe(DEFAULT_SETTINGS.alertVisual);
    });

    it('falls back to defaults for empty input', () => {
        expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings({ stake: '' }).stake).toBe(DEFAULT_SETTINGS.stake);
    });
});
