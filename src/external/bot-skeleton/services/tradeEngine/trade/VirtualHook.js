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

// Deriv normally reports pip_size as a decimal count (for example, 3). Some feeds expose the pip step
// instead (0.001). Normalize both forms so settlement and display use the same precision.
const pipDecimals = (pip, quote) => {
    const n = Number(pip);
    if (pip !== undefined && pip !== null && pip !== '' && Number.isFinite(n) && n >= 0) {
        const decimals = n > 0 && n < 1 ? Math.round(-Math.log10(n)) : Math.trunc(n);
        return Math.min(20, Math.max(0, decimals));
    }
    return (String(quote).split('.')[1] || '').length;
};

// Keep the quote as text (for example, 6022.690). Converting it to Number first drops trailing zeros.
const formatSpot = (quote, pip) => Number(quote).toFixed(pipDecimals(pip, quote));
const lastDigit = (quote, pip) => Number(formatSpot(quote, pip).slice(-1));

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
                    lastWasVirtual: false,
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

        // True when the trade that just settled was virtual. The after-purchase block uses this to skip the
        // strategy's win/loss, martingale and recovery logic for virtual trades.
        vhIsVirtualResult() {
            return Boolean(this._vh?.lastWasVirtual);
        }

        vhIsVirtualNext() {
            return this.vh.enabled && this.vh.virtualNow;
        }

        // Called for every settled contract (real and virtual).
        vhOnSettled(contract) {
            const s = this.vh;
            const was_virtual = Boolean(contract?.is_virtual_hook);
            s.lastWasVirtual = was_virtual;
            if (!s.enabled) return;
            const status = String(contract?.status || '').toLowerCase();
            const won = status === 'won' || (status !== 'lost' && Number(contract?.profit) > 0);

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
            let entry_text = '';
            let count = 0;
            let last_epoch = null;

            this.vh.subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data?.msg_type !== 'tick' || !data.tick) return;
                const tick = data.tick;
                // Resolve the intended market on every tick: the market this trade was placed on first (multi-market bots), else the
                // watched one; some engine instances populate the symbol only after purchase starts.
                // If it is still unknown, do not let an arbitrary market's tick settle this virtual trade.
                const symbol = options.symbol || this.symbol || this.options?.symbol;
                if (!symbol) return;
                if ((tick.symbol || tick.underlying_symbol) !== symbol) return;
                if (tick.epoch && tick.epoch === last_epoch) return;
                last_epoch = tick.epoch;
                const quote = Number(tick.quote);
                if (!Number.isFinite(quote)) return;
                const pip = tick.pip_size ?? this.getPipSize?.();

                if (entry === null) {
                    entry = quote;
                    entry_text = formatSpot(tick.quote, pip);
                }
                // The first tick after purchase is tick 1, including for one-tick contracts.
                count += 1;
                if (count < duration) return;

                this.vhStop();
                const exit_text = formatSpot(tick.quote, pip);
                const exit_digit = lastDigit(tick.quote, pip);
                const won = hasWon(contract_type, barrier, entry, quote, exit_digit);
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
                    entry_spot: entry_text,
                    entry_tick: entry,
                    exit_tick: quote,
                    exit_spot: exit_text,
                    entry_text,
                    exit_text,
                    entry_display_value: entry_text,
                    exit_display_value: exit_text,
                    exit_digit,
                    entry_tick_time: tick.epoch,
                    exit_tick_time: tick.epoch,
                    transaction_ids: { buy: contract_id, sell: contract_id },
                    display_name: 'Virtual',
                });
            });
            api_base.pushSubscription(this.vh.subscription);

            // Publish an open virtual contract immediately, without claiming an outcome before settlement.
            this.handleOpenContract({
                contract_id,
                contract_type,
                is_virtual_hook: 1,
                is_sold: 0,
                is_expired: 0,
                status: 'open',
                currency: this.accountInfo?.currency,
                buy_price: stake,
                sell_price: 0,
                profit: 0,
                barrier: String(barrier),
                transaction_ids: { buy: contract_id },
                display_name: 'Virtual',
            });
            return Promise.resolve();
        }
    };
