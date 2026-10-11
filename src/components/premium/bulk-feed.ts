// The Bulk Trader's live market data and signal engine, owned by the APP rather than by the page.
//
// Why: the page used to open 13 tick streams and load 1000 ticks of history every time it mounted, and drop all of it
// (and stop the signal engine) the moment you navigated away. Coming back meant a cold start, and any stream that
// went quiet stayed quiet. Here the feed starts once, keeps every market live and the engine analysing for as long
// as the app is open, repairs itself, and the page simply attaches to it.

import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import {
    BULK_MARKETS, ENGINE_TICKS, MIN_ENGINE_TICKS, OverUnderEngine, buildEngineTicks, digitsFromPrices, inferDecimals, lastDigit, recommend,
    SignalStability, type CombinedVerdict, type Recommendation,
} from './over-under-engine';

export type MarketStore = { prices: number[]; times: number[]; digits: number[]; decimals: number; lastTickAt: number };
type Market = (typeof BULK_MARKETS)[number];

/** A market whose newest tick is older than this is not "live". */
export const LIVE_WITHIN_MS = 15_000;
/** Analysis step while a page is watching / while nothing is (it still runs, just gently). */
const STEP_ACTIVE_MS = 150;
const STEP_IDLE_MS = 1_000;
const SUPERVISE_MS = 8_000;
/** A jump in tick time bigger than this means ticks were missed: reload that market's history. */
const GAP_RELOAD_S = 12;

const num = (value: unknown, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };

export type FeedStep = { now: number; ready: number };

export class BulkFeed {
    readonly store: Record<string, MarketStore> = {};
    readonly verdicts: Record<string, CombinedVerdict> = {};
    rec: Recommendation | null = null;
    private readonly errors = new Map<string, string>();
    /** The most recent market connection problem that has not been resolved yet ('' when everything is connected). */
    get lastError() { return [...this.errors.values()].pop() ?? ''; }

    private readonly engine = new OverUnderEngine();
    private readonly stability = new SignalStability();
    private readonly waiters: Record<string, Array<() => void>> = {};
    private readonly tickListeners = new Set<(symbol: string) => void>();
    private readonly stepListeners = new Set<(step: FeedStep) => void>();
    private readonly disposers = new Map<string, () => void>();
    private readonly loading = new Set<string>();
    private readonly reloading = new Set<string>();
    private started = false;
    private index = 0;
    private stepTimer: number | null = null;
    private superviseTimer: number | null = null;

    /** Idempotent. Safe to call on every mount. */
    start() {
        if (this.started) return;
        this.started = true;
        this.superviseLoop();
        this.superviseTimer = window.setInterval(() => this.superviseLoop(), SUPERVISE_MS);
        this.scheduleStep();
    }

    /** Test / teardown hook. The app never needs to call this. */
    stop() {
        this.started = false;
        if (this.stepTimer !== null) window.clearTimeout(this.stepTimer);
        if (this.superviseTimer !== null) window.clearInterval(this.superviseTimer);
        this.stepTimer = this.superviseTimer = null;
        this.disposers.forEach(dispose => { try { dispose(); } catch { /* already closed */ } });
        this.disposers.clear();
        this.loading.clear();
        this.reloading.clear();
    }

    onTick(listener: (symbol: string) => void) { this.tickListeners.add(listener); return () => { this.tickListeners.delete(listener); }; }
    onStep(listener: (step: FeedStep) => void) { this.stepListeners.add(listener); return () => { this.stepListeners.delete(listener); }; }
    nextTick(symbol: string) { return new Promise<void>(resolve => { (this.waiters[symbol] ||= []).push(resolve); }); }

    /** Markets with a tick newer than LIVE_WITHIN_MS. */
    liveCount(now = Date.now()) {
        return Object.values(this.store).filter(entry => now - entry.lastTickAt <= LIVE_WITHIN_MS).length;
    }

    /** Looks a tick up by epoch seconds in a market's history and returns its last digit. */
    digitAt(symbol: string, epochSeconds: number): number | null {
        const entry = this.store[symbol];
        if (!entry) return null;
        const target = epochSeconds * 1000;
        for (let i = entry.times.length - 1; i >= 0 && entry.times[i] >= target - 1; i -= 1) {
            if (Math.abs(entry.times[i] - target) < 1) return entry.digits[i];
        }
        return null;
    }

    // ------------------------------------------------------------------ data

    private async loadHistory(market: Market, keepSubscription: boolean) {
        const result = await PremiumDerivApiService.request({ ticks_history: market.symbol, end: 'latest', count: ENGINE_TICKS, style: 'ticks' });
        const prices: number[] = (result.history?.prices ?? []).map(Number);
        const times: number[] = (result.history?.times ?? []).map((t: unknown) => Number(t) * 1000);
        const previous = this.store[market.symbol];
        const decimals = Math.max(previous?.decimals ?? 0, inferDecimals(prices, market.pip));
        // Mutate in place: the page holds references to these arrays.
        if (previous && keepSubscription) {
            // Live ticks that arrived while the history was in flight are newer than the history: keep them.
            const lastHistory = times.length ? times[times.length - 1] : 0;
            const from = previous.times.findIndex(t => t > lastHistory);
            const tailPrices = from >= 0 ? previous.prices.slice(from) : [];
            const tailTimes = from >= 0 ? previous.times.slice(from) : [];
            const tailDigits = from >= 0 ? previous.digits.slice(from) : [];
            previous.prices.splice(0, previous.prices.length, ...prices, ...tailPrices);
            previous.times.splice(0, previous.times.length, ...times, ...tailTimes);
            previous.digits.splice(0, previous.digits.length, ...digitsFromPrices(prices, decimals), ...tailDigits);
            previous.decimals = decimals;
            if (previous.prices.length > ENGINE_TICKS) {
                const extra = previous.prices.length - ENGINE_TICKS;
                previous.prices.splice(0, extra); previous.times.splice(0, extra); previous.digits.splice(0, extra);
            }
        } else {
            this.store[market.symbol] = { prices, times, digits: digitsFromPrices(prices, decimals), decimals, lastTickAt: 0 };
        }
    }

