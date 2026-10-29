// Sixfold Auto: settings, stake / martingale / recovery rules and stop conditions. Pure functions, no I/O.
import type { RecoveryEntry } from './entry';
import { type Contract, contractLabel, isValidContract, profitMultiple, winProbability } from './bot';

export type Selectivity = 'strict' | 'balanced' | 'active';
export type RecoverySizing = 'PAYOUT' | 'MULTIPLIER';
export type EntryRule = 'SMART' | 'SETUP' | 'ANY' | 'LAB';

export type SixfoldSettings = {
    /** The two contracts Sixfold trades. Over <primaryOver> and Under <primaryUnder>; either can be switched off. */
    useOver: boolean;
    primaryOver: number;
    useUnder: boolean;
    primaryUnder: number;
    stake: number;
    takeProfit: number;
    stopLoss: number;
    /** 0 = no limit. */
    maxTrades: number;
    maxConsecutiveLosses: number;
    martingale: boolean;
    multiplier: number;
    /**
     * How the stake grows while there is an open loss. PAYOUT sizes each stake so one win on the contract being bought
     * pays back `recoverShare` % of what is still owed; MULTIPLIER multiplies the last stake.
     */
    recoverySizing: RecoverySizing;
    recoverShare: number;
    /** Most the open loss may grow to, in multiples of the base stake. When the next stake would pass it, the loss is accepted and the stake restarts at base. 0 = off. */
    streakBudget: number;
    /** Steps of the ladder before falling back to the base stake. 0 = no limit. */
    maxSteps: number;
    /** Hard cap on any single stake. 0 = no cap. */
    maxStake: number;
    /** After a loss, trade the recovery barrier of the contract's side (Over/Under only). */
    recovery: boolean;
    recoveryOver: number;
    recoveryUnder: number;
    /** Contract length in ticks (1-5). */
    duration: number;
    selectivity: Selectivity;
    /**
     * SMART learns the entry digits from the armed market's own recent ticks and changes them as the market changes;
     * SETUP waits for a digit that would have lost the contract (as the simulator does); ANY buys as soon as armed.
     */
    entry: EntryRule;
    /** After a loss, rest that market: it is not traded again until `restTrades` other trades have happened. */
    /**
     * Extra entry condition for recovery trades only: wait until the armed market's last `recoveryForm` ticks would all
     * have won (MOMENTUM), all have lost (REVERSION), or lost `recoveryForm` times and then won once (BOUNCE) for the
     * contract being bought. OFF = no extra condition.
     */
    recoveryEntry: RecoveryEntry;
    recoveryForm: number;
    lossShield: boolean;
    restTrades: number;
    /** Skip any market and contract the Meter reads as being in a loss cluster. */
    meterGate: boolean;
    /** After a loss, ask for a higher score on the next trade (fades if nothing qualifies). */
    pickyAfterLoss: boolean;
    /** How long an armed contract waits for its entry digit before it is dropped. */
    waitSeconds: number;
    /** Estimated platform margin, used for break-even and scoring. The real payout comes from Deriv. */
    margin: number;
    /** Markets Sixfold may trade. */
    markets: string[];
};

export const MIN_STAKE = 0.35;

export const DEFAULT_SETTINGS: SixfoldSettings = {
    useOver: true,
    primaryOver: 2,
    useUnder: true,
    primaryUnder: 7,
    stake: 1,
    takeProfit: 10,
    stopLoss: 30,
    maxTrades: 0,
    maxConsecutiveLosses: 6,
    martingale: false,
    multiplier: 2,
    recoverySizing: 'PAYOUT',
    recoverShare: 50,
    streakBudget: 10,
    maxSteps: 3,
    maxStake: 0,
    recovery: true,
    recoveryOver: 3,
    recoveryUnder: 6,
    duration: 1,
    selectivity: 'balanced',
    entry: 'SMART',
    recoveryEntry: 'OFF',
    recoveryForm: 3,
    lossShield: true,
    restTrades: 3,
    meterGate: false,
    pickyAfterLoss: true,
    waitSeconds: 45,
    margin: 0.05,
    markets: ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 'R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const num = (value: unknown, fallback: number, min: number, max: number) => {
    const x = Number(value);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
};

