// SIXFOLD (fused): the overlay that makes every engine support the others. It plugs into the Sixfold runner (see ../overlay.ts) and
// replaces what used to be two tools (Sixfold and Vanguard) and four separate opinions:
//
//   Sixfold scanner     the base: every market x contract is scored for health; the runner's own bar is what the votes move.
//   Pulse (Sentinel)    windows above the fair rate (strong / steady / watch).
//   Vanguard bot rules  the regime score (0-12) and the bot's full entry check, read on every tick, Under as it is and Over mirrored.
//   Sixfold pressure    losing-side pressure, winning-side momentum and multi-window health (they used to be hard gates).
//   Edge gates          Kalman health, cross-market danger, frequency, arbiter, and the mandatory digit 1 / digit 8 rule.
//   Entry study         the digit to wait for: Sentinel's formula and the Entry Brain, reconciled (see entry-study.ts).
//
// Each engine adds a plain vote (consensus.ts); the sum moves the runner's bar for that contract. A quiet spell eases the bar step by
// step (the Hunter's idle ease), so the tool keeps finding trades, but a hard "no" is never eased: the special-digit rule and the
// gates' danger veto, then the runner's own protections at the entry digit (red run, loss abort), stops, limits, recovery caps.
//
// The overlay holds no money and sends no orders. Honest limit: it decides WHEN to look and what digit to wait for. Deriv digits are
// random, so no amount of agreement between engines makes a contract more likely to win.
import { tradeContract, type SixfoldSettings, primaryContracts } from '../money';
import type { EntryTrigger, OverlayCall, RunnerOverlay } from '../overlay';
import { losingSidePressure, multiWindowHealth, winningSidePressure } from '../pressure';
import type { Cell } from '../scanner';
import type { BotRules, Side } from '../../vanguard/bot-rules';
import { huntEase, keyOf } from '../../sentinel/overlay';
import { PULSE_CONTRACTS, readPulse, type PulseRead, type PulseSnapshot } from '../../sentinel/pulse';
import { type Ballot, type Engine, tally, toCall, type Vote } from './consensus';
import { createEntryStudy, type EntryStudySource, type Study } from './entry-study';

/** One contract on one market as the page shows it: the ballot, and the digit being waited for. */
export type FusedRow = {
    symbol: string;
    key: string;
    label: string;
    ballot: Ballot;
    study: Study | null;
    /** The Vanguard bot's regime score (0-12) when it read this contract, and whether its full entry check holds right now. */
    botScore: number | null;
    botEntry: boolean;
    at: number;
};

export type FusedOverlay = RunnerOverlay & {
    /** Feed every live tick of the engine's feed here: the bot rules and the gates read each tick. */
    onTick: (symbol: string, digit: number) => void;
    /** The latest ballot of every contract the runner has asked about, best (most agreement) first. */
    rows: () => FusedRow[];
    /** The studied digit for a contract on a market, if already worked out. */
    studyOf: (symbol: string, side: 'OVER' | 'UNDER', param: number, duration: number) => Study | null;
    /** Seconds since the last trade or start, which the idle ease reads. */
    idleMs: () => number;
};

const PULSE_POINTS = { strong: -6, steady: -2, watch: 2, none: 4 } as const;
const BOT_FULL = -10;
const MAX_ROWS = 80;

const botPoints = (score: number, entry: boolean): number => (entry ? BOT_FULL : score >= 9 ? -5 : score >= 7 ? -2 : score >= 5 ? 0 : 4);

