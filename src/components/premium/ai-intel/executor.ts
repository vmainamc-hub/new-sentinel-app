// APEX INTEL executor: places real OVER 2 / UNDER 7 digit contracts and their recovery trades.
//
// It is a plain service (not tied to the page), so a session keeps running while you look at other tabs. All I/O is
// injected, which keeps it unit-testable. Purchases go through the same helpers Auto Trades and Sixfold use, and every
// purchase and settlement is pushed to the Run Panel / transactions / summary stores.
//
// Safety, in the order a trade meets it: authorised Deriv session -> fresh tick -> one contract at a time (set before
// the purchase is awaited, so a second order cannot slip in) -> stake and session limits -> purchase. A purchase that
// gets no answer is NEVER retried: the run stops and tells you to check the Deriv statement. A trade is only reported as
// settled once Deriv reports it sold.
//
// Recovery is a staking rule, not a way to change the odds. After a loss the next stake is multiplied (martingale) and,
// if you switch it on, the contract moves to the recovery barrier. A multiplier makes the next win recover earlier
// losses but also makes a long losing run cost much more; the max-stake and stop-loss limits exist for that reason.
import { type Contract, losingDigits } from '@/components/premium/sixfold/bot';
import { OVER_2, UNDER_7 } from './sim';

export type Direction = 'OVER_2' | 'UNDER_7';
export type ExecEntry = 'SETUP' | 'ANY' | 'CUSTOM';
/** AUTO buys by itself on every qualifying tick. ASSISTED prepares the contract and waits for your click. */
export type ExecMode = 'ASSISTED' | 'AUTO';

export type ExecConfig = {
    market: string;
    direction: Direction;
    entry: ExecEntry;
    customDigits: number[];
    /** Contract length in ticks (1-10). */
    duration: number;
    stake: number;
    recovery: {
        enabled: boolean;
        /** Stake multiplier applied once per consecutive loss. */
        multiplier: number;
        /** After this many consecutive losses the run stops instead of raising the stake again. */
        maxSteps: number;
        /** Move to the recovery barrier while recovering (OVER side -> overBarrier, UNDER side -> underBarrier). */
        barrierOn: boolean;
        overBarrier: number;
        underBarrier: number;
    };
    /** Hard cap on any single stake. A stake above it stops the run. */
    maxStake: number;
    /** Stop when session loss reaches this amount (0 = off). */
    stopLoss: number;
    /** Stop when session profit reaches this amount (0 = off). */
    targetProfit: number;
    /** Stop after this many trades (0 = off). */
    maxTrades: number;
    mode: ExecMode;
    /** AUTO needs this to be true: the person has read and accepted that it trades without asking. */
    autoAuthorised: boolean;
};

export const DEFAULT_EXEC: ExecConfig = {
    market: '1HZ100V',
    direction: 'OVER_2',
    entry: 'SETUP',
    customDigits: [0, 1, 2],
    duration: 1,
    stake: 1,
    recovery: { enabled: true, multiplier: 2, maxSteps: 4, barrierOn: false, overBarrier: 3, underBarrier: 6 },
    maxStake: 20,
    stopLoss: 20,
    targetProfit: 10,
    maxTrades: 0,
    mode: 'ASSISTED',
    autoAuthorised: false,
};

export const MIN_STAKE = 0.35;
const FRESH_TICK_MS = 5_000;
/** A prepared ASSISTED trade is dropped if you have not confirmed it within this time: the trigger tick is stale. */
export const PROPOSAL_TTL_MS = 3_000;
const COOLDOWN_MS = 300;
const MAX_REJECTIONS_IN_A_ROW = 3;
const HISTORY_LIMIT = 500;

