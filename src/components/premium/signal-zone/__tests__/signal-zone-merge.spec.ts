import type { CombinedVerdict } from '../../over-under-engine';
import {
    MAX_SCAN_AGE_MS, buildFusionCandidates, entryProblem, mergeCandidates, revalidate, sentinelGate,
    type FusionCandidate, type SentinelCandidate,
} from '../signal-zone-merge';
import { DEFAULT_SETTINGS, type SignalZoneSettings } from '../signal-zone-settings';

const NOW = 1_700_000_000_000;
const settings = (over: Partial<SignalZoneSettings> = {}): SignalZoneSettings => ({ ...DEFAULT_SETTINGS, excludedMarkets: [], ...over });

const sent = (over: Partial<SentinelCandidate> = {}): SentinelCandidate => ({
    symbol: 'R_25', market: 'Volatility 25', contract: 'DIGITUNDER', barrier: 8, label: 'Under 8', entryDigit: 4, entryStatus: 'ARMED',
    entryWindow: 'within 12 ticks', entryWinRate: 91.2, score: 80, danger: 20, engineBlocked: false, momentumBlocked: false, receivedAt: NOW, ...over,
});
const fus = (over: Partial<FusionCandidate> = {}): FusionCandidate => ({
    symbol: 'R_25', market: 'Volatility 25', contract: 'DIGITUNDER', barrier: 8, label: 'Under 8', action: 'EXECUTE', score: 70, danger: 25,
    confirmed: true, ripe: true, generatedAt: NOW, ...over,
});

describe('entry digit usability', () => {
    it('accepts a validated digit (armed or entering now)', () => {
        expect(entryProblem(sent())).toBeNull();
        expect(entryProblem(sent({ entryStatus: 'ENTER NOW' }))).toBeNull();
    });
    it('never invents a digit', () => {
        expect(entryProblem(sent({ entryDigit: null }))).toContain('no entry digit');
        expect(entryProblem(null)).toContain('no entry digit');
        expect(entryProblem(sent({ entryDigit: 12 }))).toContain('no entry digit');
    });
    it('rejects invalidated and unvalidated digits', () => {
        expect(entryProblem(sent({ entryStatus: 'INVALIDATED' }))).toContain('invalidated');
        expect(entryProblem(sent({ entryStatus: 'UNVALIDATED' }))).toContain('not validated');
    });
});

describe('merge mode: both agree', () => {
    it('loads a signal both engines agree on, with Sentinel\'s entry digit', () => {
        const [top] = mergeCandidates([sent()], [fus()], settings(), NOW);
        expect(top.loadable).toBe(true);
        expect(top.source).toBe('both');
        expect(top.entryDigit).toBe(4);
        expect(top.rank).toBe(75);
        expect(top.danger).toBe(25);
    });
    it('does not load when the barriers differ, and says why', () => {
        const [top] = mergeCandidates([sent()], [fus({ barrier: 7, label: 'Under 7' })], settings(), NOW);
        expect(top.loadable).toBe(false);
        expect(top.reason).toContain('barriers differ');
    });
    it('does not load when the sides disagree', () => {
        const merged = mergeCandidates([sent()], [fus({ contract: 'DIGITOVER', barrier: 2, label: 'Over 2' })], settings(), NOW);
        expect(merged.every(item => !item.loadable)).toBe(true);
        expect(merged.find(item => item.source === 'sentinel')?.reason).toContain('sides disagree');
    });
    it('lists a Fusion-only signal but cannot load it (it has no entry digit)', () => {
        const merged = mergeCandidates([], [fus()], settings(), NOW);
        expect(merged).toHaveLength(1);
        expect(merged[0].source).toBe('fusion');
        expect(merged[0].loadable).toBe(false);
    });
    it('does not load a signal with no entry digit', () => {
        const [top] = mergeCandidates([sent({ entryDigit: null })], [fus()], settings(), NOW);
        expect(top.loadable).toBe(false);
        expect(top.reason).toContain('no entry digit');
    });
});

describe('merge mode: fusion leads', () => {
    const mode = settings({ mergeMode: 'fusion_leads' });
    it('uses Sentinel only for the entry digit of the same contract', () => {
        const [top] = mergeCandidates([sent()], [fus()], mode, NOW);
        expect(top.loadable).toBe(true);
        expect(top.entryDigit).toBe(4);
    });
    it('cannot load when Sentinel has no entry for that exact contract', () => {
        const merged = mergeCandidates([sent({ barrier: 7, label: 'Under 7' })], [fus()], mode, NOW);
        const fusionRow = merged.find(item => item.fusion !== null);
        expect(fusionRow?.loadable).toBe(false);
        expect(fusionRow?.reason).toContain('no entry digit');
        expect(merged.every(item => !item.loadable)).toBe(true);
    });
    it('does not apply Sentinel\'s score gates, because Sentinel only supplies the digit', () => {
        const [top] = mergeCandidates([sent({ score: 10 })], [fus()], settings({ mergeMode: 'fusion_leads', minScore: 60 }), NOW);
        expect(top.loadable).toBe(true);
    });
});

describe('merge mode: sentinel only', () => {
    it('loads a Sentinel signal Fusion does not back', () => {
        const [top] = mergeCandidates([sent()], [], settings({ mergeMode: 'sentinel_only' }), NOW);
        expect(top.loadable).toBe(true);
        expect(top.source).toBe('sentinel');
    });
    it('marks it as both when Fusion agrees', () => {
        const [top] = mergeCandidates([sent()], [fus()], settings({ mergeMode: 'sentinel_only' }), NOW);
        expect(top.source).toBe('both');
    });
});

