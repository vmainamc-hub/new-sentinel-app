import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import {
    buildBoard,
    choosePick,
    FUSION_AGREE_BONUS,
    FUSION_CONFLICT_PENALTY,
    marketDots,
    PICKY_BUMP,
    PICKY_FADE_MS,
    pickyBumpAfterLoss,
    SWITCH_MARGIN,
    type BoardInput,
} from '../sentinel-ai-board';
import type { VettedCandidate } from '../sentinel-ai-engine-types';
import { EMPTY_FUSION_READ, fusionKey, type FusionCandidate, type FusionRead } from '../sentinel-ai-fusion';
import { DEFAULT_SETTINGS } from '../sentinel-ai-types';

const NOW = 5_000_000;

const vettedOf = (
    symbol: string,
    contractId: string,
    score: number,
    over: { blocked?: boolean; digit?: number | null; status?: string } = {}
): VettedCandidate => {
    const isOver = contractId.startsWith('OVER');
    const barrier = Number(contractId.replace(/\D/g, ''));
    const digit = over.digit === undefined ? 4 : over.digit;
    return {
        blocked: over.blocked ?? false,
        momentum: {
            pass: !(over.blocked ?? false),
            measurable: true,
            score: 50,
            blockers: over.blocked ? ['two-sided move is missing'] : [],
        },
        opportunity: {
            symbol,
            name: `Market ${symbol}`,
            score,
            blocked: false,
            dangerComposition: { total: 20, isHardBlocked: false },
            contract: {
                id: contractId,
                label: `${isOver ? 'Over' : 'Under'} ${barrier}`,
                side: isOver ? 'OVER' : 'UNDER',
                barrier,
                confidence: 60,
            },
            entryPoint: {
                status: over.status ?? 'ARMED',
                preferred: digit === null ? null : { digit, pWin: 0.8 },
                window: { label: 'last 300 ticks' },
            },
            signal: { label: 'ENTER NOW', state: 'QUALIFIED', reason: '' },
        } as unknown as RankedOpportunity,
    };
};

const fusionCandidate = (
    symbol: string,
    contract: 'DIGITOVER' | 'DIGITUNDER',
    barrier: number,
    score = 80
): FusionCandidate => ({
    symbol,
    market: `Market ${symbol}`,
    contract,
    barrier,
    label: `${contract === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`,
    action: 'EXECUTE',
    score,
    danger: 15,
    confirmed: true,
    ripe: true,
    generatedAt: NOW,
});

const fusionOf = (candidates: FusionCandidate[] = [], standDown: string[] = []): FusionRead => ({
    candidates,
    standDown: new Set(standDown),
    ready: 5,
    total: 13,
});

const inputOf = (over: Partial<BoardInput> & { vetted: VettedCandidate[] }): BoardInput => ({
    fusion: fusionOf(),
    settings: { engines: 'prefer', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
    now: NOW,
    spent: new Set(),
    resting: new Map(),
    pickyBump: 0,
    activeKey: null,
    isOut: () => false,
    ...over,
});

describe('buildBoard: engines = prefer', () => {
    it("keeps Sentinel's order when Fusion is silent", () => {
        const board = buildBoard(inputOf({ vetted: [vettedOf('R_10', 'UNDER7', 80), vettedOf('R_25', 'OVER2', 78)] }));
        expect(board.rows.map(r => r.key)).toEqual(['R_10|UNDER7', 'R_25|OVER2']);
        expect(board.rows.every(r => r.eligible && r.source === 'sentinel')).toBe(true);
        expect(board.rows[0].fusion.consensus).toBe('silent');
    });

    it('moves a signal up when Fusion backs the same contract', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 78), vettedOf('R_25', 'OVER2', 78 - FUSION_AGREE_BONUS + 2)],
                fusion: fusionOf([fusionCandidate('R_25', 'DIGITOVER', 2)]),
            })
        );
        expect(board.rows[0].key).toBe('R_25|OVER2');
        expect(board.rows[0].fusion.consensus).toBe('both');
        expect(board.rows[0].rank).toBe(78 - FUSION_AGREE_BONUS + 2 + FUSION_AGREE_BONUS);
        expect(board.rows[0].reason).toBe('Both engines agree');
    });

    it('moves a signal down, but still trades it, when Fusion disagrees', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 80), vettedOf('R_25', 'OVER2', 75)],
                fusion: fusionOf([fusionCandidate('R_10', 'DIGITOVER', 2)]),
            })
        );
        expect(board.rows.map(r => r.key)).toEqual(['R_25|OVER2', 'R_10|UNDER7']);
        const demoted = board.rows[1];
        expect(demoted.rank).toBe(80 - FUSION_CONFLICT_PENALTY);
        expect(demoted.eligible).toBe(true);
        expect(demoted.reason).toContain('Insight Fusion disagrees');
    });

    it('does not let a disagreeing Fusion take a lead of more than its penalty', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 95), vettedOf('R_25', 'OVER2', 75)],
                fusion: fusionOf([], [fusionKey('R_10', 'DIGITUNDER', 7)]),
            })
        );
        expect(board.rows[0].key).toBe('R_10|UNDER7');
    });
});