const clampInt = (x: unknown, lo: number, hi: number, fallback: number) => {
    const n = Math.trunc(Number(x));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const num = (x: unknown, fallback: number) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
export const money = (x: number) => Math.round(x * 100) / 100;

export function normalizeExec(raw: Partial<ExecConfig> | null | undefined): ExecConfig {
    const r = raw ?? {};
    const rec: Partial<ExecConfig['recovery']> = r.recovery ?? {};
    const d = DEFAULT_EXEC;
    const digits = Array.isArray(r.customDigits) ? [...new Set(r.customDigits.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 9))] : d.customDigits;
    return {
        market: typeof r.market === 'string' && r.market ? r.market : d.market,
        direction: r.direction === 'UNDER_7' ? 'UNDER_7' : 'OVER_2',
        entry: r.entry === 'ANY' || r.entry === 'CUSTOM' ? r.entry : 'SETUP',
        customDigits: digits,
        duration: clampInt(r.duration, 1, 10, d.duration),
        stake: money(Math.max(0, num(r.stake, d.stake))),
        recovery: {
            enabled: rec.enabled ?? d.recovery.enabled,
            multiplier: Math.max(1, Math.min(10, num(rec.multiplier, d.recovery.multiplier))),
            maxSteps: clampInt(rec.maxSteps, 1, 12, d.recovery.maxSteps),
            barrierOn: rec.barrierOn ?? d.recovery.barrierOn,
            overBarrier: clampInt(rec.overBarrier, 0, 8, d.recovery.overBarrier),
            underBarrier: clampInt(rec.underBarrier, 1, 9, d.recovery.underBarrier),
        },
        maxStake: money(Math.max(0, num(r.maxStake, d.maxStake))),
        stopLoss: money(Math.max(0, num(r.stopLoss, d.stopLoss))),
        targetProfit: money(Math.max(0, num(r.targetProfit, d.targetProfit))),
        maxTrades: clampInt(r.maxTrades, 0, 100000, d.maxTrades),
        mode: r.mode === 'AUTO' ? 'AUTO' : 'ASSISTED',
        autoAuthorised: Boolean(r.autoAuthorised),
    };
}

export const primaryContract = (d: Direction): Contract => (d === 'UNDER_7' ? UNDER_7 : OVER_2);

/** The contract for the next trade given consecutive losses, and the stake for it. */
export function nextTrade(cfg: ExecConfig, consecutiveLosses: number): { contract: Contract; stake: number; recovery: boolean; step: number } {
    const recovering = cfg.recovery.enabled && consecutiveLosses > 0;
    const primary = primaryContract(cfg.direction);
    const contract: Contract =
        recovering && cfg.recovery.barrierOn
            ? primary.side === 'OVER'
                ? { side: 'OVER', param: cfg.recovery.overBarrier }
                : { side: 'UNDER', param: cfg.recovery.underBarrier }
            : primary;
    const stake = recovering ? money(cfg.stake * cfg.recovery.multiplier ** consecutiveLosses) : cfg.stake;
    return { contract, stake, recovery: recovering, step: recovering ? consecutiveLosses : 0 };
}

/** Digits that arm an entry for this contract. */
export function triggerSet(cfg: ExecConfig, contract: Contract): ReadonlySet<number> {
    if (cfg.entry === 'ANY') return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    if (cfg.entry === 'CUSTOM') return new Set(cfg.customDigits);
    return new Set(losingDigits(contract));
}

const DERIV_TYPE: Record<string, string> = { OVER: 'DIGITOVER', UNDER: 'DIGITUNDER' };
const labelOf = (c: Contract) => `${c.side === 'OVER' ? 'Over' : 'Under'} ${c.param}`;

export type ExecTrade = {
    id: string;
    contractId: number | null;
    at: number;
    market: string;
    label: string;
    recovery: boolean;
    step: number;
    stake: number;
    duration: number;
    triggerDigit: number | null;
    exitDigit: number | null;
    profit: number | null;
    status: 'open' | 'won' | 'lost' | 'unconfirmed';
};

export type ExecPhase = 'idle' | 'waiting' | 'ready' | 'buying' | 'settling';

export type Proposal = { contract: Contract; label: string; stake: number; recovery: boolean; step: number; triggerDigit: number; expiresAt: number };

