// COMPLEMENTARY PRIORITY RULES for Over / Under "Find Market". They sit on top of the existing engine and only change the
// ORDER inside a tier: a market that passes ranks ahead of one that does not, but never over a better tier and never past a veto.
//
//   OVER   digit 0 (the opposite edge) above 10.1% and decreasing, digit 9 below 10%,
//          green bar (most frequent digit) even, red bar (least frequent digit) odd and never digit 1.
//   UNDER  digit 9 (the opposite edge) above 10.1% and decreasing, digit 0 below 10%,
//          green bar odd, red bar even and never digit 8.
//
// Bars use the same roles as Apex (digit-roles.ts): digits 2, 3, 6, 7 never hold a bar, so the next eligible digit takes it.
import { assignDigitRoles } from './apex/digit-roles';
import type { OuSide } from './legacy';

/** Ticks the shares are measured over (the same base window the Apex engines use). */
export const COMPLEMENTARY_WINDOW = 1000;
export const EDGE_MIN_PCT = 10.1;
export const OTHER_EDGE_MAX_PCT = 10;
const MIN_DIGITS = 200;

export type ComplementaryCheck = { name: string; ok: boolean; detail: string };
export type ComplementaryRead = { pass: boolean; passed: number; total: number; checks: ComplementaryCheck[] };

const shares = (digits: readonly number[]): number[] => {
    const c = Array(10).fill(0);
    for (const d of digits) if (d >= 0 && d <= 9) c[d] += 1;
    return c.map(n => (digits.length ? (n / digits.length) * 100 : 0));
};

export function readComplementary(allDigits: readonly number[], side: OuSide): ComplementaryRead | null {
    const digits = allDigits.slice(-COMPLEMENTARY_WINDOW);
    if (digits.length < MIN_DIGITS) return null;
    const pct = shares(digits);
    const edge = side === 'OVER' ? 0 : 9;
    const other = side === 'OVER' ? 9 : 0;
    // "Decreasing": the newer half of the window shows the edge digit less often than the older half.
    const half = Math.floor(digits.length / 2);
    const older = shares(digits.slice(0, half))[edge];
    const newer = shares(digits.slice(half))[edge];
    const roles = assignDigitRoles(pct, Array(10).fill(0));
    const green = roles.hot;
    const red = roles.cold;
    const f = (n: number) => n.toFixed(1);

    const checks: ComplementaryCheck[] = [
        { name: `digit ${edge} above ${EDGE_MIN_PCT}%`, ok: pct[edge] > EDGE_MIN_PCT, detail: `${f(pct[edge])}%` },
        { name: `digit ${edge} decreasing`, ok: newer < older, detail: `${f(older)}% then ${f(newer)}%` },
        { name: `digit ${other} below ${OTHER_EDGE_MAX_PCT}%`, ok: pct[other] < OTHER_EDGE_MAX_PCT, detail: `${f(pct[other])}%` },
        side === 'OVER'
            ? { name: 'green bar even', ok: green >= 0 && green % 2 === 0, detail: `digit ${green}` }
            : { name: 'green bar odd', ok: green >= 0 && green % 2 === 1, detail: `digit ${green}` },
        side === 'OVER'
            ? { name: 'red bar odd, not 1', ok: red >= 0 && red % 2 === 1 && red !== 1, detail: `digit ${red}` }
            : { name: 'red bar even, not 8', ok: red >= 0 && red % 2 === 0 && red !== 8, detail: `digit ${red}` },
    ];
    const passed = checks.filter(c => c.ok).length;
    return { pass: passed === checks.length, passed, total: checks.length, checks };
}
