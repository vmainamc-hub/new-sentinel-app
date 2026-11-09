// ORACLE EVEN / ODD ENGINE. Pure and framework-free.
//
// A market is signalled for EVEN (or ODD) only when ALL of these hold, read from the last 100 ticks:
//   1. RISING DIGITS   at least 3 digits of the contract are above 10.5% AND increasing.
//   2. SECOND MOST     the 2nd most appearing digit belongs to the contract.
//   3. MOST INCREASING the digit that has gained the most belongs to the contract (and really gained).
//   4. RED BARS        the least appearing digit and the 2nd least appearing digit both belong to the contract
//                      (odd digits for an Odd trade, even digits for an Even trade).
//   5. RED BARS RISING both of those least-appearing digits are increasing.
//   6. RECENT DIGITS   the latest ticks are landing on the contract: 6+ of the last 10 and 2+ of the last 3.
//
// "Increasing" = the digit printed more often in the newest 50 ticks than in the 50 ticks before them.
// Every threshold is a named constant below, so a rule can be tuned without touching the logic.
//
// Honest limit: Deriv digits are generated randomly. These rules choose the moments the digit board looks the way the
// operator wants; they cannot make the next tick more likely to be even or odd.

export type Parity = 'EVEN' | 'ODD';

export const PARITY_DIGITS: Record<Parity, readonly number[]> = { EVEN: [0, 2, 4, 6, 8], ODD: [1, 3, 5, 7, 9] };

export const EO = {
    /** Ticks the digit board is read over. */
    window: 100,
    /** Newest ticks compared with the same number of ticks before them, to decide "increasing". */
    half: 50,
    /** A digit counts as strong above this share of the window (10.5%). */
    minShare: 0.105,
    /** How many digits of the contract must be strong and increasing. */
    minRisingDigits: 3,
    recentTicks: 10,
    recentMin: 6,
    lastTicks: 3,
    lastMin: 2,
} as const;

export const EO_MIN_TICKS = EO.window;

export type DigitRow = {
    digit: number;
    count: number;
    share: number;
    /** Prints in the newest half of the window and in the older half. */
    newer: number;
    older: number;
    /** newer - older. Positive = increasing. */
    delta: number;
    rising: boolean;
    /** Ticks ago the digit last printed inside the window (0 = the newest tick); the window length when it did not. */
    lastSeen: number;
};

export type EvenOddCheck = { key: string; label: string; ok: boolean; detail: string };

export type EvenOddRead = {
    parity: Parity;
    /** Every check passed. */
    ok: boolean;
    passed: number;
    total: number;
    checks: EvenOddCheck[];
    /** 0-100 strength of the board for this parity. Only meaningful for ranking markets that pass. */
    score: number;
    rows: DigitRow[];
    mostDigit: number;
    secondMostDigit: number;
    mostIncreasingDigit: number;
    leastDigit: number;
    secondLeastDigit: number;
};

export const digitRows = (digits: readonly number[]): DigitRow[] => {
    const w = digits.slice(-EO.window);
    const n = w.length;
    const rows: DigitRow[] = [];
    for (let d = 0; d <= 9; d += 1) {
        let count = 0;
        let newer = 0;
        let lastSeen = n;
        for (let i = 0; i < n; i += 1) {
            if (w[i] !== d) continue;
            count += 1;
            if (i >= n - EO.half) newer += 1;
            lastSeen = n - 1 - i;
        }
        const older = count - newer;
        rows.push({ digit: d, count, share: n ? count / n : 0, newer, older, delta: newer - older, rising: newer > older, lastSeen });
    }
    return rows;
};

