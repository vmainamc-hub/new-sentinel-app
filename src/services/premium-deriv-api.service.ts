import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';

type ApiPayload = Record<string, unknown>;
type ApiResponse = Record<string, any>;
type ContractUpdateListener = (contract: any) => void;

type TrackedContract = {
    api: any;
    observer: { unsubscribe?: () => void } | null;
    subscriptionId: string;
    timeoutId: number;
};

type TickHub = {
    symbol: string;
    callbacks: Set<(tick: any) => void>;
    api: any;
    observer: { unsubscribe?: () => void } | null;
    /** Stream id, kept only when WE opened the stream (so we may forget it). */
    subscriptionId: string;
    owns: boolean;
    lastTickAt: number;
    lastTick: any;
    ready: Promise<void> | null;
    /** True once the stream is open. Listeners that join after this get the latest tick replayed. */
    opened: boolean;
    refreshing: boolean;
};

/** A tick stream that has been silent this long is considered dead and is re-established. */
export const TICK_STALE_MS = 10_000;
const TICK_WATCHDOG_MS = 5_000;
const FORGET_TIMEOUT_MS = 4_000;
const isAlreadySubscribed = (error: unknown) => /already ?subscribed/i.test(`${tradingErrorMessage(error, '')} ${JSON.stringify(error ?? '')}`);

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const unwrap = (value: any): ApiResponse => (value?.data && typeof value.data === 'object' ? value.data : value || {});

export const tradingErrorMessage = (value: unknown, fallback = 'Deriv trading request failed.'): string => {
    if (value instanceof Error && value.message) return value.message;
    if (typeof value === 'string' && value.trim()) return value;

    const root = value && typeof value === 'object' ? value as Record<string, any> : null;
    const nested = root?.error && typeof root.error === 'object' ? root.error as Record<string, any> : root;
    const message = nested?.message ?? root?.message;
    const code = nested?.code ?? root?.code;

    if (typeof message === 'string' && message.trim()) {
        return typeof code === 'string' && code && !message.includes(code) ? `${message} (${code})` : message;
    }
    if (typeof code === 'string' && code.trim()) return code;

    return fallback;
};

const toTradingError = (value: unknown, fallback?: string): Error => {
    if (value instanceof Error) return value;
    const error = new Error(tradingErrorMessage(value, fallback));
    const root = value && typeof value === 'object' ? value as Record<string, any> : null;
    const nested = root?.error && typeof root.error === 'object' ? root.error as Record<string, any> : root;
    const code = nested?.code ?? root?.code;
    if (code) (error as Error & { code?: string }).code = String(code);
    return error;
};

export class PremiumDerivApiService {
    private static requestId = 1000;
    private static contractListeners = new Set<ContractUpdateListener>();
    private static trackedContracts = new Map<number, TrackedContract>();
    private static trackingInFlight = new Set<number>();
    private static tickHubs = new Map<string, TickHub>();
    private static tickWatchdog: number | null = null;

    private static async getApi(): Promise<any> {
        if (!api_base.api) await api_base.init(true);

        const requiresAuthenticatedAccount = Boolean(OAuthTokenExchangeService.getAccessToken());
        let socketOpened = false;

        for (let attempt = 0; attempt < 120; attempt += 1) {
            const api: any = api_base.api;
            if (api?.connection?.readyState === WebSocket.OPEN) {
                socketOpened = true;
                if (!requiresAuthenticatedAccount || api_base.is_authorized) return api;
            }
            await sleep(125);
        }

        if (socketOpened && requiresAuthenticatedAccount && !api_base.is_authorized) {
            throw new Error('Deriv account connection opened but authentication did not complete. Reconnect the selected account and try again.');
        }
        throw new Error('Deriv WebSocket is not ready. Please reconnect and try again.');
    }

    static async request(payload: ApiPayload): Promise<ApiResponse> {
        try {
            const api = await this.getApi();
            const result = unwrap(await api.send({ ...payload, req_id: ++this.requestId }));
            if (result?.error) throw result;
            return result;
        } catch (error) {
            throw toTradingError(error);
        }
    }

    static activeSymbols = async () => {
        const result = await this.request({ active_symbols: 'brief' });
        return Array.isArray(result.active_symbols) ? result.active_symbols : [];
    };

