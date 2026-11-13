import { EntryDigitLab, LAB_DEFAULTS, readOutcomes } from '../entry-lab';

const OVER_2 = { side: 'OVER', param: 2 } as const;
const UNDER_7 = { side: 'UNDER', param: 7 } as const;

// Uniform noise with one habit that can be switched: right after a 5 the next digit is `rule` (9 = a win for Over 2, 0 = a loss).
const gen = (seed: number) => {
    let a = seed;
    let last = -1;
    return (rule: number | null): number => {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        let d = (a >> 8) % 10;
        if (rule !== null && last === 5) d = rule;
        last = d;
        return d;
    };
};
const history = (n: number, seed: number, rule: number | null = 9) => {
    const g = gen(seed);
    return Array.from({ length: n }, () => g(rule));
};
const rowsOf = (lab: EntryDigitLab, market = 'A') =>
    lab
        .view(market, OVER_2, 1)!
        .rows.map(r => ({ n: r.n, rate: +r.rate.toFixed(9), z: +r.z.toFixed(9), state: r.state }));

describe('readOutcomes', () => {
    it('weighs the newest entries most', () => {
        const recentWins = readOutcomes([...Array(60).fill(0), ...Array(30).fill(1)], 0.5, LAB_DEFAULTS);
        const recentLosses = readOutcomes([...Array(30).fill(1), ...Array(60).fill(0)], 0.5, LAB_DEFAULTS);
        expect(recentWins.rate).toBeGreaterThan(30 / 90);
        expect(recentLosses.rate).toBeLessThan(30 / 90);
        expect(recentWins.z).toBeGreaterThan(recentLosses.z);
    });
    it('knows a cold digit: its newest entries all lost', () => {
        expect(readOutcomes([1, 1, 0, 0, 0], 0.7, LAB_DEFAULTS).cold).toBe(true);
        expect(readOutcomes([0, 0, 1], 0.7, LAB_DEFAULTS).cold).toBe(false);
        expect(readOutcomes([0, 0], 0.7, LAB_DEFAULTS).cold).toBe(false);
    });
    it('reads the newest 40% as the check', () => {
        const r = readOutcomes([...Array(30).fill(1), ...Array(20).fill(0)], 0.5, LAB_DEFAULTS);
        expect(r.checkN).toBe(20);
        expect(r.checkRate).toBe(0);
    });
});

describe('Entry Digit Lab: shadow entries never see the future', () => {
    const small = { minTicks: 1, minN: 1 };
    it('settles an entry only on the digit `duration` ticks later', () => {
        const lab = new EntryDigitLab(small);
        lab.load('A', [5, 9, 5, 0, 5, 9]);
        const rows = lab.view('A', OVER_2, 1)!.rows;
        expect(rows[5].n).toBe(3); // 5 then 9 (win), 5 then 0 (loss), 5 then 9 (win)
        expect(rows[5].rate).toBeGreaterThan(2 / 3); // newest weighted most: win, loss, win
        expect(rows[9].n).toBe(1); // the 9 on the last tick has not settled yet
        expect(rows[0].n).toBe(1);
    });
    it('works for a longer run length', () => {
        const lab = new EntryDigitLab(small);
        lab.load('A', [5, 9, 5, 0, 5, 9]);
        const rows = lab.view('A', OVER_2, 2)!.rows;
        expect(rows[5].n).toBe(2); // the 5 on tick 5 settles on tick 7, which has not come
        expect(rows[5].rate).toBe(1); // 5 -> 5 (win), 5 -> 5 (win)
        expect(rows[9].n).toBe(1);
        expect(rows[9].rate).toBe(0); // 9 -> 0 (loss)
    });
    it('a single tick settles nothing', () => {
        const lab = new EntryDigitLab(small);
        lab.load('A', [5]);
        expect(lab.view('A', OVER_2, 1)!.rows.every(r => r.n === 0)).toBe(true);
    });
});

