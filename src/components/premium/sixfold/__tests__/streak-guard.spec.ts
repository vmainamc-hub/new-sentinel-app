import { streakRead } from '../streak-guard';
import type { Contract } from '../bot';

const over2: Contract = { side: 'OVER', param: 2 }; // wins on 3-9, expects 3 losses in 10

describe('streak guard', () => {
    it('needs the whole run to be winning digits', () => {
        expect(streakRead([0, 5, 6, 7, 8, 9, 4, 3], over2, 6, 1).ok).toBe(true);
        expect(streakRead([0, 5, 6, 7, 8, 9, 4, 2], over2, 6, 1).ok).toBe(false); // latest digit lost
        expect(streakRead([0, 5, 6, 7, 8, 9, 4, 3], over2, 8, 1).ok).toBe(false); // run is 7
        expect(streakRead([0, 5, 6, 7, 8, 9, 4, 3], over2, 6, 1).run).toBe(7);
    });

    it('drops a market with too many losses in the last 10', () => {
        const cold = [0, 1, 2, 0, 1, 7, 8, 1, 9, 9]; // 6 losses of 10
        const r = streakRead(cold, over2, 2, 1);
        expect(r.abortAt).toBe(4);
        expect(r.abort).toBe(true);
        expect(r.ok).toBe(false);
        expect(streakRead([5, 6, 7, 1, 8, 9, 3, 4, 5, 6], over2, 4, 1).abort).toBe(false);
    });

    it('refuses to buy on a short history', () => {
        expect(streakRead([5, 6], over2, 6, 1).ok).toBe(false);
    });
});
