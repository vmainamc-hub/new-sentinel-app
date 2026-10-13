import { DEFAULT_BUY_MS, fitOnOneTick, learnPace, tickIntervalMs } from '../burst-pace';

describe('burst pace', () => {
    it('reads the tick interval from recent ticks (median) and needs enough ticks', () => {
        expect(tickIntervalMs([1000, 2000, 3000, 4000, 5000])).toBe(1000);
        expect(tickIntervalMs([0, 2000, 4000, 6000, 9000])).toBe(2000);
        expect(tickIntervalMs([1000, 2000])).toBeNull();
        expect(tickIntervalMs([])).toBeNull();
    });

    it('caps a burst that cannot land before the next tick', () => {
        const r = fitOnOneTick({ requested: 8, intervalMs: 1000, elapsedMs: 0, perBuyMs: 150 });
        expect(r).toMatchObject({ fit: 5, capped: true });
        expect(fitOnOneTick({ requested: 100, intervalMs: 2000, elapsedMs: 0, perBuyMs: 150 }).fit).toBe(11);
    });

    it('sends everything when it fits, and never less than one', () => {
        expect(fitOnOneTick({ requested: 3, intervalMs: 2000, elapsedMs: 100, perBuyMs: 100 })).toMatchObject({ fit: 3, capped: false });
        expect(fitOnOneTick({ requested: 5, intervalMs: 1000, elapsedMs: 900, perBuyMs: 150 }).fit).toBe(1);
    });

    it('time already used in the tick shrinks the burst', () => {
        const early = fitOnOneTick({ requested: 20, intervalMs: 2000, elapsedMs: 0, perBuyMs: 100 }).fit;
        const late = fitOnOneTick({ requested: 20, intervalMs: 2000, elapsedMs: 800, perBuyMs: 100 }).fit;
        expect(late).toBeLessThan(early);
    });

    it('learns the pace from confirmation times and ignores tiny samples', () => {
        expect(learnPace(DEFAULT_BUY_MS, [1000, 1100])).toBe(DEFAULT_BUY_MS);
        // 5 confirmations spread over 400 ms -> 100 ms per buy; averaged with the old 150 estimate.
        expect(learnPace(150, [1000, 1100, 1200, 1300, 1400])).toBe(125);
        expect(learnPace(150, [1000, 1000, 1000])).toBe(75);
    });
});
