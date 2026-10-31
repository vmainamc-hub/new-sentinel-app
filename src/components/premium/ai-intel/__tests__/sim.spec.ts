import { walkForward } from '@/components/premium/sixfold/entry-lab';
import { OVER_2, SimBook, SimStream, simulate, tally, ticksFromDigits, UNDER_7 } from '../sim';

const run = (digits: number[], contract = OVER_2, rule: any = { method: 'SETUP' }, duration = 1) =>
    simulate(ticksFromDigits(digits), contract, rule, duration);

describe('SimStream: Sixfold contract methodology', () => {
    it('spec example 1,5,2,6,3 on OVER 2 SETUP: two trades, setups are not losses', () => {
        const { trades } = run([1, 5, 2, 6, 3]);
        expect(trades).toHaveLength(2);
        expect(trades[0]).toMatchObject({ triggerIndex: 0, triggerDigit: 1, entryIndex: 1, entryDigit: 5, settleIndex: 1, settleDigit: 5, won: true });
        expect(trades[1]).toMatchObject({ triggerIndex: 2, triggerDigit: 2, entryIndex: 3, entryDigit: 6, settleIndex: 3, settleDigit: 6, won: true });
    });

    it('the settlement tick is never reused as a trigger', () => {
        // 1 triggers, settles on 0 (a losing digit that would otherwise trigger). Next trigger must come after it.
        const { trades } = run([1, 0, 1, 9]);
        expect(trades.map(t => [t.triggerIndex, t.settleIndex, t.won])).toEqual([
            [0, 1, false],
            [2, 3, true],
        ]);
    });

    it('a duration of 3 enters on the next tick and settles on trigger + 3; nothing triggers while open', () => {
        const { trades, pending } = run([2, 0, 1, 9, 9, 1, 4, 4, 9], OVER_2, { method: 'SETUP' }, 3);
        expect(trades).toHaveLength(2);
        expect(trades[0]).toMatchObject({ triggerIndex: 0, entryIndex: 1, entryDigit: 0, settleIndex: 3, settleDigit: 9, won: true });
        // ticks 1,2,3 were inside the contract (0 and 1 would have triggered); 9 at tick 4 does not trigger; tick 5 (1) does.
        expect(trades[1]).toMatchObject({ triggerIndex: 5, entryIndex: 6, settleIndex: 8 });
        expect(pending).toBeNull();
    });

    it('a contract still open when ticks end is pending, not a result', () => {
        const { trades, pending } = run([1, 5], OVER_2, { method: 'SETUP' }, 3);
        expect(trades).toHaveLength(0);
        expect(pending?.triggerIndex).toBe(0);
    });

    it('OVER 2 wins on 3-9 and UNDER 7 wins on 0-6, decided only by the settlement digit', () => {
        for (let d = 0; d <= 9; d++) {
            expect(run([0, d], OVER_2, { method: 'SETUP' }).trades[0].won).toBe(d >= 3);
            expect(run([9, d], UNDER_7, { method: 'SETUP' }).trades[0].won).toBe(d <= 6);
        }
    });

    it('SETUP triggers only on losing-side digits (OVER 2: 0-2, UNDER 7: 7-9)', () => {
        expect(run([3, 4, 5, 9, 8]).trades).toHaveLength(0);
        expect(run([0, 5, 1, 5, 2, 5, 3]).trades.map(t => t.triggerDigit)).toEqual([0, 1, 2]);
        expect(run([7, 1, 8, 1, 9, 1, 6], UNDER_7).trades.map(t => t.triggerDigit)).toEqual([7, 8, 9]);
    });

    it('ANY enters as soon as free; CUSTOM uses the given digit set', () => {
        expect(run([5, 5, 5, 5], OVER_2, { method: 'ANY' }).trades.map(t => t.triggerIndex)).toEqual([0, 2]);
        expect(run([4, 7, 4, 7], OVER_2, { method: 'CUSTOM', digits: [4] }).trades.map(t => t.triggerIndex)).toEqual([0, 2]);
    });

    it('SMART trigger only ever sees history up to the trigger tick', () => {
        const seenLens: number[] = [];
        const rule = { method: 'SMART' as const, trigger: (h: readonly number[]) => (seenLens.push(h.length), h.length >= 3 && h[h.length - 1] === 5) };
        const ticks = ticksFromDigits([1, 2, 5, 7, 5, 5, 0]);
        const s = new SimStream(OVER_2, rule, 1);
        ticks.forEach((t, i) => {
            s.push(t);
            expect(seenLens.at(-1)).toBeLessThanOrEqual(i + 1);
        });
    });

    it('rejects an invalid digit and clamps duration like Sixfold', () => {
        expect(() => new SimStream(OVER_2, { method: 'ANY' }, 1).push({ digit: 10, epoch: 0 })).toThrow();
        expect(new SimStream(OVER_2, { method: 'ANY' }, 99).duration).toBe(10);
        expect(new SimStream(OVER_2, { method: 'ANY' }, 0).duration).toBe(1);
    });

    it('matches Sixfold walkForward exactly on pseudo-random digits (ANY and SETUP, several durations)', () => {
        let a = 7;
        const digits = Array.from({ length: 4000 }, () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10));
        for (const contract of [OVER_2, UNDER_7]) {
            for (const method of ['ANY', 'SETUP'] as const) {
                for (const duration of [1, 2, 3, 5]) {
                    // walkForward never triggers on index 0, so give it one throwaway lead digit.
                    const ref = walkForward([0, ...digits], contract, method, { duration, warmup: 1 });
                    const mine = simulate(ticksFromDigits(digits), contract, { method }, duration).trades;
                    expect(mine.map(t => [t.triggerIndex + 1, t.triggerDigit, t.won])).toEqual(ref.map(t => [t.entryIndex, t.entryDigit, t.won]));
                }
            }
        }
    });
});

describe('SimBook: independent streams', () => {
    it('strategies on the same market keep separate state and markets do not leak', () => {
        const book = new SimBook();
        book.add('setup', 'R_10', new SimStream(OVER_2, { method: 'SETUP' }, 3));
        book.add('any', 'R_10', new SimStream(OVER_2, { method: 'ANY' }, 1));
        book.add('other', 'R_25', new SimStream(UNDER_7, { method: 'ANY' }, 1));
        const settled: Record<string, number> = {};
        [1, 9, 9, 9, 4, 4].forEach((d, i) =>
            book.push('R_10', { digit: d, epoch: i }).forEach(({ id, event }) => {
                if (event.kind === 'settled') settled[id] = (settled[id] ?? 0) + 1;
            })
        );
        expect(book.get('other')?.ticksSeen).toBe(0);
        expect(settled.setup).toBe(1); // 1 triggers, settles on tick 3; ticks 4,4 do not trigger (win digits)
        expect(settled.any).toBe(3); // triggers 0,2,4 settle 1,3,5, unaffected by the SETUP stream's open contract
        expect(() => book.add('any', 'R_10', new SimStream(OVER_2, { method: 'ANY' }, 1))).toThrow();
    });

    it('tally counts wins and losses', () => {
        expect(tally(run([1, 5, 2, 0]).trades)).toEqual({ trades: 2, wins: 1, losses: 1, rate: 0.5 });
    });
});
