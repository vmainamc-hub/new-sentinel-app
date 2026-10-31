// SENTINEL AI (unified): "where is the signal being blocked?" Pure helpers behind the Funnel panel.
//
// Two reads are combined: the engines' side (EngineFunnel, from the overlay) and the scanner's side (ScanFunnel, from the runner).
// The steps below list how many contracts are still alive after each check, and `verdict` names the first check that left none.
import type { ScanFunnel } from '../sixfold/runner';
import type { EngineFunnel } from './overlay';

export type FunnelStep = {
    key: string;
    label: string;
    /** How many are still alive after this step. */
    alive: number | null;
    /** What this step removed, in plain words (empty when it removed nothing). */
    note: string;
    /** 'engine' steps are about Sentinel / Fusion; 'scanner' steps are about the Sixfold scan and its guards. */
    side: 'engine' | 'scanner';
};

export type FunnelView = { steps: FunnelStep[]; verdict: string; blockedAt: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const describeFunnel = (engine: EngineFunnel | null, scan: ScanFunnel | null, armed: boolean): FunnelView => {
    const steps: FunnelStep[] = [];
    const push = (s: FunnelStep) => steps.push(s);

    if (!engine) {
        return {
            steps,
            verdict: 'The engines have not been read yet. Open the page and wait for the first scan.',
            blockedAt: null,
        };
    }
    if (engine.error) {
        return {
            steps,
            verdict: `The engine read failed: ${engine.error}. Nothing can be backed until it recovers.`,
            blockedAt: 'engine-error',
        };
    }

    const p = engine.producer;
    if (p) {
        push({ key: 'ranked', side: 'engine', label: 'Sentinel engine ranking', alive: p.ranked, note: '' });
        const live = p.ranked - p.engineBlocked - p.tooDangerous;
        push({
            key: 'unblocked',
            side: 'engine',
            label: 'Not blocked and not too dangerous',
            alive: live,
            note: [
                p.engineBlocked ? `${p.engineBlocked} blocked by the engine` : '',
                p.tooDangerous ? `${p.tooDangerous} too dangerous` : '',
            ]
                .filter(Boolean)
                .join(', '),
        });
        push({
            key: 'tiers',
            side: 'engine',
            label: 'Sentinel tiers (confirmed / building / leading)',
            alive: p.confirmed + p.building + p.leading,
            note: `${p.confirmed} confirmed, ${p.building} building, ${p.leading} leading`,
        });
    }
    push({
        key: 'sentinel',
        side: 'engine',
        label: 'Sentinel signals after momentum and quality limits',
        alive: engine.sentinelReads,
        note: [
            engine.momentumFailed ? `${engine.momentumFailed} failed momentum` : '',
            engine.qualityFailed ? `${engine.qualityFailed} failed the score / danger limits` : '',
        ]
            .filter(Boolean)
            .join(', '),
    });
    push({
        key: 'fusion',
        side: 'engine',
        label: 'Insight Fusion recommendations',
        alive: engine.fusionReads,
        note: engine.standDowns ? `${plural(engine.standDowns, 'stand-down')} (vetoes)` : '',
    });
    push({
        key: 'board',
        side: 'engine',
        label: `Engine board (${engine.mode} mode)`,
        alive: engine.board,
        note: `${engine.boardBoth} both agree, ${engine.boardSentinel} Sentinel only, ${engine.boardFusion} Fusion only`,
    });

    if (scan) {
        push({ key: 'cells', side: 'scanner', label: 'Contracts the scanner scored', alive: scan.cells, note: '' });
        push({
            key: 'tradable',
            side: 'scanner',
            label: 'Tradable (not quarantined)',
            alive: scan.tradable,
            note: scan.cells - scan.tradable ? `${scan.cells - scan.tradable} quarantined` : '',
        });
        const afterRest = scan.tradable - scan.resting;
        push({
            key: 'resting',
            side: 'scanner',
            label: 'Not resting after a loss',
            alive: afterRest,
            note: scan.resting ? `${scan.resting} resting` : '',
        });
        const afterGuard = afterRest - scan.guarded;
        push({
            key: 'guards',
            side: 'scanner',
            label: 'Past the pressure / window / streak guards',
            alive: afterGuard,
            note: scan.guarded ? `${scan.guarded} refused` : '',
        });
        const afterMeter = afterGuard - scan.meterVeto;
        push({
            key: 'meter',
            side: 'scanner',
            label: 'Past the Meter guide',
            alive: afterMeter,
            note: scan.meterVeto ? `${scan.meterVeto} refused (loss cluster or Meter floor)` : '',
        });
        const afterEngines = afterMeter - scan.overlayVeto;
        push({
            key: 'engines',
            side: 'scanner',
            label: 'Backed by the engines (mode rules)',
            alive: afterEngines,
            note: scan.overlayVeto ? `${scan.overlayVeto} not backed, or Fusion stood down` : '',
        });
        push({
            key: 'bar',
            side: 'scanner',
            label: 'Scanner score clears the bar',
            alive: scan.eligible,
            note: scan.belowBar ? `${scan.belowBar} under the score they need` : '',
        });
        push({
            key: 'armed',
            side: 'scanner',
            label: 'Armed, waiting for its entry digit',
            alive: armed ? 1 : 0,
            note: armed ? '' : scan.eligible > 0 ? 'eligible but not armed yet' : '',
        });
    }

    const firstEmpty = steps.find(
        s => s.alive === 0 && s.key !== 'armed' && !(s.key === 'fusion' && engine.mode !== 'active')
    );
    if (!firstEmpty) {
        const last = steps[steps.length - 1];
        return {
            steps,
            blockedAt: null,
            verdict: armed
                ? 'A contract is armed and waiting for its entry digit.'
                : last?.alive
                  ? 'Contracts are getting through. If nothing is bought, it is waiting on an entry digit or the cool-down.'
                  : 'No blocking step found yet.',
        };
    }
    const why: Record<string, string> = {
        ranked: 'The Sentinel engine has no analysed markets. Its feed may still be warming up or disconnected.',
        unblocked:
            'The engine holds back every contract (blocked or too dangerous). Nothing for Sentinel to say right now.',
        tiers: 'Sentinel has no contract in any tier.',
        sentinel:
            'Every Sentinel signal was cut by the momentum or score / danger limits. Loosen Require momentum or the limits.',
        board:
            engine.mode === 'balanced' || engine.mode === 'careful'
                ? 'The engine board is empty: no contract passes the mode rules (Sentinel must back it).'
                : 'The engine board is empty.',
        tradable: 'Every contract is quarantined.',
        resting: 'Every market is resting after a loss.',
        guards: 'The pressure, window or streak guards refuse every contract.',
        meter: 'The Meter guide refuses every contract (a loss cluster or a Meter floor).',
        engines: 'The engines back nothing the scanner can trade.',
        bar: 'Contracts get through every check but none scores high enough for the bar it needs.',
    };
    return {
        steps,
        blockedAt: firstEmpty.key,
        verdict: why[firstEmpty.key] ?? `Nothing survives "${firstEmpty.label}".`,
    };
};

// ---- rolling tally over time ----

export type TallyPoint = { at: number; scan: ScanFunnel; engine: EngineFunnel | null };
export const TALLY_WINDOW_MS = 10 * 60 * 1000;

export class FunnelTally {
    private points: TallyPoint[] = [];

    /** Records one scan (a scan already recorded is ignored). */
    add(scan: ScanFunnel | null, engine: EngineFunnel | null, now: number) {
        if (!scan) return;
        if (this.points.length && this.points[this.points.length - 1].scan.at === scan.at) return;
        this.points.push({ at: now, scan, engine });
        this.points = this.points.filter(p => now - p.at <= TALLY_WINDOW_MS);
    }

    summary(now: number) {
        const pts = this.points.filter(p => now - p.at <= TALLY_WINDOW_MS);
        const sum = (pick: (s: ScanFunnel) => number) => pts.reduce((a, p) => a + pick(p.scan), 0);
        const reasons = new Map<string, number>();
        for (const p of pts)
            for (const r of p.scan.reasons) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count);
        return {
            scans: pts.length,
            scansWithEligible: pts.filter(p => p.scan.eligible > 0).length,
            scansWithEngineBoard: pts.filter(p => (p.engine?.board ?? 0) > 0).length,
            stoppedBy: [
                { key: 'engines', label: 'Engines did not back it', count: sum(s => s.overlayVeto) },
                { key: 'meter', label: 'Meter guide', count: sum(s => s.meterVeto) },
                { key: 'guards', label: 'Pressure / window / streak guards', count: sum(s => s.guarded) },
                { key: 'resting', label: 'Resting after a loss', count: sum(s => s.resting) },
                { key: 'bar', label: 'Score under the bar', count: sum(s => s.belowBar) },
            ].sort((a, b) => b.count - a.count),
            reasons: [...reasons.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([reason, count]) => ({ reason, count })),
        };
    }
}
