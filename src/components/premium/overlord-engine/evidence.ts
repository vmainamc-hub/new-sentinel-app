// OVERLORD EVIDENCE RULE. A signal is only given when the market is already showing the side it names. Looking at the latest
// ticks, the side must DOMINATE them:
//   Fall signal  -> most of the latest ticks were falls
//   Rise signal  -> most of the latest ticks were rises
//   Even signal  -> most of the latest digits were even
//   Odd signal   -> most of the latest digits were odd
// "Most" is MIN_OF_WINDOW out of the last EVIDENCE_WINDOW ticks (default 6 of 10), in any order: the pattern does not have to be
// consecutive. A tick that did not move counts for neither side. If the side is not dominating, the market is shown with the
// reason, never presented as a signal and never traded.
//
// Honest limit: this makes the tool stricter (signals only where the side has already been showing up). Deriv ticks are random,
// so dominance in the latest ticks does not promise the next tick.

export type EvidenceSide = 'RISE' | 'FALL' | 'EVEN' | 'ODD';

/** Letter shown for each side: F fall, R rise, E even, O odd. */
export const EVIDENCE_LETTER: Record<EvidenceSide, string> = { RISE: 'R', FALL: 'F', EVEN: 'E', ODD: 'O' };

/** How many of the latest ticks are looked at. */
export const EVIDENCE_WINDOW = 10;
/** How many of those must be the signal's side (6 of 10 = a clear majority). */
export const EVIDENCE_MIN = 6;

export type Evidence = {
    side: EvidenceSide;
    /** Ticks looked at. */
    window: number;
    /** Ticks of the side needed. */
    required: number;
    /** Ticks of the side actually found in the window. */
    count: number;
    /** Ticks of the other side found in the window. */
    against: number;
    ok: boolean;
    /** The latest ticks as letters, oldest first, e.g. "RFFRFFFRFF". "-" is a tick that did not move. */
    pattern: string;
    /** One sentence for the card and the log. */
    text: string;
};

/** Pure: letters of digits, E or O. */
export const digitLetters = (digits: readonly number[]): string =>
    digits.map(d => (Number.isFinite(d) ? (d % 2 === 0 ? 'E' : 'O') : '-')).join('');

/** Pure: letters of price moves, R (higher), F (lower) or - (same). One letter per tick after the first. */
export const moveLetters = (prices: readonly number[]): string => {
    let s = '';
    for (let i = 1; i < prices.length; i += 1) s += prices[i] > prices[i - 1] ? 'R' : prices[i] < prices[i - 1] ? 'F' : '-';
    return s;
};

const count = (letters: string, letter: string): number => {
    let n = 0;
    for (const l of letters) if (l === letter) n += 1;
    return n;
};

const OTHER: Record<EvidenceSide, string> = { RISE: 'F', FALL: 'R', EVEN: 'O', ODD: 'E' };
const WORD: Record<EvidenceSide, string> = { RISE: 'rises', FALL: 'falls', EVEN: 'even digits', ODD: 'odd digits' };

const build = (side: EvidenceSide, all: string, min: number, window: number): Evidence => {
    const need = Math.max(1, Math.min(window, Math.floor(min)));
    const pattern = all.slice(-window);
    const found = count(pattern, EVIDENCE_LETTER[side]);
    const against = count(pattern, OTHER[side]);
    // Fewer ticks than the window cannot show dominance yet.
    const ok = pattern.length >= window && found >= need;
    const text =
        pattern.length === 0
            ? `No evidence: no latest ticks to check yet (need ${need} of ${window} to be ${WORD[side]}).`
            : pattern.length < window
              ? `No evidence: only ${pattern.length} latest ticks so far (need ${window}).`
              : ok
                ? `Evidence: ${found} of the last ${window} ticks were ${WORD[side]} (${pattern}).`
                : `No evidence: only ${found} of the last ${window} ticks were ${WORD[side]}, need ${need} (${pattern}).`;
    return { side, window, required: need, count: found, against, ok, pattern, text };
};

/** Pure: the evidence for an Even / Odd signal, read from the latest digits. */
export const digitEvidence = (
    digits: readonly number[],
    side: 'EVEN' | 'ODD',
    min: number = EVIDENCE_MIN,
    window: number = EVIDENCE_WINDOW
): Evidence => build(side, digitLetters(digits.slice(-window)), min, window);

/** Pure: the evidence for a Rise / Fall signal, read from the latest ticks (prices). */
export const moveEvidence = (
    prices: readonly number[],
    side: 'RISE' | 'FALL',
    min: number = EVIDENCE_MIN,
    window: number = EVIDENCE_WINDOW
): Evidence => build(side, moveLetters(prices.slice(-(window + 1))), min, window);
