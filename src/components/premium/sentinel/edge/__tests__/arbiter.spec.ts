import type { BoardRow } from '../../overlay';
import type { PulseTier } from '../../pulse';
import { ABSTAIN_MARGIN, Arbiter, type Candidate, secondOpinion, strengthOf, SWITCH_MARGIN } from '../arbiter';

const row = (
    symbol: string,
    contract: 'DIGITOVER' | 'DIGITUNDER',
    barrier: number,
    tier: PulseTier,
    score = 60
): BoardRow => ({
    key: `${symbol}|${contract}|${barrier}`,
    symbol,
    contract,
    barrier,
    label: `${contract === 'DIGITOVER' ? 'Over' : 'Under'} ${barrier}`,
    tier,
    score,
    agree: 4,
});
const cand = (r: BoardRow, healthLift = 0, second: Candidate['second'] = 'none'): Candidate => ({
    row: r,
    healthLift,
    second,
});

describe('strengthOf', () => {
    it('orders by tier, then score, then health, with the second source moving it', () => {
        expect(strengthOf(cand(row('A', 'DIGITOVER', 2, 'strong')))).toBeGreaterThan(
            strengthOf(cand(row('A', 'DIGITOVER', 2, 'steady')))
        );
        expect(strengthOf(cand(row('A', 'DIGITOVER', 2, 'steady', 80)))).toBeGreaterThan(
            strengthOf(cand(row('A', 'DIGITOVER', 2, 'steady', 50)))
        );
        const r = row('A', 'DIGITOVER', 2, 'steady');
        expect(strengthOf(cand(r, 0, 'agree'))).toBeGreaterThan(strengthOf(cand(r, 0, 'none')));
        expect(strengthOf(cand(r, 0, 'conflict'))).toBeLessThan(strengthOf(cand(r, 0, 'none')));
        expect(strengthOf(cand(r, 3))).toBeGreaterThan(strengthOf(cand(r, 0)));
    });
});

describe('Arbiter', () => {
    it('gives each market exactly one pick and stands the rest of that market down', () => {
        const a = new Arbiter();
        const v = a.decide([
            cand(row('A', 'DIGITOVER', 1, 'watch')),
            cand(row('A', 'DIGITOVER', 2, 'strong', 80)),
            cand(row('A', 'DIGITOVER', 3, 'steady')),
            cand(row('B', 'DIGITUNDER', 7, 'steady')),
        ]);
        const roles = (k: string) => v.get(k)?.role;
        expect(roles('A|DIGITOVER|2')).toBe('pick');
        expect(roles('A|DIGITOVER|1')).toBe('beaten');
        expect(roles('A|DIGITOVER|3')).toBe('beaten');
        expect(roles('B|DIGITUNDER|7')).toBe('pick');
        expect(v.get('A|DIGITOVER|1')?.note).toMatch(/Over 2 is the pick on A/);
    });

    it('abstains on a market where the best Over and the best Under are about equally strong', () => {
        const a = new Arbiter();
        const v = a.decide([
            cand(row('A', 'DIGITOVER', 2, 'steady', 60)),
            cand(row('A', 'DIGITUNDER', 7, 'steady', 60)),
        ]);
        expect([...v.values()].every(x => x.role === 'abstain')).toBe(true);
        expect([...v.values()][0].note).toMatch(/contradict/);
    });

    it('lets a clearly stronger side win instead of abstaining', () => {
        const a = new Arbiter();
        const v = a.decide([
            cand(row('A', 'DIGITOVER', 2, 'strong', 90)),
            cand(row('A', 'DIGITUNDER', 7, 'watch', 50)),
        ]);
        expect(v.get('A|DIGITOVER|2')?.role).toBe('pick');
        expect(v.get('A|DIGITUNDER|7')?.role).toBe('beaten');
    });

    it('abstains only across sides: two Overs of similar strength still produce one pick', () => {
        const a = new Arbiter();
        const v = a.decide([
            cand(row('A', 'DIGITOVER', 2, 'steady', 60)),
            cand(row('A', 'DIGITOVER', 3, 'steady', 60)),
        ]);
        expect([...v.values()].filter(x => x.role === 'pick')).toHaveLength(1);
        expect([...v.values()].some(x => x.role === 'abstain')).toBe(false);
    });

    it('keeps the incumbent against a challenger that is only slightly stronger, and switches for a clearly stronger one', () => {
        const a = new Arbiter();
        const incumbent = row('A', 'DIGITOVER', 2, 'steady', 60);
        a.decide([cand(incumbent), cand(row('A', 'DIGITOVER', 3, 'steady', 50))]);
        const close = row('A', 'DIGITOVER', 3, 'steady', 60 + SWITCH_MARGIN); // 0.5 x score: only half a point per score point
        expect(a.decide([cand(incumbent), cand(close)]).get(incumbent.key)?.role).toBe('pick');
        const clear = row('A', 'DIGITOVER', 3, 'strong', 90);
        const v = a.decide([cand(incumbent), cand(clear)]);
        expect(v.get(clear.key)?.role).toBe('pick');
        expect(v.get(incumbent.key)?.role).toBe('beaten');
    });

    it('forgets a pick that left the board', () => {
        const a = new Arbiter();
        const first = row('A', 'DIGITOVER', 2, 'steady', 60);
        a.decide([cand(first)]);
        const v = a.decide([cand(row('A', 'DIGITOVER', 3, 'steady', 62))]);
        expect(v.get('A|DIGITOVER|3')?.role).toBe('pick');
    });

    it('is independent across markets', () => {
        const a = new Arbiter();
        const v = a.decide([
            cand(row('A', 'DIGITOVER', 2, 'steady', 60)),
            cand(row('A', 'DIGITUNDER', 7, 'steady', 60)),
            cand(row('B', 'DIGITOVER', 2, 'steady', 60)),
        ]);
        expect(v.get('A|DIGITOVER|2')?.role).toBe('abstain');
        expect(v.get('B|DIGITOVER|2')?.role).toBe('pick');
        expect(ABSTAIN_MARGIN).toBeGreaterThan(0);
    });
});

describe('secondOpinion', () => {
    const r = row('A', 'DIGITOVER', 2, 'steady');
    it('agrees when the other source lists the same contract', () => {
        expect(secondOpinion(r, [row('A', 'DIGITOVER', 2, 'watch')])).toBe('agree');
    });
    it('conflicts when the other source lists only the opposite side on that market', () => {
        expect(secondOpinion(r, [row('A', 'DIGITUNDER', 7, 'strong')])).toBe('conflict');
    });
    it('is silent when the other source has nothing on the market, lists another contract on the same side, or is off', () => {
        expect(secondOpinion(r, [row('B', 'DIGITUNDER', 7, 'strong')])).toBe('none');
        expect(secondOpinion(r, [row('A', 'DIGITOVER', 3, 'strong')])).toBe('none');
        expect(secondOpinion(r, null)).toBe('none');
    });
});
