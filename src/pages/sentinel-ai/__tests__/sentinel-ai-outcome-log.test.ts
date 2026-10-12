import { SignalOutcomeLog, type OutcomeLogIO } from '../sentinel-ai-outcome-log';
import type { SurfacedSignalInput } from '../sentinel-ai-outcomes';

const signal = (over: Partial<SurfacedSignalInput> = {}): SurfacedSignalInput => ({
    symbol: 'R_100',
    contract: 'OVER',
    barrier: 2,
    label: 'Over 2',
    psychologyScore: 66,
    momentumPass: true,
    momentumScore: 50,
    momentumBlocked: false,
    ...over,
});

const make = (overrides: Partial<OutcomeLogIO> = {}) => {
    let clock = 10_000;
    const ticks: Record<string, { t: number; price: number }[]> = { R_100: [{ t: 9_000, price: 100.11 }] };
    const listeners = new Set<(s: string) => void>();
    const save = jest.fn();
    const io: OutcomeLogIO = {
        getTicks: s => ticks[s] ?? [],
        getPipSize: () => 2,
        onTick: cb => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        now: () => clock,
        load: () => [],
        save,
        ...overrides,
    };
    const log = new SignalOutcomeLog(io);
    return {
        log,
        save,
        advance: (ms: number) => {
            clock += ms;
        },
        tick: (symbol: string, t: number, price: number) => {
            (ticks[symbol] ||= []).push({ t, price });
            listeners.forEach(l => l(symbol));
        },
    };
};

describe('SignalOutcomeLog', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('records the decision tick, then resolves on the next tick (not the decision tick)', () => {
        const h = make();
        h.log.observe([signal()]);
        const [pending] = h.log.getRecords();
        expect(pending.decisionTickEpoch).toBe(9_000);
        expect(pending.state).toBe('pending');
        h.tick('R_100', 10_000, 100.17);
        const [done] = h.log.getRecords();
        expect(done.state).toBe('resolved');
        expect(done.outcomeDigit).toBe(7);
        expect(done.won).toBe(true);
    });

    it('does not log the same live signal on every sample', () => {
        const h = make();
        for (let i = 0; i < 5; i += 1) {
            h.advance(1000);
            h.log.observe([signal()]);
        }
        expect(h.log.getRecords()).toHaveLength(1);
    });

    it('times out to unresolved after 30 s with no new tick', () => {
        const h = make();
        h.log.observe([signal()]);
        h.advance(31_000);
        h.log.observe([signal()]);
        expect(h.log.getRecords()[0].state).toBe('unresolved');
    });

    it('marks traded, notifies subscribers, and saves (throttled); clear saves at once', () => {
        const h = make();
        const listener = jest.fn();
        h.log.subscribe(listener);
        h.log.observe([signal()]);
        h.log.markTraded('R_100', 'OVER', 2);
        expect(h.log.getRecords()[0].traded).toBe(true);
        expect(listener).toHaveBeenCalled();
        expect(h.save).not.toHaveBeenCalled();
        jest.advanceTimersByTime(2_500);
        expect(h.save).toHaveBeenCalledTimes(1);
        h.log.clear();
        expect(h.log.getRecords()).toHaveLength(0);
        expect(h.save).toHaveBeenLastCalledWith([]);
    });

    it('never throws into the caller, whatever the tick source or storage does', () => {
        const h = make({
            getTicks: () => {
                throw new Error('bus down');
            },
            save: () => {
                throw new Error('quota');
            },
            load: () => {
                throw new Error('blocked');
            },
        });
        expect(() => h.log.observe([signal()])).not.toThrow();
        expect(() => h.log.markTraded('R_100', 'OVER', 2)).not.toThrow();
        expect(() => jest.advanceTimersByTime(5_000)).not.toThrow();
        expect(() => h.log.clear()).not.toThrow();
        expect(() => h.log.toCsv()).not.toThrow();
    });

    it('loads previously stored records', () => {
        const first = make();
        first.log.observe([signal()]);
        const stored = first.log.getRecords();
        const second = make({ load: () => JSON.parse(JSON.stringify(stored)) });
        expect(second.log.getRecords()).toHaveLength(1);
    });
});
