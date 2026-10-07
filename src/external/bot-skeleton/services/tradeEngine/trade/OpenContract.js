import { getRoundedNumber } from '@/components/shared';
import { api_base } from '../../api/api-base';
import { contract as broadcastContract, contractStatus } from '../utils/broadcast';
import { openContractReceived, sell } from './state/actions';

const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'expired', 'cancelled', 'canceled', 'closed']);

const unwrap = response => (response?.data && typeof response.data === 'object' ? response.data : response || {});

export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data?.msg_type === 'proposal_open_contract') {
                    this.handleOpenContract(data.proposal_open_contract);
                }
            });
            api_base.pushSubscription(subscription);
        }

        handleOpenContract(contract) {
            if (!contract || !this.expectedContractId(contract?.contract_id)) return;

            this.last_open_contract_update = Date.now();
            this.setContractFlags(contract);
            this.data.contract = contract;

            broadcastContract({ accountID: api_base.account_info.loginid, ...contract });

            if (this.isSold) {
                const settledContractId = this.contractId;
                this.contractId = '';
                clearTimeout(this.transaction_recovery_timeout);
                clearTimeout(this.open_contract_recovery_timeout);
                this.forgetOpenContractSubscription();
                this.updateTotals(contract);
                contractStatus({
                    id: 'contract.sold',
                    data: contract.transaction_ids?.sell ?? contract.contract_id,
                    contract,
                });

                if (this.afterPromise) {
                    const resolveAfter = this.afterPromise;
                    this.afterPromise = null;
                    resolveAfter();
                }

                this.store.dispatch(sell());
                console.info('[DBot] Contract settled', settledContractId, contract.status, contract.profit);
            } else {
                this.store.dispatch(openContractReceived());
            }
        }

        subscribeOpenContract(contractId) {
            if (!api_base.api || !contractId) return;

            const id = Number(contractId);
            if (!Number.isFinite(id) || !id) return;

            this.forgetOpenContractSubscription();
            clearTimeout(this.open_contract_recovery_timeout);
            this.last_open_contract_update = Date.now();

            Promise.resolve(
                api_base.api.send({
                    proposal_open_contract: 1,
                    contract_id: id,
                    subscribe: 1,
                })
            )
                .then(response => {
                    const data = unwrap(response);
                    if (data?.error) {
                        throw new Error(data.error.message || data.error.code || 'Unable to subscribe to contract updates.');
                    }

                    this.open_contract_subscription_id = data?.subscription?.id || '';
                    if (data?.proposal_open_contract) this.handleOpenContract(data.proposal_open_contract);
                    this.scheduleOpenContractRecovery(id);
                })
                .catch(error => {
                    console.warn('[DBot] Contract stream subscription failed; using recovery polling:', error?.message || error);
                    this.scheduleOpenContractRecovery(id, 250);
                });
        }

        scheduleOpenContractRecovery(contractId, delay = 2200) {
            clearTimeout(this.open_contract_recovery_timeout);
            this.open_contract_recovery_timeout = setTimeout(() => {
                if (!api_base.api || !this.expectedContractId(contractId)) return;

                const quietFor = Date.now() - Number(this.last_open_contract_update || 0);
                if (quietFor < 1800) {
                    this.scheduleOpenContractRecovery(contractId, 1800);
                    return;
                }

                Promise.resolve(api_base.api.send({ proposal_open_contract: 1, contract_id: Number(contractId) }))
                    .then(response => {
                        const data = unwrap(response);
                        if (data?.proposal_open_contract) this.handleOpenContract(data.proposal_open_contract);
                    })
                    .catch(error => {
                        console.warn('[DBot] Contract recovery request failed:', error?.message || error);
                    })
                    .finally(() => {
                        if (this.expectedContractId(contractId)) this.scheduleOpenContractRecovery(contractId, 2200);
                    });
            }, delay);
        }

        forgetOpenContractSubscription() {
            const subscriptionId = this.open_contract_subscription_id;
            this.open_contract_subscription_id = '';
            if (!subscriptionId || !api_base.api) return;

            void Promise.resolve(api_base.api.send({ forget: subscriptionId })).catch(error => {
                console.warn('[DBot] Failed to forget contract subscription:', error?.message || error);
            });
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick, entry_spot } = contract;
            const status = String(contract.status || '').toLowerCase();
            const hasFinalProfit = contract.profit !== undefined && contract.profit !== null && contract.profit !== '';

            // `is_settleable` means the position can be settled, not that it has
            // already settled. Likewise, an expiry flag can arrive before the final
            // P/L update. After Purchase must run only after final outcome data exists.
            const terminal =
                Boolean(is_sold) ||
                TERMINAL_STATUSES.has(status) ||
                (Boolean(is_expired) && hasFinalProfit);

            this.isSold = terminal;
            this.isSellAvailable = !terminal && Boolean(is_valid_to_sell);
            this.isExpired = (Boolean(is_expired) && hasFinalProfit) || status === 'expired';
            this.hasEntryTick = Boolean(entry_tick ?? entry_spot);
        }

        expectedContractId(contractId) {
            return Boolean(this.contractId) && Number(contractId) === Number(this.contractId);
        }

        getSellPrice() {
            const { bid_price: bidPrice, buy_price: buyPrice, currency } = this.data.contract;
            return getRoundedNumber(Number(bidPrice) - Number(buyPrice), currency);
        }
    };
