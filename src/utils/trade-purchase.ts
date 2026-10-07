import { api_base } from '@/external/bot-skeleton';

type TradeParameters = Record<string, any>;

export const normalizeTradeParameters = (parameters: TradeParameters) => ({
    amount: parameters.amount,
    basis: parameters.basis ?? 'stake',
    contract_type: parameters.contract_type,
    currency: parameters.currency ?? 'USD',
    duration: parameters.duration ?? 1,
    duration_unit: parameters.duration_unit ?? 't',
    symbol: parameters.symbol,
    ...(parameters.barrier != null ? { barrier: String(parameters.barrier) } : {}),
});

export const buyContractForUi = async ({
    parameters,
    price,
}: {
    parameters: TradeParameters;
    price: number;
    source?: string;
}) => {
    if (!api_base.api) throw new Error('Deriv connection is not ready yet.');

    const proposalResponse = await (api_base.api as any).send({
        proposal: 1,
        ...normalizeTradeParameters(parameters),
    });

    if (proposalResponse?.error) throw new Error(proposalResponse.error.message || 'Proposal request failed.');

    const proposalId = proposalResponse?.proposal?.id;
    if (!proposalId) throw new Error('No proposal id was returned for this contract.');

    const buyResponse = await (api_base.api as any).send({
        buy: proposalId,
        price,
    });

    if (buyResponse?.error) throw new Error(buyResponse.error.message || 'Contract purchase failed.');

    return {
        buy_price: Number(buyResponse?.buy?.buy_price ?? price),
        contract_id: Number(buyResponse?.buy?.contract_id),
        transaction_id: Number(buyResponse?.buy?.transaction_id ?? 0),
    };
};

export const streamContractUntilSettled = ({
    contractId,
    fallback,
    onUpdate,
    signal,
}: {
    contractId: number;
    fallback: Record<string, any>;
    onUpdate?: (contract: Record<string, any>) => void;
    signal?: AbortSignal;
    source?: string;
}) =>
    new Promise<Record<string, any>>(resolve => {
        if (!api_base.api || !contractId || signal?.aborted) {
            resolve(fallback);
            return;
        }

        let settled = false;
        let subscription: { unsubscribe?: () => void } | null = null;
        const finish = (contract: Record<string, any>) => {
            if (settled) return;
            settled = true;
            subscription?.unsubscribe?.();
            resolve(contract);
        };

        const timeout = window.setTimeout(() => finish(fallback), 60_000);
        const cleanupFinish = (contract: Record<string, any>) => {
            window.clearTimeout(timeout);
            finish(contract);
        };

        signal?.addEventListener('abort', () => cleanupFinish(fallback), { once: true });

        try {
            subscription = (api_base.api as any)
                .subscribe({ proposal_open_contract: 1, contract_id: contractId })
                .subscribe((data: any) => {
                    const contract = data?.proposal_open_contract;
                    if (!contract) return;
                    const snapshot = { ...fallback, ...contract };
                    onUpdate?.(snapshot);
                    if (contract.is_sold || contract.status !== 'open') cleanupFinish(snapshot);
                });
        } catch {
            cleanupFinish(fallback);
        }
    });
