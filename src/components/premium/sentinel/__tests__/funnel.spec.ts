import type { ScanFunnel } from '../../sixfold/runner';
import { describeFunnel, FunnelTally } from '../funnel';
import type { EngineFunnel } from '../overlay';

const producer = { ranked: 20, engineBlocked: 4, tooDangerous: 2, confirmed: 0, building: 3, leading: 0 };
const engine = (patch: Partial<EngineFunnel> = {}): EngineFunnel => ({
    at: 1,
    mode: 'balanced',
    producer,
    momentumFailed: 0,
    qualityFailed: 0,
    sentinelReads: 3,
    fusionReads: 2,
    standDowns: 0,
    board: 3,
    boardBoth: 1,
    boardSentinel: 2,
    boardFusion: 0,
    error: null,
    ...patch,
});
const scan = (patch: Partial<ScanFunnel> = {}): ScanFunnel => ({
    at: 1,
    cells: 60,
    tradable: 60,
    resting: 0,
    guarded: 0,
    meterVeto: 0,
    overlayVeto: 0,
    belowBar: 0,
    eligible: 4,
    reasons: [],
    ...patch,
});

describe('describeFunnel', () => {
    it('says the engines have not been read before the first read', () => {
        expect(describeFunnel(null, null, false).blockedAt).toBeNull();
    });
    it('names an engine failure', () => {
        const v = describeFunnel(engine({ error: 'boom' }), scan(), false);
        expect(v.blockedAt).toBe('engine-error');
        expect(v.verdict).toMatch(/boom/);
    });
    it('blames Sentinel when it has no signal in any tier', () => {
        const v = describeFunnel(
            engine({
                producer: { ...producer, building: 0 },
                sentinelReads: 0,
                board: 0,
                boardBoth: 0,
                boardSentinel: 0,
            }),
            scan(),
            false
        );
        expect(v.blockedAt).toBe('tiers');
    });
    it('blames the momentum / quality limits when they cut every Sentinel signal', () => {
        const v = describeFunnel(engine({ sentinelReads: 0, momentumFailed: 3, board: 0 }), scan(), false);
        expect(v.blockedAt).toBe('sentinel');
        expect(v.steps.find(s => s.key === 'sentinel')?.note).toMatch(/3 failed momentum/);
    });
    it('blames the Meter guide when it refuses every contract that the guards let through', () => {
        const v = describeFunnel(engine(), scan({ meterVeto: 60, eligible: 0 }), false);
        expect(v.blockedAt).toBe('meter');
    });
    it('blames the score bar when everything else lets contracts through', () => {
        const v = describeFunnel(engine(), scan({ belowBar: 60, eligible: 0 }), false);
        expect(v.blockedAt).toBe('bar');
    });
    it('reports contracts getting through, and an armed contract', () => {
        expect(describeFunnel(engine(), scan(), false).blockedAt).toBeNull();
        expect(describeFunnel(engine(), scan(), true).verdict).toMatch(/armed/i);
    });
    it('counts alive contracts down the scanner steps', () => {
        const v = describeFunnel(
            engine(),
            scan({ resting: 6, guarded: 4, meterVeto: 10, overlayVeto: 30, belowBar: 6, eligible: 4 }),
            false
        );
        expect(v.steps.filter(s => s.side === 'scanner').map(s => s.alive)).toEqual([60, 60, 54, 50, 40, 10, 4, 0]);
    });
});

describe('FunnelTally', () => {
    it('adds each scan once, sums what stopped contracts and drops points older than ten minutes', () => {
        const t = new FunnelTally();
        t.add(
            scan({ at: 1, overlayVeto: 10, eligible: 0, reasons: [{ reason: 'Engines: x', count: 10 }] }),
            engine({ board: 0 }),
            1000
        );
        t.add(scan({ at: 1, overlayVeto: 10 }), engine(), 1500); // the same scan again: ignored
        t.add(
            scan({ at: 2, overlayVeto: 5, meterVeto: 20, eligible: 2, reasons: [{ reason: 'Engines: x', count: 5 }] }),
            engine(),
            2000
        );
        const s = t.summary(3000);
        expect(s.scans).toBe(2);
        expect(s.scansWithEligible).toBe(1);
        expect(s.scansWithEngineBoard).toBe(1);
        expect(s.stoppedBy[0]).toMatchObject({ key: 'meter', count: 20 });
        expect(s.reasons[0]).toEqual({ reason: 'Engines: x', count: 15 });
        expect(t.summary(1000 + 11 * 60 * 1000).scans).toBe(0);
    });
});
