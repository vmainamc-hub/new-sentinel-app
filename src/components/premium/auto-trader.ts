// Auto Trader decision logic for the Bulk Trader. Pure and framework-free: it decides WHEN a run should start and when
// the auto trader must stop itself. It never places a trade; the page routes execution through the normal Run path.
import type { Recommendation } from './over-under-engine';

export type AutoGrade = 'EXECUTE' | 'ANY';
export type AutoConfig = { grade: AutoGrade; cooldownSec: number; maxRuns: number; maxLoss: number };
export const DEFAULT_AUTO: AutoConfig = { grade: 'EXECUTE', cooldownSec: 30, maxRuns: 5, maxLoss: 5 };
export const AUTO_BOUNDS = { cooldownSec: [5, 600], maxRuns: [1, 50], maxLoss: [0.35, 10_000] } as const;
const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;

export const sanitizeAuto = (input: Partial<AutoConfig>): AutoConfig => {
    const n = (value: unknown, fallback: number, bounds: readonly [number, number]) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(parsed, bounds) : fallback;
    };
    return {
        grade: input.grade === 'ANY' ? 'ANY' : 'EXECUTE',
        cooldownSec: Math.trunc(n(input.cooldownSec, DEFAULT_AUTO.cooldownSec, AUTO_BOUNDS.cooldownSec)),
        maxRuns: Math.trunc(n(input.maxRuns, DEFAULT_AUTO.maxRuns, AUTO_BOUNDS.maxRuns)),
        maxLoss: round2(n(input.maxLoss, DEFAULT_AUTO.maxLoss, AUTO_BOUNDS.maxLoss)),
    };
};
export type AutoSession = {
    armed: boolean; runs: number; pnl: number; lastFiredAt: number | null;
    seen: { key: string; ready: boolean } | null; stopReason: string;
};
export const signalKey = (rec: Recommendation) => `${rec.symbol}:${rec.proposition}`;
const meetsGrade = (rec: Recommendation, grade: AutoGrade) => grade === 'ANY'
    ? rec.action === 'EXECUTE' || rec.action === 'PREPARE' : rec.action === 'EXECUTE';
export const newSession = (): AutoSession => ({ armed: false, runs: 0, pnl: 0, lastFiredAt: null, seen: null, stopReason: '' });
export const armSession = (onScreen: Recommendation | null = null, grade: AutoGrade = 'EXECUTE'): AutoSession => ({
    ...newSession(), armed: true, seen: onScreen ? { key: signalKey(onScreen), ready: meetsGrade(onScreen, grade) } : null,
});
export const disarmSession = (session: AutoSession, reason: string): AutoSession => ({ ...session, armed: false, stopReason: reason });
export type AutoInput = { target: Recommendation | null; valid: boolean; busy: boolean; now: number };
export type AutoStep = { session: AutoSession; fire: boolean; note: string };
export const waitingNote = (config: AutoConfig) => config.grade === 'ANY'
    ? 'Armed. Waiting for the next EXECUTE or PREPARE signal.' : 'Armed. Waiting for the next EXECUTE signal.';

export const stepAuto = (session: AutoSession, config: AutoConfig, input: AutoInput): AutoStep => {
    if (!session.armed) return { session, fire: false, note: session.stopReason || 'Off.' };
    if (session.runs >= config.maxRuns) {
        const reason = `Stopped: reached ${config.maxRuns} auto run${config.maxRuns === 1 ? '' : 's'}.`;
        return { session: disarmSession(session, reason), fire: false, note: reason };
    }
    if (config.maxLoss > 0 && session.pnl <= -config.maxLoss) {
        const reason = `Stopped: session loss limit of ${config.maxLoss.toFixed(2)} reached.`;
        return { session: disarmSession(session, reason), fire: false, note: reason };
    }
    const { target, now } = input;
    const key = target ? signalKey(target) : null;
    const ready = Boolean(target && meetsGrade(target, config.grade));
    const wasReady = key !== null && session.seen?.key === key ? session.seen.ready : false;
    const next: AutoSession = { ...session, seen: key ? { key, ready } : null };
    if (!target) return { session: next, fire: false, note: waitingNote(config) };
    if (!ready) return { session: next, fire: false, note: waitingNote(config) };
    if (wasReady) return { session: next, fire: false, note: 'This signal was already seen. Waiting for the next one.' };
    if (input.busy) return { session: next, fire: false, note: 'A run is in progress. Signal skipped.' };
    if (session.lastFiredAt !== null && now - session.lastFiredAt < config.cooldownSec * 1000) {
        const left = Math.ceil((config.cooldownSec * 1000 - (now - session.lastFiredAt)) / 1000);
        return { session: next, fire: false, note: `Cooling down (${left}s). Signal skipped.` };
    }
    if (!input.valid) return { session: next, fire: false, note: 'Signal failed the live check. Skipped.' };
    return { session: { ...next, runs: session.runs + 1, lastFiredAt: now }, fire: true, note: `Firing ${target.label} on ${target.market}…` };
};
export const recordAutoRun = (session: AutoSession, result: { placed: number; failed: number; pnl: number }): AutoSession => {
    const updated = { ...session, pnl: round2(session.pnl + result.pnl) };
    if (result.placed === 0) return disarmSession(updated, 'Stopped: the run placed no trades. Check the message above.');
    if (result.failed > 0) return disarmSession(updated, `Stopped: ${result.failed} purchase${result.failed === 1 ? '' : 's'} failed.`);
    return updated;
};