describe('buildBoard: other engine modes', () => {
    it("sentinel: ignores Fusion's opinion for ordering (and keeps the engine's own order)", () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 70), vettedOf('R_25', 'OVER2', 90)],
                fusion: fusionOf([fusionCandidate('R_25', 'DIGITOVER', 2)]),
                settings: { engines: 'sentinel', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
            })
        );
        // Sentinel's rank order is the order it handed over, not re-sorted by score.
        expect(board.rows.map(r => r.key)).toEqual(['R_10|UNDER7', 'R_25|OVER2']);
        expect(board.rows[1].rank).toBe(90);
    });

    it('require: trades only the signals both engines back', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 75)],
                fusion: fusionOf([fusionCandidate('R_25', 'DIGITOVER', 2)]),
                settings: { engines: 'require', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
            })
        );
        expect(board.rows[0]).toMatchObject({ key: 'R_25|OVER2', eligible: true });
        expect(board.rows[1]).toMatchObject({ key: 'R_10|UNDER7', eligible: false, state: 'held' });
        expect(board.rows[1].reason).toContain('Needs both engines');
    });

    it('require: waits when Fusion has no read yet', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90)],
                fusion: EMPTY_FUSION_READ,
                settings: { engines: 'require', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
            })
        );
        expect(board.rows[0].eligible).toBe(false);
        expect(board.rows[0].reason).toContain('no read yet');
    });

    it("fusion_leads: Fusion picks the contract and Sentinel's validated entry digit rides along", () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90, { digit: 6 }), vettedOf('R_25', 'OVER2', 99)],
                fusion: fusionOf([fusionCandidate('R_10', 'DIGITUNDER', 7, 82)]),
                settings: { engines: 'fusion_leads', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
            })
        );
        const first = board.rows[0];
        expect(first).toMatchObject({ key: 'R_10|UNDER7', source: 'fusion', eligible: true, entryDigit: 6 });
        expect(board.signals.get('R_10|UNDER7')).toMatchObject({
            contractType: 'DIGITUNDER',
            barrier: 7,
            entryDigit: 6,
        });
        // A Sentinel signal Fusion does not back stays on the board for information only.
        const other = board.rows.find(r => r.key === 'R_25|OVER2');
        expect(other).toMatchObject({ source: 'sentinel', eligible: false });
    });

    it('fusion_leads: falls back to the default entry digit when Sentinel has no validated one', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90, { digit: 6, status: 'INVALIDATED' })],
                fusion: fusionOf([fusionCandidate('R_10', 'DIGITUNDER', 7)]),
                settings: { engines: 'fusion_leads', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
            })
        );
        expect(board.signals.get('R_10|UNDER7')?.entryDigit).toBeNull();
        expect(board.rows[0].entryStatus).toBe('DEFAULT');
    });

    it('fusion_leads: a Fusion pick on a market that is out (excluded or refused) is not on the board', () => {
        const board = buildBoard(
            inputOf({
                vetted: [],
                fusion: fusionOf([fusionCandidate('JD100', 'DIGITUNDER', 7)]),
                isOut: symbol => symbol === 'JD100',
                settings: { engines: 'fusion_leads', requireMomentum: true, minScore: 70, pickyAfterLoss: true },
            })
        );
        expect(board.rows).toEqual([]);
    });
});

