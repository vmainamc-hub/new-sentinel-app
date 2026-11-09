import { mulberry32 } from '../../../sixfold/stats';
import { EO, PARITY_DIGITS, digitRows, readEvenOdd } from '../even-odd';
import { OracleScanner, StabilityTracker, type FeedLike, evenOddMatch, marketCalls, pickOverUnder, runOracleScan } from '../oracle-engine';
import { OU_CONTRACTS, readLossRisk, readOverUnder, scanOverUnder } from '../over-under';

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
    it('Even/Odd always answers with the best available board and a percentage, and says how close it came', () => {
        const scan = runOracleScan('EVEN/ODD', { R_10: random(500) }, ['R_10']);
        expect(scan.ready).toBe(1);
        expect(scan.closest?.total).toBe(6);
        const pick = scan.best ?? scan.fallback;
        expect(pick).not.toBeNull();
        expect(pick?.deviation).toBeGreaterThan(0);
        expect(pick?.deviation).toBeLessThanOrEqual(100);
        expect(pick?.rules?.total).toBe(6);
        if (pick?.tier === 'BEST') expect(pick.rules?.passed).toBeLessThan(6);
    });

    it('Even/Odd ranks the best available by match percentage, and a full pass beats a partial one', () => {
        const scan = runOracleScan('EVEN/ODD', { R_10: random(500), R_25: [...random(400), ...evenBoard()] }, ['R_10', 'R_25']);
        expect(scan.best?.tier).toBe('STRONG');
        expect(scan.best?.rules).toEqual({ passed: 6, total: 6 });
        expect(scan.best!.deviation).toBeGreaterThan(scan.fallback!.deviation);
        expect(evenOddMatch({ passed: 6, total: 6, score: 80 })).toBeGreaterThan(evenOddMatch({ passed: 4, total: 6, score: 80 }));
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

    it('connects an offline feed and holds the verdict until the assessment time is up', () => {
        jest.useFakeTimers();
        let clock = 0;
        const series: Record<string, number[]> = {};
        const feed = fakeFeed(series);
        const found: string[] = [];
        const scanner = new OracleScanner(feed, { throttleMs: 0, assessMs: 15_000, minReadyShare: 0.1, now: () => clock });
        scanner.start('EVEN/ODD', { onSignal: s => found.push(`${s.symbol}:${s.contractType}:${s.tier}`) });
        expect(feed.connected).toBe(1);
        series.R_10 = [...random(300), ...evenBoard()];
        series.R_25 = random(500);
        clock = 5_000;
        feed.emit();
        // the board already qualifies, but the assessment is still running
        expect(found).toEqual([]);
        expect(scanner.isScanning()).toBe(true);
        clock = 15_000;
        jest.advanceTimersByTime(15_000);
        expect(found).toEqual(['R_10:EVEN:STRONG']);
        expect(scanner.isScanning()).toBe(false);
        jest.useRealTimers();
    });

    it('Even/Odd gives the best available answer when no market passes every rule', () => {
        jest.useFakeTimers();
        let clock = 0;
        const feed = fakeFeed({ R_10: random(500), R_25: random(500) });
        const found: Array<{ tier: string; rules: unknown }> = [];
        let none = 0;
        const scanner = new OracleScanner(feed, { assessMs: 4000, minReadyShare: 0.1, now: () => clock });
        scanner.start('EVEN/ODD', { onSignal: s => found.push({ tier: s.tier, rules: s.rules }), onNone: () => { none += 1; } });
        clock = 4_000;
        jest.advanceTimersByTime(4_000);
        expect(none).toBe(0);
        expect(found).toHaveLength(1);
        expect(found[0].tier === 'STRONG' || found[0].tier === 'BEST').toBe(true);
        jest.useRealTimers();
    });

    it('Over/Under does not answer before its assessment is over, then names a contract', () => {
        jest.useFakeTimers();
        let clock = 0;
        const feed = fakeFeed({ R_10: random(1000), R_25: random(1000), R_50: random(1000) });
        const found: string[] = [];
        const progress: number[] = [];
        const scanner = new OracleScanner(feed, { throttleMs: 0, assessMs: 18_000, minReadyShare: 0.1, now: () => clock });
        scanner.start('OVER/UNDER', {
            onProgress: (_scan, _name, info) => progress.push(info.elapsedMs),
            onSignal: s => found.push(`${s.contractType}${s.barrier}`),
        });
        clock = 9_000;
        feed.emit();
        jest.advanceTimersByTime(9_000);
        expect(found).toEqual([]);
        clock = 18_000;
        jest.advanceTimersByTime(9_000);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(/^(OVER[1-4]|UNDER[5-8])$/);
        expect(Math.max(...progress)).toBeGreaterThanOrEqual(18_000);
        jest.useRealTimers();
    });

    it('waits past the assessment for markets to have ticks, then gives up at the cap', () => {
        jest.useFakeTimers();
        let clock = 0;
        const feed = fakeFeed({});
        let none = 0;
        const scanner = new OracleScanner(feed, { assessMs: 5_000, capMs: 12_000, now: () => clock });
        scanner.start('OVER/UNDER', { onSignal: () => undefined, onNone: () => { none += 1; } });
        clock = 6_000;
        jest.advanceTimersByTime(6_000);
        expect(none).toBe(0);
        clock = 12_000;
        jest.advanceTimersByTime(6_000);
        expect(none).toBe(1);
        jest.useRealTimers();
    });

    it('stop() cancels a running scan', () => {
        jest.useFakeTimers();
        const feed = fakeFeed({ R_10: random(500) });
        let none = 0;
        let found = 0;
        const scanner = new OracleScanner(feed, { assessMs: 5000 });
        scanner.start('EVEN/ODD', { onSignal: () => { found += 1; }, onNone: () => { none += 1; } });
        scanner.stop();
        jest.advanceTimersByTime(6000);
        expect(none).toBe(0);
        expect(found).toBe(0);
        jest.useRealTimers();
    });
});

