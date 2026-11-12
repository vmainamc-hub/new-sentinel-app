// OVERLORD EVIDENCE RULE. A signal is only allowed when the latest ticks already show the side it names:
//   Fall signal  -> the latest ticks must end in a run of falls      (F F F F)
//   Rise signal  -> the latest ticks must end in a run of rises      (R R R R)
//   Even signal  -> the latest digits must end in a run of even ones (E E E E E)
//   Odd signal   -> the latest digits must end in a run of odd ones  (O O O O O)
// If the run is not there, the market is shown with the reason and is never presented as a signal, never traded.
//
// Honest limit: this makes the tool stricter (fewer, better-evidenced signals). Deriv ticks are random, so a run that has
// already appeared does not promise the next tick.

export type EvidenceSide = 'RISE' | 'FALL' | 'EVEN' | 'ODD';

/** Letter shown for each side: F fall, R rise, E even, O odd. */
export const EVIDENCE_LETTER: Record<EvidenceSide, string> = { RISE: 'R', FALL: 'F', EVEN: 'E', ODD: 'O' };

/** How many in a row the latest ticks must show, per side. */
export const DEFAULT_EVIDENCE_RUN: Record<EvidenceSide, number> = { RISE: 4, FALL: 4, EVEN: 5, ODD: 5 };

/** How many letters of the latest ticks are shown in the pattern. */
const PATTERN_LENGTH = 8;

export type Evidence = {
    side: EvidenceSide;
    /** Run the side needs. */
    required: number;
    /** Run the side actually has at the end of the latest ticks. */
    run: number;
    ok: boolean;
    /** The latest ticks as letters, oldest first, e.g. "RFRFFFF" or "OEOEEEE". "-" is a tick that did not move. */
    pattern: string;
    /** What the run must look like, e.g. "FFFF". */
    wanted: string;
    /** One sentence for the card and the log. */
    text: string;
};

/** Pure: letters of the latest digits, E or O. */
export const digitLetters = (digits: readonly number[]): string =>
    digits.map(d => (Number.isFinite(d) ? (d % 2 === 0 ? 'E' : 'O') : '-')).join('');

/** Pure: letters of the latest price moves, R (higher), F (lower) or - (same). One letter per tick after the first. */
export const moveLetters = (prices: readonly number[]): string => {
    let s = '';
    for (let i = 1; i < prices.length; i += 1) s += prices[i] > prices[i - 1] ? 'R' : prices[i] < prices[i - 1] ? 'F' : '-';
    return s;
};

/** Pure: how many times `letter` repeats at the very end of `letters`. */
export const trailingRun = (letters: string, letter: string): number => {
    let n = 0;
    for (let i = letters.length - 1; i >= 0 && letters[i] === letter; i -= 1) n += 1;
    return n;
};

const build = (side: EvidenceSide, letters: string, required: number): Evidence => {
    const letter = EVIDENCE_LETTER[side];
    const need = Math.max(1, Math.floor(required));
    const run = trailingRun(letters, letter);
    const ok = run >= need;
    const wanted = letter.repeat(need);
    const pattern = letters.slice(-PATTERN_LENGTH);
    const word = side === 'RISE' ? 'rises' : side === 'FALL' ? 'falls' : side === 'EVEN' ? 'even digits' : 'odd digits';
    const text = ok
        ? `Evidence: ${run} ${word} in a row at the end of the latest ticks (${pattern}).`
        : letters.length === 0
          ? `No evidence: no latest ticks to check yet (need ${wanted}).`
          : `No evidence: need ${wanted} in the latest ticks, they show ${pattern || 'nothing'}.`;
    return { side, required: need, run, ok, pattern, wanted, text };
};

/** Pure: the evidence for an Even / Odd signal, read from the latest digits. */
export const digitEvidence = (
    digits: readonly number[],
    side: 'EVEN' | 'ODD',
    required: number = DEFAULT_EVIDENCE_RUN[side]
): Evidence => build(side, digitLetters(digits.slice(-Math.max(PATTERN_LENGTH, required) - 1)), required);

/** Pure: the evidence for a Rise / Fall signal, read from the latest ticks (prices). */
export const moveEvidence = (
    prices: readonly number[],
    side: 'RISE' | 'FALL',
    required: number = DEFAULT_EVIDENCE_RUN[side]
): Evidence => build(side, moveLetters(prices.slice(-Math.max(PATTERN_LENGTH, required) - 1)), required);
