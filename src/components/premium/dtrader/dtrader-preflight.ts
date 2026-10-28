// The check before any trade: does Deriv offer this contract on this market for this length, with this barrier? It asks Deriv
// for the market's rules, turns "N ticks" into a duration Deriv offers, and asks for price quotes (nothing is bought) until it
// finds a barrier distance Deriv accepts. The network is injected, so this is unit-tested without Deriv.

import { barrierText, type Duration, extractRules, needsRules, offsetCandidates, planDuration, probeOffsets, type Quote } from './dtrader-catalog';
import { FAMILIES, type Family, legsFor, type SideChoice } from './dtrader-engine';

export type PreflightDeps = {
    contractsFor: (symbol: string) => Promise<{ available?: unknown } | undefined>;
    proposal: (params: {
        amount: number; basis: 'stake'; contract_type: string; currency: string; underlying_symbol: string;
        duration: number; duration_unit: Duration['unit']; barrier?: string; barrier2?: string;
    }) => Promise<{ payout?: number | string }>;
};

export type PreflightInput = {
    symbol: string;
    family: Family;
    side: SideChoice;
    prediction: number;
    /** Barrier distance asked for. */
    offset: number;
    ticks: number;
    stake: number;
    currency: string;
    decimals: number;
    tickSeconds: number;
    /** A distance sized from recent movement; tried after the one asked for. */
    volatilityOffset?: number;
};

export type Preflight =
    | { ok: true; duration: Duration; offset: number; timed: boolean; quotes: Quote[]; notes: string[] }
    | { ok: false; error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : (error as { message?: string })?.message || String(error));

export const preflightContract = async (deps: PreflightDeps, input: PreflightInput): Promise<Preflight> => {
    const def = FAMILIES[input.family];
    if (!needsRules(input.family)) return { ok: true, duration: { value: input.ticks, unit: 't' }, offset: input.offset, timed: false, quotes: [], notes: [] };

    const notes: string[] = [];
    // 1. The market's rules.
    let duration: Duration = { value: input.ticks, unit: 't' };
    let timed = false;
    try {
        const answer = await deps.contractsFor(input.symbol);
        const planned = planDuration(extractRules(answer?.available, input.family), input.ticks, input.tickSeconds, def.title);
        if (!planned.ok) return { ok: false, error: planned.error };
        duration = planned.plan.duration;
        timed = planned.plan.timed;
        if (planned.plan.note) notes.push(planned.plan.note);
    } catch (error) {
        notes.push(`Could not read this market's contract rules (${errorText(error)}). Using ${input.ticks} ticks as asked.`);
    }

    // 2. A barrier distance Deriv accepts, found with quotes only.
    const side: Exclude<SideChoice, 'auto'> = input.side === 'auto' ? 'both' : input.side;
    const probe = await probeOffsets({
        candidates: offsetCandidates(input.offset, input.decimals, input.volatilityOffset ?? 0),
        quote: async offset => Promise.all(legsFor(input.family, side, input.prediction, offset, input.decimals).map(async leg => {
            const quote = await deps.proposal({
                amount: input.stake, basis: 'stake', contract_type: leg.contract, currency: input.currency, underlying_symbol: input.symbol,
                duration: duration.value, duration_unit: duration.unit,
                ...(leg.barrier !== undefined ? { barrier: leg.barrier } : {}),
                ...(leg.barrier2 !== undefined ? { barrier2: leg.barrier2 } : {}),
            });
            return { label: leg.label, payout: Number(quote.payout) };
        })),
    });
    if (!probe.ok) return { ok: false, error: `${def.title}: ${probe.error}` };
    if (probe.offset !== input.offset) {
        notes.push(`Deriv would not take a barrier ${barrierText('+', input.offset, input.decimals)} away from the entry price on this market. ${barrierText('+', probe.offset, input.decimals)} is the closest distance it accepts, so that is used.`);
    }
    return { ok: true, duration, offset: probe.offset, timed, quotes: probe.quotes, notes };
};
