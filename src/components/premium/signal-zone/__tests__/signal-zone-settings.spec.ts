import { DEFAULT_SETTINGS, MIN_STAKE, normalizeSettings, validateSettings } from '../signal-zone-settings';

describe('settings', () => {
    it('fills every missing field with the defaults', () => {
        expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings({ stake: '2.5' }).stake).toBe(2.5);
        expect(normalizeSettings({ stake: '2.5' }).martingaleLevel).toBe(DEFAULT_SETTINGS.martingaleLevel);
    });
    it('falls back on garbage and rounds stakes to cents', () => {
        const s = normalizeSettings({ stake: 'abc', maxStake: 7.456, mergeMode: 'nonsense', excludedMarkets: ['R_10', 'R_10', ' '] });
        expect(s.stake).toBe(DEFAULT_SETTINGS.stake);
        expect(s.maxStake).toBe(7.46);
        expect(s.mergeMode).toBe('both');
        expect(s.excludedMarkets).toEqual(['R_10']);
    });
    it('defaults the entry digits to Over 2 and Under 7, and accepts the alternatives 4 and 5', () => {
        expect(DEFAULT_SETTINGS.defaultOverEntry).toBe(2);
        expect(DEFAULT_SETTINGS.defaultUnderEntry).toBe(7);
        expect(validateSettings({ ...DEFAULT_SETTINGS, defaultOverEntry: 4, defaultUnderEntry: 5 })).toEqual([]);
    });
    it('turns auto-push on by default with a lifetime between 30 and 300 seconds', () => {
        expect(DEFAULT_SETTINGS.autoPush).toBe(true);
        expect(DEFAULT_SETTINGS.signalLifetimeSeconds).toBe(90);
        expect(validateSettings({ ...DEFAULT_SETTINGS, signalLifetimeSeconds: 60 })).toEqual([]);
        expect(validateSettings({ ...DEFAULT_SETTINGS, signalLifetimeSeconds: 120 })).toEqual([]);
        expect(validateSettings({ ...DEFAULT_SETTINGS, signalLifetimeSeconds: 10 })[0]).toContain('lifetime');
        expect(validateSettings({ ...DEFAULT_SETTINGS, signalLifetimeSeconds: 900 })[0]).toContain('lifetime');
        expect(normalizeSettings({ autoPush: false }).autoPush).toBe(false);
    });
    it('accepts the defaults', () => {
        expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
    });
    it('names each problem in plain words', () => {
        expect(validateSettings({ ...DEFAULT_SETTINGS, stake: MIN_STAKE - 0.01 })[0]).toContain('Stake');
        expect(validateSettings({ ...DEFAULT_SETTINGS, martingaleMultiplier: 0.5 })[0]).toContain('multiplier');
        expect(validateSettings({ ...DEFAULT_SETTINGS, martingaleLevel: 0 })[0]).toContain('level');
        expect(validateSettings({ ...DEFAULT_SETTINGS, stake: 5, maxStake: 2 })[0]).toContain('Max stake');
        expect(validateSettings({ ...DEFAULT_SETTINGS, takeProfit: 0 })[0]).toContain('Take profit');
        expect(validateSettings({ ...DEFAULT_SETTINGS, defaultOverEntry: 3 })[0]).toContain('Default Over entry');
        expect(validateSettings({ ...DEFAULT_SETTINGS, defaultUnderEntry: 6 })[0]).toContain('Default Under entry');
        expect(validateSettings({ ...DEFAULT_SETTINGS, recoveryOverBarrier: 4 })[0]).toContain('Over barrier');
        expect(validateSettings({ ...DEFAULT_SETTINGS, recoveryUnderBarrier: 5 })[0]).toContain('Under barrier');
    });
    it('lets the stop loss be switched off with 0', () => {
        expect(validateSettings({ ...DEFAULT_SETTINGS, stopLoss: 0 })).toEqual([]);
    });
});
