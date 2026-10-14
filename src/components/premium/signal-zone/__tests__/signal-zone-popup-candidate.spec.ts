import { candidateFromSignal } from '../signal-zone-popup-candidate';
import { DEFAULT_SETTINGS } from '../signal-zone-settings';

const base = { symbol: '1HZ10V', marketName: 'Volatility 10 (1s)', contractType: 'DIGITUNDER' as const, barrier: 7, label: 'Under 7' };

describe('candidateFromSignal', () => {
    it('is loadable without being on any board, using the signal\'s own validated entry digit', () => {
        const { candidate, reason } = candidateFromSignal({ ...base, entryDigit: 3, entryStatus: 'ARMED' }, DEFAULT_SETTINGS, 1000);
        expect(reason).toBeNull();
        expect(candidate?.loadable).toBe(true);
        expect(candidate?.entryDigit).toBe(3);
        expect(candidate?.entrySource).toBe('engine');
    });
    it('falls back to the default digit when the engine gave none', () => {
        const { candidate } = candidateFromSignal({ ...base, entryDigit: null }, DEFAULT_SETTINGS, 1000);
        expect(candidate?.entrySource).toBe('default');
        expect(candidate?.entryDigit).toBe(DEFAULT_SETTINGS.defaultUnderEntry);
    });
    it('refuses a contract the Masika bots do not trade', () => {
        const { candidate, reason } = candidateFromSignal({ ...base, barrier: 9 }, DEFAULT_SETTINGS, 1000);
        expect(candidate).toBeNull();
        expect(reason).toMatch(/not a contract/);
    });
});
