import { classifyApiError, describeTradeFailure, TradeRequestError } from '@/utils/trade-errors';

describe('trade error classification', () => {
    it('treats InvalidContractProposal as a refused contract, not a session-ending error', () => {
        expect(classifyApiError('InvalidContractProposal', 'Unknown contract proposal')).toBe('rejected');
        const failure = describeTradeFailure({
            error: { code: 'InvalidContractProposal', message: 'Unknown contract proposal' },
        });
        expect(failure.kind).toBe('rejected');
        expect(failure.message).toBe('Unknown contract proposal (InvalidContractProposal)');
        expect(failure.outcomeUnknown).toBe(false);
    });

    it('recognises the already-formatted message from older callers', () => {
        expect(describeTradeFailure(new Error('Unknown contract proposal (InvalidContractProposal)')).kind).toBe(
            'rejected'
        );
    });

    it('treats account problems as fatal', () => {
        expect(describeTradeFailure({ error: { code: 'InsufficientBalance', message: 'Low funds' } }).kind).toBe(
            'fatal'
        );
        expect(describeTradeFailure(new Error('Please log in to your Deriv account')).kind).toBe('fatal');
    });

    it('treats unknown failures as transient', () => {
        expect(describeTradeFailure(new Error('socket closed')).kind).toBe('transient');
        expect(describeTradeFailure('boom').message).toBe('Contract purchase failed.');
    });

    it('keeps the outcome-unknown flag from a timed-out purchase', () => {
        const error = new TradeRequestError('timed out', { stage: 'buy', kind: 'timeout', outcomeUnknown: true });
        const failure = describeTradeFailure(error);
        expect(failure.kind).toBe('timeout');
        expect(failure.outcomeUnknown).toBe(true);
    });
});
