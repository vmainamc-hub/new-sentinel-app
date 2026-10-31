import { BotRules, evaluateRules, type Carry, MIN_DIGITS } from '../../vanguard/bot-rules';

// A fixed pseudo-random digit stream, identical to the one used to record what the real bot (the Blockly XML, run unchanged) decided.
const stream = (seed: number, n: number) => {
    let a = seed;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        a = (a * 1664525 + 1013904223) % 4294967296;
        out.push(Math.floor(a / 65536) % 10);
    }
    return out;
};
// Ticks (counted from the 1001st digit) on which the real bot's entry condition held, with the psychology gate at 1 and paper mode off.
const BOT_ENTRIES: Record<number, number[]> = {"11": [32, 33, 34, 176, 220, 221, 222, 224, 322, 346, 362, 363, 464, 489, 492, 499, 500, 501, 557, 574, 575, 716, 797, 798, 799, 800, 886, 887, 949, 1014, 1017, 1023, 1070, 1092, 1093, 1094, 1095, 1145, 1276, 1277, 1278, 1299, 1312, 1334, 1335, 1336, 1418, 1607, 1608, 1686, 1805, 1806, 1861, 1862, 1932, 1940, 1942, 1943, 1976, 2027, 2030, 2033, 2083, 2091, 2097, 2153, 2156, 2157, 2379, 2380], "22": [41, 42, 170, 172, 176, 258, 259, 383, 384, 385, 429, 430, 437, 515, 577, 578, 593, 635, 637, 638, 639, 731, 829, 934, 935, 936, 937, 973, 985, 986, 1110, 1112, 1113, 1149, 1207, 1209, 1262, 1324, 1328, 1369, 1370, 1371, 1469, 1528, 1584, 1629, 1657, 1658, 1672, 1693, 1750, 1752, 1783, 1860, 1892, 1895, 1920, 2030, 2096, 2097, 2269, 2270, 2292, 2293, 2373, 2376], "33": [43, 107, 136, 174, 176, 416, 418, 518, 522, 531, 532, 592, 612, 614, 624, 627, 643, 690, 754, 810, 820, 822, 824, 832, 833, 907, 908, 985, 1003, 1073, 1160, 1243, 1260, 1262, 1297, 1333, 1437, 1438, 1439, 1441, 1473, 1482, 1483, 1484, 1523, 1525, 1527, 1559, 1560, 1561, 1638, 1639, 1671, 1672, 1721, 1722, 1765, 1767, 1768, 1781, 1782, 1783, 1804, 1805, 1925, 1958, 1966, 2014, 2172, 2173, 2174, 2285, 2286, 2306, 2328, 2342, 2343, 2376, 2399, 2489]};

describe('Bot rules: the engine agrees with the real bot', () => {
    for (const seed of [11, 22, 33]) {
        it(`seed ${seed}: the same ticks qualify as in the bot (${BOT_ENTRIES[seed].length} entries)`, () => {
            const digits = stream(seed, 3500);
            let carry: Carry = null;
            let seen = 0;
            const got: number[] = [];
            for (let i = 1000; i < digits.length; i++) {
                seen += 1;
                const ev = evaluateRules(digits.slice(i + 1 - 1000, i + 1), carry, { gateMin: 1, ticksSeen: seen });
                carry = ev.next;
                if (ev.entry) got.push(i - 1000);
            }
            expect(got).toEqual(BOT_ENTRIES[seed]);
        });
    }
});

describe('Bot rules: single checks', () => {
    it('reads nothing until it has enough digits', () => {
        const ev = evaluateRules(stream(1, MIN_DIGITS - 1), null, { gateMin: 1, ticksSeen: 5 });
        expect(ev.ready).toBe(false);
        expect(ev.entry).toBe(false);
        expect(ev.waitingOn).toMatch(/Collecting digits/);
    });

    it('seven checks, the regime score is out of 12, and a stricter gate never lets more through', () => {
        const digits = stream(5, 3000);
        let c1: Carry = null;
        let c2: Carry = null;
        let loose = 0;
        let strict = 0;
        for (let i = 1000; i < digits.length; i++) {
            const w = digits.slice(i + 1 - 1000, i + 1);
            const a = evaluateRules(w, c1, { gateMin: 1, ticksSeen: 2000 });
            const b = evaluateRules(w, c2, { gateMin: 2, ticksSeen: 2000 });
            c1 = a.next;
            c2 = b.next;
            expect(a.checks).toHaveLength(7);
            expect(a.regimeScore).toBeGreaterThanOrEqual(0);
            expect(a.regimeScore).toBeLessThanOrEqual(12);
            if (a.entry) loose += 1;
            if (b.entry) strict += 1;
            if (b.entry) expect(a.entry).toBe(true);
        }
        expect(loose).toBeGreaterThan(strict);
    });

    it('with fewer than 1000 digits the gate stays shut until 1000 ticks have been counted', () => {
        const digits = stream(7, 600);
        let carry: Carry = null;
        for (let i = MIN_DIGITS; i < digits.length; i++) {
            const ev = evaluateRules(digits.slice(0, i + 1), carry, { gateMin: 1, ticksSeen: 10 });
            carry = ev.next;
            expect(ev.checks.find(c => c.key === 'gate')?.ok).toBe(false);
            expect(ev.entry).toBe(false);
        }
    });

    it('the last digit must be 6 or lower', () => {
        const digits = stream(11, 3500);
        let carry: Carry = null;
        for (let i = 1000; i < digits.length; i++) {
            const ev = evaluateRules(digits.slice(i + 1 - 1000, i + 1), carry, { gateMin: 1, ticksSeen: 2000 });
            carry = ev.next;
            if (ev.entry) expect(digits[i]).toBeLessThanOrEqual(6);
        }
    });
});

