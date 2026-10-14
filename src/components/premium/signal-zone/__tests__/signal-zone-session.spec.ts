import { SignalZoneSession, stopLossHit } from '../signal-zone-session';

const run = (runId: string, total: number, running = true) => ({ running, runId, total });

describe('stop loss decision', () => {
    it('hits at or past the limit, never when off', () => {
        expect(stopLossHit(-10, 10)).toBe(true);
        expect(stopLossHit(-9.99, 10)).toBe(false);
        expect(stopLossHit(-500, 0)).toBe(false);
    });
});

describe('session watch', () => {
    it('measures the loss from the total seen when the run started and asks to stop once', () => {
        const session = new SignalZoneSession();
        session.arm(10, 'Under 8 on Volatility 25', 1);
        expect(session.observe(run('r1', 100))).toBe(false);
        expect(session.observe(run('r1', 95))).toBe(false);
        expect(session.observe(run('r1', 90))).toBe(true);
        expect(session.observe(run('r1', 85))).toBe(false);
        expect(session.getSnapshot().stoppedBy).toContain('Stop loss reached');
        expect(session.getSnapshot().pnl).toBe(-15);
    });
    it('does nothing when not armed, but still reports the run', () => {
        const session = new SignalZoneSession();
        expect(session.observe(run('r1', 0))).toBe(false);
        expect(session.observe(run('r1', -50))).toBe(false);
        expect(session.getSnapshot().pnl).toBe(-50);
    });
    it('does nothing when the stop loss is 0', () => {
        const session = new SignalZoneSession();
        session.arm(0, 'x', 1);
        session.observe(run('r1', 0));
        expect(session.observe(run('r1', -1000))).toBe(false);
    });
    it('starts every run with a fresh baseline and clears the last stop message', () => {
        const session = new SignalZoneSession();
        session.arm(5, 'x', 1);
        session.observe(run('r1', 0));
        expect(session.observe(run('r1', -6))).toBe(true);
        session.observe(run('r1', -6, false));
        expect(session.getSnapshot().running).toBe(false);
        expect(session.getSnapshot().stoppedBy).toContain('Stop loss');
        expect(session.observe(run('r2', -6))).toBe(false);
        expect(session.getSnapshot().stoppedBy).toBeNull();
        expect(session.observe(run('r2', -12))).toBe(true);
    });
    it('stops guarding after disarm', () => {
        const session = new SignalZoneSession();
        session.arm(5, 'x', 1);
        session.disarm();
        session.observe(run('r1', 0));
        expect(session.observe(run('r1', -50))).toBe(false);
        expect(session.getSnapshot().armed).toBe(false);
    });
    it('notifies subscribers only when something changed', () => {
        const session = new SignalZoneSession();
        let calls = 0;
        const stop = session.subscribe(() => { calls += 1; });
        session.observe(run('r1', 0));
        const afterStart = calls;
        session.observe(run('r1', 0));
        expect(calls).toBe(afterStart);
        stop();
        session.observe(run('r1', 1));
        expect(calls).toBe(afterStart);
    });
    it('records the load result', () => {
        const session = new SignalZoneSession();
        session.setLoadStatus(false, 'nope', 5);
        expect(session.getSnapshot().loadStatus).toEqual({ ok: false, message: 'nope', at: 5 });
    });
});
