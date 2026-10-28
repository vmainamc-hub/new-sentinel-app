import { barrierText, extractRules, offsetCandidates, pairOutcome, parseDuration, planDuration, probeOffsets, toSeconds } from '../dtrader-catalog';
import { preflightContract, type PreflightDeps } from '../dtrader-preflight';

// A trimmed contracts_for answer in the shape Deriv returns it.
const offers = (...entries: Array<Record<string, unknown>>) => entries;
const riseFall = { contract_type: 'CALL', barrier_category: 'euro_atm', expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t' };
const higherLowerTimed = [
    { contract_type: 'CALL', barrier_category: 'euro_non_atm', expiry_type: 'intraday', min_contract_duration: '15s', max_contract_duration: '1d' },
    { contract_type: 'PUT', barrier_category: 'euro_non_atm', expiry_type: 'intraday', min_contract_duration: '15s', max_contract_duration: '1d' },
];

describe('durations', () => {
    it('parses Deriv duration text', () => {
        expect(parseDuration('15s')).toEqual({ value: 15, unit: 's' });
        expect(parseDuration('5t')).toEqual({ value: 5, unit: 't' });
        expect(parseDuration('1d')).toEqual({ value: 1, unit: 'd' });
        expect(parseDuration('soon')).toBeNull();
        expect(toSeconds({ value: 2, unit: 'm' }, 1)).toBe(120);
        expect(toSeconds({ value: 3, unit: 't' }, 2)).toBe(6);
    });
});

describe('extractRules', () => {
    it('keeps Higher/Lower offers and ignores the barrier-less Rise/Fall CALL', () => {
        const rules = extractRules(offers(riseFall, ...higherLowerTimed), 'highlow');
        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({ barrierCategory: 'euro_non_atm', expiryType: 'intraday', min: { value: 15, unit: 's' } });
    });
    it('returns nothing for families without barrier rules, or a bad answer', () => {
        expect(extractRules(offers(riseFall), 'risefall')).toEqual([]);
        expect(extractRules(undefined, 'highlow')).toEqual([]);
    });
});

describe('planDuration', () => {
    it('keeps ticks when the market offers them in range', () => {
        const rules = extractRules(offers({ contract_type: 'CALL', barrier_category: 'euro_non_atm', expiry_type: 'tick', min_contract_duration: '5t', max_contract_duration: '10t' }), 'highlow');
        const r = planDuration(rules, 7, 1, 'Higher/Lower');
        expect(r.ok && r.plan).toMatchObject({ duration: { value: 7, unit: 't' }, changed: false, timed: false });
    });
    it('moves to the nearest allowed tick length when asked for too few', () => {
        const rules = extractRules(offers({ contract_type: 'CALL', barrier_category: 'euro_non_atm', expiry_type: 'tick', min_contract_duration: '5t', max_contract_duration: '10t' }), 'highlow');
        const r = planDuration(rules, 1, 1, 'Higher/Lower');
        expect(r.ok && r.plan).toMatchObject({ duration: { value: 5, unit: 't' }, changed: true });
        expect(r.ok && r.plan.note).toMatch(/5 to 10 ticks/);
    });
    it('falls back to seconds at the shortest allowed time when ticks are not offered, and says it settles on a clock time', () => {
        const r = planDuration(extractRules(higherLowerTimed, 'highlow'), 1, 1, 'Higher/Lower');
        expect(r.ok && r.plan).toMatchObject({ duration: { value: 15, unit: 's' }, timed: true, changed: true });
        expect(r.ok && r.plan.note).toMatch(/not offered in ticks/);
    });
    it('uses minutes when the span is a whole number of minutes', () => {
        const r = planDuration(extractRules(higherLowerTimed, 'highlow'), 60, 1, 'Higher/Lower');
        expect(r.ok && r.plan.duration).toEqual({ value: 1, unit: 'm' });
    });
    it('reports that the contract is not offered when there are no rules', () => {
        expect(planDuration([], 1, 1, 'Ends Between/Outside')).toEqual({ ok: false, error: 'Deriv does not offer Ends Between/Outside on this market.' });
    });
});

describe('barriers', () => {
    it('writes the offset with the market decimals and a sign', () => {
        expect(barrierText('+', 0.5, 2)).toBe('+0.50');
        expect(barrierText('-', 2, 2)).toBe('-2.00');
        expect(barrierText('+', 3, 0)).toBe('+3');
    });
    it('lists candidate distances smallest first without duplicates', () => {
        const list = offsetCandidates(0.5, 2, 1.3);
        expect(list[0]).toBe(0.5);
        expect(list).toEqual([...list].sort((a, b) => a - b));
        expect(new Set(list).size).toBe(list.length);
    });
    it('probeOffsets takes the first distance Deriv accepts and stops on errors a bigger barrier cannot fix', async () => {
        const quote = async (offset: number) => { if (offset < 2) throw new Error('Invalid barrier. (InvalidtoBuy)'); return [{ label: 'x', payout: 1.9 }]; };
        const ok = await probeOffsets({ candidates: [0.5, 1, 2, 4], quote });
        expect(ok).toMatchObject({ ok: true, offset: 2, tried: [0.5, 1, 2] });
        const stop = await probeOffsets({ candidates: [0.5, 1], quote: async () => { throw new Error('Trading is not offered for this duration.'); } });
        expect(stop).toMatchObject({ ok: false, tried: [0.5] });
        const never = await probeOffsets({ candidates: [0.5, 1], quote: async () => { throw new Error('Invalid barrier.'); } });
        expect(never.ok).toBe(false);
        expect(!never.ok && never.error).toMatch(/distances tried: 0.5, 1/);
    });
});

describe('pairOutcome', () => {
    it('shows the result of each way a Higher + Lower pair can end', () => {
        const o = pairOutcome(1, 2.4, 2.4, true);
        expect(o).toMatchObject({ total: 2, ifFirstWins: 0.4, ifSecondWins: 0.4, ifNeither: -2, locked: false });
        expect(o.note).toMatch(/between the two barriers/);
    });
    it('warns when the pair loses money whichever side wins', () => {
        const o = pairOutcome(1, 1.95, 1.95, false);
        expect(o.locked).toBe(true);
        expect(o.ifFirstWins).toBe(-0.05);
        expect(o.note).toMatch(/loses money whichever side wins/);
    });
});

describe('preflightContract', () => {
    const deps = (over: Partial<PreflightDeps> = {}, minOffset = 0): PreflightDeps => ({
        contractsFor: async () => ({ available: higherLowerTimed }),
        proposal: async p => { if (Math.abs(Number(p.barrier)) < minOffset) throw new Error('Invalid barrier. (InvalidtoBuy)'); return { payout: 2.1 }; },
        ...over,
    });
    const input = { symbol: '1HZ100V', family: 'highlow' as const, side: 'both' as const, prediction: 0, offset: 0.5, ticks: 1, stake: 1, currency: 'USD', decimals: 2, tickSeconds: 1 };

    it('converts ticks to a time Deriv offers and finds the smallest barrier it accepts', async () => {
        const r = await preflightContract(deps({}, 2), input);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.duration).toEqual({ value: 15, unit: 's' });
            expect(r.offset).toBe(2);
            expect(r.quotes).toHaveLength(2);
            expect(r.notes.join(' ')).toMatch(/closest distance it accepts/);
        }
    });
    it('sends both legs of a Higher + Lower pair with opposite signs', async () => {
        const seen: Array<{ type: string; barrier?: string }> = [];
        await preflightContract(deps({ proposal: async p => { seen.push({ type: p.contract_type, barrier: p.barrier }); return { payout: 2 }; } }), input);
        expect(seen).toEqual([{ type: 'CALL', barrier: '+0.50' }, { type: 'PUT', barrier: '-0.50' }]);
    });
    it('refuses with Deriv\'s own words when no distance works', async () => {
        const r = await preflightContract(deps({ proposal: async () => { throw new Error('Invalid barrier.'); } }), input);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/Higher\/Lower: Invalid barrier/);
    });
    it('still checks quotes when the rules cannot be read, and says so', async () => {
        const r = await preflightContract(deps({ contractsFor: async () => { throw new Error('offline'); } }), input);
        expect(r.ok && r.notes[0]).toMatch(/Could not read this market's contract rules/);
    });
    it('does nothing for contracts that carry no price barrier', async () => {
        const r = await preflightContract(deps(), { ...input, family: 'overunder' });
        expect(r).toMatchObject({ ok: true, quotes: [] });
    });
});