describe('quality gates and allowed contracts', () => {
    it('applies the Sentinel gates', () => {
        expect(sentinelGate(sent({ engineBlocked: true }), settings())).toContain('blocked');
        expect(sentinelGate(sent({ engineBlocked: true }), settings({ skipBlocked: false }))).toBeNull();
        expect(sentinelGate(sent({ momentumBlocked: true }), settings())).toContain('movement');
        expect(sentinelGate(sent({ score: 50 }), settings({ minScore: 60 }))).toContain('below');
        expect(sentinelGate(sent({ danger: 70 }), settings({ maxDanger: 60 }))).toContain('above');
        expect(sentinelGate(sent(), settings({ excludedMarkets: ['R_25'] }))).toContain('excluded');
    });
    it('drops contracts outside Over 1/2/3 and Under 8/7/6', () => {
        const merged = mergeCandidates(
            [sent({ contract: 'DIGITOVER', barrier: 4, label: 'Over 4' }), sent({ contract: 'DIGITUNDER', barrier: 5, label: 'Under 5' })],
            [fus({ contract: 'DIGITOVER', barrier: 0, label: 'Over 0' })], settings(), NOW,
        );
        expect(merged).toHaveLength(0);
    });
    it('keeps excluded markets out of the Fusion side too', () => {
        expect(mergeCandidates([], [fus()], settings({ excludedMarkets: ['R_25'] }), NOW)).toHaveLength(0);
    });
});

describe('ranking', () => {
    it('puts loadable first, then agreement, then rank, then lower danger', () => {
        const merged = mergeCandidates(
            [sent({ symbol: 'R_10', market: 'Volatility 10', score: 95, danger: 10 }), sent({ symbol: 'R_50', market: 'Volatility 50', score: 60, danger: 30 }),
                sent({ symbol: 'R_75', market: 'Volatility 75', score: 70, danger: 50, entryDigit: null })],
            [fus({ symbol: 'R_50', market: 'Volatility 50', score: 90, danger: 20 })], settings({ mergeMode: 'sentinel_only' }), NOW,
        );
        expect(merged.map(item => item.symbol)).toEqual(['R_50', 'R_10', 'R_75']);
        expect(merged[0].source).toBe('both');
        expect(merged[2].loadable).toBe(false);
    });
    it('breaks equal ranks by the lower danger', () => {
        const merged = mergeCandidates(
            [sent({ symbol: 'R_10', score: 80, danger: 40 }), sent({ symbol: 'R_50', score: 80, danger: 15 })], [], settings({ mergeMode: 'sentinel_only' }), NOW,
        );
        expect(merged[0].symbol).toBe('R_50');
    });
});

describe('revalidation before loading', () => {
    const chosen = () => mergeCandidates([sent()], [fus()], settings(), NOW)[0];
    it('passes when the signal is still there with the same entry digit', () => {
        expect(revalidate(chosen(), mergeCandidates([sent()], [fus()], settings(), NOW + 5000), NOW + 5000).ok).toBe(true);
    });
    it('asks for a new scan when there is nothing chosen, or it is gone', () => {
        expect(revalidate(null, [], NOW).ok).toBe(false);
        const gone = revalidate(chosen(), [], NOW + 1000);
        expect(gone.ok).toBe(false);
    });
    it('refuses when the signal can no longer be loaded', () => {
        const fresh = mergeCandidates([sent({ entryStatus: 'INVALIDATED' })], [fus()], settings(), NOW + 1000);
        const result = revalidate(chosen(), fresh, NOW + 1000);
        expect(result.ok).toBe(false);
    });
    it('refuses when the entry digit changed', () => {
        const fresh = mergeCandidates([sent({ entryDigit: 6 })], [fus()], settings(), NOW + 1000);
        const result = revalidate(chosen(), fresh, NOW + 1000);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('changed from 4 to 6');
    });
    it('refuses an out-of-date scan when nothing fresh is available', () => {
        expect(revalidate(chosen(), [], NOW + MAX_SCAN_AGE_MS + 1).ok).toBe(false);
    });
});

describe('Fusion candidates', () => {
    const item = (proposition: string, over: Record<string, unknown> = {}) => ({
        proposition, action: 'EXECUTE', score: 80, danger: 20, independence: 50, digitpulse: { confirmed: true, ripe: true }, ...over,
    });
    const verdict = (items: unknown[], over: Partial<CombinedVerdict> = {}) =>
        ({ market: 'Volatility 25', ready: true, generatedAt: NOW, sample: 1000, verdicts: items, ...over } as unknown as CombinedVerdict);

    it('keeps recommendable, fresh, allowed propositions', () => {
        const out = buildFusionCandidates({ R_25: verdict([item('UNDER8'), item('OVER2', { action: 'OBSERVE' }), item('UNDER7', { danger: 60 })]) }, NOW);
        expect(out.map(c => c.label)).toEqual(['Under 8']);
        expect(out[0].contract).toBe('DIGITUNDER');
    });
    it('drops markets that are not ready or whose analysis is stale', () => {
        expect(buildFusionCandidates({ R_25: verdict([item('UNDER8')], { ready: false }) }, NOW)).toHaveLength(0);
        expect(buildFusionCandidates({ R_25: verdict([item('UNDER8')]) }, NOW + 60_000)).toHaveLength(0);
    });
});
