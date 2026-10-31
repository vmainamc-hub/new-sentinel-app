import { produceSignals, tierOf } from '../producer';

// The momentum gate reads many engine fields; its own tests cover it. Here it only passes everything through.
jest.mock('@/sentinel-engine/lib/momentum/momentum-gate', () => ({
    selectTradable: (list: unknown[], setting: { requireMomentum: boolean }) => ({
        tradable: list[0] ?? null,
        reports: list.map(candidate => ({
            candidate,
            blocked: setting.requireMomentum && (candidate as { noMomentum?: boolean }).noMomentum === true,
        })),
        blockedCount: 0,
    }),
}));

type Over = Partial<{
    psych: number;
    verdict: string;
    rising: number;
    threat: number;
    sweep: boolean;
    blocked: boolean;
    danger: number;
    noMomentum: boolean;
}>;
const opp = (symbol: string, o: Over = {}) =>
    ({
        symbol,
        noMomentum: o.noMomentum,
        blocked: o.blocked ?? false,
        dangerComposition: { total: o.danger ?? 30, isHardBlocked: false },
        intel: { danger: o.danger ?? 30 },
        digitPsychology: { verdict: o.verdict ?? 'SUPPORT', score: o.psych ?? 70 },
        losingSidePressure: { risingCount: o.rising ?? 0 },
        contract: { threat: { groupThreat: o.threat ?? 5 } },
        observationDossier: {
            liquiditySweep: { confirmed: o.sweep ?? true, state: o.sweep === false ? 'FORMING' : 'CONFIRMED' },
        },
    }) as never;

describe('Sentinel signal producer', () => {
    it("confirmed: all four of the engine's own surface conditions hold", () => {
        expect(tierOf(opp('A'))).toBe('confirmed');
    });
    it('building: a near miss (sweep not yet confirmed, one losing digit gaining, threat under 20)', () => {
        expect(tierOf(opp('A', { sweep: false }))).toBe('building');
        expect(tierOf(opp('A', { rising: 1, threat: 15 }))).toBe('building');
    });
    it('a blocked candidate is never a signal, whatever its rank', () => {
        expect(tierOf(opp('A', { blocked: true }))).toBeNull();
    });
    it('leading: weak evidence but not dangerous; too dangerous is nothing', () => {
        expect(tierOf(opp('A', { verdict: 'CONFLICT', psych: 30, danger: 40 }))).toBe('leading');
        expect(tierOf(opp('A', { verdict: 'CONFLICT', psych: 30, danger: 80 }))).toBeNull();
    });
    it("speaks even when the engine's own rule surfaces nothing: leading fills a quiet board", () => {
        const out = produceSignals(
            [opp('A', { verdict: 'CONFLICT', psych: 30 }), opp('B', { verdict: 'CONFLICT', psych: 30 })],
            true
        );
        expect(out.map(c => [c.tier, (c.opportunity as { symbol: string }).symbol])).toEqual([
            ['leading', 'A'],
            ['leading', 'B'],
        ]);
    });
    it('a leading read is not added when a better tier exists, so a busy board is not diluted', () => {
        const out = produceSignals(
            [opp('A'), opp('B', { sweep: false }), opp('C', { verdict: 'CONFLICT', psych: 30 })],
            true
        );
        expect(out.map(c => c.tier)).toEqual(['confirmed', 'building']);
    });
    it("keeps the engine's rank order and flags momentum failures instead of dropping them", () => {
        const out = produceSignals([opp('A', { noMomentum: true }), opp('B')], true);
        expect(out.map(c => [(c.opportunity as { symbol: string }).symbol, c.blocked])).toEqual([
            ['A', true],
            ['B', false],
        ]);
        expect(produceSignals([opp('A', { noMomentum: true })], false)[0].blocked).toBe(false);
    });
    it('limits the weaker tiers so they cannot flood the scanner', () => {
        const many = Array.from({ length: 12 }, (_, i) => opp(`M${i}`, { sweep: false }));
        expect(produceSignals(many, false)).toHaveLength(6);
    });
});