export type ExecSnapshot = {
    running: boolean;
    phase: ExecPhase;
    config: ExecConfig;
    proposal: Proposal | null;
    consecutiveLosses: number;
    session: { trades: number; wins: number; losses: number; pnl: number };
    trades: ExecTrade[];
    log: Array<{ at: number; kind: 'info' | 'warn' | 'trade' | 'win' | 'loss'; text: string }>;
    lastError: string | null;
    stopMessage: string | null;
    /** What would be bought next, shown even while waiting. */
    next: { label: string; stake: number; recovery: boolean; triggers: number[] } | null;
};

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ExecStores {
    client?: { currency?: string };
    run_panel: {
        run_id?: string;
        is_contract_buying_in_progress: boolean;
        setIsRunning: (v: boolean) => void;
        setRunId: (id: string) => void;
        setContractStage?: (stage: number) => void;
        toggleDrawer: (open: boolean) => void;
        setHasOpenContract?: (v: boolean) => void;
        setShowBotStopMessage?: (v: boolean) => void;
        onBotContractEvent: (data: Loose) => void;
    };
    summary_card: { onBotContractEvent: (data: Loose) => void };
    transactions: { pushTransaction: (data: Loose) => void };
    dashboard: {
        active_trading_module: string | null;
        setActiveTradingModule: (id: string | null) => void;
        registerTradingStopHandler: (id: string, handler: () => void) => void;
        unregisterTradingStopHandler: (id: string) => void;
        stopActiveTradingModule: () => void;
    };
}

export type ExecIO = {
    buy: (a: { parameters: Loose; price: number }) => Promise<{ buy_price: number; contract_id: number; transaction_id: number }>;
    settle: (a: { contractId: number; fallback: Loose; onUpdate: (c: Loose) => void; signal: AbortSignal }) => Promise<Loose>;
    isAuthorized: () => boolean;
    now: () => number;
    lastTickAt: (symbol: string) => number | null;
    isFeedLive: () => boolean;
    connectFeed: () => void;
    describeFailure: (e: unknown) => { kind: string; message: string; outcomeUnknown: boolean };
    afterStop?: () => void;
    load: () => Partial<ExecConfig> | null;
    save: (c: ExecConfig) => void;
    loadTrades?: () => ExecTrade[];
    saveTrades?: (t: ExecTrade[]) => void;
    runningStage?: number;
    notRunningStage?: number;
};

const lastDigitOf = (v: unknown): number | null => {
    const s = String(v ?? '');
    const m = /(\d)\D*$/.exec(s);
    return m ? Number(m[1]) : null;
};

export class AiIntelExecutor {
    readonly moduleId = 'ai_intel';
    private cfg: ExecConfig;
    private stores: ExecStores | null = null;
    private running = false;
    private phase: ExecPhase = 'idle';
    private proposal: Proposal | null = null;
    private inFlight = false;
    private losses = 0;
    private rejections = 0;
    private cooldownUntil = 0;
    private runToken = 0;
    private session = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    private trades: ExecTrade[];
    private log: ExecSnapshot['log'] = [];
    private lastError: string | null = null;
    private stopMessage: string | null = null;
    private aborts = new Set<AbortController>();
    private listeners = new Set<() => void>();
    private snap: ExecSnapshot;
    private seq = 0;
    private disposeWatch: (() => void) | null = null;
    private watch: ((on: (runPanelRunning: boolean, active: string | null) => void) => () => void) | null = null;

    constructor(private io: ExecIO) {
        this.cfg = normalizeExec(io.load());
        this.trades = io.loadTrades?.() ?? [];
        this.snap = this.build();
    }

    subscribe = (l: () => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    };
    getSnapshot = (): ExecSnapshot => this.snap;
    isRunning = () => this.running;

    attach(stores: ExecStores, watch?: (on: (runPanelRunning: boolean, active: string | null) => void) => () => void) {
        this.stores = stores;
        this.watch = watch ?? null;
    }

