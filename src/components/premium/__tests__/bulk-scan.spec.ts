import {
    DEFAULT_SCAN_SETTINGS, SCAN_SPECS, checkFusionRules, ScanSession, discoverEntry, entryTriggered, parseEntryDigit, readCell, sanitizeScan,
} from '../bulk-scan';

const lcg = (seed: number) => { let a = seed; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10); };
const spec = (label: string) => SCAN_SPECS.find(s => s.label === label)!;

/** 1000 digits for Over 2: no 1s, a few 0s and 2s, winners everywhere else, and digit 8 rising over the last 90 ticks. */
const planted = (): number[] => {
    const rnd = lcg(3);
    const out = Array.from({ length: 1000 }, (_, i) => { const d = rnd(); return d === 1 ? 5 : d === 8 ? 6 : (d === 0 || d === 2) && i % 3 !== 0 ? 7 : d; });
    const put = (back: number, digit: number) => { out[999 - back] = digit; };
    // digit 8: 0 prints in the oldest 30 of the last 90, 1 in the next, 2 in the next, then a burst in the last 15.
    [70].forEach(b => put(b, 8)); [45, 40].forEach(b => put(b, 8)); [20, 10, 2].forEach(b => put(b, 8));
    return out;
};

describe('readCell', () => {
    it('passes a market whose winners lead, losers fade, digit 1 is dormant and digit 8 is rising', () => {
        const read = readCell(planted(), spec('Over 2'));
        expect(read.blockedBy).toEqual([]);
        expect(read.pass).toBe(true);
        expect(read.score).toBeGreaterThan(50);
    });

    it('holds back a market with too few ticks', () => {
        const read = readCell(planted().slice(-100), spec('Over 2'));
        expect(read.pass).toBe(false);
        expect(read.blockedBy[0]).toMatch(/ticks/);
    });

    it('blocks when digit 1 is building', () => {
        const d = planted();
        [1, 3, 6, 9].forEach(b => { d[999 - b] = 1; });
        const read = readCell(d, spec('Over 2'));
        expect(read.pass).toBe(false);
        expect(read.blockedBy).toContain('Special digits 1 / 8');
    });

    it('with the special-digit gate off, the same market is judged on the other gates only', () => {
        const d = planted();
        [1, 3, 6, 9].forEach(b => { d[999 - b] = 1; });
        expect(readCell(d, spec('Over 2'), { edge: 0.008, maxLoserShare: 0.115, specialDigits: false, minPersistence: 0.6, minSamples: 5 }).gates.some(g => g.key === 'special')).toBe(false);
    });

    it('does not pass random digits often (a few percent at most)', () => {
        const rnd = lcg(11);
        let pass = 0;
        let n = 0;
        for (let k = 0; k < 120; k += 1) {
            const digits = Array.from({ length: 1000 }, rnd);
            for (const s of SCAN_SPECS) { n += 1; if (readCell(digits, s).pass) pass += 1; }
        }
        expect(pass / n).toBeLessThan(0.05);
    });
});

describe('discoverEntry', () => {
    // After a 4 the next digit is always a winner for Over 2; otherwise it is random.
    const entryMarket = () => {
        const rnd = lcg(5);
        const out: number[] = [];
        for (let i = 0; i < 1200; i += 1) out.push(out[i - 1] === 4 ? 3 + (rnd() % 7) : rnd());
        return out;
    };

    it('finds the digit after which the contract keeps winning, and checks it on the newest third', () => {
        const pick = discoverEntry(entryMarket(), spec('Over 2'), 1);
        expect(pick?.digit).toBe(4);
        expect(pick?.strength).toBe('confirmed');
        expect(pick?.holdout.rate).toBeGreaterThan(0.7);
    });

    it('labels a digit weak when nothing stands out, and says it is timing only', () => {
        const rnd = lcg(21);
        const pick = discoverEntry(Array.from({ length: 1000 }, rnd), spec('Over 2'), 1);
        expect(pick).not.toBeNull();
        if (pick?.strength === 'weak') expect(pick.note).toMatch(/timing choice/);
    });

    it('returns null with too little history', () => {
        expect(discoverEntry(Array(100).fill(5), spec('Over 2'), 1)).toBeNull();
    });
});

