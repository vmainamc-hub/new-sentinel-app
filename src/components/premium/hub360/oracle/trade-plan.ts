// ORACLE TRADE PLAN: what the Oracle trades next, and the Virtual Hook that can keep real money out of the market.
//
// Recovery (Over/Under tab only): after a real loss the next trade is the recovery contract instead of the scanned one,
// e.g. lose OVER 2, recover with OVER 3, UNDER 6, EVEN or ODD. It stays in force until a real trade wins.
//
// Virtual Hook (Even/Odd and Over/Under): Sentinel AI's paper-trading hook. After `enterLosses` real losses in a row the
// Oracle keeps choosing contracts exactly as before, but nothing is bought: each one is settled on the market's real
// ticks and only counted on paper. It goes back to real money after `returnWins` paper wins in a row (STREAK) or after
// `fixedCount` paper trades (FIXED). The state machine is Sentinel's own (../../sixfold/virtual-hook).
//
// What it does: keeps real stakes out of a losing run until the entries have won on paper. What it cannot do: change the
// odds of a real trade. Digits are random, so a paper win does not make the next real trade more likely to win.
import { freshVh, vhAfterReal, vhAfterVirtual, type VhConfig, type VhMode, type VhState } from '../../sixfold/virtual-hook';

export { freshVh, vhAfterReal, vhAfterVirtual };
export type { VhConfig, VhMode, VhState };

export type OracleTradeType = 'EVEN' | 'ODD' | 'OVER' | 'UNDER';

/** Recovery contracts offered after a loss (Over/Under tab). */
export const RECOVERY_TYPES: readonly OracleTradeType[] = ['OVER', 'UNDER', 'EVEN', 'ODD'];

export const needsBarrier = (type: string): boolean => type === 'OVER' || type === 'UNDER';

/** The digits a barrier may take: Over 0-8, Under 1-9. */
export const barrierRange = (type: string): [number, number] => (type === 'OVER' ? [0, 8] : [1, 9]);

/** Sentinel's recovery barriers: Over 3, Under 6. */
export const defaultRecoveryBarrier = (type: string): number => (type === 'UNDER' ? 6 : 3);

export const clampBarrier = (type: string, value: unknown, fallback?: number): number => {
    const [lo, hi] = barrierRange(type);
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return fallback ?? defaultRecoveryBarrier(type);
    return Math.min(hi, Math.max(lo, n));
};

export type RecoveryPlan = { enabled: boolean; type: OracleTradeType; barrier: number };

export type NextTrade = { type: OracleTradeType; barrier: number | null; recovery: boolean };

/**
 * The contract for the next trade. Recovery only applies on the Over/Under tab and only while real losses are unrecovered
 * (`realLossStreak` counts real losses in a row; paper results never change it).
 */
export function nextTrade(args: {
    kind: string;
    type: OracleTradeType;
    barrier: number | null;
    recovery: RecoveryPlan;
    realLossStreak: number;
}): NextTrade {
    const { kind, type, barrier, recovery, realLossStreak } = args;
    if (kind === 'OVER/UNDER' && recovery.enabled && realLossStreak > 0) {
        return {
            type: recovery.type,
            barrier: needsBarrier(recovery.type) ? clampBarrier(recovery.type, recovery.barrier) : null,
            recovery: true,
        };
    }
    return { type, barrier: needsBarrier(type) ? barrier : null, recovery: false };
}

/** Does this contract win on that last digit? */
export function tradeWins(type: string, barrier: number | null, digit: number): boolean {
    if (type === 'EVEN') return digit % 2 === 0;
    if (type === 'ODD') return digit % 2 === 1;
    if (barrier === null || !Number.isFinite(barrier)) return false;
    if (type === 'OVER') return digit > barrier;
    if (type === 'UNDER') return digit < barrier;
    return false;
}

/** Last digit of a tick quote, read at the market's own price precision (so 1234.50 ends in 0, not 5). */
export function digitOfQuote(quote: unknown, pipSize?: number): number | null {
    const n = Number(quote);
    if (!Number.isFinite(n)) return null;
    const pip = Number(pipSize);
    // pip_size is a decimal count (3); some feeds send the pip step (0.001). Both mean three decimals.
    const decimals = pipSize !== undefined && Number.isFinite(pip) && pip >= 0 ? Math.min(20, pip > 0 && pip < 1 ? Math.round(-Math.log10(pip)) : Math.trunc(pip)) : null;
    const text = decimals === null ? String(quote) : n.toFixed(decimals);
    const last = text.replace(/[^0-9]/g, '').slice(-1);
    return last === '' ? null : Number(last);
}

const clampInt = (value: unknown, lo: number, hi: number, fallback: number): number => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Virtual Hook settings as the Oracle form gives them (strings), clamped to Sentinel's ranges. */
export function normalizeVh(raw: { mode?: string; enterLosses?: unknown; returnWins?: unknown; fixedCount?: unknown }): VhConfig {
    return {
        mode: raw.mode === 'FIXED' ? 'FIXED' : 'STREAK',
        enterLosses: clampInt(raw.enterLosses, 1, 10, 2),
        returnWins: clampInt(raw.returnWins, 1, 10, 2),
        fixedCount: clampInt(raw.fixedCount, 1, 20, 3),
    };
}

export const describeTrade = (type: string, barrier: number | null): string =>
    needsBarrier(type) && barrier !== null ? `${type} ${barrier}` : type;