    configure(patch: Partial<ExecConfig>) {
        if (this.running) return; // the running session's rules never change under it
        this.cfg = normalizeExec({ ...this.cfg, ...patch, recovery: { ...this.cfg.recovery, ...(patch.recovery ?? {}) } });
        this.io.save(this.cfg);
        this.emit();
    }

    private build(): ExecSnapshot {
        const n = nextTrade(this.cfg, this.losses);
        return {
            running: this.running,
            phase: this.phase,
            config: this.cfg,
            proposal: this.proposal,
            consecutiveLosses: this.losses,
            session: { ...this.session },
            trades: this.trades.slice(0, 200),
            log: this.log.slice(0, 60),
            lastError: this.lastError,
            stopMessage: this.stopMessage,
            next: { label: labelOf(n.contract), stake: n.stake, recovery: n.recovery, triggers: [...triggerSet(this.cfg, n.contract)] },
        };
    }

    private emit() {
        this.snap = this.build();
        this.listeners.forEach(l => l());
    }

    private addLog(kind: ExecSnapshot['log'][number]['kind'], text: string) {
        this.log = [{ at: this.io.now(), kind, text }, ...this.log].slice(0, 120);
    }

    /** Why the run cannot start, or null. */
    startBlocker(): string | null {
        const c = this.cfg;
        if (!this.stores) return 'Apex Intel is still starting. Try again in a moment.';
        if (!this.io.isAuthorized()) return 'Please log in to your Deriv account before trading.';
        if (c.stake < MIN_STAKE) return `Stake must be at least ${MIN_STAKE.toFixed(2)}.`;
        if (c.maxStake < c.stake) return 'Max stake is below the stake.';
        if (c.entry === 'CUSTOM' && c.customDigits.length === 0) return 'Pick at least one entry digit for CUSTOM.';
        if (c.mode === 'AUTO' && !c.autoAuthorised) return 'AUTO needs your explicit authorisation: tick the box that says it trades without asking.';
        if (c.stopLoss === 0 && c.maxTrades === 0 && c.targetProfit === 0) return 'Set at least one limit: stop loss, target profit or max trades.';
        return null;
    }

    start() {
        if (this.running) return;
        const blocker = this.startBlocker();
        if (blocker) {
            this.lastError = blocker;
            return this.emit();
        }
        const stores = this.stores as ExecStores;
        try {
            const other = stores.dashboard.active_trading_module;
            if (other && other !== this.moduleId) stores.dashboard.stopActiveTradingModule();
        } catch {
            /* a failing foreign stop handler must not block Run */
        }
        this.lastError = null;
        this.stopMessage = null;
        this.losses = 0;
        this.rejections = 0;
        this.cooldownUntil = 0;
        this.proposal = null;
        this.inFlight = false;
        this.session = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        this.runToken += 1;
        this.running = true;
        this.phase = 'waiting';
        try {
            stores.run_panel.setIsRunning(true);
            stores.run_panel.setRunId(`apex-intel-${this.io.now()}`);
            if (this.io.runningStage !== undefined) stores.run_panel.setContractStage?.(this.io.runningStage);
            stores.run_panel.toggleDrawer(true);
        } catch {
            /* optional run-panel mount failures are ignored */
        }
        stores.dashboard.setActiveTradingModule(this.moduleId);
        stores.dashboard.registerTradingStopHandler(this.moduleId, () => this.stop('Stopped from the Run Panel'));
        this.disposeWatch?.();
        this.disposeWatch =
            this.watch?.((runPanelRunning, active) => {
                if (!this.running) return;
                if (!runPanelRunning) this.stop('Stopped from the Run Panel');
                else if (active && active !== this.moduleId) this.stop('Another trading module took over the Run Panel');
            }) ?? null;
        if (!this.io.isFeedLive()) {
            this.addLog('info', 'Connecting to the live market feed.');
            this.io.connectFeed();
        }
        const n = nextTrade(this.cfg, 0);
        this.addLog(
            'info',
            `Started: ${labelOf(n.contract)} on ${this.cfg.market}, stake ${n.stake.toFixed(2)}, entry ${this.cfg.entry}, ${this.cfg.mode === 'AUTO' ? 'AUTO (buys by itself)' : 'ASSISTED (you confirm each trade)'}.`
        );
        this.emit();
    }

