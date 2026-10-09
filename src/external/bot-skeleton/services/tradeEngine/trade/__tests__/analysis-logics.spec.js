jest.mock('../../../api/api-base', () => ({ api_base: { api: null, pushSubscription: jest.fn() } }));
jest.mock('@deriv-com/translations', () => ({ localize: text => text }));

import Ticks from '../Ticks';

const make = (digits, candles = []) => {
    const Engine = Ticks(class {});
    const engine = new Engine();
    engine.getLastDigitList = async () => digits;
    engine.getOhlc = async () => candles;
    return engine;
};

describe('Analysis Logics helpers', () => {
    const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // 5 even, 5 odd, 5 over 4, 4 under 4... over 4 = 5 digits

    it('even/odd percent', async () => {
        expect(await make(digits).getEvenOddPercent({ type: 'EVEN', n: 10 })).toBe(50);
        expect(await make([2, 4, 6, 1]).getEvenOddPercent({ type: 'EVEN', n: 4 })).toBe(75);
        expect(await make([2, 4, 6, 1]).getEvenOddPercent({ type: 'ODD', n: 4 })).toBe(25);
    });

    it('over/under percent honours the window and the threshold', async () => {
        expect(await make(digits).getOverUnderPercent({ threshold: 4, n: 10, type: 'OVER' })).toBe(50);
        expect(await make(digits).getOverUnderPercent({ threshold: 4, n: 10, type: 'UNDER' })).toBe(40);
        expect(await make(digits).getOverUnderPercent({ threshold: 4, n: 2, type: 'OVER' })).toBe(100); // last two: 8, 9
    });

    it('match/differ percent', async () => {
        expect(await make([5, 5, 1, 2]).getMatchDiffPercent({ type: 'MATCH', val: 5, n: 4 })).toBe(50);
        expect(await make([5, 5, 1, 2]).getMatchDiffPercent({ type: 'DIFF', val: 5, n: 4 })).toBe(50);
    });

    it('most / least frequent digit', async () => {
        const list = [3, 3, 3, 1, 1, 7];
        expect(await make(list).getDigitFrequency({ rank: 'MOST', n: 6 })).toBe(3);
        expect(await make(list).getDigitFrequency({ rank: 'LEAST', n: 6 })).toBe(9);
    });

    it('last N digits condition', async () => {
        expect(await make([9, 1, 2, 3]).getLastDigitsCondition({ n: 3, op: 'LESS', digit: 4 })).toBe(true);
        expect(await make([9, 1, 2, 5]).getLastDigitsCondition({ n: 3, op: 'LESS', digit: 4 })).toBe(false);
        expect(await make([4, 4, 4]).getLastDigitsCondition({ n: 3, op: 'EQ', digit: 4 })).toBe(true);
    });

    it('rise/fall percent from candles', async () => {
        const candles = [{ open: 1, close: 2 }, { open: 2, close: 1 }, { open: 1, close: 3 }, { open: 3, close: 4 }];
        expect(await make([], candles).getRiseFallPercent({ type: 'RISE', n: 4 })).toBe(75);
        expect(await make([], candles).getRiseFallPercent({ type: 'FALL', n: 4 })).toBe(25);
    });
});
