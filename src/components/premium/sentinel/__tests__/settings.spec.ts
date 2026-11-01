import { DEFAULT_TRADING, GREENS_DEFAULT, loadTrading, normalizeTradingSettings, PRESETS, SENTINEL_GATES } from '../settings';

describe('Sentinel AI trading gates', () => {
    beforeEach(() => window.localStorage.clear());

    it('starts with the win-streak guard on (3 greens) and the eased gates', () => {
        expect(DEFAULT_TRADING).toMatchObject({
            winStreakGate: true,
            winStreak: GREENS_DEFAULT,
            pressureMax: 45,
            meterFloor: 45,
            meterFloorRecovery: 48,
        });
        expect(loadTrading()).toMatchObject(SENTINEL_GATES);
    });

    it('the guard cannot be saved off: whatever is stored, it loads on', () => {
        expect(normalizeTradingSettings({ winStreakGate: false }).winStreakGate).toBe(true);
        window.localStorage.setItem('sentinelai.auto.settings.v1', JSON.stringify({ stake: 2, winStreakGate: false }));
        window.localStorage.setItem('sentinelai.auto.gates.v1', '1');
        window.localStorage.setItem('sentinelai.auto.greens.v1', '1');
        expect(loadTrading().winStreakGate).toBe(true);
    });

    it('moves settings saved before the green-digits rule to 3 greens once, then respects the chosen number', () => {
        // the old Sentinel: guard off, a run of 6
        window.localStorage.setItem('sentinelai.auto.gates.v1', '1');
        window.localStorage.setItem(
            'sentinelai.auto.settings.v1',
            JSON.stringify({ stake: 2, winStreakGate: false, winStreak: 6, pressureMax: 35 })
        );
        const first = loadTrading();
        expect(first).toMatchObject({ stake: 2, winStreakGate: true, winStreak: GREENS_DEFAULT, pressureMax: 35 });
        // the user picks 5 greens: the migration does not run again
        window.localStorage.setItem('sentinelai.auto.settings.v1', JSON.stringify({ ...first, winStreak: 5 }));
        expect(loadTrading().winStreak).toBe(5);
    });

    it('every preset keeps the win-streak guard on, and Careful keeps the strictest gates', () => {
        for (const p of PRESETS) expect(p.trading.winStreakGate).toBe(true);
        const by = (id: string) => PRESETS.find(p => p.id === id)!.trading;
        expect(by('careful').winStreak).toBeGreaterThan(by('balanced').winStreak!);
        expect(by('balanced').winStreak).toBeGreaterThan(by('active').winStreak!);
        expect(by('careful').pressureMax).toBeLessThan(by('balanced').pressureMax!);
        expect(by('balanced').pressureMax).toBeLessThan(by('active').pressureMax!);
        expect(by('careful').meterFloor).toBeGreaterThan(by('balanced').meterFloor!);
        expect(by('balanced').meterFloor).toBeGreaterThan(by('active').meterFloor!);
    });
});
