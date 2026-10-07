import brandConfig from '../../brand.config.json';
import { getCurrentSiteConfig } from '@/config/site-registry';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';

export type CopyFollower = {
    id: string;
    account_id: string;
    account_type: 'demo' | 'real';
    balance: number;
    currency: string;
    token: string;
    token_hint: string;
};

export type CopyLog = {
    id: string;
    at: number;
    level: 'info' | 'success' | 'error';
    message: string;
};

type ProposalParameters = Record<string, unknown>;
type Listener = (log: CopyLog) => void;

const cleanTokens = (raw: string) => [...new Set(raw.split(/[\n,;\s]+/).map(value => value.trim()).filter(Boolean))];
const tokenHint = (token: string) => token.length < 10 ? '••••••' : `${token.slice(0, 4)}••••${token.slice(-4)}`;
const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

const unwrap = (value: any) => {
    if (value?.data && typeof value.data === 'object') return value.data;
    if (typeof value?.data === 'string') {
        try { return JSON.parse(value.data); } catch { return value; }
    }
    return value || {};
};

const sanitizeProposal = (echo: Record<string, unknown> = {}) => {
    const allowed = [
        'amount', 'basis', 'contract_type', 'currency', 'underlying_symbol', 'duration', 'duration_unit',
        'barrier', 'barrier2', 'multiplier', 'growth_rate', 'limit_order', 'cancellation',
    ];
    return Object.fromEntries(allowed.filter(key => echo[key] !== undefined && echo[key] !== null && echo[key] !== '').map(key => [key, echo[key]]));
};

export class CopyTradingService {
    private static followers: CopyFollower[] = [];
    private static proposalMap = new Map<string, ProposalParameters>();
    private static listeners = new Set<Listener>();
    private static messageSubscription: { unsubscribe: () => void } | null = null;
    private static running = false;

    private static site() {
        return getCurrentSiteConfig();
    }

    private static optionsBase() {
        const site = this.site();
        return `${brandConfig.platform.derivws.url[site.environment]}${brandConfig.platform.derivws.directories.options}`;
    }

    private static headers(token: string): HeadersInit {
        return {
            Authorization: `Bearer ${token}`,
            'Deriv-App-ID': this.site().client_id,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        };
    }

    private static emit(level: CopyLog['level'], message: string) {
        const log = { id: `${Date.now()}-${Math.random()}`, at: Date.now(), level, message } as CopyLog;
        this.listeners.forEach(listener => listener(log));
    }