export const createFusedOverlay = (opts: {
    /** The edge-gate overlay (Kalman / danger / frequency / arbiter and the mandatory special-digit rule). */
    gates: RunnerOverlay;
    /** The live ticks per market. */
    series: () => Readonly<Record<string, readonly number[]>>;
    /** The Vanguard bot's regime engine. The overlay feeds it every tick; it never trades from it. */
    rules: BotRules;
    /** The clock. Default: Date.now. */
    now?: () => number;
    /** Test hooks. */
    study?: EntryStudySource;
    pulse?: (series: Readonly<Record<string, readonly number[]>>, symbols: readonly string[]) => PulseSnapshot;
    /** The id and name the runner shows. */
    moduleId?: string;
    name?: string;
}): FusedOverlay => {
    const clock = opts.now ?? Date.now;
    const study = opts.study ?? createEntryStudy();
    const pulse = opts.pulse ?? ((series, symbols) => readPulse(series, symbols, PULSE_CONTRACTS));
    let settings: SixfoldSettings | null = null;
    let lastActivity = clock();
    let pulseIndex = new Map<string, PulseRead>();
    let botIndex = new Map<string, { score: number | null; entry: boolean }>();
    let generation = 0;
    const cache = new Map<string, { gen: number; recovering: boolean; votes: Vote[]; veto: string | null; row: Omit<FusedRow, 'ballot' | 'at'> }>();
    const latest = new Map<string, FusedRow>();

    const duration = () => settings?.duration ?? 1;
    /** The contract that would actually be bought: the recovery barrier after a loss. */
    const tradedOf = (cell: Cell, recovering: boolean) =>
        settings ? tradeContract(cell.contract, recovering ? 1 : 0, settings).contract : cell.contract;

    const botRead = (cell: Cell) => {
        if (cell.contract.side !== 'OVER' && cell.contract.side !== 'UNDER') return null;
        return botIndex.get(`${cell.symbol}|${cell.contract.side}`) ?? null;
    };

    /** Everything except the idle ease, worked out once per scan for each contract and kept until the next scan. */
    const engineVotes = (cell: Cell, ctx: { recovering: boolean; now: number }) => {
        const id = `${cell.symbol}|${cell.key}`;
        const hit = cache.get(id);
        if (hit && hit.gen === generation && hit.recovering === ctx.recovering) return hit;
        const votes: Vote[] = [];
        let veto: string | null = null;
        const series = opts.series()[cell.symbol] ?? [];
        const traded = tradedOf(cell, ctx.recovering);
        const add = (engine: Engine, points: number, note: string) => votes.push({ engine, points, note });

        // 1. Edge gates: the mandatory special-digit rule and a danger veto are final; the rest is a vote.
        try {
            const g = opts.gates.call(cell, ctx);
            if (!g.allow) veto = g.note || 'held back by the edge gates';
            else add('gates', g.bump, g.note);
        } catch {
            add('gates', 0, 'the gates could not be read');
        }

        // 2. Scanner: a cell that is statistically distinguishable from luck, or clearly above break-even, supports itself.
        add(
            'scanner',
            cell.significant ? -4 : (cell.edgePts ?? 0) >= 2 ? -2 : (cell.edgePts ?? 0) < 0 ? 2 : 0,
            cell.significant ? 'significant after adjusting for the cells scanned' : `${(cell.edgePts ?? 0).toFixed(1)} pts vs break-even`
        );

        // 3. Pulse.
        const read = pulseIndex.get(keyOf(cell.symbol, cell.contract.side, cell.contract.param));
        if (read) {
            const tier = read.tier ?? 'none';
            add('pulse', PULSE_POINTS[tier], tier === 'none' ? 'no Pulse signal' : `Pulse ${tier} (${read.agree} of 4 windows)`);
        } else add('pulse', 0, 'Pulse does not read this contract');

        // 4. Vanguard bot rules (Under as it is, Over mirrored).
        const bot = botRead(cell);
        if (bot && bot.score !== null) add('bot', botPoints(bot.score, bot.entry), bot.entry ? 'the bot’s full entry check holds' : `regime ${bot.score}/12`);
        else add('bot', 0, 'the bot rules are still collecting digits');

        // 5. Sixfold pressure engines, now votes instead of hard gates.
        if (traded.side === 'OVER' || traded.side === 'UNDER') {
            const lose = losingSidePressure(series, traded);
            add('losing', lose.measurable ? { CALM: -2, BUILDING: 0, PRESSURED: 3, HOSTILE: 6 }[lose.state] : 0, lose.measurable ? `losing side ${lose.state.toLowerCase()}` : 'losing side not measurable yet');
            const win = winningSidePressure(series, traded);
            add('winning', win.measurable ? { RISING: -3, DORMANT: 0, FALLING: 3 }[win.state] : 0, win.measurable ? `winning side ${win.state.toLowerCase()}` : 'winning side not measurable yet');
            const health = multiWindowHealth(series, traded);
            add('window', { LOADING: 0, CONSISTENT: -3, THRUST: 0, FADING: 2, WEAK: 4 }[health.verdict], `windows ${health.verdict.toLowerCase()}`);
        }

        // 6. The studied entry digit. A confirmed digit (and more so one both studies agree on) supports the contract; no digit means
        //    there is nothing to wait for yet.
        const found = series.length ? study.get(cell.symbol, traded, series, duration(), ctx.now) : null;
        if (found) {
            const both = found.source === 'both';
            add(
                'digit',
                found.trigger.strength === 'confirmed' ? (both ? -5 : -3) : 0,
                `entry digit ${found.trigger.digit} (${found.trigger.strength}${both ? ', both studies agree' : ''})`
            );
        } else add('digit', 2, 'no entry digit yet');

        const entry = {
            gen: generation,
            recovering: ctx.recovering,
            votes,
            veto,
            row: { symbol: cell.symbol, key: cell.key, label: cell.label, study: found, botScore: bot?.score ?? null, botEntry: Boolean(bot?.entry) },
        };
        cache.set(id, entry);
        return entry;
    };

    const call = (cell: Cell, ctx: { recovering: boolean; now: number }): OverlayCall => {
        const base = engineVotes(cell, ctx);
        const idle = Math.max(0, ctx.now - lastActivity);
        const ease = huntEase(idle);
        const votes: Vote[] = ease > 0 ? [...base.votes, { engine: 'idle', points: -ease, note: `no trade for ${Math.round(idle / 1000)}s` }] : base.votes;
        const ballot = tally(votes, base.veto);
        const id = `${cell.symbol}|${cell.key}`;
        latest.set(id, { ...base.row, ballot, at: ctx.now });
        if (latest.size > MAX_ROWS * 2) for (const k of [...latest.keys()].slice(0, MAX_ROWS)) latest.delete(k);
        return toCall(ballot);
    };

    return {
        moduleId: opts.moduleId ?? opts.gates.moduleId,
        name: opts.name ?? opts.gates.name,
        guardLabel: opts.gates.guardLabel ?? 'Gate check',
        contracts: s => {
            settings = s;
            return primaryContracts(s);
        },
        onStart: now => {
            lastActivity = now;
            study.reset();
            cache.clear();
            opts.gates.onStart?.(now);
        },
        refresh: (now, symbols) => {
            generation += 1;
            const series = opts.series();
            try {
                const snap = pulse(series, symbols);
                pulseIndex = new Map(snap.reads.map(r => [keyOf(r.symbol, r.contract.side, r.contract.param), r]));
            } catch {
                pulseIndex = new Map(); // a failed read counts as no signal, never as a veto
            }
            try {
                botIndex = new Map(opts.rules.board(symbols, s => s).map(r => [`${r.symbol}|${r.side}`, { score: r.score, entry: r.entry }]));
            } catch {
                botIndex = new Map();
            }
            opts.gates.refresh?.(now, symbols);
        },
        arbitrate: (eligible, now) => opts.gates.arbitrate?.(eligible, now),
        call,
        entryTrigger: (symbol, traded, series, ctx): EntryTrigger | null => study.get(symbol, traded, series, ctx.duration, ctx.now)?.trigger ?? null,
        guard: (symbol, traded, series) => opts.gates.guard?.(symbol, traded, series) ?? { ok: true, note: '' },
        onBought: notice => {
            lastActivity = clock();
            opts.gates.onBought?.(notice);
        },
        onSettled: notice => {
            lastActivity = clock();
            opts.gates.onSettled?.(notice);
        },
        onTick: (symbol, digit) => {
            void digit;
            const series = opts.series()[symbol];
            if (!series) return;
            try {
                // live: false = read the digits and carry the bot's tick-to-tick state, buy nothing.
                opts.rules.onTick(symbol, series, {
                    live: false,
                    idle: false,
                    now: clock(),
                    barriers: { UNDER: settings?.primaryUnder ?? 7, OVER: settings?.primaryOver ?? 2 } as Record<Side, number>,
                    refused: { UNDER: false, OVER: false },
                });
            } catch {
                /* the bot rules are an extra look: a failure never gets in the way of a tick */
            }
        },
        rows: () => [...latest.values()].sort((a, b) => a.ballot.net - b.ballot.net || b.ballot.agree - a.ballot.agree).slice(0, MAX_ROWS),
        studyOf: (symbol, side, param, dur) => study.peek(symbol, { side, param }, dur),
        idleMs: () => Math.max(0, clock() - lastActivity),
    };
};

