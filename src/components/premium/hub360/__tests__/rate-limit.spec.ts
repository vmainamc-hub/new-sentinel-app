import {
    backoffDelayMs,
    isRateLimitError,
    planRateLimitRetry,
    rateLimitDelayMs,
    reconnectDelayMs,
} from '../rate-limit';

const noJitter = () => 0;
const rateLimited = (echo_req: Record<string, unknown>) => ({
    error: { code: 'RateLimit', message: 'You have reached the rate limit for proposal_open_contract.' },
    echo_req,
    msg_type: 'proposal_open_contract',
});

describe('isRateLimitError', () => {
    it('recognises the RateLimit code and the message', () => {
        expect(isRateLimitError(rateLimited({}))).toBe(true);
        expect(isRateLimitError({ error: { code: 'Other', message: 'You have reached the rate limit for buy.' } })).toBe(true);
    });

    it('ignores other errors and normal replies', () => {
        expect(isRateLimitError({ error: { code: 'InvalidContractProposal', message: 'Nope' } })).toBe(false);
        expect(isRateLimitError({ msg_type: 'tick' })).toBe(false);
        expect(isRateLimitError(null)).toBe(false);
    });
});

describe('backoff', () => {
    it('doubles and caps (no jitter)', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 40].map(n => reconnectDelayMs(n, noJitter))).toEqual([
            1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
        ]);
        expect([0, 1, 2, 3, 4].map(n => rateLimitDelayMs(n, noJitter))).toEqual([3000, 6000, 12000, 24000, 30000]);
    });

    it('adds at most 25% jitter', () => {
        expect(backoffDelayMs(2, { random: () => 1 })).toBe(5000);
        expect(backoffDelayMs(2, { random: () => 0.5 })).toBe(4500);
    });

    it('treats bad attempt numbers as the first attempt', () => {
        expect(reconnectDelayMs(-3, noJitter)).toBe(1000);
        expect(reconnectDelayMs(Number.NaN, noJitter)).toBe(1000);
    });
});

describe('planRateLimitRetry', () => {
    it('returns null for anything that is not a rate limit', () => {
        expect(planRateLimitRetry({ msg_type: 'buy' })).toBeNull();
    });

    it('re-requests the updates of a contract whose stream was refused (the stuck "Contract bought" case)', () => {
        const plan = planRateLimitRetry(rateLimited({ proposal_open_contract: 1, contract_id: 37289745799, subscribe: 1, req_id: 190 }), {
            isContractActive: id => id === '37289745799',
            random: noJitter,
        });
        expect(plan).toEqual({
            kind: 'resend_contract',
            delayMs: 3000,
            callName: 'proposal_open_contract',
            payload: { proposal_open_contract: 1, contract_id: 37289745799, subscribe: 1 },
        });
    });

    it('keeps a one-shot status check one-shot', () => {
        const plan = planRateLimitRetry(rateLimited({ proposal_open_contract: 1, contract_id: 5 }), {
            isContractActive: () => true,
            random: noJitter,
        });
        expect(plan?.payload).toEqual({ proposal_open_contract: 1, contract_id: 5 });
    });

    it('does not chase a contract that is no longer open', () => {
        const plan = planRateLimitRetry(rateLimited({ proposal_open_contract: 1, contract_id: 5, subscribe: 1 }), {
            isContractActive: () => false,
            random: noJitter,
        });
        expect(plan?.kind).toBe('wait');
        expect(plan?.payload).toBeUndefined();
    });

    it('starts a fresh cycle after a refused proposal or buy while running', () => {
        const proposal = planRateLimitRetry(rateLimited({ proposal: 1, amount: 1, req_id: 7 }), { isRunning: true, attempt: 1, random: noJitter });
        expect(proposal).toMatchObject({ kind: 'new_proposal', callName: 'proposal', delayMs: 6000 });
        const buy = planRateLimitRetry(rateLimited({ buy: 'abc', price: 1 }), { isRunning: true, random: noJitter });
        expect(buy).toMatchObject({ kind: 'new_proposal', callName: 'buy' });
    });

    it('only waits when the bot is not running or the call is something else', () => {
        expect(planRateLimitRetry(rateLimited({ buy: 'abc' }), { isRunning: false })?.kind).toBe('wait');
        expect(planRateLimitRetry(rateLimited({ ticks: 'R_50', subscribe: 1 }), { isRunning: true })).toMatchObject({
            kind: 'wait',
            callName: 'ticks',
        });
    });
});
