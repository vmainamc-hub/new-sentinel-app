// Serializable entry rules for generated strategies (so they can be stored, versioned and replayed).
// A rule fires on the current tick when (a) the current digit is in `digits` and (b) the `k` ticks BEFORE it satisfy `prev`
// for the contract being traded: ALL_WIN = each would have won, ALL_LOSE = each would have lost, ANY = no condition.
// It only ever reads ticks up to and including the current one, so it cannot use future data.
import { type Contract, winningDigits } from '@/components/premium/sixfold/bot';
import type { PickDirection } from './picker';

export type PrevKind = 'ANY' | 'ALL_WIN' | 'ALL_LOSE';
export type RuleSpec = { digits: number[]; prev: { kind: PrevKind; k: number } };

export const normalizeRule = (r: RuleSpec): RuleSpec => ({
    digits: [...new Set(r.digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9))].sort((a, b) => a - b),
    prev: r.prev.kind === 'ANY' ? { kind: 'ANY', k: 0 } : { kind: r.prev.kind, k: Math.max(1, Math.min(5, Math.trunc(r.prev.k) || 1)) },
});

export const ruleKey = (r: RuleSpec): string => {
    const n = normalizeRule(r);
    return `${n.digits.join('')}|${n.prev.kind}${n.prev.k}`;
};

export function compileRule(rule: RuleSpec, contract: Contract): (history: readonly number[]) => boolean {
    const r = normalizeRule(rule);
    const set = new Set(r.digits);
    const win = new Set(winningDigits(contract));
    const { kind, k } = r.prev;
    return h => {
        const n = h.length;
        if (n < k + 1 || !set.has(h[n - 1])) return false;
        for (let i = 1; i <= k; i++) {
            const w = win.has(h[n - 1 - i]);
            if (kind === 'ALL_WIN' && !w) return false;
            if (kind === 'ALL_LOSE' && w) return false;
        }
        return true;
    };
}

export function describeRule(rule: RuleSpec, direction: PickDirection): string {
    const r = normalizeRule(rule);
    const side = direction === 'UNDER_7' ? 'Under 7' : 'Over 2';
    const prev = r.prev.kind === 'ANY' ? '' : ` after ${r.prev.k} ${r.prev.kind === 'ALL_WIN' ? 'winning' : 'losing'} digit${r.prev.k > 1 ? 's' : ''}`;
    return `${side}: enter when digit is ${r.digits.join(' or ')}${prev}`;
}