/** Brings any stored / typed value back into a safe range. */
export function normalizeSettings(input: Partial<SixfoldSettings> | null | undefined): SixfoldSettings {
    const d = DEFAULT_SETTINGS;
    const s = input ?? {};
    return {
        useOver: typeof s.useOver === 'boolean' ? s.useOver : d.useOver,
        primaryOver: Math.trunc(num(s.primaryOver, d.primaryOver, 0, 8)),
        useUnder: typeof s.useUnder === 'boolean' ? s.useUnder : d.useUnder,
        primaryUnder: Math.trunc(num(s.primaryUnder, d.primaryUnder, 1, 9)),
        stake: round2(num(s.stake, d.stake, MIN_STAKE, 10_000)),
        takeProfit: round2(num(s.takeProfit, d.takeProfit, 0, 1_000_000)),
        stopLoss: round2(num(s.stopLoss, d.stopLoss, 0, 1_000_000)),
        maxTrades: Math.trunc(num(s.maxTrades, d.maxTrades, 0, 100_000)),
        maxConsecutiveLosses: Math.trunc(num(s.maxConsecutiveLosses, d.maxConsecutiveLosses, 0, 100)),
        martingale: typeof s.martingale === 'boolean' ? s.martingale : d.martingale,
        multiplier: round2(num(s.multiplier, d.multiplier, 1, 10)),
        recoverySizing: s.recoverySizing === 'MULTIPLIER' ? 'MULTIPLIER' : 'PAYOUT',
        recoverShare: Math.trunc(num(s.recoverShare, d.recoverShare, 10, 100)),
        streakBudget: round2(num(s.streakBudget, d.streakBudget, 0, 1000)),
        maxSteps: Math.trunc(num(s.maxSteps, d.maxSteps, 0, 20)),
        maxStake: round2(num(s.maxStake, d.maxStake, 0, 100_000)),
        recovery: typeof s.recovery === 'boolean' ? s.recovery : d.recovery,
        recoveryOver: Math.trunc(num(s.recoveryOver, d.recoveryOver, 0, 8)),
        recoveryUnder: Math.trunc(num(s.recoveryUnder, d.recoveryUnder, 1, 9)),
        duration: Math.trunc(num(s.duration, d.duration, 1, 5)),
        selectivity: s.selectivity === 'strict' || s.selectivity === 'active' ? s.selectivity : 'balanced',
        entry: s.entry === 'ANY' || s.entry === 'SETUP' || s.entry === 'LAB' ? s.entry : 'SMART',
        recoveryEntry: s.recoveryEntry === 'MOMENTUM' || s.recoveryEntry === 'REVERSION' || s.recoveryEntry === 'BOUNCE' || s.recoveryEntry === 'LAB' ? s.recoveryEntry : 'OFF',
        recoveryForm: Math.trunc(num(s.recoveryForm, d.recoveryForm, 2, 8)),
        meterGate: typeof s.meterGate === 'boolean' ? s.meterGate : d.meterGate,
        lossShield: typeof s.lossShield === 'boolean' ? s.lossShield : d.lossShield,
        restTrades: Math.trunc(num(s.restTrades, d.restTrades, 1, 10)),
        pickyAfterLoss: typeof s.pickyAfterLoss === 'boolean' ? s.pickyAfterLoss : d.pickyAfterLoss,
        waitSeconds: Math.trunc(num(s.waitSeconds, d.waitSeconds, 5, 600)),
        margin: num(s.margin, d.margin, 0.01, 0.2),
        markets: Array.isArray(s.markets) && s.markets.length ? s.markets.filter(m => typeof m === 'string') : d.markets,
    };
}

/** The contracts the scanner looks at and the runner may buy: only the ones switched on, nothing else. */
export function primaryContracts(settings: Pick<SixfoldSettings, 'useOver' | 'primaryOver' | 'useUnder' | 'primaryUnder'>): Contract[] {
    const out: Contract[] = [];
    if (settings.useOver) out.push({ side: 'OVER', param: settings.primaryOver });
    if (settings.useUnder) out.push({ side: 'UNDER', param: settings.primaryUnder });
    return out;
}

const STORAGE_KEY = 'sixfold.auto.settings.v1';

