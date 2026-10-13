import { isRiseFall } from '../rise-fall';

describe('isRiseFall', () => {
    it('does not crash without a shortcode and uses the barrier', () => {
        expect(isRiseFall({ contract_type: 'CALL' })).toBe(true);
        expect(isRiseFall({ contract_type: 'CALL', barrier: '+0.10' })).toBe(false);
        expect(isRiseFall({ contract_type: 'PUT', shortcode: undefined, barrier: '' })).toBe(true);
        expect(isRiseFall({})).toBe(true);
        expect(isRiseFall()).toBe(true);
        expect(isRiseFall(null)).toBe(true);
    });

    it('still reads the shortcode when there is one', () => {
        expect(isRiseFall({ shortcode: 'CALL_R_100_10_1700000000_5_S0P_0' })).toBe(true);
        expect(isRiseFall({ shortcode: 'CALL_R_100_10_1700000000_5_S10P_0' })).toBe(false);
    });
});
