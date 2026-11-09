import { mulberry32 } from '../../../sixfold/stats';
import { EO, PARITY_DIGITS, digitRows, readEvenOdd } from '../even-odd';
import { OracleScanner, type FeedLike, runOracleScan } from '../oracle-engine';
import { OU_CONTRACTS, readOverUnder, scanOverUnder } from '../over-under';

const rand = mulberry32(11);
const random = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10));

/**
 * A 100-tick board that satisfies every Even rule. Prints per digit [older 50, newer 50]:
 * evens 0:[5,8] 2:[5,8] 4:[5,7] 6:[1,3] 8:[1,3]   odds 1,3,5,7:[7,4] 9:[5,5]
 * The newest ticks are even.
 */
const evenBoard = (): number[] => {
    const plan: Record<number, [number, number]> = { 0: [5, 8], 2: [5, 8], 4: [5, 7], 6: [1, 3], 8: [1, 3], 1: [7, 4], 3: [7, 4], 5: [7, 4], 7: [7, 4], 9: [5, 5] };
    const older: number[] = [];
    const newer: number[] = [];
    for (const [d, [o, n]] of Object.entries(plan)) {
        for (let i = 0; i < o; i += 1) older.push(Number(d));
        for (let i = 0; i < n; i += 1) newer.push(Number(d));
    }
    const shuffle = (xs: number[], seed: number) => {
        const r = mulberry32(seed);
        return xs.map(v => [r(), v] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    };
    const n = shuffle(newer, 3);
    // evens last, so the newest ticks are even
    const evens = n.filter(d => d % 2 === 0);
    const odds = n.filter(d => d % 2 === 1);
    return [...shuffle(older, 5), ...odds, ...evens];
};
const flipParity = (xs: number[]) => xs.map(d => (d + 1) % 10);

describe('Oracle Even/Odd', () => {
    it('passes every rule on a board built for Even', () => {
        const r = readEvenOdd(evenBoard(), 'EVEN');
        expect(r?.checks.filter(c => !c.ok).map(c => c.key)).toEqual([]);
        expect(r?.ok).toBe(true);
        expect(readEvenOdd(evenBoard(), 'ODD')?.ok).toBe(false);
    });

    it('passes the mirrored board for Odd', () => {
        const r = readEvenOdd(flipParity(evenBoard()), 'ODD');
        expect(r?.checks.filter(c => !c.ok).map(c => c.key)).toEqual([]);
        expect(r?.ok).toBe(true);
    });

    it('needs 100 ticks', () => {
        expect(readEvenOdd(random(99), 'EVEN')).toBeNull();
    });

    it('fails when a red-bar digit belongs to the other parity', () => {
        const board = evenBoard();
        // turn every 9 into an 8: digit 9 now never prints, so the least appearing digit is odd
        const broken = board.map(d => (d === 9 ? 8 : d));
        const r = readEvenOdd(broken, 'EVEN');
        expect(r?.ok).toBe(false);
        expect(r?.checks.find(c => c.key === 'red')?.ok).toBe(false);
    });

    it('fails when the newest ticks are not the contract', () => {
        const board = evenBoard();
        const tail = board.slice(-3);
        const swapped = [...board.slice(0, -3), ...tail.map(d => (d % 2 === 0 ? d + 1 : d))];
        const r = readEvenOdd(swapped, 'EVEN');
        expect(r?.checks.find(c => c.key === 'recent')?.ok).toBe(false);
    });

    it('reads shares, increase and parity of every digit', () => {
        const rows = digitRows(evenBoard());
        expect(rows.reduce((t, r) => t + r.count, 0)).toBe(EO.window);
        expect(rows[0].delta).toBe(3);
        expect(PARITY_DIGITS.EVEN).toEqual([0, 2, 4, 6, 8]);
    });

    it('does not signal on a random board unless every rule holds', () => {
        for (let i = 0; i < 50; i += 1) {
            const r = readEvenOdd(random(300), 'EVEN');
            expect(r?.ok === (r?.passed === r?.total)).toBe(true);
        }
    });
});

describe('Oracle Over/Under', () => {
    it('reads every Over 1-4 and Under 5-8 contract with every layer', () => {
        const reads = scanOverUnder({ A: random(1000) }, ['A']);
        expect(reads).toHaveLength(OU_CONTRACTS.length);
        for (const r of reads) {
            const keys = r.layers.map(l => l.key);
            for (const k of ['pulse', 'kalman', 'special', 'losing', 'winning', 'multi', 'meter', 'viability', 'apex']) expect(keys).toContain(k);
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(100);
        }
    });

    it('adds the Vanguard layer only to Over 2 and Under 7', () => {
        const reads = scanOverUnder({ A: random(1000) }, ['A']);
        const withVanguard = reads.filter(r => r.layers.some(l => l.key === 'vanguard')).map(r => r.label).sort();
        expect(withVanguard).toEqual(['Over 2', 'Under 7']);
    });

    it('needs 300 ticks', () => {
        expect(readOverUnder('A', random(299), OU_CONTRACTS[0])).toBeNull();
    });

    it('never signals a contract a hard layer objects to; STRONG means every required layer agrees', () => {
        const series = { A: random(1000), B: random(1000), C: random(1000) };
        for (const r of scanOverUnder(series, ['A', 'B', 'C'])) {
            if (r.vetoed) expect(r.tier).toBeNull();
            if (r.tier === 'STRONG') expect(r.layers.every(l => !l.required || l.ok)).toBe(true);
            if (r.tier === 'BEST') expect(r.layers.some(l => l.hard && !l.ok)).toBe(false);
        }
    });

    it('vetoes a contract on a market that is all losing digits', () => {
        // Over 4 loses on 0-4; a stream of 0-4 is as hostile as it gets
        const losing = Array.from({ length: 600 }, (_, i) => i % 5);
        const r = readOverUnder('A', losing, { side: 'OVER', param: 4 });
        expect(r?.tier).toBeNull();
        expect(r?.vetoed).toBe(true);
    });
});

describe('Oracle scan', () => {
    it('Even/Odd offers no signal and no fallback on a random market, and says how close it came', () => {
        const scan = runOracleScan('EVEN/ODD', { R_10: random(500) }, ['R_10']);
        expect(scan.ready).toBe(1);
        expect(scan.fallback).toBeNull();
        expect(scan.closest?.total).toBe(6);
    });

    it('Even/Odd picks the market whose board passes', () => {
        const scan = runOracleScan('EVEN/ODD', { R_10: random(500), R_25: [...random(400), ...evenBoard()] }, ['R_10', 'R_25']);
        expect(scan.best?.symbol).toBe('R_25');
        expect(scan.best?.contractType).toBe('EVEN');
        expect(scan.best?.barrier).toBeNull();
    });

    it('Over/Under signals carry the engine barrier', () => {
        const scan = runOracleScan('OVER/UNDER', { R_10: random(1000), R_25: random(1000) }, ['R_10', 'R_25']);
        const pick = scan.best ?? scan.fallback;
        expect(pick).not.toBeNull();
        expect(['OVER', 'UNDER']).toContain(pick?.contractType);
        expect(pick?.barrier).toBeGreaterThanOrEqual(1);
        expect(pick?.barrier).toBeLessThanOrEqual(8);
    });
});

describe('OracleScanner', () => {
    const fakeFeed = (series: Record<string, number[]>) => {
        const listeners = new Set<() => void>();
        let status = 'offline';
        const feed: FeedLike & { emit: () => void; connected: number } = {
            connected: 0,
            connect: () => { feed.connected += 1; status = 'live'; },
            getStatus: () => status,
            getLiveSeries: () => series,
            subscribe: l => { listeners.add(l); return () => { listeners.delete(l); }; },
            isOffered: () => null,
            emit: () => listeners.forEach(l => l()),
        };
        return feed;
    };

    it('connects an offline feed, waits for ticks, and signals when a market qualifies', () => {
        jest.useFakeTimers();
        const series: Record<string, number[]> = {};
        const feed = fakeFeed(series);
        const found: string[] = [];
        const scanner = new OracleScanner(feed, { throttleMs: 0, warmupMs: 0 });
        scanner.start('EVEN/ODD', { onSignal: s => found.push(`${s.symbol}:${s.contractType}`) });
        expect(feed.connected).toBe(1);
        expect(found).toEqual([]);
        series.R_10 = [...random(300), ...evenBoard()];
        feed.emit();
        expect(found).toEqual(['R_10:EVEN']);
        expect(scanner.isScanning()).toBe(false);
        jest.useRealTimers();
    });

    it('reports none when an Even/Odd scan window ends without a qualifying market', () => {
        jest.useFakeTimers();
        const feed = fakeFeed({ R_10: random(500) });
        let none = 0;
        const scanner = new OracleScanner(feed, { maxMs: 5000 });
        scanner.start('EVEN/ODD', { onSignal: () => undefined, onNone: () => { none += 1; } });
        jest.advanceTimersByTime(5001);
        expect(none).toBe(1);
        jest.useRealTimers();
    });

    it('stop() cancels a running scan', () => {
        jest.useFakeTimers();
        const feed = fakeFeed({ R_10: random(500) });
        let none = 0;
        const scanner = new OracleScanner(feed, { maxMs: 5000 });
        scanner.start('EVEN/ODD', { onSignal: () => undefined, onNone: () => { none += 1; } });
        scanner.stop();
        jest.advanceTimersByTime(6000);
        expect(none).toBe(0);
        jest.useRealTimers();
    });
});