describe('Entry Digit Lab: one step for replay and live', () => {
    it('a market replayed from history and the same market fed tick by tick read the same', () => {
        const hist = history(900, 21);
        const replayed = new EntryDigitLab();
        replayed.load('A', hist);
        const warmThenLive = new EntryDigitLab();
        warmThenLive.load('A', hist.slice(0, 400));
        warmThenLive.choose('A', OVER_2, 1); // the contract is being watched from here
        hist.slice(400).forEach(d => warmThenLive.observe('A', d));
        const liveOnly = new EntryDigitLab();
        liveOnly.load('A', hist.slice(0, 400));
        hist.slice(400).forEach(d => liveOnly.observe('A', d)); // watched only after the ticks came
        expect(rowsOf(warmThenLive)).toEqual(rowsOf(replayed));
        expect(rowsOf(liveOnly)).toEqual(rowsOf(replayed));
    });
    it('keeps each contract and run length apart', () => {
        const lab = new EntryDigitLab();
        lab.load('A', history(900, 5));
        expect(rowsOf(lab)).not.toEqual(
            lab
                .view('A', UNDER_7, 1)!
                .rows.map(r => ({ n: r.n, rate: +r.rate.toFixed(9), z: +r.z.toFixed(9), state: r.state }))
        );
        expect(lab.view('A', OVER_2, 3)!.rows).not.toEqual(lab.view('A', OVER_2, 1)!.rows);
    });
    it('is null with too little history and for what it does not read', () => {
        const lab = new EntryDigitLab();
        lab.load('A', history(250, 5));
        expect(lab.choose('A', OVER_2, 1)).toBeNull();
        lab.load('A', history(900, 5));
        expect(lab.choose('A', { side: 'OVER', param: 5 }, 1)).toBeNull();
        expect(lab.choose('A', { side: 'EVEN', param: 0 }, 1)).toBeNull();
        expect(lab.choose('Z', OVER_2, 1)).toBeNull();
    });
    it('a tick for a market it has not loaded is ignored, and a bad digit is too', () => {
        const lab = new EntryDigitLab();
        lab.observe('Z', 4);
        expect(lab.has('Z')).toBe(false);
        lab.load('A', history(400, 3));
        const before = lab.ticksOf('A');
        lab.observe('A', 12);
        lab.observe('A', -1);
        lab.observe('A', 2.5);
        expect(lab.ticksOf('A')).toBe(before);
    });
    it('notices when its copy no longer matches the feed', () => {
        const lab = new EntryDigitLab();
        const hist = history(400, 3);
        lab.load('A', hist);
        expect(lab.matches('A', hist)).toBe(true);
        expect(lab.matches('A', [...hist.slice(0, -1), (hist[hist.length - 1] + 1) % 10])).toBe(false);
        expect(lab.matches('B', hist)).toBe(false);
    });
});

describe('Entry Digit Lab: the digit follows the market', () => {
    it('finds the digit that is working, as confirmed', () => {
        const lab = new EntryDigitLab();
        lab.load('A', history(700, 3, 9));
        const c = lab.choose('A', OVER_2, 1)!;
        expect(c).toMatchObject({ digit: 5, state: 'confirmed', tradable: true });
        expect(c.note).toContain('after a 5');
    });
    it('drops that digit within a few entries of the market turning, instead of keeping it for a minute', () => {
        const g = gen(3);
        const lab = new EntryDigitLab();
        lab.load(
            'A',
            Array.from({ length: 700 }, () => g(9))
        );
        expect(lab.choose('A', OVER_2, 1)).toMatchObject({ digit: 5, tradable: true });
        // The habit flips: after a 5 the next digit is now 0, a loss for Over 2.
        let dropped = -1;
        for (let i = 1; i <= 150; i += 1) {
            lab.observe('A', g(0));
            const now = lab.choose('A', OVER_2, 1);
            if (!(now && now.digit === 5 && now.tradable)) {
                dropped = i;
                break;
            }
        }
        expect(dropped).toBeGreaterThan(0);
        expect(dropped).toBeLessThan(120);
        // ...and it stays dropped while the market keeps doing it.
        for (let i = 0; i < 60; i += 1) {
            lab.observe('A', g(0));
            const now = lab.choose('A', OVER_2, 1);
            expect(now && now.digit === 5 && now.tradable).toBeFalsy();
        }
        expect(lab.view('A', OVER_2, 1)!.rows[5].state).toBe('cooling');
    });
    it('answers from the newest tick every time: no clock, no memory of an old answer', () => {
        const g = gen(8);
        const lab = new EntryDigitLab();
        lab.load(
            'A',
            Array.from({ length: 700 }, () => g(9))
        );
        const seen = new Set<string>();
        for (let i = 0; i < 400; i += 1) {
            lab.observe('A', g(i < 100 ? 9 : 0));
            const c = lab.choose('A', OVER_2, 1);
            seen.add(c ? `${c.digit}:${c.tradable}` : 'none');
        }
        expect(seen.has('5:true')).toBe(true); // while it worked
        expect(seen.size).toBeGreaterThan(1); // and it did not stay the answer
    });
    it('stands aside (not tradable) when nothing holds up, rather than trading the best of a poor lot', () => {
        const lab = new EntryDigitLab({ zLead: 50, zConfirm: 60 }); // an impossible bar
        lab.load('A', history(900, 4));
        const c = lab.choose('A', OVER_2, 1)!;
        expect(c.tradable).toBe(false);
        expect(c.note).toContain('Standing aside');
        expect(lab.view('A', OVER_2, 1)!.current).toBeNull();
    });
    it('a digit in use is replaced less often with hysteresis than without', () => {
        const stream = history(2600, 17, null);
        const run = (hysteresis: number) => {
            const lab = new EntryDigitLab({ hysteresis, zLead: 1 });
            lab.load('A', stream.slice(0, 700));
            for (const d of stream.slice(700)) {
                lab.observe('A', d);
                lab.choose('A', OVER_2, 1);
            }
            return lab.view('A', OVER_2, 1)!.switches;
        };
        const free = run(0);
        const sticky = run(0.35);
        const stuck = run(1000);
        expect(free).toBeGreaterThan(0);
        expect(sticky).toBeLessThanOrEqual(free);
        expect(stuck).toBeLessThanOrEqual(sticky);
    });
});