describe('buildBoard: rules that keep a row out', () => {
    it('momentum holds a row while the switch is on, and not when it is off', () => {
        const vetted = [vettedOf('R_10', 'UNDER7', 90, { blocked: true })];
        const on = buildBoard(inputOf({ vetted }));
        expect(on.rows[0]).toMatchObject({ eligible: false, state: 'held' });
        expect(on.rows[0].reason).toContain('Momentum');
        const off = buildBoard(
            inputOf({
                vetted,
                settings: { engines: 'prefer', requireMomentum: false, minScore: 70, pickyAfterLoss: true },
            })
        );
        expect(off.rows[0].eligible).toBe(true);
    });

    it('a worked setup waits for a new one, and the next best row is armed instead', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80)],
                spent: new Set(['R_10|UNDER7']),
            })
        );
        expect(board.rows[0].key).toBe('R_25|OVER2');
        expect(board.rows[1]).toMatchObject({ key: 'R_10|UNDER7', eligible: false, state: 'spent' });
    });

    it('a market resting after a loss is skipped, with the trades left shown', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80)],
                resting: new Map([['R_10', 2]]),
            })
        );
        expect(board.rows[0].key).toBe('R_25|OVER2');
        expect(board.rows[1]).toMatchObject({ eligible: false, state: 'resting' });
        expect(board.rows[1].reason).toContain('2 trades left');
    });

    it('raises the bar for a moment after a loss, and only for signals under it', () => {
        const vetted = [vettedOf('R_10', 'UNDER7', 72), vettedOf('R_25', 'OVER2', 90)];
        const board = buildBoard(inputOf({ vetted, pickyBump: PICKY_BUMP }));
        const low = board.rows.find(r => r.key === 'R_10|UNDER7');
        const high = board.rows.find(r => r.key === 'R_25|OVER2');
        expect(low).toMatchObject({ eligible: false, state: 'held' });
        expect(low?.reason).toContain(`under ${70 + PICKY_BUMP}`);
        expect(high?.eligible).toBe(true);
    });

    it('does not raise the bar when the setting is off', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 72)],
                pickyBump: PICKY_BUMP,
                settings: { engines: 'prefer', requireMomentum: true, minScore: 70, pickyAfterLoss: false },
            })
        );
        expect(board.rows[0].eligible).toBe(true);
    });

    it('marks the row being worked as armed', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80)],
                activeKey: 'R_25|OVER2',
            })
        );
        expect(board.rows.find(r => r.key === 'R_25|OVER2')?.state).toBe('armed');
        expect(board.rows.find(r => r.key === 'R_10|UNDER7')?.state).toBe('next');
    });
});

describe('choosePick', () => {
    const boardOf = (...scores: Array<[string, string, number]>) =>
        buildBoard(inputOf({ vetted: scores.map(([symbol, id, score]) => vettedOf(symbol, id, score)) }));

    it('picks the best tradable row when nothing is armed', () => {
        const board = boardOf(['R_10', 'UNDER7', 90], ['R_25', 'OVER2', 80]);
        expect(choosePick(board, null, 'prefer')?.key).toBe('R_10|UNDER7');
    });

    it('returns null when nothing is tradable', () => {
        const board = buildBoard(inputOf({ vetted: [vettedOf('R_10', 'UNDER7', 90, { blocked: true })] }));
        expect(choosePick(board, null, 'prefer')).toBeNull();
    });

    it('keeps a waiting signal against a challenger that is only slightly better', () => {
        const board = boardOf(['R_10', 'UNDER7', 80 + SWITCH_MARGIN - 1], ['R_25', 'OVER2', 80]);
        expect(choosePick(board, { key: 'R_25|OVER2', hold: true }, 'prefer')?.key).toBe('R_25|OVER2');
    });

    it('switches when the challenger leads by the margin', () => {
        const board = boardOf(['R_10', 'UNDER7', 80 + SWITCH_MARGIN], ['R_25', 'OVER2', 80]);
        expect(choosePick(board, { key: 'R_25|OVER2', hold: true }, 'prefer')?.key).toBe('R_10|UNDER7');
    });

    it('does not use the margin when the armed signal is no longer holdable, or in sentinel mode', () => {
        const board = boardOf(['R_10', 'UNDER7', 81], ['R_25', 'OVER2', 80]);
        expect(choosePick(board, { key: 'R_25|OVER2', hold: false }, 'prefer')?.key).toBe('R_10|UNDER7');
        expect(choosePick(board, { key: 'R_25|OVER2', hold: true }, 'sentinel')?.key).toBe('R_10|UNDER7');
    });

    it('moves off an armed signal that is no longer tradable', () => {
        const board = buildBoard(
            inputOf({
                vetted: [vettedOf('R_10', 'UNDER7', 90), vettedOf('R_25', 'OVER2', 80)],
                resting: new Map([['R_25', 2]]),
            })
        );
        expect(choosePick(board, { key: 'R_25|OVER2', hold: true }, 'prefer')?.key).toBe('R_10|UNDER7');
    });
});

describe('marketDots and pickyBumpAfterLoss', () => {
    it('gives each market its best row, or null', () => {
        const board = buildBoard(inputOf({ vetted: [vettedOf('R_10', 'UNDER7', 90), vettedOf('R_10', 'OVER2', 70)] }));
        const dots = marketDots(board, [
            { symbol: 'R_10', name: 'V10' },
            { symbol: 'R_25', name: 'V25' },
        ]);
        expect(dots[0].best?.key).toBe('R_10|UNDER7');
        expect(dots[1].best).toBeNull();
    });

    it('starts at the full bump after a loss and fades to nothing by itself', () => {
        expect(pickyBumpAfterLoss(0, 0)).toBe(0);
        expect(pickyBumpAfterLoss(1, 0)).toBe(PICKY_BUMP);
        expect(pickyBumpAfterLoss(1, PICKY_FADE_MS * 2)).toBe(PICKY_BUMP - 2);
        expect(pickyBumpAfterLoss(3, PICKY_FADE_MS * 100)).toBe(0);
        expect(DEFAULT_SETTINGS.pickyAfterLoss).toBe(true);
    });
});
