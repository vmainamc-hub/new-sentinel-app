// The Bulk Trader's market scanner. Pure and framework-free: it is fed the live digits of every market and says which market and
// which Over / Under contract to trade, and which digit to wait for before entering.
//
// How a scan works. For `seconds` (at most 30) every new tick of every market is judged for each of the six contracts (Over 1/2/3,
// Under 6/7/8). A contract is judged by the gates below. Nothing is picked from a single moment: a contract has to keep passing as
// ticks arrive (persistence), and it has to pass on the last look. The best survivor is the pick.
//
// The gates follow the Precision Scanner idea (distribution edge, winners building, losers fading, the end digit not climbing)
// plus the operator's special-digit rule (digit 1 for Over, digit 8 for Under, see sentinel/special-digits.ts). Fusion is not
// used here: it is a separate signal and its verdicts are not required.
//
// The entry digit is found by replay: for each digit 0-9, how often did the contract win when it was entered right after that
// digit printed? The digit is chosen on the older two thirds of the history and checked on the newest third.
//
// Honest limit: Deriv's synthetic digits are random. A scan decides WHERE and WHEN to look; it cannot change the chance that the
// settling digit wins, and every payout is below fair odds, so the expected return stays negative. The scan result says so.
import { readSpecialDigits } from './sentinel/special-digits';

export type ScanContract = 'DIGITOVER' | 'DIGITUNDER';
export type ScanSpec = { contract: ScanContract; barrier: number; label: string; winners: number[]; losers: number[]; fair: number; gateDigit: number };

const spec = (contract: ScanContract, barrier: number): ScanSpec => {
    const over = contract === 'DIGITOVER';
    const winners = Array.from({ length: 10 }, (_, d) => d).filter(d => (over ? d > barrier : d < barrier));
    const losers = Array.from({ length: 10 }, (_, d) => d).filter(d => !winners.includes(d));
    return { contract, barrier, label: `${over ? 'Over' : 'Under'} ${barrier}`, winners, losers, fair: winners.length / 10, gateDigit: over ? 0 : 9 };
};
export const SCAN_SPECS: readonly ScanSpec[] = [spec('DIGITOVER', 1), spec('DIGITOVER', 2), spec('DIGITOVER', 3), spec('DIGITUNDER', 6), spec('DIGITUNDER', 7), spec('DIGITUNDER', 8)];

export const SCAN_MIN_SECONDS = 5;
export const SCAN_MAX_SECONDS = 30;
export const DEFAULT_SCAN_SECONDS = 20;
/** Fewest ticks a market needs before it can be judged. */
export const SCAN_MIN_TICKS = 300;

export type ScanOptions = {
    /** Distribution edge: winners' share over the long window must beat fair by this many points (0.008 = 0.8 pp). */
    edge: number;
    /** A loser digit above this share of the long window is "competing". */
    maxLoserShare: number;
    /** Apply the special-digit rule (digit 1 for Over, digit 8 for Under, and the winning mirror digit increasing). */
    specialDigits: boolean;
    /** The share of a contract's samples that must pass for it to be picked. */
    minPersistence: number;
    /** Fewest samples (new ticks seen during the scan) a market needs. */
    minSamples: number;
};
export const DEFAULT_SCAN_OPTIONS: ScanOptions = { edge: 0.008, maxLoserShare: 0.115, specialDigits: true, minPersistence: 0.6, minSamples: 5 };

export type Gate = { key: string; label: string; pass: boolean; note: string };
export type CellRead = { pass: boolean; score: number; gates: Gate[]; blockedBy: string[] };

