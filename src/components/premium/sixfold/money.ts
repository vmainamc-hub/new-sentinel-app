// Sixfold Auto: settings, stake / martingale / recovery rules and stop conditions. Pure functions, no I/O.
import { type Contract, contractLabel, isValidContract } from './bot';

export type Selectivity = 'strict' | 'balanced' | 'active';
export type EntryRule = 'SMART' | 'SETUP' | 'ANY';

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
    lossShield: boolean;
    restTrades: number;
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
    maxSteps: 3,
    maxStake: 0,
    recovery: true,
    recoveryOver: 3,
    recoveryUnder: 6,
    duration: 1,
    selectivity: 'balanced',
    entry: 'SMART',
    lossShield: true,
    restTrades: 3,
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
        maxSteps: Math.trunc(num(s.maxSteps, d.maxSteps, 0, 20)),
        maxStake: round2(num(s.maxStake, d.maxStake, 0, 100_000)),
        recovery: typeof s.recovery === 'boolean' ? s.recovery : d.recovery,
        recoveryOver: Math.trunc(num(s.recoveryOver, d.recoveryOver, 0, 8)),
        recoveryUnder: Math.trunc(num(s.recoveryUnder, d.recoveryUnder, 1, 9)),
        duration: Math.trunc(num(s.duration, d.duration, 1, 5)),
        selectivity: s.selectivity === 'strict' || s.selectivity === 'active' ? s.selectivity : 'balanced',
        entry: s.entry === 'ANY' || s.entry === 'SETUP' ? s.entry : 'SMART',
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
    return {
        ...session,
        ...nextStake(session, profit, settings),
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
