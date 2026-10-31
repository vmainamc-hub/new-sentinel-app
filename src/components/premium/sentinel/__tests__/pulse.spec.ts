import { PULSE_CONTRACTS, PULSE_MIN_TICKS, readContract, readPulse } from '../pulse';

const flat = (digit: number, n = 1000) => Array<number>(n).fill(digit);
const OVER1 = { side: 'OVER', param: 1 } as const;

describe('Pulse', () => {
    it('calls a contract strong when every window is well above fair and nothing lost lately', () => {
        const r = readContract('R_10', flat(5), OVER1);
        expect(r.agree).toBe(4);
        expect(r.tier).toBe('strong');
        expect(r.score).toBeGreaterThan(50);
    });

    it('gives no signal when the contract has been losing', () => {
        const r = readContract('R_10', flat(0), OVER1);
        expect(r.tier).toBeNull();
        expect(r.agree).toBe(0);
    });

    it('steps a signal down one tier after an unusual run of recent losses', () => {
        const series = [...flat(5, 990), 0, 0, 0, 0, 0, 5, 5, 5, 5, 5];
        expect(readContract('R_10', series, OVER1).tier).toBe('steady');
    });

    it('is steady, not strong, when only the three shorter windows agree', () => {
        // 700 old losing ticks then 300 winning ones: the 1000 window is 30% (below fair 80%), the others are 100%
        const r = readContract('R_10', [...flat(0, 700), ...flat(5, 300)], OVER1);
        expect(r.agree).toBe(3);
        expect(r.tier).toBe('steady');
    });

    it('reads only markets that have enough ticks', () => {
        const snap = readPulse({ A: flat(5, PULSE_MIN_TICKS), B: flat(5, PULSE_MIN_TICKS - 1) }, ['A', 'B', 'C']);
        expect(snap.markets).toBe(1);
        expect(snap.reads).toHaveLength(PULSE_CONTRACTS.length);
        expect(snap.reads.every(r => r.symbol === 'A')).toBe(true);
    });
});