    private onMarketTick(market: Market, tick: any) {
        const entry = this.store[market.symbol];
        const quote = Number(tick?.quote);
        if (!entry || !Number.isFinite(quote)) return;
        const epoch = num(tick?.epoch, Date.now() / 1000);
        const lastTime = entry.times.length ? entry.times[entry.times.length - 1] / 1000 : 0;
        if (epoch <= lastTime) return; // the same tick delivered twice (shared stream / re-sync)
        const gap = lastTime > 0 ? epoch - lastTime : 0;
        const pip = Number(tick?.pip_size);
        if (Number.isInteger(pip) && pip > entry.decimals) entry.decimals = pip;
        entry.prices.push(quote);
        entry.times.push(epoch * 1000);
        entry.digits.push(lastDigit(quote, entry.decimals));
        entry.lastTickAt = Date.now();
        if (entry.prices.length > ENGINE_TICKS) {
            const extra = entry.prices.length - ENGINE_TICKS;
            entry.prices.splice(0, extra); entry.times.splice(0, extra); entry.digits.splice(0, extra);
        }
        const pending = this.waiters[market.symbol];
        if (pending?.length) { this.waiters[market.symbol] = []; pending.forEach(resolve => resolve()); }
        this.tickListeners.forEach(listener => { try { listener(market.symbol); } catch { /* a listener must never break the feed */ } });
        // Missed ticks (sleep, reconnect): the digit statistics would be wrong, so rebuild this market's history.
        if (gap > GAP_RELOAD_S && !this.reloading.has(market.symbol)) {
            this.reloading.add(market.symbol);
            void this.loadHistory(market, true).catch(() => undefined).finally(() => { this.reloading.delete(market.symbol); });
        }
    }

    /** (Re)starts any market that has no live subscription. Runs on a timer, so a failed start heals itself. */
    private superviseLoop() {
        if (!this.started) return;
        const queue = BULK_MARKETS.filter(market => !this.disposers.has(market.symbol) && !this.loading.has(market.symbol));
        const worker = async () => {
            for (let market = queue.shift(); market && this.started; market = queue.shift()) await this.connect(market);
        };
        void Promise.all([worker(), worker(), worker(), worker()]);
    }

    private async connect(market: Market) {
        if (this.loading.has(market.symbol) || this.disposers.has(market.symbol)) return;
        this.loading.add(market.symbol);
        try {
            if (!this.store[market.symbol]) await this.loadHistory(market, false);
            const dispose = await PremiumDerivApiService.subscribeTicks(market.symbol, tick => this.onMarketTick(market, tick));
            if (this.started) this.disposers.set(market.symbol, dispose); else dispose();
            this.errors.delete(market.symbol);
        } catch (error) {
            this.errors.set(market.symbol, error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error));
        } finally {
            this.loading.delete(market.symbol);
        }
    }

    // ------------------------------------------------------------------ signal engine

    private scheduleStep() {
        if (!this.started) return;
        this.stepTimer = window.setTimeout(() => {
            this.step();
            this.scheduleStep();
        }, this.stepListeners.size ? STEP_ACTIVE_MS : STEP_IDLE_MS);
    }

    /** One engine step: analyse the next market (round-robin), refresh the recommendation, tell the page. Never throws. */
    step(now = Date.now()) {
        try {
            for (let tries = 0; tries < BULK_MARKETS.length; tries += 1) {
                const market = BULK_MARKETS[this.index % BULK_MARKETS.length];
                this.index += 1;
                const entry = this.store[market.symbol];
                if (!entry || entry.prices.length < MIN_ENGINE_TICKS) continue;
                try {
                    this.verdicts[market.symbol] = this.engine.analyse(market.symbol, buildEngineTicks(entry.prices, entry.times, entry.decimals));
                    this.stability.observe(market.symbol, this.verdicts[market.symbol]);
                } catch (error) {
                    // One market failing to analyse must not stop the engine for the other twelve.
                    console.warn(`[bulk-feed] analysis failed for ${market.symbol}:`, error);
                }
                break;
            }
            this.rec = recommend(this.verdicts, now, this.rec, this.stability);
            const ready = Object.values(this.verdicts).filter(v => v.ready).length;
            this.stepListeners.forEach(listener => { try { listener({ now, ready }); } catch (error) { console.warn('[bulk-feed] listener failed:', error); } });
        } catch (error) {
            console.warn('[bulk-feed] engine step failed:', error);
        }
    }
}

export const bulkFeed = new BulkFeed();

