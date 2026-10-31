import type { ScanFunnel } from '../../sixfold/runner';
import { describeFunnel, FunnelTally } from '../funnel';
import type { EngineFunnel } from '../overlay';

const engine = (patch: Partial<EngineFunnel> = {}): EngineFunnel => ({
    at: 1,
    mode: 'balanced',
    markets: 10,
    reads: 60,
    strong: 2,
    steady: 4,
    watch: 6,
    none: 48,
    board: 6,
    error: null,
    ...patch,
});
const scan = (patch: Partial<ScanFunnel> = {}): ScanFunnel => ({
    at: 1,
    cells: 60,
    guardedPressure: 0,
    guardedWindow: 0,
    guardedWinning: 0,
    streakDropped: 0,
    streakReady: 0,
    streakGate: false,
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
    it('blames the feed when no market has enough ticks', () => {
        const v = describeFunnel(
            engine({ markets: 0, reads: 0, strong: 0, steady: 0, watch: 0, none: 0, board: 0 }),
            scan(),
            false
        );
        expect(v.blockedAt).toBe('markets');
    });
    it('blames Pulse when no contract has a signal in any tier', () => {
        const v = describeFunnel(engine({ strong: 0, steady: 0, watch: 0, none: 60, board: 0 }), scan(), false);
        expect(v.blockedAt).toBe('tiers');
    });
    it('blames the mode when signals exist but none is strong enough for it', () => {
        const v = describeFunnel(engine({ mode: 'careful', strong: 0, board: 0 }), scan(), false);
        expect(v.blockedAt).toBe('board');
        expect(v.steps.find(s => s.key === 'board')?.note).toMatch(/strong only/);
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
    it('splits the guard refusals by guard', () => {
        const v = describeFunnel(
            engine(),
            scan({ guarded: 56, guardedPressure: 40, guardedWindow: 10, guardedWinning: 6, eligible: 0 }),
            false
        );
        const note = v.steps.find(s => s.key === 'guards')?.note ?? '';
        expect(note).toMatch(/40 losing-side pressure, 10 multi-window, 6 winning-side/);
    });
    it('blames the win-streak guard when it drops every contract that cleared the score bar', () => {
        const v = describeFunnel(engine(), scan({ eligible: 3, streakDropped: 3, streakGate: true }), false);
        expect(v.blockedAt).toBe('streak');
        expect(v.steps.find(s => s.key === 'streak')?.note).toMatch(/3 dropped/);
    });
    it('says the win-streak guard is off when it is', () => {
        expect(describeFunnel(engine(), scan(), false).steps.find(s => s.key === 'streak')?.note).toBe('off');
    });
    it('counts alive contracts down the scanner steps', () => {
        const v = describeFunnel(
            engine(),
            scan({ resting: 6, guarded: 4, meterVeto: 10, overlayVeto: 30, belowBar: 6, eligible: 4 }),
            false
        );
        expect(v.steps.filter(s => s.side === 'scanner').map(s => s.alive)).toEqual([60, 60, 54, 50, 40, 10, 4, 4, 0]);
    });
});

describe('FunnelTally', () => {
    it('adds each scan once, sums what stopped contracts and drops points older than ten minutes', () => {
        const t = new FunnelTally();
        t.add(
            scan({ at: 1, overlayVeto: 10, eligible: 0, reasons: [{ reason: 'Pulse: x', count: 10 }] }),
            engine({ board: 0 }),
            1000
        );
        t.add(scan({ at: 1, overlayVeto: 10 }), engine(), 1500); // the same scan again: ignored
        t.add(
            scan({ at: 2, overlayVeto: 5, meterVeto: 20, eligible: 2, reasons: [{ reason: 'Pulse: x', count: 5 }] }),
            engine(),
            2000
        );
        const s = t.summary(3000);
        expect(s.scans).toBe(2);
        expect(s.scansWithEligible).toBe(1);
        expect(s.scansWithBoard).toBe(1);
        expect(s.stoppedBy[0]).toMatchObject({ key: 'meter', count: 20 });
        expect(s.reasons[0]).toEqual({ reason: 'Pulse: x', count: 15 });
        expect(t.summary(1000 + 11 * 60 * 1000).scans).toBe(0);
    });
});
