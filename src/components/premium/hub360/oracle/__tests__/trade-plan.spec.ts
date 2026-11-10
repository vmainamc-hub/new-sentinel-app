import {
    clampBarrier, defaultRecoveryBarrier, describeTrade, digitOfQuote, freshVh, nextTrade, normalizeVh, tradeWins,
    vhAfterReal, vhAfterVirtual, type RecoveryPlan,
} from '../trade-plan';

const rec = (over: Partial<RecoveryPlan> = {}): RecoveryPlan => ({ enabled: true, type: 'OVER', barrier: 3, ...over });

describe('recovery contract', () => {
    it('trades the scanned contract until a real loss', () => {
        expect(nextTrade({ kind: 'OVER/UNDER', type: 'OVER', barrier: 2, recovery: rec(), realLossStreak: 0 })).toEqual({ type: 'OVER', barrier: 2, recovery: false });
    });
    it('lose OVER 2, recover OVER 3 / UNDER 6 / EVEN / ODD', () => {
        const base = { kind: 'OVER/UNDER', type: 'OVER' as const, barrier: 2, realLossStreak: 1 };
        expect(nextTrade({ ...base, recovery: rec({ type: 'OVER', barrier: 3 }) })).toEqual({ type: 'OVER', barrier: 3, recovery: true });
        expect(nextTrade({ ...base, recovery: rec({ type: 'UNDER', barrier: 6 }) })).toEqual({ type: 'UNDER', barrier: 6, recovery: true });
        expect(nextTrade({ ...base, recovery: rec({ type: 'EVEN' }) })).toEqual({ type: 'EVEN', barrier: null, recovery: true });
        expect(nextTrade({ ...base, recovery: rec({ type: 'ODD' }) })).toEqual({ type: 'ODD', barrier: null, recovery: true });
    });
    it('stays on recovery through several losses and is off when disabled', () => {
        expect(nextTrade({ kind: 'OVER/UNDER', type: 'UNDER', barrier: 7, recovery: rec(), realLossStreak: 4 }).recovery).toBe(true);
        expect(nextTrade({ kind: 'OVER/UNDER', type: 'UNDER', barrier: 7, recovery: rec({ enabled: false }), realLossStreak: 4 })).toEqual({ type: 'UNDER', barrier: 7, recovery: false });
    });
    it('never applies on the Even/Odd tab', () => {
        expect(nextTrade({ kind: 'EVEN/ODD', type: 'EVEN', barrier: null, recovery: rec(), realLossStreak: 3 })).toEqual({ type: 'EVEN', barrier: null, recovery: false });
    });
    it('keeps barriers legal', () => {
        expect(clampBarrier('OVER', 12)).toBe(8);
        expect(clampBarrier('OVER', -3)).toBe(0);
        expect(clampBarrier('UNDER', 0)).toBe(1);
        expect(clampBarrier('UNDER', 'x')).toBe(6);
        expect(defaultRecoveryBarrier('OVER')).toBe(3);
        expect(describeTrade('UNDER', 6)).toBe('UNDER 6');
        expect(describeTrade('ODD', null)).toBe('ODD');
    });
});

describe('paper settlement', () => {
    it('decides each contract on the last digit', () => {
        expect(tradeWins('EVEN', null, 0)).toBe(true);
        expect(tradeWins('EVEN', null, 7)).toBe(false);
        expect(tradeWins('ODD', null, 7)).toBe(true);
        expect(tradeWins('OVER', 3, 4)).toBe(true);
        expect(tradeWins('OVER', 3, 3)).toBe(false);
        expect(tradeWins('UNDER', 6, 5)).toBe(true);
        expect(tradeWins('UNDER', 6, 6)).toBe(false);
        expect(tradeWins('OVER', null, 9)).toBe(false);
    });
    it('reads the digit at the market price precision', () => {
        expect(digitOfQuote(1234.5, 2)).toBe(0);
        expect(digitOfQuote(1234.57, 2)).toBe(7);
        expect(digitOfQuote('987.123', undefined)).toBe(3);
        expect(digitOfQuote('abc', 2)).toBeNull();
    });
});

describe('virtual hook (Sentinel state machine)', () => {
    const cfg = normalizeVh({ mode: 'STREAK', enterLosses: 2, returnWins: 2, fixedCount: 3 });
    it('goes to paper after the set real losses and back after paper wins in a row', () => {
        let s = freshVh();
        s = vhAfterReal(s, false, cfg).state;
        expect(s.virtual).toBe(false);
        const entered = vhAfterReal(s, false, cfg);
        expect(entered.event).toBe('entered');
        s = entered.state;
        s = vhAfterVirtual(s, true, cfg).state;
        s = vhAfterVirtual(s, false, cfg).state; // streak broken
        s = vhAfterVirtual(s, true, cfg).state;
        const back = vhAfterVirtual(s, true, cfg);
        expect(back.event).toBe('returned');
        expect(back.state.virtual).toBe(false);
    });
    it('FIXED mode returns after the set number of paper trades whatever they did', () => {
        const fixed = normalizeVh({ mode: 'FIXED', enterLosses: 1, fixedCount: 2 });
        let s = vhAfterReal(freshVh(), false, fixed).state;
        s = vhAfterVirtual(s, false, fixed).state;
        expect(vhAfterVirtual(s, false, fixed).event).toBe('returned');
    });
    it('clamps the form values', () => {
        expect(normalizeVh({ mode: 'x', enterLosses: 0, returnWins: 99, fixedCount: 'a' })).toEqual({ mode: 'STREAK', enterLosses: 1, returnWins: 10, fixedCount: 3 });
    });
});
