// Crowd placement: where the six kinds of trader are likely sitting, and who is trapped.
//
// IMPORTANT: this is a MODEL, not an observation. Nobody can see other traders' positions from a digit stream. Each
// archetype below is an explicit, adjustable behavioural rule applied to the digits the market has just printed:
//
//   CHASE traders (Over, Under, Even, Odd, Differs) buy the side that has just been WINNING. "The market showed a
//   direction" = that contract beat its normal win rate over the BAIT window. They are TRAPPED when, over the most
//   recent DELIVERY window, the market delivered the opposite (the contract fell well below its normal rate).
//
//   DUE traders (Matches) buy the digit that has been absent the longest, believing it is "due". They are TRAPPED when
//   it keeps not showing up.
//
// "Trade the opposite" then means the exact complement contract of the trapped side.

import { complementOf, type Contract, contractLabel } from './bot';
import { type ContractSide, outcome } from './engine';
import { clamp } from './stats';

export type TrapState = 'QUIET' | 'CHASING' | 'WAVERING' | 'TRAPPED';

export type CrowdConfig = {
    /** Barrier the Over trader and the Under trader use (their two safe-looking contracts). */
    overBarrier: number;
    underBarrier: number;
    /** Ticks of "what the market showed" before the delivery window. */
    baitTicks: number;
    /** Ticks of "what the market delivered". */
    deliveryTicks: number;
    /** The bait window must beat the normal rate by at least this many sigmas for the crowd to pile in. */
    baitZ: number;
    /** The delivery window must fall at least this many sigmas below normal (a negative number) to count as trapped. */
    deliveryZ: number;
    /** Matches: absence (ticks) at which traders start leaning on a digit, and at which they count as trapped. */
    dueChase: number;
    dueTrap: number;
};

export const DEFAULT_CROWD: CrowdConfig = {
    overBarrier: 2,
    underBarrier: 7,
    baitTicks: 40,
    deliveryTicks: 20,
    baitZ: 1,
    deliveryZ: -1,
    dueChase: 20,
    dueTrap: 40,
};

/** Named sensitivities for the trap thresholds. */
export const SENSITIVITY = {
    sensitive: { baitZ: 0.75, deliveryZ: -0.75 },
    standard: { baitZ: 1, deliveryZ: -1 },
    strict: { baitZ: 1.5, deliveryZ: -1.5 },
} as const;
export type Sensitivity = keyof typeof SENSITIVITY;

export const ARCHETYPES: ContractSide[] = ['OVER', 'UNDER', 'EVEN', 'ODD', 'MATCHES', 'DIFFERS'];

export const ARCHETYPE_TEXT: Record<ContractSide, { name: string; behaviour: 'CHASE' | 'DUE'; rule: string }> = {
    OVER: { name: 'Over trader', behaviour: 'CHASE', rule: 'Buys Over after high digits have been winning.' },
    UNDER: { name: 'Under trader', behaviour: 'CHASE', rule: 'Buys Under after low digits have been winning.' },
    EVEN: { name: 'Even trader', behaviour: 'CHASE', rule: 'Buys Even after even digits have been winning.' },
    ODD: { name: 'Odd trader', behaviour: 'CHASE', rule: 'Buys Odd after odd digits have been winning.' },
    MATCHES: {
        name: 'Matches trader',
        behaviour: 'DUE',
        rule: 'Buys the digit that has been absent longest, believing it is due.',
    },
    DIFFERS: {
        name: 'Differs trader',
        behaviour: 'CHASE',
        rule: 'Buys "Differs from the last digit" while repeats have stayed away.',
    },
};

export type CrowdPosition = {
    archetype: ContractSide;
    name: string;
    behaviour: 'CHASE' | 'DUE';
    /** The contract this trader is modelled as holding right now. */
    holds: Contract;
    /** The exact opposite contract: what the trapped crowd's counter-party would hold. */
    opposite: Contract;
    /** 0-100: how strongly the market has pulled this trader in. */
    conviction: number;
    state: TrapState;
    baitZ: number | null;
    deliveryZ: number | null;
    /** Matches only: ticks the due digit has been absent. */
    absence: number | null;
    /** Consecutive ticks this trader has been in the TRAPPED state up to now. */
    trapAge: number;
    note: string;
};

export type CrowdMap = {
    positions: CrowdPosition[];
    /** The position the crowd is leaning on hardest (preferring trapped ones), or null if nobody is leaning. */
    lead: CrowdPosition | null;
    trapped: CrowdPosition[];
    headline: string;
};

