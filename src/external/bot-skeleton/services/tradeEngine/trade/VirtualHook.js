import { api_base } from '../../api/api-base';
import { contractStatus, notify } from '../utils/broadcast';
import { purchaseSuccessful } from './state/actions';

// Virtual Hook: mirrors qualified trades with zero financial stake.
// A virtual trade is settled on real ticks and is fed through the normal contract-result path,
// so "Result is Win/Loss" and "Profit" blocks keep working, but no money is staked and the
// run totals are not changed.
const SUPPORTED = new Set(['DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT']);
const VIRTUAL_ID_BASE = 9_000_000_000_000;
let virtual_counter = 0;

const lastDigit = (quote, pip) => Number(Number(quote).toFixed(Math.max(0, Number(pip) || 2)).slice(-1));

const winProbability = (type, barrier) => {
    const b = Number(barrier);
    switch (type) {
        case 'DIGITOVER': return Math.max(0.1, (9 - b) / 10);
        case 'DIGITUNDER': return Math.max(0.1, b / 10);
        case 'DIGITMATCH': return 0.1;
        case 'DIGITDIFF': return 0.9;
        default: return 0.5;
    }
};

const hasWon = (type, barrier, entry, exit, digit) => {
    const b = Number(barrier);
    switch (type) {
        case 'DIGITOVER': return digit > b;
        case 'DIGITUNDER': return digit < b;
        case 'DIGITEVEN': return digit % 2 === 0;
        case 'DIGITODD': return digit % 2 === 1;
        case 'DIGITMATCH': return digit === b;
        case 'DIGITDIFF': return digit !== b;
        case 'CALL': return exit > entry;
        default: return exit < entry;
    }
};

export default Engine =>
    class VirtualHook extends Engine {
        get vh() {
            if (!this._vh) {
                this._vh = {
                    enabled: false,
                    mode: 'streak', // 'streak' or 'fixed'
                    virtualNow: false,
                    enterAfterLosses: 2,
                    returnAfterWins: 1,
                    fixedCount: 3,
                    realLosses: 0,
                    virtualWins: 0,
                    fixedDone: 0,
                    subscription: null,
                };
            }
            return this._vh;
        }

        setVirtualHook(settings = {}) {
            const s = this.vh;
            const int = (value, fallback, min) => {
                const n = Math.trunc(Number(value));
                return Number.isFinite(n) ? Math.max(min, n) : fallback;
            };
            s.enabled = Boolean(settings.enabled);
            s.mode = settings.mode === 'fixed' ? 'fixed' : 'streak';
            s.enterAfterLosses = int(settings.enterAfterLosses, s.enterAfterLosses, 1);
            s.returnAfterWins = int(settings.returnAfterWins, s.returnAfterWins, 1);
            s.fixedCount = int(settings.fixedCount, s.fixedCount, 1);
            s.realLosses = 0;
            s.virtualWins = 0;
            s.fixedDone = 0;
            s.virtualNow = s.enabled && Boolean(settings.startVirtual);
        }

        vhIsVirtualNext() {
            return this.vh.enabled && this.vh.virtualNow;
        }

        // Called for every settled contract (real and virtual).
        vhOnSettled(contract) {
            const s = this.vh;
            if (!s.enabled) return;
            const status = String(contract?.status || '').toLowerCase();
            const won = status === 'won' || (status !== 'lost' && Number(contract?.profit) > 0);
            const was_virtual = Boolean(contract?.is_virtual_hook);

            if (!was_virtual) {
                if (won) {
                    s.realLosses = 0;
                } else {
                    s.realLosses += 1;
                    if (s.realLosses >= s.enterAfterLosses) {
                        s.virtualNow = true;
                        s.virtualWins = 0;
                        s.fixedDone = 0;
                        notify('info', `Virtual Hook: entering virtual mode after ${s.realLosses} real loss(es).`);
                    }
                }
                return;
            }

            if (s.mode === 'fixed') {
                s.fixedDone += 1;
                if (s.fixedDone >= s.fixedCount) {
                    s.virtualNow = false;
                    s.realLosses = 0;
                    notify('info', `Virtual Hook: ${s.fixedCount} virtual trade(s) done, returning to real trading.`);
                }
                return;
            }

            if (won) {
                s.virtualWins += 1;
                if (s.virtualWins >= s.returnAfterWins) {
                    s.virtualNow = false;
                    s.realLosses = 0;
                    s.virtualWins = 0;
                    notify('info', 'Virtual Hook: virtual wins reached, returning to real trading.');
                }
            } else {
                s.virtualWins = 0;
            }
        }

        vhStop() {
            const s = this.vh;
            if (s.subscription) {
                s.subscription.unsubscribe();
                s.subscription = null;
            }
        }

        virtualPurchase(contract_type) {
            const options = this.tradeOptions || {};
            if (!SUPPORTED.has(contract_type) || String(options.duration_unit || 't') !== 't') {
                throw new Error(
                    'Virtual Hook supports tick-duration Digits and Rise/Fall contracts only. ' +
                        'Use a tick duration or disable the Virtual Hook block.'
                );
            }
            const stake = Number(options.amount) || 0;
            const duration = Math.max(1, Math.trunc(Number(options.duration) || 1));
            const barrier = options.prediction ?? options.barrier ?? 0;
            const probability = winProbability(contract_type, barrier);
            const potential_profit = Math.round(stake * (0.965 / probability - 1) * 100) / 100;

            this.isSold = false;
            this.vhStop();
            virtual_counter += 1;
            const contract_id = VIRTUAL_ID_BASE + virtual_counter;
            this.contractId = contract_id;
            contractStatus({ id: 'contract.purchase_sent', data: 0 });
            this.store.dispatch(purchaseSuccessful());

            let entry = null;
            let count = 0;
            let last_epoch = null;
            const symbol = this.symbol;

            this.vh.subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data?.msg_type !== 'tick' || !data.tick) return;
                const tick = data.tick;
                if (symbol && (tick.symbol || tick.underlying_symbol) !== symbol) return;
                if (tick.epoch && tick.epoch === last_epoch) return;
                last_epoch = tick.epoch;
                const quote = Number(tick.quote);
                if (!Number.isFinite(quote)) return;

                if (entry === null) {
                    entry = quote;
                    return;
                }
                count += 1;
                if (count < duration) return;

                this.vhStop();
                const pip = tick.pip_size ?? this.getPipSize?.() ?? 2;
                const won = hasWon(contract_type, barrier, entry, quote, lastDigit(quote, pip));
                const profit = won ? potential_profit : -stake;
                this.handleOpenContract({
                    contract_id,
                    contract_type,
                    is_virtual_hook: 1,
                    is_sold: 1,
                    is_expired: 1,
                    status: won ? 'won' : 'lost',
                    currency: this.accountInfo?.currency,
                    buy_price: stake,
                    sell_price: won ? stake + potential_profit : 0,
                    profit,
                    barrier: String(barrier),
                    entry_spot: entry,
                    entry_tick: entry,
                    exit_tick: quote,
                    exit_spot: quote,
                    entry_tick_time: tick.epoch,
                    exit_tick_time: tick.epoch,
                    transaction_ids: { buy: contract_id, sell: contract_id },
                    display_name: 'Virtual',
                });
            });
            api_base.pushSubscription(this.vh.subscription);
            return Promise.resolve();
        }
    };
