import { applyResult, DEFAULT_SETTINGS, freshSession, nextStake, normalizeSettings, primaryContracts, stopReason, tradeContract } from '../money';

const base = { ...DEFAULT_SETTINGS, stake: 1, martingale: true, multiplier: 2, maxSteps: 3 };

describe('Sixfold stake rules', () => {
    it('doubles after each loss and resets on a win', () => {
        let s = freshSession(base);
        s = applyResult(s, -1, base);
        expect(s.currentStake).toBe(2);
        s = applyResult(s, -2, base);
        expect(s.currentStake).toBe(4);
        s = applyResult(s, 1.5, base);
        expect(s.currentStake).toBe(1);
        expect(s.consecutiveLosses).toBe(0);
    });
    it('falls back to the base stake once the ladder is exhausted', () => {
        let s = freshSession(base);
        for (let i = 0; i < 4; i++) s = applyResult(s, -1, base);
        expect(s.currentStake).toBe(1);
        expect(s.consecutiveLosses).toBe(4);
    });
    it('never doubles when martingale is off and respects the stake cap', () => {
        const off = { ...base, martingale: false };
        expect(nextStake({ currentStake: 1, consecutiveLosses: 0, martingaleStep: 0 }, -1, off).currentStake).toBe(1);
        const capped = { ...base, maxStake: 3 };
        expect(nextStake({ currentStake: 2, consecutiveLosses: 1, martingaleStep: 1 }, -2, capped).currentStake).toBe(3);
    });
    it('tracks drawdown from the session peak', () => {
        let s = freshSession(base);
        s = applyResult(s, 2, base);
        s = applyResult(s, -1, base);
        s = applyResult(s, -2, base);
        expect(s.pnl).toBe(-1);
        expect(s.maxDrawdown).toBe(3);
    });
    it('stops on take profit, stop loss and consecutive losses', () => {
        const s = { ...freshSession(base), pnl: 10 };
        expect(stopReason(s, base)).toMatch(/Take profit/);
        expect(stopReason({ ...s, pnl: -30 }, base)).toMatch(/Stop loss/);
        expect(stopReason({ ...s, pnl: 0, consecutiveLosses: 6 }, base)).toMatch(/consecutive/);
        expect(stopReason({ ...s, pnl: 0 }, base)).toBeNull();
    });
    it('uses the side recovery barrier only after a loss and only for Over/Under', () => {
        const r = { ...base, recovery: true, recoveryOver: 3, recoveryUnder: 6 };
        expect(tradeContract({ side: 'OVER', param: 2 }, 0, r).label).toBe('Over 2');
        expect(tradeContract({ side: 'OVER', param: 2 }, 1, r).label).toBe('Over 3');
        expect(tradeContract({ side: 'UNDER', param: 7 }, 2, r).label).toBe('Under 6');
        expect(tradeContract({ side: 'EVEN', param: 0 }, 2, r).recovery).toBe(false);
    });
    it('normalizes junk settings into safe ranges', () => {
        const n = normalizeSettings({ stake: -5, multiplier: 99, duration: 40, selectivity: 'x' as never, markets: [] });
        expect(n.stake).toBeGreaterThanOrEqual(0.35);
        expect(n.multiplier).toBe(10);
        expect(n.duration).toBe(5);
        expect(n.selectivity).toBe('balanced');
        expect(n.markets.length).toBeGreaterThan(0);
    });
});

describe('primary contracts', () => {
    it('defaults to Over 2 and Under 7 with Over 3 / Under 6 recovery switched on', () => {
        expect(primaryContracts(DEFAULT_SETTINGS)).toEqual([{ side: 'OVER', param: 2 }, { side: 'UNDER', param: 7 }]);
        expect(DEFAULT_SETTINGS.recovery).toBe(true);
        expect(DEFAULT_SETTINGS.recoveryOver).toBe(3);
        expect(DEFAULT_SETTINGS.recoveryUnder).toBe(6);
    });
    it('respects the on/off switches and clamps barriers to ones Deriv offers', () => {
        expect(primaryContracts({ ...DEFAULT_SETTINGS, useOver: false })).toEqual([{ side: 'UNDER', param: 7 }]);
        expect(primaryContracts({ ...DEFAULT_SETTINGS, useOver: false, useUnder: false })).toEqual([]);
        const n = normalizeSettings({ primaryOver: 99, primaryUnder: 0 });
        expect(n.primaryOver).toBe(8);
        expect(n.primaryUnder).toBe(1);
    });
    it('settings saved before this existed fall back to the defaults', () => {
        const n = normalizeSettings({ stake: 2, markets: ['R_10'] } as never);
        expect(primaryContracts(n)).toEqual([{ side: 'OVER', param: 2 }, { side: 'UNDER', param: 7 }]);
    });
});
