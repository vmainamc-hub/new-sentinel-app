import { sentinelAgreement } from '../agree';

const sig = { symbol: 'R_50', contractType: 'DIGITOVER' as const, barrier: 2, label: 'Over 2' };
describe('sentinelAgreement', () => {
    it('classifies each relationship', () => {
        expect(sentinelAgreement(null, 'R_50', { side: 'OVER', param: 2 }).kind).toBe('NONE');
        expect(sentinelAgreement(sig, 'R_10', { side: 'OVER', param: 2 }).kind).toBe('NONE');
        expect(sentinelAgreement(sig, 'R_50', { side: 'OVER', param: 2 }).kind).toBe('SAME');
        expect(sentinelAgreement(sig, 'R_50', { side: 'OVER', param: 4 }).kind).toBe('SIDE');
        expect(sentinelAgreement(sig, 'R_50', { side: 'UNDER', param: 7 }).kind).toBe('MARKET');
    });
});