    /** Immediate stop. Always works, also mid-trade: an open contract stays on the account and settles on its own. */
    stop(reason = 'Stopped') {
        if (!this.running) return;
        this.running = false;
        this.runToken += 1;
        this.phase = 'idle';
        this.proposal = null;
        this.inFlight = false;
        this.stopMessage = reason;
        this.aborts.forEach(c => c.abort());
        this.aborts.clear();
        this.disposeWatch?.();
        this.disposeWatch = null;
        if (this.stores) {
            const { run_panel, dashboard } = this.stores;
            dashboard.unregisterTradingStopHandler(this.moduleId);
            if (dashboard.active_trading_module === this.moduleId) dashboard.setActiveTradingModule(null);
            try {
                run_panel.is_contract_buying_in_progress = false;
                run_panel.setIsRunning(false);
                run_panel.setHasOpenContract?.(false);
                if (this.io.notRunningStage !== undefined) run_panel.setContractStage?.(this.io.notRunningStage);
                run_panel.setShowBotStopMessage?.(false);
            } catch {
                /* optional run-panel cleanup failures are ignored */
            }
        }
        try {
            this.io.afterStop?.();
        } catch {
            /* optional cleanup failures are ignored */
        }
        this.addLog('warn', reason);
        this.emit();
    }

    /** Drop a prepared ASSISTED trade. */
    dismissProposal() {
        if (!this.proposal) return;
        this.proposal = null;
        if (this.running && !this.inFlight) this.phase = 'waiting';
        this.emit();
    }

    /** Every live tick of every market. Only the configured market matters. */
    handleTick(symbol: string, digit: number) {
        if (!this.running || symbol !== this.cfg.market) return;
        const now = this.io.now();
        if (this.proposal && now > this.proposal.expiresAt) {
            this.addLog('info', `Dropped the ${this.proposal.label} signal: not confirmed in time, the trigger tick is stale.`);
            this.proposal = null;
            this.phase = 'waiting';
            this.emit();
        }
        if (this.inFlight || this.proposal || now < this.cooldownUntil) return;
        if (this.limitReached()) return;
        const n = nextTrade(this.cfg, this.losses);
        if (!triggerSet(this.cfg, n.contract).has(digit)) return;
        const check = this.stakeCheck(n.stake);
        if (check) return this.stop(check);
        const label = labelOf(n.contract);
        if (this.cfg.mode === 'AUTO') {
            void this.execute({ contract: n.contract, label, stake: n.stake, recovery: n.recovery, step: n.step, triggerDigit: digit, expiresAt: now });
        } else {
            this.proposal = { contract: n.contract, label, stake: n.stake, recovery: n.recovery, step: n.step, triggerDigit: digit, expiresAt: now + PROPOSAL_TTL_MS };
            this.phase = 'ready';
            this.addLog('info', `Signal: entry digit ${digit}. ${label}${n.recovery ? ' (recovery)' : ''}, stake ${n.stake.toFixed(2)} is ready. Confirm within ${PROPOSAL_TTL_MS / 1000}s.`);
            this.emit();
        }
    }

    /** ASSISTED: the person authorises the prepared trade. */
    confirmProposal() {
        const p = this.proposal;
        if (!this.running || !p) return;
        if (this.io.now() > p.expiresAt) {
            this.proposal = null;
            this.phase = 'waiting';
            this.addLog('info', 'That signal expired before it was confirmed.');
            return this.emit();
        }
        this.proposal = null;
        void this.execute(p);
    }