const byMost = (a: DigitRow, b: DigitRow) => b.count - a.count || b.newer - a.newer || a.lastSeen - b.lastSeen || a.digit - b.digit;
const byLeast = (a: DigitRow, b: DigitRow) => a.count - b.count || a.newer - b.newer || b.lastSeen - a.lastSeen || a.digit - b.digit;
const byIncrease = (a: DigitRow, b: DigitRow) => b.delta - a.delta || b.newer - a.newer || a.lastSeen - b.lastSeen || a.digit - b.digit;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export function readEvenOdd(digits: readonly number[], parity: Parity): EvenOddRead | null {
    if (digits.length < EO_MIN_TICKS) return null;
    const mine = new Set(PARITY_DIGITS[parity]);
    const rows = digitRows(digits);
    const most = [...rows].sort(byMost);
    const least = [...rows].sort(byLeast);
    const climb = [...rows].sort(byIncrease);

    const strong = rows.filter(r => mine.has(r.digit) && r.share > EO.minShare && r.rising);
    const second = most[1];
    const top = climb[0];
    const [l1, l2] = least;
    const recent = digits.slice(-EO.recentTicks).filter(d => mine.has(d)).length;
    const last = digits.slice(-EO.lastTicks).filter(d => mine.has(d)).length;
    const word = parity === 'EVEN' ? 'even' : 'odd';

    const checks: EvenOddCheck[] = [
        {
            key: 'rising',
            label: `${EO.minRisingDigits}+ ${word} digits above ${(EO.minShare * 100).toFixed(1)}% and increasing`,
            ok: strong.length >= EO.minRisingDigits,
            detail: strong.length ? `${strong.map(r => `${r.digit} (${pct(r.share)})`).join(', ')}` : 'none yet',
        },
        {
            key: 'second',
            label: `2nd most appearing digit is ${word}`,
            ok: mine.has(second.digit),
            detail: `${second.digit} at ${pct(second.share)}`,
        },
        {
            key: 'climber',
            label: `Most increasing digit is ${word}`,
            ok: mine.has(top.digit) && top.delta > 0,
            detail: `${top.digit} (${top.older} to ${top.newer} prints)`,
        },
        {
            key: 'red',
            label: `Least and 2nd least appearing digits are ${word}`,
            ok: mine.has(l1.digit) && mine.has(l2.digit),
            detail: `${l1.digit} at ${pct(l1.share)}, ${l2.digit} at ${pct(l2.share)}`,
        },
        {
            key: 'red-rising',
            label: 'Both red-bar digits are increasing',
            ok: l1.delta > 0 && l2.delta > 0,
            detail: `${l1.digit}: ${l1.older} to ${l1.newer}, ${l2.digit}: ${l2.older} to ${l2.newer}`,
        },
        {
            key: 'recent',
            label: `Recent digits are ${word} (${EO.recentMin}+ of ${EO.recentTicks}, ${EO.lastMin}+ of ${EO.lastTicks})`,
            ok: recent >= EO.recentMin && last >= EO.lastMin,
            detail: `${recent} of the last ${EO.recentTicks}, ${last} of the last ${EO.lastTicks}`,
        },
    ];

    const passed = checks.filter(c => c.ok).length;
    const parityShare = rows.filter(r => mine.has(r.digit)).reduce((t, r) => t + r.share, 0);
    const score = clamp(
        (strong.length / 5) * 35 +
            (recent / EO.recentTicks) * 20 +
            clamp(top.delta / 10, 0, 1) * 15 +
            clamp((parityShare - 0.5) / 0.2, 0, 1) * 15 +
            (passed / checks.length) * 15
    );
    return {
        parity,
        ok: passed === checks.length,
        passed,
        total: checks.length,
        checks,
        score: Math.round(score * 10) / 10,
        rows,
        mostDigit: most[0].digit,
        secondMostDigit: second.digit,
        mostIncreasingDigit: top.digit,
        leastDigit: l1.digit,
        secondLeastDigit: l2.digit,
    };
}

/** Both sides of one market. */
export const readBothParities = (digits: readonly number[]): Record<Parity, EvenOddRead> | null => {
    const even = readEvenOdd(digits, 'EVEN');
    const odd = readEvenOdd(digits, 'ODD');
    return even && odd ? { EVEN: even, ODD: odd } : null;
};