    static contractsFor = async (underlyingSymbol: string) => {
        const result = await this.request({ contracts_for: underlyingSymbol });
        return result.contracts_for || { available: [] };
    };

    static async ticksHistory(underlyingSymbol: string, count = 1000, style: 'ticks' | 'candles' = 'ticks', granularity?: number) {
        const request: ApiPayload = {
            ticks_history: underlyingSymbol,
            end: 'latest',
            count: Math.min(Math.max(Math.trunc(count), 1), 5000),
            style,
        };
        if (style === 'candles' && granularity) request.granularity = granularity;
        const result = await this.request(request);
        if (style === 'candles') return Array.isArray(result.candles) ? result.candles : [];
        return Array.isArray(result.history?.prices) ? result.history.prices.map(Number).filter(Number.isFinite) : [];
    }

    /**
     * Live ticks for one market. Many pages and engines want the same market, but Deriv allows ONE stream per market
     * per connection and `forget` kills it for everybody. So this keeps one hub per market:
     *  - one real Deriv subscription, fanned out to every listener;
     *  - the stream is forgotten only when the LAST listener leaves;
     *  - "already subscribed" (someone else owns the stream) is not an error: we simply listen to the shared feed;
     *  - a watchdog re-establishes any stream that goes silent or whose socket was replaced (reconnect, or another
     *    part of the app calling forget / forgetAll on ticks).
     */
    static async subscribeTicks(underlyingSymbol: string, callback: (tick: any) => void): Promise<() => void> {
        let hub = this.tickHubs.get(underlyingSymbol);
        if (!hub) {
            hub = { symbol: underlyingSymbol, callbacks: new Set(), api: null, observer: null, subscriptionId: '', owns: false, lastTickAt: Date.now(), lastTick: null, ready: null, opened: false, refreshing: false };
            this.tickHubs.set(underlyingSymbol, hub);
        }
        const current = hub;
        const joinedOpenHub = current.opened;
        current.callbacks.add(callback);
        try {
            if (!current.ready) current.ready = this.openTickHub(current).catch(error => { current.ready = null; throw error; });
            await current.ready;
        } catch (error) {
            current.callbacks.delete(callback);
            if (!current.callbacks.size) this.closeTickHub(current);
            throw error;
        }
        // Listeners present while the stream opened already got its first tick; only later joiners need the replay.
        if (joinedOpenHub && current.lastTick) { try { callback(current.lastTick); } catch { /* listener errors never break the feed */ } }
        this.ensureTickWatchdog();

        let disposed = false;
        return () => {
            if (disposed) return;
            disposed = true;
            current.callbacks.delete(callback);
            if (!current.callbacks.size) this.closeTickHub(current);
        };
    }

    private static emitTick(hub: TickHub, tick: any) {
        hub.lastTickAt = Date.now();
        hub.lastTick = tick;
        hub.callbacks.forEach(listener => {
            try { listener(tick); } catch (error) { console.warn('[PremiumDerivAPI] Tick listener failed:', tradingErrorMessage(error)); }
        });
    }

    private static async openTickHub(hub: TickHub) {
        const api = await this.getApi();
        hub.api = api;
        hub.observer?.unsubscribe?.();
        hub.observer = api.onMessage().subscribe((event: any) => {
            const message = unwrap(event);
            if (message.msg_type !== 'tick' || message.tick?.symbol !== hub.symbol) return;
            if (hub.owns) hub.subscriptionId = message.subscription?.id || message.tick?.id || hub.subscriptionId;
            this.emitTick(hub, message.tick);
        });
        hub.lastTickAt = Date.now();
        try {
            const response = unwrap(await api.send({ ticks: hub.symbol, subscribe: 1, req_id: ++this.requestId }));
            if (response?.error) throw response;
            hub.owns = true;
            hub.subscriptionId = response.subscription?.id || response.tick?.id || hub.subscriptionId;
            if (response.tick) this.emitTick(hub, response.tick);
            hub.opened = true;
        } catch (error) {
            if (isAlreadySubscribed(error)) {
                // Another part of the app owns the stream. Its ticks still reach our listener; we just must not forget it.
                hub.owns = false;
                hub.subscriptionId = '';
                hub.opened = true;
                return;
            }
            hub.observer?.unsubscribe?.();
            hub.observer = null;
            throw toTradingError(error, 'Unable to subscribe to ticks.');
        }
    }