const share = (digits: readonly number[], set: readonly number[], window: number): number => {
    const n = Math.min(window, digits.length);
    if (n === 0) return 0;
    let hit = 0;
    for (let i = digits.length - n; i < digits.length; i += 1) if (set.includes(digits[i])) hit += 1;
    return hit / n;
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Judges one contract on one market's digits. Pure. */
export const readCell = (digits: readonly number[], s: ScanSpec, options: ScanOptions = DEFAULT_SCAN_OPTIONS): CellRead => {
    const gates: Gate[] = [];
    if (digits.length < SCAN_MIN_TICKS) {
        return { pass: false, score: 0, gates, blockedBy: [`only ${digits.length} ticks, ${SCAN_MIN_TICKS} needed`] };
    }
    const wins = (w: number) => share(digits, s.winners, w);
    const [r1000, r300, r100, r30] = [wins(1000), wins(300), wins(100), wins(30)];
    const fair = s.fair;

    // 1. Distribution edge: over the long window the winning digits beat their fair share, and no losing digit is competing.
    const edge = r1000 - fair;
    const hot = s.losers.filter(d => share(digits, [d], 1000) > options.maxLoserShare);
    gates.push({
        key: 'edge', label: 'Distribution edge', pass: edge >= options.edge && hot.length === 0,
        note: `winners ${pct(r1000)} vs fair ${pct(fair)}${hot.length ? `, losers above ${pct(options.maxLoserShare)}: ${hot.join(', ')}` : ''}`,
    });

    // 2. Winners building: most windows above fair, and the two latest ones are.
    const above = [r1000, r300, r100, r30].filter(r => r > fair).length;
    gates.push({ key: 'winners', label: 'Winners building', pass: above >= 3 && r100 > fair && r30 > fair, note: `${above} of 4 windows above fair (last 30: ${pct(r30)})` });

    // 3. Losers fading: the losing digits are not taking more of the recent ticks than of the ticks before.
    const l60 = share(digits, s.losers, 60);
    const l200 = share(digits, s.losers, 200);
    gates.push({ key: 'losers', label: 'Losers fading', pass: l60 <= l200 * 1.05, note: `losers ${pct(l60)} (last 60) vs ${pct(l200)} (last 200)` });

    // 4. End digit: the digit at the far end of the losing side is not climbing back.
    const g60 = share(digits, [s.gateDigit], 60);
    const g200 = share(digits, [s.gateDigit], 200);
    gates.push({ key: 'gate', label: `Digit ${s.gateDigit} not climbing`, pass: g60 <= g200 + 0.01, note: `${pct(g60)} (last 60) vs ${pct(g200)} (last 200)` });

    // 5. No fresh loss cluster: not more than the expected number of losing digits in the last 10, plus two.
    const last10 = digits.slice(-10);
    const losses10 = last10.filter(d => s.losers.includes(d)).length;
    const allowed = Math.round(10 * (1 - fair)) + 2;
    gates.push({ key: 'recent', label: 'No loss cluster', pass: losses10 <= allowed, note: `${losses10} losing digits in the last 10 (limit ${allowed})` });

    // 6. Special digits: digit 1 (Over) / digit 8 (Under) dormant or falling, and the other one increasing.
    if (options.specialDigits) {
        const special = readSpecialDigits(digits, s.contract === 'DIGITOVER' ? 'OVER' : 'UNDER');
        gates.push({ key: 'special', label: 'Special digits 1 / 8', pass: special.ok, note: special.note });
    }

    // Score: how far the four windows sit above the fair rate, in standard errors, on the same 0-100 scale Sentinel's Pulse uses.
    const se = (n: number) => Math.sqrt((fair * (1 - fair)) / Math.min(n, digits.length));
    const z = [[r1000, 1000], [r300, 300], [r100, 100], [r30, 30]].map(([r, n]) => (r - fair) / se(n));
    const meanZ = z.reduce((a, b) => a + b, 0) / z.length;
    const score = Math.round(clamp(50 + 12 * meanZ, 0, 100) * 10) / 10;
    const blockedBy = gates.filter(g => !g.pass).map(g => g.label);
    return { pass: blockedBy.length === 0, score, gates, blockedBy };
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Entry digit
// ---------------------------------------------------------------------------------------------------------------------------------
export type EntryStrength = 'confirmed' | 'weak';
export type DigitStat = { digit: number; n: number; wins: number; rate: number; z: number };
export type EntryPick = {
    digit: number;
    strength: EntryStrength;
    /** Older two thirds of the history: how often the contract won when entered right after this digit. */
    train: DigitStat;
    /** Newest third: the same, as a check. */
    holdout: { n: number; wins: number; rate: number };
    fair: number;
    note: string;
};
/** One-sided z needed for the best of ten digits to count as more than luck (Bonferroni, 5%). */
export const ENTRY_Z = 2.58;
export const ENTRY_MIN_N = 25;

const statFor = (digits: readonly number[], from: number, to: number, entryDigit: number, s: ScanSpec, duration: number): DigitStat => {
    let n = 0;
    let wins = 0;
    // The buy goes out after the entry digit has printed at index i; the contract settles on the digit `duration` ticks later.
    for (let i = from; i < to - duration; i += 1) {
        if (digits[i] !== entryDigit) continue;
        n += 1;
        const exit = digits[i + duration];
        if (s.winners.includes(exit)) wins += 1;
    }
    const rate = n ? wins / n : 0;
    const sd = Math.sqrt((s.fair * (1 - s.fair)) / Math.max(1, n));
    return { digit: entryDigit, n, wins, rate, z: n ? (rate - s.fair) / sd : 0 };
};

/** The digit to wait for before entering `s` on this market, found by replaying the market's own history. Null when there is too little. */
export const discoverEntry = (digits: readonly number[], s: ScanSpec, duration: number): EntryPick | null => {
    if (digits.length < SCAN_MIN_TICKS) return null;
    const d = clamp(Math.round(duration) || 1, 1, 10);
    const cut = Math.floor((digits.length * 2) / 3);
    const train = Array.from({ length: 10 }, (_, e) => statFor(digits, 0, cut, e, s, d)).filter(t => t.n >= ENTRY_MIN_N);
    if (train.length === 0) return null;
    const best = train.reduce((a, b) => (b.z > a.z ? b : a));
    const test = statFor(digits, cut, digits.length, best.digit, s, d);
    const strength: EntryStrength = best.z >= ENTRY_Z && test.n > 0 && test.rate > s.fair ? 'confirmed' : 'weak';
    const note = strength === 'confirmed'
        ? `after a ${best.digit} the contract won ${pct(best.rate)} of ${best.n} (fair ${pct(s.fair)}), and ${pct(test.rate)} of the newest ${test.n}`
        : `no digit stands out (best: ${best.digit}, ${pct(best.rate)} of ${best.n}, fair ${pct(s.fair)}). Waiting for it is a timing choice, not an edge`;
    return { digit: best.digit, strength, train: best, holdout: { n: test.n, wins: test.wins, rate: test.rate }, fair: s.fair, note };
};

// ---------------------------------------------------------------------------------------------------------------------------------
// A scan session
// ---------------------------------------------------------------------------------------------------------------------------------
export type ScanPick = {
    symbol: string;
    market: string;
    contract: ScanContract;
    barrier: number;
    side: 0 | 1;
    label: string;
    /** Mean score over the scan (0-100) and the share of samples that passed every gate. */
    score: number;
    persistence: number;
    samples: number;
    /** Whether it passed on the last look. */
    passing: boolean;
    /** The gates on the last look. */
    gates: Gate[];
    blockedBy: string[];
    entry: EntryPick | null;
    rank: number;
};

export type ScanOutcome = {
    seconds: number;
    finishedAt: number;
    marketsRead: number;
    /** The pick, or null when nothing held up for the whole scan. */
    best: ScanPick | null;
    /** What to show when there is no pick: the closest contract (it failed at least one gate). Null when no market could be read. */
    closest: ScanPick | null;
    /** The best few (the pick first), then the near misses. */
    top: ScanPick[];
    note: string;
};

type Tally = { samples: number; passes: number; scoreSum: number; last: CellRead | null };
export type MarketInfo = { symbol: string; name: string };

export class ScanSession {
    private tally = new Map<string, Tally>();
    private seen = new Map<string, number>();
    private ready = new Set<string>();
    readonly options: ScanOptions;
    constructor(readonly startedAt: number, readonly seconds: number, options: Partial<ScanOptions> = {}) {
        this.options = { ...DEFAULT_SCAN_OPTIONS, ...options };
    }

    /** Offer a market's digits. Only a NEW tick (a different `tickId`) counts as a sample. */
    sample(symbol: string, digits: readonly number[], tickId: number): void {
        if (digits.length < SCAN_MIN_TICKS) return;
        this.ready.add(symbol);
        if (this.seen.get(symbol) === tickId) return;
        this.seen.set(symbol, tickId);
        for (const s of SCAN_SPECS) {
            const key = `${symbol}|${s.label}`;
            const read = readCell(digits, s, this.options);
            const t = this.tally.get(key) ?? { samples: 0, passes: 0, scoreSum: 0, last: null };
            t.samples += 1;
            if (read.pass) t.passes += 1;
            t.scoreSum += read.score;
            t.last = read;
            this.tally.set(key, t);
        }
    }

    get marketsRead(): number { return this.ready.size; }
    get sampleCount(): number { let n = 0; this.seen.forEach(() => { n += 1; }); return n; }

    /** Ends the scan. `digitsOf` gives the market's digits for the entry-digit replay; `duration` is the contract's tick duration. */
    finish(now: number, markets: readonly MarketInfo[], digitsOf: (symbol: string) => readonly number[], duration: number): ScanOutcome {
        const name = (symbol: string) => markets.find(m => m.symbol === symbol)?.name ?? symbol;
        const rows: ScanPick[] = [];
        this.tally.forEach((t, key) => {
            const [symbol, label] = key.split('|');
            const s = SCAN_SPECS.find(x => x.label === label);
            if (!s || !t.last) return;
            const persistence = t.samples ? t.passes / t.samples : 0;
            const score = t.samples ? Math.round((t.scoreSum / t.samples) * 10) / 10 : 0;
            rows.push({
                symbol, market: name(symbol), contract: s.contract, barrier: s.barrier, side: s.contract === 'DIGITOVER' ? 0 : 1, label: s.label, score, persistence,
                samples: t.samples, passing: t.last.pass, gates: t.last.gates, blockedBy: t.last.blockedBy, entry: null,
                rank: Math.round(score * (0.5 + 0.5 * persistence) * 10) / 10,
            });
        });
        const qualifies = (r: ScanPick) => r.passing && r.persistence >= this.options.minPersistence && r.samples >= this.options.minSamples;
        const sorted = rows.sort((a, b) => Number(qualifies(b)) - Number(qualifies(a)) || b.rank - a.rank);
        const top = sorted.slice(0, 5);
        for (const r of top) {
            const s = SCAN_SPECS.find(x => x.label === r.label) as ScanSpec;
            r.entry = discoverEntry(digitsOf(r.symbol), s, duration);
        }
        const best = top[0] && qualifies(top[0]) ? top[0] : null;
        const note = best
            ? `${best.label} on ${best.market}: passed ${Math.round(best.persistence * 100)}% of ${best.samples} checks. A scan says where to look; it cannot make a digit more likely to win.`
            : this.marketsRead === 0
                ? 'No market has enough ticks yet. Wait for the feed to fill, then scan again.'
                : 'Nothing held up for the whole scan. Showing the closest. Trading one anyway is your call.';
        return { seconds: this.seconds, finishedAt: now, marketsRead: this.marketsRead, best, closest: best ? null : (top[0] ?? null), top, note };
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------------------
export type EntryMode = 'INSTANT' | 'WAIT';
export type ScanSettings = {
    seconds: number;
    /** Load the pick onto the deck by itself when a scan ends. */
    autoLoad: boolean;
    /** ...and its entry digit with it. */
    autoLoadEntry: boolean;
    /** INSTANT: Over / Under buys at once. WAIT: it buys when the entry digit prints. */
    entryMode: EntryMode;
    /** The digit to wait for, as typed ('' = none). */
    entryDigit: string;
    /** How long a wait for the entry digit may last, seconds. */
    waitSec: number;
    /** Fusion's signals must also pass the scanner's gates (the same readCell rules) before they are offered or can trade. */
    fusionRules: boolean;
};
export const DEFAULT_SCAN_SETTINGS: ScanSettings = { seconds: DEFAULT_SCAN_SECONDS, autoLoad: false, autoLoadEntry: true, entryMode: 'INSTANT', entryDigit: '', waitSec: 90, fusionRules: true };

export const parseEntryDigit = (text: string): number | null => {
    const n = Number(text);
    return text.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
};

export const sanitizeScan = (input: Partial<ScanSettings>): ScanSettings => {
    const seconds = Number(input.seconds);
    const wait = Number(input.waitSec);
    return {
        seconds: Number.isFinite(seconds) ? clamp(Math.round(seconds), SCAN_MIN_SECONDS, SCAN_MAX_SECONDS) : DEFAULT_SCAN_SETTINGS.seconds,
        autoLoad: Boolean(input.autoLoad),
        autoLoadEntry: input.autoLoadEntry === undefined ? DEFAULT_SCAN_SETTINGS.autoLoadEntry : Boolean(input.autoLoadEntry),
        entryMode: input.entryMode === 'WAIT' ? 'WAIT' : 'INSTANT',
        entryDigit: parseEntryDigit(String(input.entryDigit ?? '')) === null ? '' : String(Number(input.entryDigit)),
        waitSec: Number.isFinite(wait) ? clamp(Math.round(wait), 5, 600) : DEFAULT_SCAN_SETTINGS.waitSec,
        fusionRules: input.fusionRules === undefined ? DEFAULT_SCAN_SETTINGS.fusionRules : Boolean(input.fusionRules),
    };
};

const SCAN_KEY = 'apex_bulk_scan_v1';
export const loadScanSettings = (): ScanSettings => {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SCAN_KEY) : null;
        return sanitizeScan(raw ? (JSON.parse(raw) as Partial<ScanSettings>) : {});
    } catch { return { ...DEFAULT_SCAN_SETTINGS }; }
};
export const saveScanSettings = (settings: ScanSettings): void => {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(SCAN_KEY, JSON.stringify(settings)); } catch { /* storage unavailable: the choice lasts for this visit */ }
};

/** The next tick of a market is the entry when it shows the digit being waited for. Only ticks AFTER the wait began count. */
export const entryTriggered = (waitDigit: number, armedAtTime: number, tickTimes: readonly number[], digits: readonly number[]): boolean => {
    const n = digits.length;
    if (n === 0 || tickTimes.length !== n) return false;
    return tickTimes[n - 1] > armedAtTime && digits[n - 1] === waitDigit;
};

/**
 * The scanner's rules applied to ONE Fusion signal (a contract on a market's live digits). Fusion itself is untouched: this only
 * decides whether its signal may be offered or traded. A contract the scanner does not read passes through unchanged.
 */
export const checkFusionRules = (
    digits: readonly number[] | undefined, contract: string, barrier: number, options: ScanOptions = DEFAULT_SCAN_OPTIONS,
): { ok: boolean; reason: string } => {
    const s = SCAN_SPECS.find(x => x.contract === contract && x.barrier === barrier);
    if (!s) return { ok: true, reason: '' };
    if (!digits || digits.length < SCAN_MIN_TICKS) return { ok: false, reason: `Scanner rules: only ${digits?.length ?? 0} ticks read, ${SCAN_MIN_TICKS} needed.` };
    const read = readCell(digits, s, options);
    return read.pass ? { ok: true, reason: '' } : { ok: false, reason: `Scanner rules block ${s.label}: ${read.blockedBy.join('; ')}.` };
};