    private stakeCheck(stake: number): string | null {
        if (stake > this.cfg.maxStake) return `Stopped: the next stake ${stake.toFixed(2)} is above your max stake ${this.cfg.maxStake.toFixed(2)}.`;
        if (this.cfg.recovery.enabled && this.losses > this.cfg.recovery.maxSteps) return `Stopped: ${this.losses} losses in a row, past your ${this.cfg.recovery.maxSteps} recovery steps.`;
        if (this.cfg.stopLoss > 0 && this.session.pnl - stake < -this.cfg.stopLoss) return `Stopped: another stake of ${stake.toFixed(2)} could take the session loss past your stop loss of ${this.cfg.stopLoss.toFixed(2)}.`;
        return null;
    }

    private limitReached(): boolean {
        const c = this.cfg;
        if (c.targetProfit > 0 && this.session.pnl >= c.targetProfit) {
            this.stop(`Target profit reached (${this.session.pnl.toFixed(2)}).`);
            return true;
        }
        if (c.stopLoss > 0 && this.session.pnl <= -c.stopLoss) {
            this.stop(`Stop loss reached (${this.session.pnl.toFixed(2)}).`);
            return true;
        }
        if (c.maxTrades > 0 && this.session.trades >= c.maxTrades) {
            this.stop(`Max trades reached (${this.session.trades}).`);
            return true;
        }
        return false;
    }

    private pushContract(data: Loose) {
        if (!this.stores) return;
        try {
            const { transactions, run_panel, summary_card } = this.stores;
            transactions.pushTransaction({ ...data, run_id: run_panel.run_id });
            run_panel.onBotContractEvent(data);
            summary_card.onBotContractEvent(data);
        } catch {
            /* observer emit failures are ignored */
        }
    }

    private persistTrades() {
        try {
            this.io.saveTrades?.(this.trades.slice(0, HISTORY_LIMIT));
        } catch {
            /* storage may be unavailable */
        }
    }