const STATE_CODE: TrapState[] = ['QUIET', 'CHASING', 'WAVERING', 'TRAPPED'];
const CODE = { QUIET: 0, CHASING: 1, WAVERING: 2, TRAPPED: 3 } as const;

/** Per-tick series for one archetype. `trigger[i]` is true when the trader is TRAPPED using only ticks 0..i. */
export type TrapSeries = {
    archetype: ContractSide;
    state: Uint8Array;
    baitZ: Float32Array;
    deliveryZ: Float32Array;
    /** Matches: the due digit at each tick and how long it has been absent. */
    dueDigit: Int8Array | null;
    absence: Int16Array | null;
    /** The contract the trader holds when trapped, with a dynamic target where the digit varies per tick. */
    holds: Contract;
    opposite: Contract;
    trigger: Uint8Array;
};

const zOf = (sum: number, m: number, p: number) => (m > 0 ? (sum - m * p) / Math.sqrt(m * p * (1 - p)) : 0);

/** Contract and win indicator for a CHASE archetype. */
function chaseSpec(
    a: ContractSide,
    cfg: CrowdConfig
): { holds: Contract; p0: number; y: (d: readonly number[], i: number) => number } {
    switch (a) {
        case 'OVER': {
            const b = cfg.overBarrier;
            return {
                holds: { side: 'OVER', param: b },
                p0: (9 - b) / 10,
                y: (d, i) => (outcome('OVER', d[i], b) ? 1 : 0),
            };
        }
        case 'UNDER': {
            const b = cfg.underBarrier;
            return { holds: { side: 'UNDER', param: b }, p0: b / 10, y: (d, i) => (outcome('UNDER', d[i], b) ? 1 : 0) };
        }
        case 'EVEN':
            return { holds: { side: 'EVEN', param: 0 }, p0: 0.5, y: (d, i) => (d[i] % 2 === 0 ? 1 : 0) };
        case 'ODD':
            return { holds: { side: 'ODD', param: 0 }, p0: 0.5, y: (d, i) => (d[i] % 2 === 1 ? 1 : 0) };
        case 'DIFFERS':
            return {
                holds: { side: 'DIFFERS', param: 0, dynamic: true },
                p0: 0.9,
                y: (d, i) => (i === 0 || d[i] !== d[i - 1] ? 1 : 0),
            };
        default:
            throw new Error('Matches is a DUE trader');
    }
}

export function trapSeries(
    digits: readonly number[],
    archetype: ContractSide,
    cfg: CrowdConfig = DEFAULT_CROWD
): TrapSeries {
    const n = digits.length;
    const state = new Uint8Array(n),
        baitZ = new Float32Array(n),
        deliveryZ = new Float32Array(n),
        trigger = new Uint8Array(n);

    if (archetype === 'MATCHES') {
        const dueDigit = new Int8Array(n),
            absence = new Int16Array(n),
            last = Array(10).fill(-1) as number[];
        for (let i = 0; i < n; i++) {
            last[digits[i]] = i;
            let best = 0,
                bestAbs = -1;
            for (let d = 0; d < 10; d++) {
                const a = i - last[d];
                if (a > bestAbs) {
                    bestAbs = a;
                    best = d;
                }
            }
            dueDigit[i] = best;
            absence[i] = Math.min(bestAbs, 32767);
            // The first ticks of a history cannot tell "absent" from "not seen yet", so the series starts after the trap length.
            if (i < cfg.dueTrap) continue;
            const s = bestAbs >= cfg.dueTrap ? CODE.TRAPPED : bestAbs >= cfg.dueChase ? CODE.CHASING : CODE.QUIET;
            state[i] = s;
            trigger[i] = s === CODE.TRAPPED ? 1 : 0;
        }
        return {
            archetype,
            state,
            baitZ,
            deliveryZ,
            dueDigit,
            absence,
            trigger,
            holds: { side: 'MATCHES', param: 0, dynamic: true },
            opposite: { side: 'DIFFERS', param: 0, dynamic: true },
        };
    }

    const { holds, p0, y } = chaseSpec(archetype, cfg);
    const pre = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + y(digits, i);
    const B = cfg.baitTicks,
        D = cfg.deliveryTicks;
    for (let i = B + D - 1; i < n; i++) {
        const sDel = pre[i + 1] - pre[i + 1 - D],
            sBait = pre[i + 1 - D] - pre[i + 1 - D - B];
        const bz = zOf(sBait, B, p0),
            dz = zOf(sDel, D, p0);
        baitZ[i] = bz;
        deliveryZ[i] = dz;
        const s =
            bz < cfg.baitZ ? CODE.QUIET : dz <= cfg.deliveryZ ? CODE.TRAPPED : dz < 0 ? CODE.WAVERING : CODE.CHASING;
        state[i] = s;
        trigger[i] = s === CODE.TRAPPED ? 1 : 0;
    }
    return {
        archetype,
        state,
        baitZ,
        deliveryZ,
        dueDigit: null,
        absence: null,
        holds,
        opposite: complementOf(holds),
        trigger,
    };
}