describe('Bot rules: paper mode, as the bot runs it', () => {
    // Plays the stream through the engine as one market. A paper trade is resolved with a digit we choose.
    function play(rules: BotRules, seed: number, resolveWith: number, until: (i: number, enter: boolean) => boolean) {
        const digits = stream(seed, 3500);
        const events: string[] = [];
        let pendingNext = false;
        for (let i = 1000; i < digits.length; i++) {
            if (pendingNext) {
                digits[i] = resolveWith;
                pendingNext = false;
            }
            const out = rules.onTick('A', digits.slice(i + 1 - 1000, i + 1), { live: true, idle: true, prediction: 7, now: i * 1000 });
            events.push(...out.events);
            if (out.events.some(e => /taken as a paper trade/.test(e))) pendingNext = true;
            if (until(i, out.enter)) return { i, events };
        }
        return { i: -1, events };
    }
    const cfg = { virtualMode: true, virtualLosses: 2, gateMin: 1 };

    it('goes real only after two paper losses', () => {
        const rules = new BotRules(() => cfg);
        const r = play(rules, 11, 9, (_i, enter) => enter);
        expect(r.i).toBeGreaterThan(-1);
        expect(r.events.filter(e => /Paper trade on A lost/.test(e))).toHaveLength(2);
        expect(rules.paperState().paper).toBe(false);
    });

    it('a paper win does not count towards going real', () => {
        const rules = new BotRules(() => cfg);
        const r = play(rules, 11, 0, i => i > 2400);
        expect(r.events.some(e => /Paper trade on A won/.test(e))).toBe(true);
        expect(r.events.some(e => /lost/.test(e))).toBe(false);
        expect(rules.paperState().paper).toBe(true);
        expect(rules.paperState().losses).toBe(0);
    });

    it('a real win sends it back to paper; a real loss does not', () => {
        const rules = new BotRules(() => cfg);
        play(rules, 11, 9, (_i, enter) => enter);
        expect(rules.paperState().paper).toBe(false);
        rules.onResult(false);
        expect(rules.paperState().paper).toBe(false);
        rules.onResult(true);
        expect(rules.paperState().paper).toBe(true);
    });

    it('with paper mode off the first signal is bought', () => {
        const rules = new BotRules(() => ({ ...cfg, virtualMode: false }));
        const r = play(rules, 11, 9, (_i, enter) => enter);
        expect(r.i).toBe(BOT_ENTRIES[11][0] + 1000);
        expect(r.events).toHaveLength(0);
    });

    it('no entry while a paper trade is waiting, and it is cleared if its market goes silent', () => {
        const rules = new BotRules(() => cfg);
        const digits = stream(11, 3500);
        const first = BOT_ENTRIES[11][0] + 1000;
        // the bot's carried values need the ticks before the entry
        for (let i = first - 40; i < first; i++) rules.onTick('A', digits.slice(i + 1 - 1000, i + 1), { live: true, idle: false, prediction: 7, now: 0 });
        const a = rules.onTick('A', digits.slice(first + 1 - 1000, first + 1), { live: true, idle: true, prediction: 7, now: 0 });
        expect(a.events.join(' ')).toMatch(/paper trade/);
        expect(rules.paperState().pending).toBe('A');
        const b = rules.onTick('B', digits.slice(first + 1 - 1000, first + 1), { live: true, idle: true, prediction: 7, now: 1000 });
        expect(b.enter).toBe(false);
        expect(b.events.join(' ')).not.toMatch(/taken as a paper trade/);
        const c = rules.onTick('B', digits.slice(first + 2 - 1000, first + 2), { live: true, idle: true, prediction: 7, now: 40_000 });
        expect(c.events.join(' ')).toMatch(/timed out/);
        expect(rules.paperState().pending).not.toBe('A'); // the silent market's paper trade is gone (B may start its own on the same tick)
    });

    it('nothing is entered while stopped or busy, but the board keeps reading', () => {
        const digits = stream(11, 3500);
        const first = BOT_ENTRIES[11][0] + 1000;
        const stopped = new BotRules(() => ({ ...cfg, virtualMode: false }));
        for (let i = first - 40; i < first; i++) stopped.onTick('A', digits.slice(i + 1 - 1000, i + 1), { live: false, idle: false, prediction: 7, now: 0 });
        const out = stopped.onTick('A', digits.slice(first + 1 - 1000, first + 1), { live: false, idle: true, prediction: 7, now: 0 });
        expect(out.enter).toBe(false);
        expect(stopped.board(['A'], s => s)[0].entry).toBe(true);
        const busy = new BotRules(() => ({ ...cfg, virtualMode: false }));
        for (let i = first - 40; i < first; i++) busy.onTick('A', digits.slice(i + 1 - 1000, i + 1), { live: true, idle: false, prediction: 7, now: 0 });
        expect(busy.onTick('A', digits.slice(first + 1 - 1000, first + 1), { live: true, idle: false, prediction: 7, now: 0 }).enter).toBe(false);
    });

    it('the board lists every market with its seven checks and the first missing one', () => {
        const rules = new BotRules(() => cfg);
        rules.onTick('A', stream(3, 1200), { live: true, idle: true, prediction: 7, now: 0 });
        const rows = rules.board(['A', 'B'], s => `Market ${s}`);
        expect(rows).toHaveLength(2);
        expect(rows[0].checks).toHaveLength(7);
        expect(rows[0].ready).toBe(true);
        expect(rows[1].ready).toBe(false);
        expect(rows[1].waitingOn).toMatch(/Waiting/);
    });
});
