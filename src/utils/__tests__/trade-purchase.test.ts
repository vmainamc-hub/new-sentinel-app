import { api_base } from '@/external/bot-skeleton';
import { TradeRequestError } from '@/utils/trade-errors';
import { buyContractForUi } from '@/utils/trade-purchase';

jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: { send: jest.fn() } } }));

const send = () => (api_base as any).api.send as jest.Mock;
const params = { amount: 1, contract_type: 'DIGITUNDER', symbol: 'JD50', barrier: 8 };
const apiError = (code: string, message: string) => ({ error: { code, message } });

describe('buyContractForUi', () => {
    beforeEach(() => send().mockReset());

    it('buys directly from parameters without requesting a proposal id', async () => {
        send().mockResolvedValueOnce({ buy: { buy_price: 1, contract_id: 7, transaction_id: 9 } });
        const result = await buyContractForUi({ parameters: params, price: 1 });
        expect(result.contract_id).toBe(7);
        expect(send().mock.calls).toHaveLength(1);
        expect(send().mock.calls[0][0]).toEqual({
            buy: '1',
            price: 1,
            parameters: {
                amount: 1,
                basis: 'stake',
                contract_type: 'DIGITUNDER',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                underlying_symbol: 'JD50',
                barrier: '8',
            },
        });
    });

    it('allows identical contracts to be purchased independently', async () => {
        send()
            .mockResolvedValueOnce({ buy: { buy_price: 1, contract_id: 7, transaction_id: 9 } })
            .mockResolvedValueOnce({ buy: { buy_price: 1, contract_id: 8, transaction_id: 10 } });
        const first = await buyContractForUi({ parameters: params, price: 1 });
        const second = await buyContractForUi({ parameters: params, price: 1 });
        expect([first.contract_id, second.contract_id]).toEqual([7, 8]);
        expect(send().mock.calls.every(call => call[0].buy === '1')).toBe(true);
    });

    it('reports an explicitly refused buy without retrying it', async () => {
        send().mockRejectedValueOnce(apiError('InvalidContractProposal', 'Unknown contract proposal'));
        await expect(buyContractForUi({ parameters: params, price: 1 })).rejects.toMatchObject({
            kind: 'rejected',
            stage: 'buy',
            code: 'InvalidContractProposal',
            outcomeUnknown: false,
        });
        expect(send().mock.calls).toHaveLength(1);
    });

    it('treats a buy that dies without a Deriv error code as outcome unknown and never retries it', async () => {
        send().mockRejectedValueOnce(new Error('WebSocket closed'));
        await expect(buyContractForUi({ parameters: params, price: 1 })).rejects.toMatchObject({
            stage: 'buy',
            outcomeUnknown: true,
        });
        expect(send().mock.calls.length).toBe(1);
    });

    it('does not mark a connection-not-ready failure as unknown (nothing was sent)', async () => {
        const saved = (api_base as any).api;
        (api_base as any).api = null;
        try {
            await expect(buyContractForUi({ parameters: params, price: 1 })).rejects.toMatchObject({
                stage: 'request',
                kind: 'transient',
                outcomeUnknown: false,
            });
        } finally {
            (api_base as any).api = saved;
        }
    });

    it('never retries a buy that timed out: the contract may exist', async () => {
        jest.useFakeTimers();
        send().mockImplementationOnce(() => new Promise(() => undefined));
        const pending = buyContractForUi({ parameters: params, price: 1 });
        const assertion = expect(pending).rejects.toMatchObject({
            kind: 'timeout',
            stage: 'buy',
            outcomeUnknown: true,
        });
        await jest.advanceTimersByTimeAsync(16_000);
        await assertion;
        expect(send().mock.calls.length).toBe(1);
        expect(await pending.catch(e => e)).toBeInstanceOf(TradeRequestError);
        jest.useRealTimers();
    });
});