export function loadSettings(): SixfoldSettings {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings: SixfoldSettings) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        /* storage unavailable: settings simply are not remembered */
    }
}

// ---------- stake state ----------

export type SessionStats = {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    currentStake: number;
    consecutiveLosses: number;
    martingaleStep: number;
    /** What is still owed from losses since the last time the books were clear (a win that pays it all back, or a write-off). */
    openLoss: number;
    /** Times the streak budget was reached and the loss accepted. */
    writeOffs: number;
    /** Largest drop from the session's best P/L. */
    maxDrawdown: number;
    peak: number;
};

export const clampStake = (stake: number, settings: SixfoldSettings) => {
    let next = Math.max(MIN_STAKE, round2(stake));
    if (settings.maxStake > 0) next = Math.min(next, Math.max(MIN_STAKE, settings.maxStake));
    return next;
};

export const freshSession = (settings: SixfoldSettings): SessionStats => ({
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    currentStake: clampStake(settings.stake, settings),
    consecutiveLosses: 0,
    martingaleStep: 0,
    openLoss: 0,
    writeOffs: 0,
    maxDrawdown: 0,
    peak: 0,
});

/** Stake after a settled trade. A trade with profit < 0 is a loss; anything else is a win (as in Auto Trades). */
export function nextStake(
    prev: Pick<SessionStats, 'currentStake' | 'consecutiveLosses' | 'martingaleStep'>,
    profit: number,
    settings: SixfoldSettings
): Pick<SessionStats, 'currentStake' | 'consecutiveLosses' | 'martingaleStep'> {
    const base = clampStake(settings.stake, settings);
    if (!(profit < 0)) return { currentStake: base, consecutiveLosses: 0, martingaleStep: 0 };
    const consecutiveLosses = prev.consecutiveLosses + 1;
    if (!settings.martingale) return { currentStake: base, consecutiveLosses, martingaleStep: 0 };
    const step = prev.martingaleStep + 1;
    if (settings.maxSteps > 0 && step > settings.maxSteps) {
        // Ladder exhausted: fall back to the base stake instead of escalating further.
        return { currentStake: base, consecutiveLosses, martingaleStep: 0 };
    }
    return {
        currentStake: clampStake(prev.currentStake * settings.multiplier, settings),
        consecutiveLosses,
        martingaleStep: step,
    };
}

export function applyResult(session: SessionStats, profit: number, settings: SixfoldSettings): SessionStats {
    const pnl = round2(session.pnl + profit);
    const peak = Math.max(session.peak, pnl);
    const openLoss = round2(Math.max(0, session.openLoss - profit));
    const next = nextStake(session, profit, settings);
    const owing = { ...session, ...next, openLoss };
    return {
        ...owing,
        // With payout sizing the displayed next stake is an estimate; the real one is sized for the contract bought.
        currentStake:
            settings.martingale && settings.recoverySizing === 'PAYOUT'
                ? stakeFor(owing, previewContract(settings), settings).stake
                : next.currentStake,
        trades: session.trades + 1,
        wins: session.wins + (profit < 0 ? 0 : 1),
        losses: session.losses + (profit < 0 ? 1 : 0),
        pnl,
        peak,
        maxDrawdown: Math.max(session.maxDrawdown, round2(peak - pnl)),
    };
}

/** The contract actually bought: the candidate's own, or its side's recovery barrier while recovering from a loss. */
export function tradeContract(
    candidate: Contract,
    consecutiveLosses: number,
    settings: SixfoldSettings
): { contract: Contract; label: string; recovery: boolean } {
    if (settings.recovery && consecutiveLosses > 0 && (candidate.side === 'OVER' || candidate.side === 'UNDER')) {
        const contract: Contract =
            candidate.side === 'OVER'
                ? { side: 'OVER', param: settings.recoveryOver }
                : { side: 'UNDER', param: settings.recoveryUnder };
        if (isValidContract(contract)) return { contract, label: contractLabel(contract), recovery: true };
    }
    return { contract: candidate, label: contractLabel(candidate), recovery: false };
}

