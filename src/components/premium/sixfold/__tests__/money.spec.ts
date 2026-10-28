import {
    applyResult,
    applyWriteOff,
    DEFAULT_SETTINGS,
    freshSession,
    ladderPreview,
    nextStake,
    normalizeSettings,
    primaryContracts,
    stakeFor,
    stopReason,
    streakChance,
    tradeContract,
} from '../money';

const base = { ...DEFAULT_SETTINGS, stake: 1, martingale: true, multiplier: 2, maxSteps: 3, recoverySizing: 'MULTIPLIER' as const, streakBudget: 0 };

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

describe('payout-sized recovery and the streak budget', () => {
    const payout = { ...DEFAULT_SETTINGS, stake: 1, martingale: true, recoverySizing: 'PAYOUT' as const, recoverShare: 100, streakBudget: 0, maxSteps: 0, margin: 0.05, recovery: false };
    const over2 = { side: 'OVER' as const, param: 2 };

    it('sizes the stake so one win pays back the share of what is owed', () => {
        let s = freshSession(payout);
        s = applyResult(s, -1, payout);
        expect(s.openLoss).toBe(1);
        const { stake } = stakeFor(s, over2, payout);
        // Over 2 wins 70%, payout ratio (1 - 0.05) / 0.7 - 1 = 0.357: stake 1 / 0.357 = 2.8
        expect(stake).toBeCloseTo(2.8, 1);
        expect(stake * 0.357).toBeCloseTo(1, 1);
    });

    it('asks for less stake on a higher-paying contract and at a smaller share', () => {
        let s = applyResult(freshSession(payout), -10, payout);
        const over3 = { side: 'OVER' as const, param: 3 };
        expect(stakeFor(s, over3, payout).stake).toBeLessThan(stakeFor(s, over2, payout).stake);
        const half = { ...payout, recoverShare: 50 };
        expect(stakeFor(s, over2, half).stake).toBeCloseTo(stakeFor(s, over2, payout).stake / 2, 0);
    });

    it('never goes below the base stake and keeps the debt across a partial recovery', () => {
        const half = { ...payout, recoverShare: 10 };
        let s = applyResult(freshSession(half), -1, half);
        expect(stakeFor(s, over2, half).stake).toBe(1);
        const big = applyResult(freshSession(payout), -10, payout);
        const won = applyResult(big, 4, payout); // pays back 4 of the 10
        expect(won.openLoss).toBe(6);
        const cleared = applyResult(won, 8, payout);
        expect(cleared.openLoss).toBe(0);
        expect(stakeFor(cleared, over2, payout).stake).toBe(1);
    });

    it('accepts the loss and restarts at base when the next stake would pass the streak budget', () => {
        const cfg = { ...payout, streakBudget: 10 };
        let s = freshSession(cfg);
        s = applyResult(s, -1, cfg);
        s = applyResult(s, -2.8, cfg);
        const next = stakeFor(s, over2, cfg);
        expect(next.writeOff).toBe(true);
        expect(next.stake).toBe(1);
        const cleared = applyWriteOff(s, cfg);
        expect(cleared.openLoss).toBe(0);
        expect(cleared.writeOffs).toBe(1);
        expect(cleared.currentStake).toBe(1);
        expect(cleared.consecutiveLosses).toBe(2); // the streak counter is kept for the stop rule
    });

    it('applies the budget to the multiplier too', () => {
        const cfg = { ...base, streakBudget: 5 };
        let s = freshSession(cfg);
        s = applyResult(s, -1, cfg); // owes 1, next stake 2
        expect(stakeFor(s, { side: 'OVER', param: 2 }, cfg).writeOff).toBe(false);
        s = applyResult(s, -2, cfg); // owes 3, next stake 4 -> 7 > 5
        expect(stakeFor(s, { side: 'OVER', param: 2 }, cfg).writeOff).toBe(true);
    });

    it('does nothing without martingale', () => {
        const off = { ...payout, martingale: false };
        const s = applyResult(freshSession(off), -5, off);
        expect(stakeFor(s, over2, off)).toEqual({ stake: 1, writeOff: false });
    });

    it('previews the cost of a losing streak and the chance of one', () => {
        const rows = ladderPreview({ ...payout, streakBudget: 0, maxSteps: 0 }, 4);
        expect(rows).toHaveLength(4);
        expect(rows[0].stake).toBe(1);
        expect(rows[3].total).toBeGreaterThan(rows[2].total);
        expect(streakChance(0.7, 4)).toBeCloseTo(0.0081, 4);
        expect(streakChance(0.6, 4)).toBeCloseTo(0.0256, 4);
    });

    it('keeps a bad run bounded: the open loss never passes the budget plus one base stake', () => {
        const cfg = { ...payout, streakBudget: 10, recoverShare: 100 };
        let s = freshSession(cfg);
        let worst = 0;
        for (let i = 0; i < 12; i++) {
            const sized = stakeFor(s, over2, cfg);
            if (sized.writeOff) s = applyWriteOff(s, cfg);
            s = applyResult(s, -sized.stake, cfg);
            worst = Math.max(worst, s.openLoss);
        }
        expect(worst).toBeLessThanOrEqual(10 + 1);
    });
});