    static subscribe(listener: Listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    static isRunning() {
        return this.running;
    }

    static getFollowers() {
        return this.followers.map(item => ({ ...item, token: '' }));
    }

    private static async readError(response: Response) {
        const raw = await response.text().catch(() => '');
        if (!raw) return `${response.status} ${response.statusText}`;
        try {
            const parsed = JSON.parse(raw);
            return parsed?.errors?.[0]?.message || parsed?.message || raw;
        } catch {
            return raw;
        }
    }

    static async syncTokens(raw: string): Promise<CopyFollower[]> {
        const tokens = cleanTokens(raw);
        if (!tokens.length) throw new Error('Paste at least one follower Personal Access Token.');

        const preferredType = (localStorage.getItem('account_type') === 'demo' ? 'demo' : 'real') as 'demo' | 'real';
        const synced: CopyFollower[] = [];
        const failures: string[] = [];

        await Promise.all(tokens.map(async (token, index) => {
            try {
                const response = await fetch(`${this.optionsBase()}accounts`, { headers: this.headers(token) });
                if (!response.ok) throw new Error(await this.readError(response));
                const payload = await response.json();
                const accounts = Array.isArray(payload?.data) ? payload.data : [];
                if (!accounts.length) throw new Error('No Options account was returned for this token.');
                const selected = accounts.find((account: any) => account.account_type === preferredType) || accounts[0];
                synced.push({
                    id: `${selected.account_id}-${index}`,
                    account_id: String(selected.account_id),
                    account_type: selected.account_type === 'demo' ? 'demo' : 'real',
                    balance: asNumber(selected.balance),
                    currency: String(selected.currency || 'USD'),
                    token,
                    token_hint: tokenHint(token),
                });
            } catch (error) {
                failures.push(`${tokenHint(token)}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }));

        if (!synced.length) throw new Error(failures.join(' | ') || 'No follower token could be validated.');
        this.followers = synced;
        this.emit('success', `Synced ${synced.length} follower account${synced.length === 1 ? '' : 's'}.`);
        failures.forEach(message => this.emit('error', message));
        return synced.map(item => ({ ...item }));
    }

    private static async ensureMasterApi() {
        if (!api_base.api) await api_base.init(true);
        for (let attempt = 0; attempt < 80; attempt += 1) {
            const api: any = api_base.api;
            if (api?.connection?.readyState === WebSocket.OPEN && api?.onMessage) return api;
            await new Promise(resolve => window.setTimeout(resolve, 125));
        }
        throw new Error('The master Deriv WebSocket is not ready.');
    }

    static async start(followers = this.followers) {
        if (!followers.length) throw new Error('Sync follower tokens before starting copy trading.');
        this.stop();
        this.followers = followers;
        const api = await this.ensureMasterApi();
        this.running = true;
        this.emit('info', `Copy trading started for ${followers.length} follower account${followers.length === 1 ? '' : 's'}.`);

        this.messageSubscription = api.onMessage().subscribe((event: any) => {
            const message = unwrap(event);
            if (!this.running || message?.error) return;

            if (message?.msg_type === 'proposal' && message?.proposal?.id) {
                const parameters = sanitizeProposal(message.echo_req || {});
                if (parameters.contract_type && parameters.underlying_symbol) {
                    this.proposalMap.set(String(message.proposal.id), parameters);
                }
                return;
            }

            if (message?.msg_type === 'buy' && message?.buy) {
                const proposalId = String(message?.echo_req?.buy || '');
                const parameters = this.proposalMap.get(proposalId);
                if (!parameters) return;
                this.proposalMap.delete(proposalId);
                void this.copyConfirmedMasterBuy(parameters, message.buy);
            }
        });
    }

    static stop() {
        this.running = false;
        this.messageSubscription?.unsubscribe();
        this.messageSubscription = null;
        this.proposalMap.clear();
        if (this.followers.length) this.emit('info', 'Copy trading stopped.');
    }

    private static async copyConfirmedMasterBuy(parameters: ProposalParameters, masterBuy: any) {
        const masterContract = masterBuy?.contract_id ? `Master contract ${masterBuy.contract_id}` : 'Master purchase';
        this.emit('info', `${masterContract} confirmed. Copying to ${this.followers.length} follower account${this.followers.length === 1 ? '' : 's'}…`);
        const results = await Promise.all(this.followers.map(follower => this.purchaseForFollower(follower, parameters)));
        const ok = results.filter(item => item.ok).length;
        this.emit(ok === results.length ? 'success' : 'error', `${masterContract}: ${ok}/${results.length} follower purchase${results.length === 1 ? '' : 's'} completed.`);
        results.filter(item => !item.ok).forEach(item => this.emit('error', `${item.account_id}: ${item.error}`));
    }

    private static async purchaseForFollower(follower: CopyFollower, parameters: ProposalParameters) {
        try {
            const otpResponse = await fetch(`${this.optionsBase()}accounts/${encodeURIComponent(follower.account_id)}/otp`, {
                method: 'POST',
                headers: this.headers(follower.token),
            });
            if (!otpResponse.ok) throw new Error(await this.readError(otpResponse));
            const otpPayload = await otpResponse.json();
            const url = otpPayload?.data?.url;
            if (!url) throw new Error('OTP response did not contain a WebSocket URL.');

            const socket = new WebSocket(url);
            await new Promise<void>((resolve, reject) => {
                const timer = window.setTimeout(() => reject(new Error('Follower WebSocket connection timed out.')), 10000);
                socket.addEventListener('open', () => { window.clearTimeout(timer); resolve(); }, { once: true });
                socket.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('Follower WebSocket connection failed.')); }, { once: true });
            });

            let reqId = 70000;
            const request = (payload: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
                const id = ++reqId;
                const timer = window.setTimeout(() => {
                    socket.removeEventListener('message', onMessage);
                    reject(new Error('Follower request timed out.'));
                }, 12000);
                const onMessage = (event: MessageEvent) => {
                    let data: any;
                    try { data = JSON.parse(String(event.data)); } catch { return; }
                    if (data.req_id !== id) return;
                    window.clearTimeout(timer);
                    socket.removeEventListener('message', onMessage);
                    if (data.error) reject(new Error(data.error.message || data.error.code || 'Follower request failed.'));
                    else resolve(data);
                };
                socket.addEventListener('message', onMessage);
                socket.send(JSON.stringify({ ...payload, req_id: id }));
            });

            try {
                const proposalResponse = await request({ proposal: 1, ...parameters });
                const proposal = proposalResponse?.proposal;
                if (!proposal?.id) throw new Error('No follower proposal was returned.');
                const price = asNumber(proposal.ask_price, asNumber(parameters.amount, 0));
                const buyResponse = await request({ buy: proposal.id, price });
                if (!buyResponse?.buy) throw new Error('No follower purchase confirmation was returned.');
                return { account_id: follower.account_id, ok: true, contract_id: buyResponse.buy.contract_id };
            } finally {
                socket.close();
            }
        } catch (error) {
            return { account_id: follower.account_id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}