export function stopReason(session: SessionStats, settings: SixfoldSettings): string | null {
    if (settings.takeProfit > 0 && session.pnl >= settings.takeProfit) {
        return `Take profit reached (+${session.pnl.toFixed(2)})`;
    }
    if (settings.stopLoss > 0 && session.pnl <= -settings.stopLoss) {
        return `Stop loss reached (${session.pnl.toFixed(2)})`;
    }
    if (settings.maxTrades > 0 && session.trades >= settings.maxTrades) return `Max trades reached (${session.trades})`;
    if (settings.maxConsecutiveLosses > 0 && session.consecutiveLosses >= settings.maxConsecutiveLosses) {
        return `Max consecutive losses reached (${session.consecutiveLosses})`;
    }
    return null;
}

/** Deriv's contract type names for the sides Sixfold can execute. */
export const DERIV_CONTRACT_TYPE: Partial<Record<Contract['side'], string>> = {
    OVER: 'DIGITOVER',
    UNDER: 'DIGITUNDER',
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
};

export const isExecutable = (c: Contract) => !c.dynamic && DERIV_CONTRACT_TYPE[c.side] !== undefined;

// ---------- stake sizing while recovering ----------

/** A representative contract for estimates: the recovery barrier when it is on, otherwise the first primary. */
export function previewContract(settings: SixfoldSettings): Contract {
    if (settings.recovery) return { side: 'OVER', param: settings.recoveryOver };
    return primaryContracts(settings)[0] ?? { side: 'OVER', param: settings.primaryOver };
}

/**
 * The stake for the next trade of `contract`, and whether the streak budget says to accept the loss first (writeOff).
 * Pure: the caller applies the write-off with `applyWriteOff`.
 */
export function stakeFor(
    session: Pick<SessionStats, 'currentStake' | 'consecutiveLosses' | 'openLoss'>,
    contract: Contract,
    settings: SixfoldSettings
): { stake: number; writeOff: boolean } {
    const base = clampStake(settings.stake, settings);
    if (!settings.martingale) return { stake: base, writeOff: false };
    let stake: number;
    if (settings.recoverySizing === 'PAYOUT') {
        if (session.openLoss <= 0) return { stake: base, writeOff: false };
        const ratio = profitMultiple(winProbability(contract), settings.margin);
        stake = ratio > 0 ? clampStake(Math.max(base, (session.openLoss * (settings.recoverShare / 100)) / ratio), settings) : base;
        // The ladder of consecutive losses ends at maxSteps, as with the multiplier.
        if (settings.maxSteps > 0 && session.consecutiveLosses > settings.maxSteps) return { stake: base, writeOff: session.openLoss > 0 };
    } else {
        stake = session.currentStake;
    }
    const budget = settings.streakBudget * base;
    if (budget > 0 && stake > base && session.openLoss + stake > budget) return { stake: base, writeOff: true };
    return { stake, writeOff: false };
}

/** Accepts the open loss: the books are cleared and the stake restarts at base. The loss streak itself is kept. */
export function applyWriteOff(session: SessionStats, settings: SixfoldSettings): SessionStats {
    return {
        ...session,
        openLoss: 0,
        martingaleStep: 0,
        currentStake: clampStake(settings.stake, settings),
        writeOffs: session.writeOffs + 1,
    };
}

/** Chance of losing `n` trades in a row on a contract that wins with probability `p`. */
export const streakChance = (p: number, n: number) => Math.pow(1 - p, n);

/** The stakes you would place if every trade lost, with the running total at risk. Shows the real cost of a streak. */
export function ladderPreview(settings: SixfoldSettings, steps = 5): Array<{ stake: number; total: number; writeOff: boolean }> {
    const out: Array<{ stake: number; total: number; writeOff: boolean }> = [];
    let s = freshSession(settings);
    const primary = primaryContracts(settings)[0] ?? { side: 'OVER' as const, param: settings.primaryOver };
    let total = 0;
    for (let i = 0; i < steps; i++) {
        const c = tradeContract(primary, s.consecutiveLosses, settings).contract;
        const sized = stakeFor(s, c, settings);
        if (sized.writeOff) s = applyWriteOff(s, settings);
        const stake = sized.writeOff ? clampStake(settings.stake, settings) : sized.stake;
        total += stake;
        out.push({ stake, total: round2(total), writeOff: sized.writeOff });
        s = applyResult(s, -stake, settings);
    }
    return out;
}
