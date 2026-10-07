import {
    AI_BOTS, DEFAULT_RISK, RULES, activeRule, applyResult, candidateTrades, digitFromPrice, initialRunState,
    rankMarkets, sanitizeRisk, stopReason, streakStats, tradeWins, winPercent,
} from '../apex-logic';

describe('digits', () => {
    it('extracts the last digit using pip decimals', () => {
        expect(digitFromPrice(1043.94, 2)).toBe(4);
        expect(digitFromPrice(84.2, 4)).toBe(0);
        expect(digitFromPrice(4972.3, 2)).toBe(0);
    });
});

describe('AI bot rules', () => {
    it('even-odd triggers the opposite parity', () => {
        expect(RULES.evenodd({ digits: [4], prices: [] })?.contract).toBe('DIGITODD');
        expect(RULES.evenodd({ digits: [7], prices: [] })?.contract).toBe('DIGITEVEN');
    });
    it('over4-under5 ignores digits 4 and 5', () => {
        expect(RULES.range45({ digits: [3], prices: [] })).toMatchObject({ contract: 'DIGITOVER', barrier: '4' });
        expect(RULES.range45({ digits: [6], prices: [] })).toMatchObject({ contract: 'DIGITUNDER', barrier: '5' });
        expect(RULES.range45({ digits: [4], prices: [] })).toBeNull();
        expect(RULES.range45({ digits: [5], prices: [] })).toBeNull();
    });
    it('over2 and under7 triggers', () => {
        expect(RULES.over2({ digits: [1], prices: [] })).toMatchObject({ contract: 'DIGITOVER', barrier: '2' });
        expect(RULES.over2({ digits: [2], prices: [] })).toBeNull();
        expect(RULES.under7({ digits: [8], prices: [] })).toMatchObject({ contract: 'DIGITUNDER', barrier: '7' });
        expect(RULES.under7({ digits: [7], prices: [] })).toBeNull();
    });
    it('rise-fall trades against a run', () => {
        expect(RULES.risefall({ digits: [], prices: [1, 2, 3] })?.contract).toBe('PUT');
        expect(RULES.risefall({ digits: [], prices: [3, 2, 1] })?.contract).toBe('CALL');
        expect(RULES.risefall({ digits: [], prices: [1, 3, 2] })).toBeNull();
        expect(RULES.risefall({ digits: [], prices: [1, 2] })).toBeNull();
    });
    it('defines seven bots with valid rules', () => {
        expect(AI_BOTS).toHaveLength(7);
        AI_BOTS.forEach(bot => {
            expect(RULES[bot.primary]).toBeDefined();
            if (bot.recovery) expect(RULES[bot.recovery]).toBeDefined();
        });
    });
});

describe('risk management', () => {
    const recoveryBot = AI_BOTS[3];
    const plainBot = AI_BOTS[0];
    const risk = sanitizeRisk({ stake: 1, multiplier: 2, maxStake: 5, takeProfit: 3, stopLoss: 4, maxConsecutiveLosses: 3 });

    it('sanitizes unsafe input', () => {
        expect(sanitizeRisk({ stake: -5, multiplier: 99, maxStake: 0 }).stake).toBe(0.35);
        expect(sanitizeRisk({ multiplier: 99 }).multiplier).toBe(10);
        expect(sanitizeRisk({ stake: NaN as any })).toEqual(sanitizeRisk({}));
        expect(DEFAULT_RISK.maxStake).toBeGreaterThanOrEqual(DEFAULT_RISK.stake);
    });
    it('martingale grows on loss, is capped, and resets on win', () => {
        let s = initialRunState(risk);
        s = applyResult(s, plainBot, risk, -1); expect(s.stake).toBe(2);
        s = applyResult(s, plainBot, risk, -2); expect(s.stake).toBe(4);
        s = applyResult(s, plainBot, risk, -4); expect(s.stake).toBe(5);
        s = applyResult(s, plainBot, risk, 4.5); expect(s.stake).toBe(1);
        expect(s.trades).toBe(4); expect(s.wins).toBe(1); expect(s.losses).toBe(3); expect(s.consecutiveLosses).toBe(0);
    });
    it('recovery bots switch phase on loss and back on win', () => {
        let s = initialRunState(risk);
        expect(activeRule(recoveryBot, s.phase)).toBe('over2');
        s = applyResult(s, recoveryBot, risk, -1); expect(s.phase).toBe('recovery');
        expect(activeRule(recoveryBot, s.phase)).toBe('evenodd');
        s = applyResult(s, recoveryBot, risk, -2); expect(s.phase).toBe('recovery');
        s = applyResult(s, recoveryBot, risk, 3); expect(s.phase).toBe('primary');
        expect(activeRule(plainBot, 'recovery')).toBe('evenodd');
    });
    it('stop reasons', () => {
        const base = initialRunState(risk);
        expect(stopReason({ ...base, pnl: 3 }, risk)).toBe('take_profit');
        expect(stopReason({ ...base, pnl: -4 }, risk)).toBe('stop_loss');
        expect(stopReason({ ...base, consecutiveLosses: 3 }, risk)).toBe('max_losses');
        expect(stopReason(base, risk)).toBeNull();
    });
});

describe('digits analysis', () => {
    it('computes win percent and trade wins', () => {
        const over2 = { side: 'over' as const, barrier: 2, label: 'Over 2' };
        expect(tradeWins(over2, 3)).toBe(true);
        expect(tradeWins(over2, 2)).toBe(false);
        expect(winPercent([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], over2)).toBe(70);
        expect(winPercent([], over2)).toBe(0);
    });
    it('ranks markets by the best side and respects the analysis window', () => {
        const markets = [
            { symbol: 'A', name: 'A', digits: [9, 9, 9, 9, 0, 0, 0, 0, 9, 9] },
            { symbol: 'B', name: 'B', digits: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
            { symbol: 'C', name: 'C', digits: [] },
        ];
        const ranked = rankMarkets(markets, 'over_under', { over: 2, under: 7 }, 1000);
        expect(ranked.map(r => r.symbol)).toEqual(['B', 'A']);
        expect(ranked[0].trade.label).toBe('Under 7');
        expect(ranked[0].percent).toBe(100);
        const windowed = rankMarkets([markets[0]], 'over_under', { over: 2, under: 7 }, 2);
        expect(windowed[0].percent).toBe(100);
        expect(candidateTrades('even_odd', { over: 2, under: 7 }).map(t => t.label)).toEqual(['Even', 'Odd']);
    });
    it('computes streaks and longest win streak', () => {
        const trade = { side: 'over' as const, barrier: 2, label: 'Over 2' };
        const stats = streakStats([5, 6, 7, 1, 8, 9, 0, 4], trade, 100);
        expect(stats.wins).toBe(6); expect(stats.losses).toBe(2);
        expect(stats.longestWin).toBe(3);
        expect(stats.current).toEqual({ type: 'Win', length: 1 });
        expect(stats.latest).toEqual({ digit: 4, win: true });
        expect(streakStats([5, 0, 1], trade, 2).current).toEqual({ type: 'Loss', length: 2 });
        expect(streakStats([], trade, 10).current.type).toBeNull();
    });
});