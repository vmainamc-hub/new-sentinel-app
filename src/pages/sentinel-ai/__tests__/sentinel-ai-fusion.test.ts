import type { CombinedVerdict } from '@/components/premium/over-under-engine';
import {
    buildFusionCandidates,
    buildStandDown,
    consensusFor,
    EMPTY_FUSION_READ,
    fusionKey,
    readFusion,
    type FusionRead,
} from '../sentinel-ai-fusion';

const NOW = 1_000_000;

type ItemInput = {
    proposition: string;
    action?: 'EXECUTE' | 'PREPARE' | 'OBSERVE' | 'STAND_DOWN';
    score?: number;
    danger?: number;
    independence?: number;
};

const verdictOf = (items: ItemInput[], over: Partial<CombinedVerdict> = {}): CombinedVerdict =>
    ({
        market: 'Volatility 100',
        sample: 1000,
        generatedAt: NOW,
        ready: true,
        analysis: null,
        digitFrequency: [],
        best: null,
        headline: '',
        verdicts: items.map(item => ({
            proposition: item.proposition,
            action: item.action ?? 'EXECUTE',
            score: item.score ?? 80,
            danger: item.danger ?? 20,
            independence: item.independence ?? 50,
            digitpulse: { confirmed: true, ripe: true },
        })),
        ...over,
    }) as unknown as CombinedVerdict;

const readOf = (partial: Partial<FusionRead>): FusionRead => ({
    ...EMPTY_FUSION_READ,
    ready: 1,
    total: 13,
    ...partial,
});

describe('buildFusionCandidates', () => {
    it('keeps recommendable contracts that pass Fusion quality and maps them to Over / Under with their barrier', () => {
        const out = buildFusionCandidates(
            { R_100: verdictOf([{ proposition: 'UNDER7' }, { proposition: 'OVER2', action: 'PREPARE', score: 70 }]) },
            NOW
        );
        expect(out.map(c => `${c.symbol} ${c.label} ${c.action}`)).toEqual([
            'R_100 Under 7 EXECUTE',
            'R_100 Over 2 PREPARE',
        ]);
        expect(out[0]).toMatchObject({
            contract: 'DIGITUNDER',
            barrier: 7,
            score: 80,
            danger: 20,
            confirmed: true,
            ripe: true,
        });
    });

    it('drops observe / stand-down, low-score PREPARE, dangerous, not-ready and stale verdicts', () => {
        const verdicts = {
            A: verdictOf([
                { proposition: 'UNDER7', action: 'OBSERVE' },
                { proposition: 'UNDER8', action: 'STAND_DOWN' },
            ]),
            B: verdictOf([{ proposition: 'OVER2', action: 'PREPARE', score: 60 }]),
            C: verdictOf([{ proposition: 'OVER3', danger: 45 }]),
            D: verdictOf([{ proposition: 'OVER1' }], { ready: false }),
            E: verdictOf([{ proposition: 'UNDER6' }], { generatedAt: NOW - 31_000 }),
        };
        expect(buildFusionCandidates(verdicts, NOW)).toEqual([]);
    });
});

describe('buildStandDown', () => {
    it('lists the contracts Fusion stands down on, only for fresh ready verdicts', () => {
        const out = buildStandDown(
            {
                R_100: verdictOf([{ proposition: 'UNDER7', action: 'STAND_DOWN' }, { proposition: 'OVER2' }]),
                R_50: verdictOf([{ proposition: 'UNDER8', action: 'STAND_DOWN' }], { ready: false }),
                R_25: verdictOf([{ proposition: 'UNDER6', action: 'STAND_DOWN' }], { generatedAt: NOW - 60_000 }),
            },
            NOW
        );
        expect([...out]).toEqual([fusionKey('R_100', 'DIGITUNDER', 7)]);
    });
});

describe('readFusion', () => {
    it('counts the markets Fusion has a verdict for', () => {
        const read = readFusion({ A: verdictOf([{ proposition: 'UNDER7' }]), B: verdictOf([], { ready: false }) }, NOW);
        expect(read.ready).toBe(1);
        expect(read.total).toBe(13);
        expect(read.candidates).toHaveLength(1);
    });
});

describe('consensusFor', () => {
    const under7 = { symbol: 'R_100', contractType: 'DIGITUNDER' as const, barrier: 7 };
    const candidate = (symbol: string, contract: 'DIGITOVER' | 'DIGITUNDER', barrier: number) => ({
        symbol,
        market: symbol,
        contract,
        barrier,
        label: `${contract === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`,
        action: 'EXECUTE',
        score: 77,
        danger: 18,
        confirmed: true,
        ripe: true,
        generatedAt: NOW,
    });

    it('is off when Fusion is not consulted, and also while Fusion has no data yet', () => {
        expect(consensusFor(under7, null).consensus).toBe('off');
        expect(consensusFor(under7, EMPTY_FUSION_READ).consensus).toBe('off');
    });

    it('says both when Fusion recommends the same market, side and barrier', () => {
        const view = consensusFor(under7, readOf({ candidates: [candidate('R_100', 'DIGITUNDER', 7)] }));
        expect(view).toMatchObject({ consensus: 'both', score: 77, danger: 18 });
        expect(view.note).toContain('Under 7');
    });

    it('says partial when Fusion reads the same side with another barrier', () => {
        const view = consensusFor(under7, readOf({ candidates: [candidate('R_100', 'DIGITUNDER', 8)] }));
        expect(view.consensus).toBe('partial');
        expect(view.note).toContain('barriers differ');
    });

    it('says conflict when Fusion reads the other side on the market', () => {
        const view = consensusFor(under7, readOf({ candidates: [candidate('R_100', 'DIGITOVER', 2)] }));
        expect(view.consensus).toBe('conflict');
        expect(view.note).toContain('Over 2');
    });

    it('says conflict when Fusion stands down on exactly this contract', () => {
        const view = consensusFor(under7, readOf({ standDown: new Set([fusionKey('R_100', 'DIGITUNDER', 7)]) }));
        expect(view).toMatchObject({ consensus: 'conflict', score: null });
        expect(view.note).toContain('stands down');
    });

    it('prefers an exact match over a stand-down or other-side read', () => {
        const view = consensusFor(
            under7,
            readOf({
                candidates: [candidate('R_100', 'DIGITOVER', 2), candidate('R_100', 'DIGITUNDER', 7)],
                standDown: new Set([fusionKey('R_100', 'DIGITUNDER', 7)]),
            })
        );
        expect(view.consensus).toBe('both');
    });

    it('is silent when Fusion has nothing on this market, and ignores other markets', () => {
        const view = consensusFor(under7, readOf({ candidates: [candidate('R_50', 'DIGITUNDER', 7)] }));
        expect(view.consensus).toBe('silent');
    });
});
