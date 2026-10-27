// Does Sentinel AI's current signal point at the same market and contract as a Sixfold reading? Information only:
// two analysers agreeing is not evidence that either is right, and disagreeing is not evidence that either is wrong.
import type { Contract } from './bot';

export type SentinelLike = { symbol: string; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number; label: string };
export type Agreement = { kind: 'SAME' | 'SIDE' | 'MARKET' | 'NONE'; text: string };

export function sentinelAgreement(signal: SentinelLike | null | undefined, symbol: string, c: Contract): Agreement {
    if (!signal) return { kind: 'NONE', text: 'Sentinel AI has no live signal.' };
    if (signal.symbol !== symbol) return { kind: 'NONE', text: `Sentinel AI's live signal is on another market (${signal.label}).` };
    const side = signal.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER';
    if (c.side === side && c.param === signal.barrier) return { kind: 'SAME', text: `Sentinel AI also signals ${signal.label} here.` };
    if (c.side === side) return { kind: 'SIDE', text: `Sentinel AI signals ${signal.label} here: same side, different barrier.` };
    return { kind: 'MARKET', text: `Sentinel AI signals ${signal.label} here, a different side.` };
}