    private static closeTickHub(hub: TickHub) {
        if (this.tickHubs.get(hub.symbol) === hub) this.tickHubs.delete(hub.symbol);
        try { hub.observer?.unsubscribe?.(); } catch { /* already closed */ }
        hub.observer = null;
        if (hub.owns && hub.subscriptionId) void Promise.resolve(hub.api?.send?.({ forget: hub.subscriptionId })).catch(() => undefined);
        hub.owns = false;
        hub.subscriptionId = '';
    }

    /** Re-establishes one market's tick stream on the CURRENT socket. Safe to call at any time. */
    static async refreshTicks(underlyingSymbol: string): Promise<void> {
        const hub = this.tickHubs.get(underlyingSymbol);
        if (!hub || hub.refreshing) return;
        hub.refreshing = true;
        try {
            if (hub.owns && hub.subscriptionId && hub.api) {
                // Never wait on a dead socket: a forget that gets no answer must not wedge the recovery.
                await Promise.race([Promise.resolve(hub.api.send({ forget: hub.subscriptionId })).catch(() => undefined), sleep(FORGET_TIMEOUT_MS)]);
            }
            hub.owns = false;
            hub.subscriptionId = '';
            await this.openTickHub(hub);
        } catch (error) {
            console.warn(`[PremiumDerivAPI] Could not refresh the ${underlyingSymbol} tick stream:`, tradingErrorMessage(error));
        } finally {
            hub.lastTickAt = Date.now(); // back off a full stale window before trying again
            hub.refreshing = false;
        }
    }

    /** How long a market's stream has been silent (null when nobody listens to it). */
    static tickAgeMs(underlyingSymbol: string, now = Date.now()): number | null {
        const hub = this.tickHubs.get(underlyingSymbol);
        return hub ? Math.max(0, now - hub.lastTickAt) : null;
    }

    /** One watchdog pass (exposed for tests). Returns the markets it re-established. */
    static sweepTickHubs(now = Date.now()): string[] {
        const current = api_base.api;
        const revived: string[] = [];
        this.tickHubs.forEach(hub => {
            if (hub.refreshing || !hub.ready) return;
            const socketReplaced = Boolean(current) && Boolean(hub.api) && current !== hub.api;
            const silent = now - hub.lastTickAt > TICK_STALE_MS;
            if (socketReplaced || silent) {
                revived.push(hub.symbol);
                void this.refreshTicks(hub.symbol);
            }
        });
        return revived;
    }

    private static ensureTickWatchdog() {
        if (this.tickWatchdog !== null || typeof window === 'undefined') return;
        this.tickWatchdog = window.setInterval(() => {
            if (!this.tickHubs.size) {
                window.clearInterval(this.tickWatchdog as number);
                this.tickWatchdog = null;
                return;
            }
            this.sweepTickHubs();
        }, TICK_WATCHDOG_MS);
    }

