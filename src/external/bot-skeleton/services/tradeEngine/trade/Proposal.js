import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { api_base } from '../../api/api-base';
import { doUntilDone, tradeOptionToProposal } from '../utils/helpers';
import { clearProposals, proposalsReady } from './state/actions';

const normalizedApiError = value => value?.error || value || {};

export default Engine =>
    class Proposal extends Engine {
        makeProposals(trade_option) {
            if (!this.isNewTradeOption(trade_option)) {
                return;
            }

            // Generate a purchase reference when trade options are different from previous trade options.
            // This will ensure the bot doesn't mistakenly purchase the wrong proposal.
            this.regeneratePurchaseReference();
            this.trade_option = trade_option;
            this.proposal_templates = tradeOptionToProposal(trade_option, this.getPurchaseReference());
            this.renewProposalsOnPurchase();
        }

        selectProposal(contract_type) {
            const { proposals } = this.data;

            if (proposals.length === 0) {
                throw Error(getLocalizedErrorMessage('ProposalsNotReady'));
            }

            const to_buy = proposals.find(proposal => {
                if (
                    proposal.contract_type === contract_type &&
                    proposal.purchase_reference === this.getPurchaseReference()
                ) {
                    if (proposal.error) {
                        throw proposal.error;
                    }

                    return proposal;
                }

                return false;
            });

            if (!to_buy) {
                throw new Error(getLocalizedErrorMessage('SelectedProposalNotExist'));
            }

            return {
                id: to_buy.id,
                askPrice: to_buy.ask_price,
            };
        }

        renewProposalsOnPurchase() {
            this.data.proposals = [];
            this.store.dispatch(clearProposals());
            this.requestProposals();
        }

        requestProposals() {
            let has_informed_error = false;

            Promise.all(
                this.proposal_templates.map(proposal => {
                    doUntilDone(() => api_base.api.send(proposal)).catch(error => {
                        const apiError = normalizedApiError(error);
                        const code = apiError?.code || error?.code || '';

                        if (code === 'ContractBuyValidationError') {
                            const localizedError = new Error(getLocalizedErrorMessage(code, apiError));
                            localizedError.code = code;
                            localizedError.details = apiError?.details;
                            localizedError.message_to_client = apiError?.message_to_client;

                            this.data.proposals.push({
                                ...(apiError?.echo_req || error?.echo_req || {}),
                                ...(error?.echo_req?.passthrough || proposal?.passthrough || {}),
                                error: localizedError,
                            });

                            this.checkProposalReady();
                            return null;
                        }

                        if (!has_informed_error) {
                            has_informed_error = true;
                            const localizedErrorMessage = code
                                ? getLocalizedErrorMessage(code, apiError)
                                : apiError?.message || error?.message || getLocalizedErrorMessage('GeneralError');
                            const localizedError = new Error(localizedErrorMessage);
                            localizedError.code = code || 'ProposalError';
                            localizedError.details = apiError?.details;
                            this.$scope.observer.emit('Error', localizedError);
                        }
                        return null;
                    });
                })
            );
        }

        observeProposals() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(response => {
                if (response.data.msg_type === 'proposal') {
                    const { passthrough, proposal, error } = response.data;

                    if (error) {
                        const localizedError = new Error(getLocalizedErrorMessage(error.code, error));
                        localizedError.code = error.code;
                        localizedError.details = error.details;
                        localizedError.message_to_client = error.message_to_client;

                        this.data.proposals.push({
                            ...passthrough,
                            error: localizedError,
                        });
                        this.checkProposalReady();
                        return;
                    }

                    if (proposal && this.data.proposals.findIndex(p => p.id === proposal.id) === -1) {
                        this.data.proposals.push({ ...proposal, ...passthrough });
                        this.checkProposalReady();
                    }
                }
            });
            api_base.pushSubscription(subscription);
        }

        checkProposalReady() {
            const { proposals } = this.data;

            if (proposals.length > 0 && this.proposal_templates) {
                const has_equal_proposals = this.proposal_templates.every(template => {
                    return (
                        proposals.findIndex(proposal => {
                            return (
                                proposal.purchase_reference === template.passthrough.purchase_reference &&
                                proposal.contract_type === template.contract_type
                            );
                        }) !== -1
                    );
                });

                if (has_equal_proposals) {
                    this.startPromise.then(() => this.store.dispatch(proposalsReady()));
                }
            }
        }

        isNewTradeOption(trade_option) {
            if (!this.trade_option) {
                this.trade_option = trade_option;
                return true;
            }

            return [
                'amount',
                'barrierOffset',
                'basis',
                'duration',
                'duration_unit',
                'prediction',
                'secondBarrierOffset',
                'symbol',
            ].some(value => this.trade_option[value] !== trade_option[value]);
        }
    };
