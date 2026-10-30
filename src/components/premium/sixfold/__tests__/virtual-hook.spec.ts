import { freshVh, vhAfterReal, vhAfterVirtual, type VhConfig } from '../virtual-hook';

const streak: VhConfig = { enterLosses: 2, returnWins: 2, mode: 'STREAK', fixedCount: 3 };

describe('virtual hook state machine', () => {
    it('goes virtual after the configured real losses in a row, and a win resets the count', () => {
        let s = freshVh();
        s = vhAfterReal(s, false, streak).state;
        expect(s.virtual).toBe(false);
        s = vhAfterReal(s, true, streak).state;
        expect(s.realLosses).toBe(0);
        s = vhAfterReal(s, false, streak).state;
        const step = vhAfterReal(s, false, streak);
        expect(step.event).toBe('entered');
        expect(step.state.virtual).toBe(true);
    });

    it('streak mode needs consecutive paper wins; a paper loss restarts the count', () => {
        let s = vhAfterReal(vhAfterReal(freshVh(), false, streak).state, false, streak).state;
        s = vhAfterVirtual(s, true, streak).state;
        s = vhAfterVirtual(s, false, streak).state;
        expect(s.virtualWins).toBe(0);
        s = vhAfterVirtual(s, true, streak).state;
        const step = vhAfterVirtual(s, true, streak);
        expect(step.event).toBe('returned');
        expect(step.state).toEqual(freshVh());
    });

    it('fixed mode returns after the set number of paper trades whatever they did', () => {
        const cfg: VhConfig = { ...streak, mode: 'FIXED', fixedCount: 3 };
        let s = vhAfterReal(vhAfterReal(freshVh(), false, cfg).state, false, cfg).state;
        s = vhAfterVirtual(s, false, cfg).state;
        s = vhAfterVirtual(s, true, cfg).state;
        expect(s.virtual).toBe(true);
        expect(vhAfterVirtual(s, false, cfg).event).toBe('returned');
    });
});