describe('Entry Digit Lab: real results feed back', () => {
    const fresh = () => {
        const g = gen(3);
        const lab = new EntryDigitLab();
        lab.load(
            'A',
            Array.from({ length: 700 }, () => g(9))
        );
        return { lab, g };
    };
    it('benches a digit after two lost trades in a row, and picks again from the newest data', () => {
        const { lab } = fresh();
        expect(lab.choose('A', OVER_2, 1)?.digit).toBe(5);
        expect(lab.record('A', OVER_2, 1, 5, false)).toBeNull();
        const line = lab.record('A', OVER_2, 1, 5, false);
        expect(line).toContain('Entry digit 5 benched on A');
        const after = lab.choose('A', OVER_2, 1);
        expect(after && after.digit === 5 && after.tradable).toBeFalsy();
        expect(lab.view('A', OVER_2, 1)!.rows[5].state).toBe('benched');
    });
    it('a win in between clears the count', () => {
        const { lab } = fresh();
        lab.choose('A', OVER_2, 1);
        lab.record('A', OVER_2, 1, 5, false);
        lab.record('A', OVER_2, 1, 5, true);
        expect(lab.record('A', OVER_2, 1, 5, false)).toBeNull();
        expect(lab.choose('A', OVER_2, 1)).toMatchObject({ digit: 5, tradable: true });
    });
    it('lets the digit back after the bench runs out, if the market still supports it', () => {
        const { lab, g } = fresh();
        lab.choose('A', OVER_2, 1);
        lab.record('A', OVER_2, 1, 5, false);
        lab.record('A', OVER_2, 1, 5, false);
        for (let i = 0; i < LAB_DEFAULTS.benchTicks - 1; i += 1) lab.observe('A', g(9));
        expect(lab.view('A', OVER_2, 1)!.rows[5].state).toBe('benched');
        for (let i = 0; i < 3; i += 1) lab.observe('A', g(9));
        expect(lab.view('A', OVER_2, 1)!.rows[5].state).not.toBe('benched');
        expect(lab.choose('A', OVER_2, 1)).toMatchObject({ digit: 5, tradable: true });
    });
    it('keeps the count per market and contract', () => {
        const { lab } = fresh();
        lab.load('B', history(700, 3, 9));
        lab.choose('A', OVER_2, 1);
        lab.choose('B', OVER_2, 1);
        lab.record('A', OVER_2, 1, 5, false);
        lab.record('A', OVER_2, 1, 5, false);
        expect(lab.view('A', OVER_2, 1)!.rows[5].state).toBe('benched');
        expect(lab.view('B', OVER_2, 1)!.rows[5].state).not.toBe('benched');
    });
    it('ignores a result for a market it does not know or a digit that is not one', () => {
        const { lab } = fresh();
        expect(lab.record('Z', OVER_2, 1, 5, false)).toBeNull();
        expect(lab.record('A', OVER_2, 1, 12, false)).toBeNull();
    });
});
