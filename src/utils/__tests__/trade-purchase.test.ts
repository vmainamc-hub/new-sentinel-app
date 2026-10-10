import { api_base } from '@/external/bot-skeleton';
import { TradeRequestError } from '@/utils/trade-errors';
import { buyContractForUi } from '@/utils/trade-purchase';

jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: { send: jest.fn() } } }));

const send = () => (api_base as any).api.send as jest.Mock;
const params = { amount: 1, contract_type: 'DIGITUNDER', symbol: 'JD50', barrier: 8 };
const apiError = (code: string, message: string) => ({ error: { code, message } });

describe('buyContractForUi', () => {
    beforeEach(() => send().mockReset());

    it('requests a fresh proposal and buys it', async () => {
        send()
            .mockResolvedValueOnce({ proposal: { id: 'p1' } })
            .mockResolvedValueOnce({ buy: { buy_price: 1, contract_id: 7, transaction_id: 9 } });
        const result = await buyContractForUi({ parameters: params, price: 1 });
        expect(result.contract_id).toBe(7);
        expect(send().mock.calls[0][0].underlying_symbol).toBe('JD50');
        expect(send().mock.calls[1][0]).toEqual({ buy: 'p1', price: 1 });
    });

    it('reports a refused proposal as a rejection', async () => {
        send().mockRejectedValueOnce(apiError('InvalidContractProposal', 'Unknown contract proposal'));
        await expect(buyContractForUi({ parameters: params, price: 1 })).rejects.toMatchObject({
            kind: 'rejected',
            stage: 'proposal',
            code: 'InvalidContractProposal',
        });
        expect(send().mock.calls.length).toBe(1);
    });

    it('retries ONCE with a fresh proposal when Deriv explicitly rejects the buy as unknown', async () => {
        send()
            .mockResolvedValueOnce({ proposal: { id: 'p1' } })
            .mockRejectedValueOnce(apiError('InvalidContractProposal', 'Unknown contract proposal'))
            .mockResolvedValueOnce({ proposal: { id: 'p2' } })
            .mockResolvedValueOnce({ buy: { buy_price: 1, contract_id: 8, transaction_id: 10 } });
        const result = await buyContractForUi({ parameters: params, price: 1 });
        expect(result.contract_id).toBe(8);
        expect(send().mock.calls[3][0].buy).toBe('p2');
    });

    it('treats a buy that dies without a Deriv error code as outcome unknown and never retries it', async () => {
        send()
            .mockResolvedValueOnce({ proposal: { id: 'p1' } })
            .mockRejectedValueOnce(new Error('WebSocket closed'));
        await expect(buyContractForUi({ parameters: params, price: 1 })).rejects.toMatchObject({
            stage: 'buy',
            outcomeUnknown: true,
        });
        expect(send().mock.calls.length).toBe(2);
    });

    it('does not mark a proposal-stage network failure as unknown (nothing was bought)', async () => {
        send().mockRejectedValueOnce(new Error('socket closed'));
        await expect(buyContractForUi({ parameters: params, price: 1 })).rejects.toMatchObject({
            stage: 'proposal',
            kind: 'transient',
            outcomeUnknown: false,
        });
    });

    it('never retries a buy that timed out: the contract may exist', async () => {
        jest.useFakeTimers();
        send()
            .mockResolvedValueOnce({ proposal: { id: 'p1' } })
            .mockImplementationOnce(() => new Promise(() => undefined));
        const pending = buyContractForUi({ parameters: params, price: 1 });
        const assertion = expect(pending).rejects.toMatchObject({
            kind: 'timeout',
            stage: 'buy',
            outcomeUnknown: true,
        });
        await jest.advanceTimersByTimeAsync(16_000);
        await assertion;
        expect(send().mock.calls.length).toBe(2);
        expect(await pending.catch(e => e)).toBeInstanceOf(TradeRequestError);
        jest.useRealTimers();
    });
});
