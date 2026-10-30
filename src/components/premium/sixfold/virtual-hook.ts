// Sixfold's Virtual Hook, the same idea as the bot builder's Virtual Hook block.
//
// After `enterLosses` real losses in a row, Sixfold keeps choosing and "buying" contracts exactly as before, but with no
// money: each one is settled on the market's real ticks and only counted on paper. It returns to real trading after
// `returnWins` virtual wins in a row (STREAK) or after `fixedCount` virtual trades (FIXED).
//
// What it does: it keeps real money out of the market while the bot is on a losing run and only goes back once the entry
// rules have produced wins on paper. What it cannot do: change the odds of a real trade. Deriv's digits are random, so a
// virtual win does not make the next real trade more likely to win.
export type VhMode = 'STREAK' | 'FIXED';

export type VhConfig = { enterLosses: number; returnWins: number; mode: VhMode; fixedCount: number };

export type VhState = {
    virtual: boolean;
    /** Real losses in a row since the last real win (or since returning to real). */
    realLosses: number;
    /** Virtual wins in a row. */
    virtualWins: number;
    /** Virtual trades done in this virtual spell (FIXED mode). */
    virtualDone: number;
};

export const freshVh = (): VhState => ({ virtual: false, realLosses: 0, virtualWins: 0, virtualDone: 0 });

export type VhStep = { state: VhState; event: 'entered' | 'returned' | null };

/** A real trade settled. */
export function vhAfterReal(s: VhState, won: boolean, cfg: VhConfig): VhStep {
    if (won) return { state: { ...s, realLosses: 0 }, event: null };
    const realLosses = s.realLosses + 1;
    if (realLosses >= cfg.enterLosses) return { state: { virtual: true, realLosses, virtualWins: 0, virtualDone: 0 }, event: 'entered' };
    return { state: { ...s, realLosses }, event: null };
}

/** A virtual trade settled. */
export function vhAfterVirtual(s: VhState, won: boolean, cfg: VhConfig): VhStep {
    const back: VhState = { virtual: false, realLosses: 0, virtualWins: 0, virtualDone: 0 };
    if (cfg.mode === 'FIXED') {
        const virtualDone = s.virtualDone + 1;
        return virtualDone >= cfg.fixedCount
            ? { state: back, event: 'returned' }
            : { state: { ...s, virtualDone, virtualWins: won ? s.virtualWins + 1 : 0 }, event: null };
    }
    if (!won) return { state: { ...s, virtualWins: 0, virtualDone: s.virtualDone + 1 }, event: null };
    const virtualWins = s.virtualWins + 1;
    return virtualWins >= cfg.returnWins ? { state: back, event: 'returned' } : { state: { ...s, virtualWins, virtualDone: s.virtualDone + 1 }, event: null };
}
