import { api_base } from '@/external/bot-skeleton';

import { classifyApiError, TradeRequestError, type TradeStage } from './trade-errors';

type TradeParameters = Record<string, any>;

export const normalizeTradeParameters = (parameters: TradeParameters) => ({
    amount: parameters.amount,
    basis: parameters.basis ?? 'stake',
    contract_type: parameters.contract_type,
    currency: parameters.currency ?? 'USD',
    duration: parameters.duration ?? 1,
    duration_unit: parameters.duration_unit ?? 't',
    // Deriv's API now rejects `symbol` ("Properties not allowed: symbol"); it expects `underlying_symbol`.
    underlying_symbol: parameters.underlying_symbol ?? parameters.symbol,
    ...(parameters.barrier != null ? { barrier: String(parameters.barrier) } : {}),
});

/**
 * Deriv's API client rejects with the raw response object ({ error: { code, message } }),
 * not an Error instance, so `err instanceof Error` checks lose the real reason.
 */
export const getErrorMessage = (err: unknown, fallback: string): string => {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    const candidate = err as { error?: { message?: string; code?: string }; message?: string } | null;
    const message = candidate?.error?.message ?? candidate?.message;
    if (message) return candidate?.error?.code ? `${message} (${candidate.error.code})` : String(message);
    return fallback;
};

/** A request that gets no answer must not leave the UI (or a trading session) waiting forever. */
export const TRADE_REQUEST_TIMEOUT_MS = 15_000;

const sendRequest = async (request: Record<string, any>, stage: TradeStage, timeoutMs = TRADE_REQUEST_TIMEOUT_MS) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const sentBuy = stage === 'buy';
            reject(
                new TradeRequestError(
                    sentBuy
                        ? 'Purchase request timed out. The result is unknown: check your Deriv statement before trading again.'
                        : `Deriv did not answer the ${stage} request in time.`,
                    { stage, kind: 'timeout', outcomeUnknown: sentBuy }
                )
            );
        }, timeoutMs);
    });
    try {
        return await Promise.race([(api_base.api as any).send(request), timeout]);
    } catch (err) {
        if (err instanceof TradeRequestError) throw err;
        const candidate = err as { error?: { code?: string }; code?: string } | null;
        const code = candidate?.error?.code ?? candidate?.code;
        const message = getErrorMessage(err, 'Deriv request failed.');
        // A buy that fails WITHOUT a Deriv error code (socket dropped, connection lost) was sent but never answered, so
        // the contract may exist. Only an explicit Deriv error response proves nothing was bought.
        if (stage === 'buy' && !code) {
            throw new TradeRequestError(
                `${message} The purchase result is unknown: check your Deriv statement before trading again.`,
                { stage, kind: 'timeout', outcomeUnknown: true }
            );
        }
        throw new TradeRequestError(message, { stage, kind: classifyApiError(code, message), code });
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const raiseIfError = (response: any, stage: TradeStage, fallback: string) => {
    if (!response?.error) return;
    const code: string | undefined = response.error.code;
    const message = response.error.message || fallback;
    const text = code && !message.includes(code) ? `${message} (${code})` : message;
    throw new TradeRequestError(text, { stage, kind: classifyApiError(code, text), code });
};

/**
 * Proposal -> buy. A fresh proposal is requested for every purchase and bought immediately, so a quote can never go
 * stale while the caller waits for an entry point.
 *
 * Retry rule: if Deriv EXPLICITLY answers the buy with "unknown / expired proposal" the contract was not bought, so one
 * retry with a fresh proposal is safe. A buy that times out is never retried (it may have been bought).
 */
export const buyContractForUi = async ({
    parameters,
    price,
}: {
    parameters: TradeParameters;
    price: number;
    source?: string;
}) => {
    if (!api_base.api) {
        throw new TradeRequestError('Deriv connection is not ready yet.', { stage: 'request', kind: 'transient' });
    }

    const attempt = async () => {
        const proposalResponse = await sendRequest(
            { proposal: 1, ...normalizeTradeParameters(parameters) },
            'proposal'
        );
        raiseIfError(proposalResponse, 'proposal', 'Proposal request failed.');

        const proposalId = proposalResponse?.proposal?.id;
        if (!proposalId) {
            throw new TradeRequestError('No proposal id was returned for this contract.', {
                stage: 'proposal',
                kind: 'rejected',
            });
        }

        const response = await sendRequest({ buy: proposalId, price }, 'buy');
        raiseIfError(response, 'buy', 'Contract purchase failed.');
        return response;
    };

    let buyResponse: any;
    try {
        buyResponse = await attempt();
    } catch (error) {
        const retriable =
            error instanceof TradeRequestError &&
            error.stage === 'buy' &&
            error.kind === 'rejected' &&
            !error.outcomeUnknown &&
            (error.code === 'InvalidContractProposal' || error.code === 'ProposalExpired');
        if (!retriable) throw error;
        buyResponse = await attempt();
    }

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
