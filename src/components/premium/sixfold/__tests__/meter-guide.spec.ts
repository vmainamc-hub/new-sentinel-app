import { climateOf, MAX_METER_BUMP, meterCall } from '../meter-guide';
import type { RegimeSummary } from '../regime';

const good = { meter: 58, coldShare: 0.1, verdict: 'GO' as const };
const poor = { meter: 40, coldShare: 0.4, verdict: 'AVOID' as const };
const base = { cell: { state: 'NORMAL' as const, strength: 50 }, recovering: false, waitedMs: 0, patienceMs: 90_000 };

describe('meterCall', () => {
    it('asks nothing when the Meter reads well', () => {
        const c = meterCall({ ...base, climate: good });
        expect(c).toMatchObject({ allow: true, bump: 0 });
    });

    it('never buys a cell in a loss cluster, however long it has waited', () => {
        for (const waitedMs of [0, 60_000, 10 * 60_000]) {
            const c = meterCall({ ...base, climate: good, cell: { state: 'COLD', strength: 20 }, waitedMs });
            expect(c.allow).toBe(false);
        }
    });

    it('has no cliff at 50: a Meter of 49 asks about the same as 51', () => {
        const at = (meter: number) =>
            meterCall({ ...base, climate: { meter, coldShare: 0.1, verdict: meter >= 50 ? 'GO' : 'WAIT' } });
        expect(at(51).bump).toBe(0);
        expect(at(49).bump).toBeLessThanOrEqual(1);
        expect(at(49).allow).toBe(true);
    });

    it('raises the bar smoothly as the climate gets worse', () => {
        const bumps = [50, 46, 42, 38, 30].map(
            meter => meterCall({ ...base, climate: { meter, coldShare: 0.2, verdict: 'WAIT' } }).bump
        );
        for (let i = 1; i < bumps.length; i++) expect(bumps[i]).toBeGreaterThanOrEqual(bumps[i - 1]);
        expect(bumps[bumps.length - 1]).toBeGreaterThan(bumps[0]);
    });

    it('asks more of a recovery trade than of a normal one', () => {
        const normal = meterCall({ ...base, climate: poor });
        const recovery = meterCall({ ...base, climate: poor, recovering: true });
        expect(recovery.bump).toBeGreaterThan(normal.bump);
        // And a good climate costs a recovery trade nothing either.
        expect(meterCall({ ...base, climate: good, recovering: true }).bump).toBe(0);
    });

    it('fades to nothing while it waits, so it can never freeze trading', () => {
        const at = (waitedMs: number) => meterCall({ ...base, climate: poor, recovering: true, waitedMs }).bump;
        expect(at(0)).toBeGreaterThan(at(45_000));
        expect(at(45_000)).toBeGreaterThan(0);
        expect(at(90_000)).toBe(0);
        expect(at(500_000)).toBe(0);
    });

    it('never adds more than the cap', () => {
        const worst = meterCall({
            climate: { meter: 0, coldShare: 1, verdict: 'AVOID' },
            cell: { state: 'NORMAL', strength: 0 },
            recovering: true,
            waitedMs: 0,
            patienceMs: 90_000,
        });
        expect(worst.bump).toBe(MAX_METER_BUMP);
    });

    it('treats a missing reading as neutral, not as bad', () => {
        expect(
            meterCall({ climate: null, cell: null, recovering: true, waitedMs: 0, patienceMs: 90_000 })
        ).toMatchObject({ allow: true, bump: 0 });
    });

    it('orders eligible cells by Meter strength without gating any', () => {
        const strong = meterCall({ ...base, climate: good, cell: { state: 'HOT', strength: 75 } });
        const weak = meterCall({ ...base, climate: good, cell: { state: 'NORMAL', strength: 42 } });
        expect(strong.rank).toBeGreaterThan(weak.rank);
        expect(weak.allow).toBe(true);
    });

    it('reads the climate off a regime summary', () => {
        const r = {
            total: 4,
            meter: 47,
            verdict: 'WAIT',
            counts: { COLD: 1, NORMAL: 3, HOT: 0, TURNING: 0 },
        } as unknown as RegimeSummary;
        expect(climateOf(r)).toEqual({ meter: 47, coldShare: 0.25, verdict: 'WAIT' });
        expect(climateOf(null)).toBeNull();
    });

    describe('hard floor', () => {
        const at = (climate: number, cell: number, floor: number, recovering = false, waitedMs = 0) =>
            meterCall({
                ...base,
                floor,
                recovering,
                waitedMs,
                climate: { meter: climate, coldShare: 0, verdict: climate >= 50 ? 'GO' : 'WAIT' },
                cell: { state: 'NORMAL', strength: cell },
            });

        it('buys at the floor and not under it, for the market-wide Meter and for the contract', () => {
            expect(at(50, 50, 50).allow).toBe(true);
            expect(at(49, 60, 50).allow).toBe(false);
            expect(at(60, 49, 50).allow).toBe(false);
            expect(at(49, 60, 50).note).toMatch(/Meter 49 is under the 50 floor/);
        });

        it('uses the recovery floor for recovery: 51 passes a normal trade but not a recovery trade at 52', () => {
            expect(at(51, 51, 50, false).allow).toBe(true);
            expect(at(51, 51, 52, true).allow).toBe(false);
            expect(at(52, 52, 52, true).allow).toBe(true);
        });

        it('never eases off with waiting', () => {
            for (const waitedMs of [0, 90_000, 60 * 60_000]) expect(at(40, 40, 50, false, waitedMs).allow).toBe(false);
        });

        it('is off at 0', () => {
            expect(at(10, 10, 0).allow).toBe(true);
        });
    });
});
