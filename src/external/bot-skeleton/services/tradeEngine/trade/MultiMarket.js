import { createError } from '../../../utils/error';

/**
 * Multi-market support for strategies.
 *
 * A DBot run is bound to ONE market: its tick loop (tick_analysis / before_purchase) follows that market only.
 * To get more entries, a strategy can instead WATCH a list of markets, read their digit statistics every tick,
 * and place the next contract on whichever market qualifies:
 *
 *   Bot.watchMarkets(list)                    subscribe + wait for history (async, call once in Initialization)
 *   Bot.getMarketTickCount(symbol)            ticks available (0 while warming up, or if the feed went stale)
 *   Bot.getMarketDigitCount(symbol, n, skip, digits)   ticks, among the n ending `skip` ticks ago, with last digit in `digits`
 *   Bot.getMarketDigits(symbol)               raw last-digit list, oldest first
 *   Bot.setTradeMarket(symbol)                the next purchase is made on this market (resets on every trade restart)
 *
 * Only the purchase market changes. The tick loop keeps following the market chosen in the Trade definition, so no
 * tick listener is ever re-pointed (unlike Bot.changeSymbol) and each new trade starts on the base market again.
 */
const MAX_MARKETS = 20;
const SYMBOL_PATTERN = /^[A-Za-z0-9_]{2,24}$/;
const WARMUP_TIMEOUT_MS = 6000;
const WARMUP_POLL_MS = 150;
/** A market that has delivered nothing for this long is treated as having no data (the bus watchdog re-opens it). */
const MAX_FEED_AGE_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const normalizeMarkets = markets => {
    const list = Array.isArray(markets) ? markets : [markets];
    const seen = new Set();
    list.forEach(item => {
        const symbol = String(item ?? '').trim();
        if (!symbol) return;
        if (!SYMBOL_PATTERN.test(symbol)) {
            throw createError('MultiMarket', `"${symbol}" is not a valid market symbol.`);
        }
        seen.add(symbol);
    });
    if (seen.size > MAX_MARKETS) {
        throw createError('MultiMarket', `Watching more than ${MAX_MARKETS} markets at once is not supported.`);
    }
    return [...seen];
};

export default Engine =>
    class MultiMarket extends Engine {
        async watchMarkets(markets) {
            const symbols = normalizeMarkets(markets);
            this.releaseMarkets();
            if (!symbols.length) return 0;

            // Loaded on demand so the trade engine does not depend on the Sentinel engine at import time.
            const { derivBus } = await import('@/sentinel-engine/lib/deriv/tick-bus');
            this.multi_market_bus = derivBus;
            this.multi_market_symbols = new Set(symbols);
            this.multi_market_release = derivBus.subscribe(symbols);

            const deadline = Date.now() + WARMUP_TIMEOUT_MS;
            while (Date.now() < deadline && symbols.some(symbol => derivBus.getDigitCount(symbol) === 0)) {
                await sleep(WARMUP_POLL_MS);
            }
            return symbols.filter(symbol => derivBus.getDigitCount(symbol) > 0).length;
        }

        releaseMarkets() {
            try {
                this.multi_market_release?.();
            } catch {
                // already released
            }
            this.multi_market_release = null;
            this.multi_market_symbols = null;
        }

        isMarketReadable(symbol) {
            const bus = this.multi_market_bus;
            if (!bus || !this.multi_market_symbols?.has(String(symbol))) return false;
            const age = bus.getAgeMs?.(String(symbol));
            return age === undefined || age <= MAX_FEED_AGE_MS;
        }

        getMarketTickCount(symbol) {
            return this.isMarketReadable(symbol) ? this.multi_market_bus.getDigitCount(String(symbol)) : 0;
        }

        getMarketDigitCount(symbol, window, skip, digits) {
            if (!this.isMarketReadable(symbol)) return NaN;
            return this.multi_market_bus.countDigits(String(symbol), window, skip, Array.isArray(digits) ? digits : []);
        }

        getMarketDigits(symbol) {
            return this.isMarketReadable(symbol) ? this.multi_market_bus.getDigits(String(symbol)) : [];
        }

        setTradeMarket(symbol) {
            const market = String(symbol ?? '').trim();
            if (!SYMBOL_PATTERN.test(market)) {
                throw createError('MultiMarket', `"${market}" is not a valid market symbol.`);
            }
            if (!this.tradeOptions) {
                throw createError('MultiMarket', 'Set the trade market inside Before purchase, after the trade has started.');
            }
            const base = this.options?.symbol;
            if (market !== base && !this.multi_market_symbols?.has(market)) {
                throw createError(
                    'MultiMarket',
                    `Market ${market} is not being watched. Add it to the list given to "Watch markets" first.`
                );
            }
            if (market !== base && this.is_proposal_subscription_required) {
                throw createError(
                    'MultiMarket',
                    'Trading another market needs Stake basis and no Payout / Ask price blocks, because those request prices for the base market only.'
                );
            }
            this.tradeOptions = { ...this.tradeOptions, symbol: market };
            return market;
        }
    };