describe('ScanSession', () => {
    const markets = [{ symbol: 'A', name: 'Market A' }, { symbol: 'B', name: 'Market B' }];
    const ticks = (series: number[], count: number) => Array.from({ length: count }, (_, i) => series.slice(0, series.length - count + i + 1));
    const opts = { specialDigits: false };

    it('picks the market that keeps passing and gives an entry digit', () => {
        const good = Array.from({ length: 1100 }, (_, i) => (i % 10 === 0 ? 0 : [3, 4, 5, 6, 7, 9, 2, 6, 5][i % 9]));
        const noise = Array.from({ length: 1100 }, lcg(99));
        const s = new ScanSession(0, 20, opts);
        const a = ticks(good, 12);
        const b = ticks(noise, 12);
        a.forEach((d, i) => { s.sample('A', d, i); s.sample('B', b[i], i); });
        const out = s.finish(20_000, markets, symbol => (symbol === 'A' ? good : noise), 1);
        expect(out.marketsRead).toBe(2);
        expect(out.best?.symbol).toBe('A');
        expect(out.best?.persistence).toBeGreaterThanOrEqual(0.6);
        expect(out.best?.entry).not.toBeNull();
        expect(out.closest).toBeNull();
    });

    it('counts a sample only when a new tick arrived', () => {
        const d = Array.from({ length: 400 }, lcg(1));
        const s = new ScanSession(0, 10, opts);
        s.sample('A', d, 1); s.sample('A', d, 1); s.sample('A', d, 1);
        const out = s.finish(10_000, markets, () => d, 1);
        expect(out.top[0].samples).toBe(1);
    });

    it('with no qualifying contract, gives no pick but names the closest and says so', () => {
        const noise = Array.from({ length: 1100 }, lcg(2));
        const s = new ScanSession(0, 10);
        ticks(noise, 8).forEach((d, i) => s.sample('B', d, i));
        const out = s.finish(10_000, markets, () => noise, 1);
        expect(out.best).toBeNull();
        expect(out.closest).not.toBeNull();
        expect(out.note).toMatch(/Nothing held up/);
    });

    it('reports when no market has enough ticks', () => {
        const s = new ScanSession(0, 10);
        s.sample('A', [1, 2, 3], 1);
        const out = s.finish(1, markets, () => [], 1);
        expect(out.best).toBeNull();
        expect(out.closest).toBeNull();
        expect(out.note).toMatch(/enough ticks/);
    });
});

describe('settings and the entry wait', () => {
    it('keeps the scan to 30 seconds at most and the entry digit to 0-9', () => {
        expect(sanitizeScan({ seconds: 90 }).seconds).toBe(30);
        expect(sanitizeScan({ seconds: 1 }).seconds).toBe(5);
        expect(sanitizeScan({ entryDigit: '12' }).entryDigit).toBe('');
        expect(sanitizeScan({ entryDigit: '7' }).entryDigit).toBe('7');
        expect(sanitizeScan({ entryMode: 'WAIT' }).entryMode).toBe('WAIT');
        expect(sanitizeScan({ entryMode: 'x' as never }).entryMode).toBe('INSTANT');
        expect(sanitizeScan({}).autoLoadEntry).toBe(DEFAULT_SCAN_SETTINGS.autoLoadEntry);
    });

    it('parses typed digits', () => {
        expect(parseEntryDigit('0')).toBe(0);
        expect(parseEntryDigit('')).toBeNull();
        expect(parseEntryDigit('10')).toBeNull();
        expect(parseEntryDigit('x')).toBeNull();
    });

    it('fires only on a NEW tick that shows the entry digit', () => {
        expect(entryTriggered(4, 100, [90, 100], [1, 4])).toBe(false); // the 4 was already there when the wait began
        expect(entryTriggered(4, 100, [100, 110], [4, 2])).toBe(false);
        expect(entryTriggered(4, 100, [100, 110], [2, 4])).toBe(true);
        expect(entryTriggered(4, 100, [], [])).toBe(false);
    });
});

describe('scanner rules on Fusion signals', () => {
    it('lets a Fusion signal through when the market passes the gates', () => {
        expect(checkFusionRules(planted(), 'DIGITOVER', 2).ok).toBe(true);
    });
    it('blocks a Fusion signal when digit 1 is building, and says why', () => {
        const d = planted();
        [1, 3, 6, 9].forEach(b => { d[999 - b] = 1; });
        const r = checkFusionRules(d, 'DIGITOVER', 2);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/Over 2.*Special digits/);
    });
    it('holds a signal back while the market has too few ticks, and ignores contracts the scanner does not read', () => {
        expect(checkFusionRules(planted().slice(-50), 'DIGITOVER', 2).ok).toBe(false);
        expect(checkFusionRules(undefined, 'DIGITUNDER', 7).ok).toBe(false);
        expect(checkFusionRules([1, 2, 3], 'DIGITOVER', 5).ok).toBe(true);
    });
    it('defaults to on and survives sanitising', () => {
        expect(DEFAULT_SCAN_SETTINGS.fusionRules).toBe(true);
        expect(sanitizeScan({}).fusionRules).toBe(true);
        expect(sanitizeScan({ fusionRules: false }).fusionRules).toBe(false);
    });
});
