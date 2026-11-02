// APEX INTEL AI guard: the live-execution check every signal passes just before it is bought (or paper-traded).
// It is the agents' judgement applied per trade: market regime, whether the winning digits are drying up, whether the
// strategy behind the signal is failing its forward test, and (STRICT) whether there is proven edge. Honest scope: rules
// and statistics only, no language model and no prediction of the next digit. It can only BLOCK a signal; it never
// creates one, raises a stake or changes a contract.
//   OFF    : no check.
//   GUARD  : blocks unsafe signals (unstable or unreadable regime, collapsed win share, failed strategy).
//   STRICT : also needs the regime STABLE and, for main contracts, an edge that beats chance after false-discovery control.
import { type Contract, winningDigits, winProbability } from '@/components/premium/sixfold/bot';
import { classifyRegime, MIN_TICKS_FOR_REGIME, MIN_TRADES } from './analysis';
import type { Forward } from './monitor';

export type AiMode = 'OFF' | 'GUARD' | 'STRICT';

export type GuardRequest = {
    mode: AiMode;
    market: string;
    contract: Contract;
    recovery: boolean;
    strategyId: string | null;
    /** The picker's verdict for a main-contract signal (recovery signals have none). */
    significant: boolean;
    trades: number;
};
export type GuardContext = { series: readonly number[]; forward: readonly Forward[] };
export type GuardVerdict = { allow: boolean; reason: string };

const RECENT = 100;
/** The recent win share must not sit this many standard errors below chance. */
const MIN_Z = -2.5;

export function assess(req: GuardRequest, ctx: GuardContext): GuardVerdict {
    if (req.mode === 'OFF') return { allow: true, reason: 'AI guard off' };
    const digits = ctx.series;
    if (digits.length < MIN_TICKS_FOR_REGIME) return { allow: false, reason: `only ${digits.length} ticks of ${req.market} (needs ${MIN_TICKS_FOR_REGIME})` };
    const regime = classifyRegime(digits, req.contract).regime;
    if (regime === 'UNSTABLE' || regime === 'INSUFFICIENT_DATA') return { allow: false, reason: `${req.market} regime is ${regime.toLowerCase().replace('_', ' ')}` };
    const p = winProbability(req.contract);
    const win = new Set(winningDigits(req.contract));
    const recent = digits.slice(-RECENT);
    const share = recent.filter(d => win.has(d)).length / recent.length;
    const z = (share - p) / Math.sqrt((p * (1 - p)) / recent.length);
    if (z <= MIN_Z) return { allow: false, reason: `winning digits dried up on ${req.market}: ${(share * 100).toFixed(0)}% of the last ${recent.length} ticks vs ${(p * 100).toFixed(0)}% expected` };
    if (req.strategyId) {
        const f = ctx.forward.find(x => x.strategyId === req.strategyId);
        if (f?.suspended) return { allow: false, reason: 'its strategy was suspended by the forward test' };
        if (f && f.trades >= MIN_TRADES && f.hi < p) return { allow: false, reason: 'its strategy is failing the forward test' };
    }
    if (req.mode === 'STRICT') {
        if (regime !== 'STABLE') return { allow: false, reason: `strict: ${req.market} regime is ${regime.toLowerCase()}, not stable` };
        if (req.trades < MIN_TRADES) return { allow: false, reason: `strict: only ${req.trades} trades of evidence (needs ${MIN_TRADES})` };
        if (!req.recovery && !req.significant) return { allow: false, reason: 'strict: no edge over chance after false-discovery control' };
    }
    return { allow: true, reason: `${regime.toLowerCase()} regime, last ${recent.length} ticks ${(share * 100).toFixed(0)}% winning (chance ${(p * 100).toFixed(0)}%)${!req.recovery && req.significant ? ', proven edge' : ''}` };
}
