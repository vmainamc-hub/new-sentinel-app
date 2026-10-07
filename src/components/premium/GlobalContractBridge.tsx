import { useEffect } from 'react';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

const unwrapMessage = (event: any) => event?.data && typeof event.data === 'object' ? event.data : event || {};

const normalizeContract = (contract: any) => {
    if (!contract || !contract.contract_id) return contract;
    const exitTime = contract.exit_tick_time ?? contract.exit_spot_time;
    const entryTime = contract.entry_tick_time ?? contract.entry_spot_time;
    const currentStatus = String(contract.status || '').toLowerCase();
    const hasFinalProfit = contract.profit !== undefined && contract.profit !== null && contract.profit !== '';
    const terminal = PremiumDerivApiService.isContractClosed(contract);
    let status = contract.status;

    // Some current Options responses can carry the final exit/profit fields
    // before legacy DBot's status helpers recognise the contract as complete.
    // Normalise those fields so the native TransactionsStore marks the row
    // completed instead of leaving a settled one-tick trade looking open.
    if (terminal && (!currentStatus || currentStatus === 'open')) {
        const profit = Number(contract.profit || 0);
        status = profit > 0 ? 'won' : 'lost';
    }

    return {
        ...contract,
        status,
        exit_tick_time: exitTime,
        entry_tick_time: entryTime,
        exit_tick: contract.exit_tick ?? contract.exit_spot,
        is_expired: contract.is_expired || (terminal && hasFinalProfit ? 1 : 0),
    };
};

/**
 * Keeps the native DBot transaction store in sync with the authenticated
 * Deriv account, regardless of which premium tool placed the trade.
 */
const GlobalContractBridge = () => {
    const { activeLoginid, connectionStatus } = useApiBase();
    const store = useStore();
    const client = store?.client;
    const transactions = store?.transactions;
    const loginid = client?.loginid || activeLoginid || '';

    useEffect(() => {
        if (!transactions || !loginid || !api_base.api) return;

        let cancelled = false;
        const api = api_base.api;

        const pushContract = (rawContract: any) => {
            if (cancelled || !rawContract?.contract_id) return;
            const contract = normalizeContract(rawContract);
            try {
                transactions.onBotContractEvent(contract);
            } catch (error) {
                console.error('[ContractBridge] Failed to update Run Panel contract:', error);
            }
        };

        const observer = api.onMessage()?.subscribe((event: any) => {
            const message = unwrapMessage(event);
            if (message?.error) {
                if (message.msg_type === 'proposal_open_contract') {
                    console.warn('[ContractBridge] proposal_open_contract stream error:', message.error?.message || message.error?.code || message.error);
                }
                return;
            }
            if (message?.msg_type === 'proposal_open_contract') pushContract(message.proposal_open_contract);
        });

        // PremiumDerivApiService attaches a dedicated contract-id subscription
        // immediately after every premium buy. Listen to that channel too so
        // the final settled update cannot be missed by the broad account stream.
        const disposePremiumUpdates = PremiumDerivApiService.onContractUpdate(pushContract);

        // Recover contracts that were already open before this listener mounted,
        // then attach a dedicated settlement stream to each recovered position.
        void PremiumDerivApiService.portfolio()
            .then(async portfolio => {
                const contracts = Array.isArray(portfolio?.contracts) ? portfolio.contracts : [];
                await Promise.allSettled(contracts.map(async (position: any) => {
                    const contractId = Number(position?.contract_id);
                    if (!Number.isFinite(contractId) || !contractId) return;
                    const response = await PremiumDerivApiService.request({ proposal_open_contract: 1, contract_id: contractId });
                    pushContract(response?.proposal_open_contract);
                    await PremiumDerivApiService.trackContract(contractId);
                }));
            })
            .catch(error => {
                if (!cancelled) console.warn('[ContractBridge] Could not recover open contracts:', error instanceof Error ? error.message : error);
            });

        return () => {
            cancelled = true;
            observer?.unsubscribe?.();
            disposePremiumUpdates();
        };
    }, [connectionStatus, loginid, transactions]);

    return null;
};

export default GlobalContractBridge;