describe('Oracle losing-digit risk', () => {
    // Over 2 loses on 0, 1, 2 (30% fair). Build a market whose losing digits have been running at about 50%.
    const hot = (n: number, loseEvery = 2) => Array.from({ length: n }, (_, i) => (i % loseEvery === 0 ? i % 3 : 3 + (i % 7)));
    const calm = (n: number) => Array.from({ length: n }, (_, i) => (i % 10 < 3 ? i % 3 : 3 + (i % 7)));
    const over2 = { side: 'OVER' as const, param: 2 };

    it('reads a fair market as LOW risk', () => {
        const r = readLossRisk(calm(600), over2);
        expect(r.level).toBe('LOW');
        expect(r.expected).toBeCloseTo(0.3, 5);
    });

    it('flags losing digits printing far above their fair share as HIGH, which is a hard veto', () => {
        const r = readLossRisk(hot(600), over2);
        expect(r.level).toBe('HIGH');
        expect(r.loss100).toBeGreaterThan(0.4);
        expect(r.detail).toContain('losing digits');
        const read = readOverUnder('A', hot(600), over2);
        expect(read?.layers.find(l => l.key === 'risk')?.hard).toBe(true);
        expect(read?.vetoed).toBe(true);
        expect(read?.tier).toBeNull();
    });

    it('marks a market FLAGGED, with the losing-digit reason, when its leading contract is vetoed', () => {
        const HOT = 'losing digits 52% in the last 100 against 30.0% fair';
        const base = scanOverUnder({ A: random(1000), B: random(1000) }, ['A', 'B']);
        const hotA = base.map(r =>
            r.symbol !== 'A'
                ? r
                : {
                      ...r,
                      vetoed: true,
                      tier: null,
                      risk: { ...r.risk, level: 'HIGH' as const, detail: HOT },
                      layers: r.layers.map(l => (l.key === 'risk' ? { ...l, ok: false, hard: true, detail: HOT } : l)),
                  }
        );
        const calls = marketCalls(hotA);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({ symbol: 'A', level: 'FLAGGED' });
        expect(calls[0].reason).toContain('losing digits 52%');
        expect(calls[1].symbol).toBe('B');
        expect(calls[1].level).not.toBe('FLAGGED');
    });

    it('never offers a vetoed contract as the verdict', () => {
        const reads = scanOverUnder({ A: hot(600), B: random(1000) }, ['A', 'B']);
        const tracker = new StabilityTracker();
        tracker.observe(reads);
        const pick = pickOverUnder(reads, tracker);
        expect(pick).not.toBeNull();
        const chosen = reads.find(r => r.symbol === pick?.symbol && r.barrier === pick?.barrier && r.side === pick?.contractType);
        expect(chosen?.vetoed).toBe(false);
    });

    it('returns no verdict when every contract is vetoed', () => {
        const reads = scanOverUnder({ A: hot(600) }, ['A']).filter(r => r.vetoed);
        const tracker = new StabilityTracker();
        tracker.observe(reads);
        expect(pickOverUnder(reads, tracker)).toBeNull();
    });
});

describe('StabilityTracker', () => {
    const base = () => scanOverUnder({ A: random(1000) }, ['A'])[0];
    const strongRead = () => ({ ...base(), tier: 'STRONG' as const, vetoed: false });

    it('calls a contract STRONG only when it held through most of the assessment', () => {
        const strong = strongRead();
        const steady = new StabilityTracker();
        for (let i = 0; i < 5; i += 1) steady.observe([strong]);
        expect(pickOverUnder([strong], steady)?.tier).toBe('STRONG');

        const flaky = new StabilityTracker();
        flaky.observe([strong]);
        for (let i = 0; i < 4; i += 1) flaky.observe([{ ...strong, tier: null, vetoed: true }]);
        const pick = pickOverUnder([strong], flaky);
        expect(pick?.tier).toBe('BEST');
    });

    it('a steady contract outranks one with a higher final score that kept flipping', () => {
        const [first, second] = scanOverUnder({ A: random(1000), B: random(1000) }, ['A', 'B']);
        const steady = { ...first, score: 70, tier: 'STRONG' as const, vetoed: false };
        const flip = { ...second, score: 75, tier: 'STRONG' as const, vetoed: false };
        const t = new StabilityTracker();
        for (let i = 0; i < 6; i += 1) t.observe([steady, i % 3 === 0 ? flip : { ...flip, tier: null, vetoed: true }]);
        const pick = pickOverUnder([steady, flip], t);
        expect(`${pick?.symbol}:${pick?.barrier}`).toBe(`${steady.symbol}:${steady.barrier}`);
    });

    it('shares are fractions of the evaluations seen', () => {
        const read = base();
        const t = new StabilityTracker();
        t.observe([{ ...read, tier: 'STRONG' }]);
        t.observe([{ ...read, tier: 'BEST' }]);
        t.observe([{ ...read, tier: null }]);
        t.observe([{ ...read, tier: 'STRONG' }]);
        expect(t.evaluations).toBe(4);
        expect(t.share(read)).toEqual({ strong: 0.5, clear: 0.75 });
    });
});
