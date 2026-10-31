import { DEFAULT_TRADING, loadTrading, PRESETS, SENTINEL_GATES } from '../settings';

describe('Sentinel AI trading gates', () => {
    beforeEach(() => window.localStorage.clear());

    it('starts with the win-streak guard off and the eased gates', () => {
        expect(DEFAULT_TRADING).toMatchObject({
            winStreakGate: false,
            pressureMax: 45,
            meterFloor: 45,
            meterFloorRecovery: 48,
        });
        expect(loadTrading()).toMatchObject(SENTINEL_GATES);
    });

    it('moves settings saved before the change to the new gates once, then respects later choices', () => {
        window.localStorage.setItem(
            'sentinelai.auto.settings.v1',
            JSON.stringify({ stake: 2, winStreakGate: true, pressureMax: 35, meterFloor: 50 })
        );
        const first = loadTrading();
        expect(first).toMatchObject({ stake: 2, winStreakGate: false, pressureMax: 45, meterFloor: 45 });
        // the user switches the win-streak guard back on: the migration does not run again
        window.localStorage.setItem('sentinelai.auto.settings.v1', JSON.stringify({ ...first, winStreakGate: true }));
        expect(loadTrading().winStreakGate).toBe(true);
    });

    it('every preset leaves the win-streak guard off, and Careful keeps the strictest gates', () => {
        for (const p of PRESETS) expect(p.trading.winStreakGate).toBe(false);
        const by = (id: string) => PRESETS.find(p => p.id === id)!.trading;
        expect(by('careful').pressureMax).toBeLessThan(by('balanced').pressureMax!);
        expect(by('balanced').pressureMax).toBeLessThan(by('active').pressureMax!);
        expect(by('careful').meterFloor).toBeGreaterThan(by('balanced').meterFloor!);
        expect(by('balanced').meterFloor).toBeGreaterThan(by('active').meterFloor!);
    });
});