    private async execute(p: Proposal) {
        if (!this.running || this.inFlight) return;
        const symbol = this.cfg.market;
        const lastTick = this.io.lastTickAt(symbol);
        if (!this.io.isAuthorized()) return this.stop('Stopped: disconnected from Deriv.');
        if (lastTick === null || this.io.now() - lastTick > FRESH_TICK_MS) {
            this.addLog('warn', 'Skipped a signal: the market feed is stale.');
            this.phase = 'waiting';
            return this.emit();
        }
        const contractType = DERIV_TYPE[p.contract.side];
        if (!contractType) return this.stop('Stopped: unsupported contract.');
        // Set before any await: a second order cannot start while this one is being sent.
        this.inFlight = true;
        this.phase = 'buying';
        const token = this.runToken;
        const currency = this.stores?.client?.currency || 'USD';
        const startedAt = Math.floor(this.io.now() / 1000);
        const stake = money(p.stake);
        const parameters: Loose = {
            amount: stake,
            basis: 'stake',
            contract_type: contractType,
            currency,
            duration: this.cfg.duration,
            duration_unit: 't',
            symbol,
            barrier: String(p.contract.param),
        };
        const base: Loose = {
            display_name: symbol,
            underlying_symbol: symbol,
            shortcode: `APEX_INTEL_${contractType}_${symbol}`,
            contract_type: contractType,
            currency,
            date_start: startedAt,
            verification_id: `${symbol}_${startedAt}_${Math.random().toString(36).slice(2, 11)}`,
        };
        this.emit();
        let contractId = 0;
        const abort = new AbortController();
        try {
            const sentAt = this.io.now();
            const buy = await this.io.buy({ parameters, price: stake });
            contractId = buy.contract_id;
            this.rejections = 0;
            const opened: Loose = { ...base, buy_price: buy.buy_price, contract_id: buy.contract_id, transaction_ids: { buy: buy.transaction_id } };
            this.pushContract(opened);
            const record: ExecTrade = {
                id: `${startedAt}-${++this.seq}`,
                contractId,
                at: this.io.now(),
                market: symbol,
                label: p.label,
                recovery: p.recovery,
                step: p.step,
                stake,
                duration: this.cfg.duration,
                triggerDigit: p.triggerDigit,
                exitDigit: null,
                profit: null,
                status: 'open',
            };
            this.trades = [record, ...this.trades].slice(0, HISTORY_LIMIT);
            this.addLog('trade', `Bought ${p.label}${p.recovery ? ` (recovery step ${p.step})` : ''} on ${symbol}, stake ${stake.toFixed(2)}, entry digit ${p.triggerDigit}. Confirmed in ${Math.max(0, this.io.now() - sentAt)} ms.`);
            if (token !== this.runToken) {
                this.inFlight = false;
                return this.emit(); // stopped while buying: the contract is on the account, the run is over
            }
            this.phase = 'settling';
            this.aborts.add(abort);
            this.emit();
            const settled = await this.io.settle({
                contractId,
                fallback: opened,
                onUpdate: snapshot => {
                    if (token === this.runToken) this.pushContract(snapshot);
                },
                signal: abort.signal,
            });
            this.aborts.delete(abort);
            if (token !== this.runToken) {
                this.inFlight = false;
                return;
            }
            const final = Boolean(settled.is_sold) || ['won', 'lost', 'sold'].includes(String(settled.status ?? '').toLowerCase());
            const profit = Number(settled.profit);
            if (!final || !Number.isFinite(profit)) {
                this.lastError = 'Contract result was not confirmed in time. Counted as unconfirmed; the run stopped. Check your Deriv statement.';
                this.finish(record, null, null);
                return this.stop('Stopped: a contract result was not confirmed. Check your Deriv statement before trading again.');
            }
            const exit = lastDigitOf(settled.exit_tick_display_value ?? settled.exit_spot_display_value ?? settled.exit_spot ?? settled.sell_spot_display_value ?? settled.sell_spot ?? settled.exit_tick);
            this.finish(record, profit, exit);
        } catch (error) {
            this.aborts.delete(abort);
            this.inFlight = false;
            if (token !== this.runToken) return;
            if (contractId) {
                const t = this.trades.find(x => x.contractId === contractId);
                if (t) this.finish(t, null, null);
                return this.stop('Stopped: lost track of an open contract. Check your Deriv statement.');
            }
            const failure = this.io.describeFailure(error);
            this.lastError = failure.message;
            // A purchase that got no answer may exist. Never retry.
            if (failure.outcomeUnknown || failure.kind === 'fatal') return this.stop(`Stopped: ${failure.message}`);
            this.rejections += 1;
            this.phase = 'waiting';
            this.addLog('warn', `Purchase refused: ${failure.message}`);
            this.cooldownUntil = this.io.now() + 1500;
            if (this.rejections >= MAX_REJECTIONS_IN_A_ROW) return this.stop(`Stopped: Deriv refused ${this.rejections} purchases in a row. Last: ${failure.message}`);
            this.emit();
        }
    }

    private finish(trade: ExecTrade, profit: number | null, exitDigit: number | null) {
        this.inFlight = false;
        this.cooldownUntil = this.io.now() + COOLDOWN_MS;
        if (this.running) this.phase = 'waiting';
        this.session.trades += 1;
        if (profit === null) {
            trade.status = 'unconfirmed';
        } else {
            const won = profit > 0;
            trade.profit = profit;
            trade.exitDigit = exitDigit;
            trade.status = won ? 'won' : 'lost';
            this.session.pnl = money(this.session.pnl + profit);
            if (won) {
                this.session.wins += 1;
                this.losses = 0;
            } else {
                this.session.losses += 1;
                this.losses += 1;
            }
            this.addLog(won ? 'win' : 'loss', `${trade.label} ${won ? 'won' : 'lost'} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}${exitDigit === null ? '' : `, exit digit ${exitDigit}`}. Session ${this.session.pnl >= 0 ? '+' : ''}${this.session.pnl.toFixed(2)}.`);
        }
        this.persistTrades();
        this.emit();
        if (this.running) this.limitReached();
    }
}