const fmtZ = (z: number) => `${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`;

export function crowdMap(digits: readonly number[], cfg: CrowdConfig = DEFAULT_CROWD): CrowdMap {
    const n = digits.length,
        i = n - 1;
    const positions: CrowdPosition[] = ARCHETYPES.map(a => {
        const meta = ARCHETYPE_TEXT[a];
        const s = trapSeries(digits, a, cfg);
        if (n < cfg.baitTicks + cfg.deliveryTicks) {
            return {
                archetype: a,
                name: meta.name,
                behaviour: meta.behaviour,
                holds: s.holds,
                opposite: s.opposite,
                conviction: 0,
                state: 'QUIET' as TrapState,
                baitZ: null,
                deliveryZ: null,
                absence: null,
                trapAge: 0,
                note: `Needs ${cfg.baitTicks + cfg.deliveryTicks} ticks of history.`,
            };
        }
        const st = STATE_CODE[s.state[i]];
        let trapAge = 0;
        for (let k = i; k >= 0 && s.state[k] === CODE.TRAPPED; k--) trapAge++;

        if (a === 'MATCHES') {
            const d = s.dueDigit![i],
                abs = s.absence![i];
            const holds: Contract = { side: 'MATCHES', param: d };
            return {
                archetype: a,
                name: meta.name,
                behaviour: meta.behaviour,
                holds,
                opposite: complementOf(holds),
                conviction: Math.round(clamp((abs - 10) / 40) * 100),
                state: st,
                baitZ: null,
                deliveryZ: null,
                absence: abs,
                trapAge,
                note:
                    st === 'QUIET'
                        ? `Digit ${d} is the longest absent at ${abs} ticks; not yet "due" enough to pull people in.`
                        : st === 'CHASING'
                          ? `Digit ${d} has been absent ${abs} ticks: traders are leaning on it as "due".`
                          : `Digit ${d} has now been absent ${abs} ticks: Matches buyers keep waiting.`,
            };
        }
        const bz = s.baitZ[i],
            dz = s.deliveryZ[i];
        const holds = s.holds;
        const lab = contractLabel(holds);
        const note =
            st === 'QUIET'
                ? `${lab} has not been winning enough (${fmtZ(bz)} over the last ${cfg.baitTicks} ticks before the latest ${cfg.deliveryTicks}) to pull people in.`
                : st === 'CHASING'
                  ? `${lab} showed strength (${fmtZ(bz)}) and is still delivering (${fmtZ(dz)} over the last ${cfg.deliveryTicks}).`
                  : st === 'WAVERING'
                    ? `${lab} showed strength (${fmtZ(bz)}) but the last ${cfg.deliveryTicks} ticks softened (${fmtZ(dz)}).`
                    : `${lab} showed strength (${fmtZ(bz)}), then delivered the opposite (${fmtZ(dz)} over the last ${cfg.deliveryTicks} ticks).`;
        return {
            archetype: a,
            name: meta.name,
            behaviour: meta.behaviour,
            holds,
            opposite: s.opposite,
            conviction: Math.round(clamp(bz / 3) * 100),
            state: st,
            baitZ: bz,
            deliveryZ: dz,
            absence: null,
            trapAge,
            note,
        };
    });

    const leaning = positions.filter(p => p.state !== 'QUIET');
    const score = (p: CrowdPosition) => p.conviction + (p.state === 'TRAPPED' ? 25 : 0);
    const lead = leaning.length ? leaning.reduce((best, p) => (score(p) > score(best) ? p : best)) : null;
    const trapped = positions.filter(p => p.state === 'TRAPPED');
    const headline = !lead
        ? 'No clear crowd lean right now: nothing has been winning enough to pull traders in.'
        : lead.state === 'TRAPPED'
          ? `The crowd is trapped on ${contractLabel(lead.holds)}. Its exact opposite is ${contractLabel(lead.opposite)}.`
          : `The crowd is leaning on ${contractLabel(lead.holds)} (conviction ${lead.conviction}), and is ${lead.state === 'CHASING' ? 'still being rewarded' : 'starting to wobble'}.`;
    return { positions, lead, trapped, headline };
}