    static async proposal(parameters: {
        amount: number;
        basis?: 'stake' | 'payout';
        contract_type: string;
        currency: string;
        underlying_symbol: string;
        duration?: number;
        duration_unit?: 'd' | 'm' | 's' | 'h' | 't';
        barrier?: string;
        barrier2?: string;
        selected_tick?: number;
        multiplier?: number;
        growth_rate?: number;
    }) {
        const clean = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== '' && value !== undefined && value !== null));
        const result = await this.request({ proposal: 1, ...clean });
        if (!result.proposal?.id) throw new Error('Deriv did not return a proposal ID.');
        return result.proposal;
    }

    static isContractClosed(contract: any): boolean {
        if (!contract) return false;
        const status = String(contract.status || '').toLowerCase();
        const terminalStatus = ['won', 'lost', 'sold', 'cancelled', 'canceled', 'expired', 'closed'].includes(status);
        const exitTime = Number(contract.exit_spot_time ?? contract.exit_tick_time ?? 0);
        const hasFinalProfit = contract.profit !== undefined && contract.profit !== null && contract.profit !== '';
        return Boolean(
            terminalStatus ||
            contract.is_sold ||
            (contract.is_expired && hasFinalProfit) ||
            (exitTime > 0 && hasFinalProfit && status !== 'open')
        );
    }

    static onContractUpdate(listener: ContractUpdateListener): () => void {
        this.contractListeners.add(listener);
        return () => this.contractListeners.delete(listener);
    }

    private static emitContractUpdate(contract: any) {
        if (!contract?.contract_id) return;
        this.contractListeners.forEach(listener => {
            try {
                listener(contract);
            } catch (error) {
                console.warn('[PremiumDerivAPI] Contract update listener failed:', tradingErrorMessage(error));
            }
        });
    }

    private static cleanupTrackedContract(contractId: number) {
        const tracked = this.trackedContracts.get(contractId);
        if (!tracked) return;
        this.trackedContracts.delete(contractId);
        window.clearTimeout(tracked.timeoutId);
        try { tracked.observer?.unsubscribe?.(); } catch { /* already disposed */ }
        if (tracked.subscriptionId) {
            void Promise.resolve(tracked.api?.send?.({ forget: tracked.subscriptionId })).catch(() => undefined);
        }
    }

    static async trackContract(contractId: number): Promise<void> {
        const id = Math.trunc(Number(contractId));
        if (!id || this.trackedContracts.has(id) || this.trackingInFlight.has(id)) return;
        this.trackingInFlight.add(id);

        let api: any;
        let observer: any = null;
        try {
            api = await this.getApi();
            let subscriptionId = '';

            observer = api.onMessage().subscribe((event: any) => {
                const message = unwrap(event);
                if (message?.msg_type !== 'proposal_open_contract') return;
                const contract = message?.proposal_open_contract;
                if (Number(contract?.contract_id) !== id) return;
                subscriptionId = message?.subscription?.id || subscriptionId;
                const tracked = this.trackedContracts.get(id);
                if (tracked && subscriptionId) tracked.subscriptionId = subscriptionId;
                this.emitContractUpdate(contract);
                if (this.isContractClosed(contract)) this.cleanupTrackedContract(id);
            });

            const timeoutId = window.setTimeout(() => this.cleanupTrackedContract(id), 10 * 60 * 1000);
            this.trackedContracts.set(id, { api, observer, subscriptionId: '', timeoutId });

            const response = unwrap(await api.send({
                proposal_open_contract: 1,
                contract_id: id,
                subscribe: 1,
                req_id: ++this.requestId,
            }));
            if (response?.error) throw response;

            subscriptionId = response?.subscription?.id || subscriptionId;
            const tracked = this.trackedContracts.get(id);
            if (tracked && subscriptionId) tracked.subscriptionId = subscriptionId;
            if (response?.proposal_open_contract) {
                this.emitContractUpdate(response.proposal_open_contract);
                if (this.isContractClosed(response.proposal_open_contract)) this.cleanupTrackedContract(id);
            }
        } catch (error) {
            this.cleanupTrackedContract(id);
            try { observer?.unsubscribe?.(); } catch { /* already disposed */ }
            console.warn(`[PremiumDerivAPI] Could not attach settlement stream for contract ${id}:`, tradingErrorMessage(error));
        } finally {
            this.trackingInFlight.delete(id);
        }
    }

    static async buy(proposalId: string, maximumPrice: number) {
        const result = await this.request({ buy: proposalId, price: Math.max(0, Number(maximumPrice) || 0) });
        if (!result.buy) throw new Error('Deriv did not return a purchased contract.');
        const contractId = Math.trunc(Number(result.buy.contract_id || 0));
        if (contractId > 0) void this.trackContract(contractId);
        return result.buy;
    }


    /**
     * Buys a contract straight from its parameters, with no proposal ID. A proposal ID can be bought only once, and Deriv
     * hands out the same ID for identical proposal requests, so N copies of one trade cannot share proposals.
     * Each call here is an independent, valid purchase.
     */
    static async buyNow(parameters: {
        amount: number;
        basis?: 'stake' | 'payout';
        contract_type: string;
        currency: string;
        underlying_symbol: string;
        duration: number;
        duration_unit: 'd' | 'm' | 's' | 'h' | 't';
        barrier?: string;
        barrier2?: string;
    }, maximumPrice: number) {
        const clean = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== '' && value !== undefined && value !== null));
        const result = await this.request({ buy: '1', price: Math.max(0, Number(maximumPrice) || 0), parameters: clean });
        if (!result.buy) throw new Error('Deriv did not return a purchased contract.');
        const contractId = Math.trunc(Number(result.buy.contract_id || 0));
        if (contractId > 0) void this.trackContract(contractId);
        return result.buy;
    }

    static async sell(contractId: number, price = 0) {
        const result = await this.request({ sell: contractId, price: Math.max(0, Number(price) || 0) });
        if (result?.sell) this.emitContractUpdate({ ...result.sell, contract_id: contractId, status: 'sold', is_sold: 1 });
        return result.sell;
    }

    static async portfolio() {
        const result = await this.request({ portfolio: 1 });
        return result.portfolio || { contracts: [] };
    }

    static async profitTable(limit = 25) {
        const result = await this.request({ profit_table: 1, limit, sort: 'DESC' });
        return result.profit_table || { count: 0, transactions: [] };
    }

    static async statement(limit = 25) {
        const result = await this.request({ statement: 1, limit });
        return result.statement || { count: 0, transactions: [] };
    }

    static async autoList() {
        const result = await this.request({ auto_list: 1 });
        return result.auto_list || result;
    }

    static async autoListStrategies() {
        const result = await this.request({ auto_list_strategies: 1 });
        return result.auto_list_strategies || result;
    }

    static async refreshAccounts() {
        const token = OAuthTokenExchangeService.getAccessToken();
        if (!token) throw new Error('OAuth access token is unavailable. Please sign in again.');
        DerivWSAccountsService.clearCache();
        return DerivWSAccountsService.fetchAccountsList(token);
    }

    private static async withAccountSocket<T>(accountId: string, action: (request: (payload: ApiPayload) => Promise<ApiResponse>) => Promise<T>): Promise<T> {
        const token = OAuthTokenExchangeService.getAccessToken();
        if (!token) throw new Error('OAuth access token is unavailable.');
        const url = await DerivWSAccountsService.fetchOTPWebSocketURL(token, accountId);
        const socket = new WebSocket(url);

        await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error(`Timed out connecting ${accountId}.`)), 10000);
            socket.addEventListener('open', () => { window.clearTimeout(timer); resolve(); }, { once: true });
            socket.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error(`Could not connect ${accountId}.`)); }, { once: true });
        });

        let reqId = 50000;
        const request = (payload: ApiPayload) => new Promise<ApiResponse>((resolve, reject) => {
            const currentId = ++reqId;
            const timer = window.setTimeout(() => {
                socket.removeEventListener('message', onMessage);
                reject(new Error(`Deriv request timed out for ${accountId}.`));
            }, 12000);
            const onMessage = (event: MessageEvent) => {
                let data: any;
                try { data = JSON.parse(String(event.data)); } catch { return; }
                if (data.req_id !== currentId) return;
                window.clearTimeout(timer);
                socket.removeEventListener('message', onMessage);
                if (data.error) reject(toTradingError(data));
                else resolve(data);
            };
            socket.addEventListener('message', onMessage);
            socket.send(JSON.stringify({ ...payload, req_id: currentId }));
        });

        try {
            return await action(request);
        } finally {
            socket.close();
        }
    }

    static async copyTradeAcrossOwnAccounts(accountIds: string[], proposalParameters: Parameters<typeof PremiumDerivApiService.proposal>[0]) {
        return Promise.all(accountIds.map(async accountId => {
            try {
                const result = await this.withAccountSocket(accountId, async request => {
                    const proposalResponse = await request({ proposal: 1, ...proposalParameters });
                    const proposal = proposalResponse.proposal;
                    if (!proposal?.id) throw new Error('No proposal returned.');
                    const maxPrice = Number(proposal.ask_price ?? proposalParameters.amount);
                    const buyResponse = await request({ buy: proposal.id, price: Number.isFinite(maxPrice) ? maxPrice : proposalParameters.amount });
                    return buyResponse.buy;
                });
                return { account_id: accountId, ok: true, result };
            } catch (error) {
                return { account_id: accountId, ok: false, error: tradingErrorMessage(error) };
            }
        }));
    }
}
