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
    /** 'engine' steps are about the Pulse signal engine; 'scanner' steps are about the Sixfold scan and its guards. */
    side: 'engine' | 'scanner';
};

export type FunnelView = { steps: FunnelStep[]; verdict: string; blockedAt: string | null };

export const describeFunnel = (engine: EngineFunnel | null, scan: ScanFunnel | null, armed: boolean): FunnelView => {
    const steps: FunnelStep[] = [];
    const who = engine?.source === 'digits' ? 'Digits Analysis' : 'Pulse';
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

    push({
        key: 'markets',
        side: 'engine',
        label: `Markets with enough ticks for ${who}`,
        alive: engine.markets,
        note: '',
    });
    push({ key: 'reads', side: 'engine', label: `Contracts ${who} read`, alive: engine.reads, note: '' });
    push({
        key: 'tiers',
        side: 'engine',
        label: engine.source === 'digits' ? 'Ranked #1 / #2 / #3 for their pair' : 'Pulse signals (strong / steady / watch)',
        alive: engine.strong + engine.steady + engine.watch,
        note:
            engine.source === 'digits'
                ? `${engine.strong} ranked #1, ${engine.steady} #2, ${engine.watch} #3, ${engine.none} not in the top 3`
                : `${engine.strong} strong, ${engine.steady} steady, ${engine.watch} watch, ${engine.none} no signal`,
    });
    push({
        key: 'board',
        side: 'engine',
        label: `Signals the ${engine.mode} mode accepts`,
        alive: engine.board,
        note:
            engine.mode === 'careful'
                ? 'strong only'
                : engine.mode === 'balanced'
                  ? 'strong and steady'
                  : 'strong, steady and watch',
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
            label: 'Past the pressure / window / winning-side guards',
            alive: afterGuard,
            note: scan.guarded
                ? `${scan.guarded} refused: ${scan.guardedPressure} losing-side pressure, ${scan.guardedWindow} multi-window, ${scan.guardedWinning} winning-side`
                : '',
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
            label: `Backed by ${who === 'Pulse' ? 'a Pulse signal' : 'Digits Analysis'} (mode rules)`,
            alive: afterEngines,
            note: scan.overlayVeto ? `${scan.overlayVeto} without a ${who} signal` : '',
        });
        push({
            key: 'bar',
            side: 'scanner',
            label: 'Scanner score clears the bar',
            alive: scan.eligible,
            note: scan.belowBar ? `${scan.belowBar} under the score they need` : '',
        });
        const afterStreak = scan.eligible - scan.streakDropped;
        push({
            key: 'streak',
            side: 'scanner',
            label: 'Past the win-streak guard',
            alive: afterStreak,
            note: scan.streakGate
                ? `ON: ${scan.streakDropped} dropped for losing digits lately, ${scan.streakReady} have their run of wins now, the rest wait for one`
                : 'off',
        });
        push({
            key: 'armed',
            side: 'scanner',
            label: 'Armed, waiting for its entry digit',
            alive: armed ? 1 : 0,
            note: armed ? '' : scan.eligible > 0 ? 'eligible but not armed yet' : '',
        });
    }

    const firstEmpty = steps.find(s => s.alive === 0 && s.key !== 'armed');
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
        markets:
            `No market has enough ticks yet (${who} needs 300). The live feed may still be connecting or warming up.`,
        reads: `${who} has no contract to read. Switch on at least one contract.`,
        tiers:
            engine.source === 'digits'
                ? 'Digits Analysis has no ranked market for the contracts switched on.'
                : 'Pulse sees no signal on any market: no contract is winning above its fair share in enough time windows.',
        board: `${who} has signals, but none strong enough for this mode. Try a looser style (Balanced or Active).`,
        tradable: 'Every contract is quarantined.',
        resting: 'Every market is resting after a loss.',
        guards: 'The losing-side pressure, multi-window or winning-side guards refuse every contract. Check which one in the step note and loosen or switch it off.',
        streak: 'The win-streak guard drops every contract that cleared the checks.',
        meter: 'The Meter guide refuses every contract (a loss cluster or a Meter floor).',
        engines: `${who} backs nothing the scanner can trade.`,
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
            scansWithBoard: pts.filter(p => (p.engine?.board ?? 0) > 0).length,
            stoppedBy: [
                { key: 'engines', label: 'No Pulse signal', count: sum(s => s.overlayVeto) },
                { key: 'meter', label: 'Meter guide', count: sum(s => s.meterVeto) },
                { key: 'guards', label: 'Pressure / window / winning-side guards', count: sum(s => s.guarded) },
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
