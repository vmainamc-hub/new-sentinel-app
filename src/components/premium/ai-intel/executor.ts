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
import { type Contract, losingDigits, winningDigits, winProbability } from '@/components/premium/sixfold/bot';
import { profitMultiple } from '@/components/premium/sixfold/stats';
import { freshVh, vhAfterReal, vhAfterVirtual, type VhConfig, type VhMode, type VhState } from '@/components/premium/sixfold/virtual-hook';
import type { AiMode, GuardRequest, GuardVerdict } from './guard';
import { compileRule } from './rules';
import { bestPerMarket, contractOf, type Pick, type PickDirection, type PickEntry, type PickOptions, recoveryContract, type RecoveryPick } from './picker';

export type Direction = 'OVER_2' | 'UNDER_7';
/** AUTO: the best of fixed-digit, any-tick and your ACTIVE strategies. */
export type ExecEntry = 'AUTO' | 'SETUP' | 'ANY';
/** AUTO buys by itself on every qualifying tick. ASSISTED prepares the contract and waits for your click. */
export type ExecMode = 'ASSISTED' | 'AUTO';

export type ExecConfig = {
    /** Which primary contracts may be traded: Over 2, Under 7 or both. */
    directions: 'BOTH' | PickDirection;
    entry: ExecEntry;
    /** Markets left out. Every other fresh market is scanned on every tick. */
    excluded: string[];
    /** Contract length in ticks (1-10). */
    duration: number;
    stake: number;
    recovery: {
        enabled: boolean;
        /** Stake multiplier applied once per consecutive loss. */
        multiplier: number;
        /** After this many consecutive losses the run stops instead of raising the stake again. */
        maxSteps: number;
    };
    /** Stop when session loss reaches this amount (0 = off). */
    stopLoss: number;
    /** Stop when session profit reaches this amount (0 = off). */
    targetProfit: number;
    /** Stop after this many real trades (0 = off). */
    maxTrades: number;
    /** Only trade a market that beats chance after false-discovery control. */
    evidenceOnly: boolean;
    /** AI guard: every signal is checked just before it is bought. OFF / GUARD (blocks unsafe signals) / STRICT (needs proven edge). */
    ai: AiMode;
    /** Sixfold's Virtual Hook: after real losses, trade on paper (no money) until paper wins say go back. */
    virtualHook: { enabled: boolean; opening: boolean; mode: VhMode; enterLosses: number; returnWins: number; fixedCount: number };
    mode: ExecMode;
    /** AUTO needs this to be true: the person has read and accepted that it trades without asking. */
    autoAuthorised: boolean;
};

export const DEFAULT_EXEC: ExecConfig = {
    directions: 'BOTH',
    entry: 'AUTO',
    excluded: [],
    duration: 1,
    stake: 1,
    recovery: { enabled: true, multiplier: 2, maxSteps: 4 },
    stopLoss: 20,
    targetProfit: 10,
    maxTrades: 0,
    evidenceOnly: false,
    ai: 'GUARD',
    virtualHook: { enabled: true, opening: true, mode: 'STREAK', enterLosses: 2, returnWins: 2, fixedCount: 3 },
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
/** How often the live board (best contract and entry of every market) is rebuilt, and how many markets stay on it. */
export const BOARD_EVERY_MS = 2_000;
export const BOARD_TOP = 6;
/** A paper trade with no ticks for this long is dropped. */
const VIRTUAL_TIMEOUT_MS = 120_000;
const VIRTUAL_ID_BASE = 8_000_000_000;
/** Estimated platform margin for paper payouts (Sixfold's default). The real payout comes from Deriv. */
const PAPER_MARGIN = 0.05;

const clampInt = (x: unknown, lo: number, hi: number, fallback: number) => {
    const n = Math.trunc(Number(x));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const num = (x: unknown, fallback: number) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
export const money = (x: number) => Math.round(x * 100) / 100;

export function normalizeExec(raw: Partial<ExecConfig> | null | undefined): ExecConfig {
    const r = raw ?? {};
    const rec: Partial<ExecConfig['recovery']> = r.recovery ?? {};
    const vh: Partial<ExecConfig['virtualHook']> = r.virtualHook ?? {};
    const d = DEFAULT_EXEC;
    return {
        directions: r.directions === 'OVER_2' || r.directions === 'UNDER_7' ? r.directions : 'BOTH',
        entry: r.entry === 'SETUP' || r.entry === 'ANY' ? r.entry : 'AUTO',
        excluded: Array.isArray(r.excluded) ? [...new Set(r.excluded.filter(x => typeof x === 'string' && x))] : [],
        duration: clampInt(r.duration, 1, 10, d.duration),
        stake: money(Math.max(0, num(r.stake, d.stake))),
        recovery: {
            enabled: rec.enabled ?? d.recovery.enabled,
            multiplier: Math.max(1, Math.min(10, num(rec.multiplier, d.recovery.multiplier))),
            maxSteps: clampInt(rec.maxSteps, 1, 12, d.recovery.maxSteps),
        },
        stopLoss: money(Math.max(0, num(r.stopLoss, d.stopLoss))),
        targetProfit: money(Math.max(0, num(r.targetProfit, d.targetProfit))),
        maxTrades: clampInt(r.maxTrades, 0, 100000, d.maxTrades),
        evidenceOnly: Boolean(r.evidenceOnly),
        ai: r.ai === 'OFF' || r.ai === 'STRICT' ? r.ai : 'GUARD',
        virtualHook: {
            enabled: vh.enabled ?? d.virtualHook.enabled,
            opening: vh.opening ?? d.virtualHook.opening,
            mode: vh.mode === 'FIXED' ? 'FIXED' : 'STREAK',
            enterLosses: clampInt(vh.enterLosses, 1, 20, d.virtualHook.enterLosses),
            returnWins: clampInt(vh.returnWins, 1, 20, d.virtualHook.returnWins),
            fixedCount: clampInt(vh.fixedCount, 1, 50, d.virtualHook.fixedCount),
        },
        mode: r.mode === 'AUTO' ? 'AUTO' : 'ASSISTED',
        autoAuthorised: Boolean(r.autoAuthorised),
    };
}

/** The stake for the next trade after `consecutiveLosses` real losses, and whether it is a recovery trade. */
export function nextStake(cfg: ExecConfig, consecutiveLosses: number): { stake: number; recovery: boolean; step: number } {
    const recovering = cfg.recovery.enabled && consecutiveLosses > 0;
    return { stake: recovering ? money(cfg.stake * cfg.recovery.multiplier ** consecutiveLosses) : cfg.stake, recovery: recovering, step: recovering ? consecutiveLosses : 0 };
}

/** Does this digit arm an entry for this pick? SMART strategies also need their rule to hold on `history` (current tick included). */
export function armsOn(pick: Pick | RecoveryPick, contract: Contract, digit: number, history?: readonly number[]): boolean {
    if (pick.entry === 'ANY') return true;
    if (pick.entry === 'SETUP') return losingDigits(contract).includes(digit);
    const p = pick as Pick;
    if (!p.rule) return p.customDigits.includes(digit);
    if (!p.rule.digits.includes(digit)) return false;
    return history ? compileRule(p.rule, contract)(history) : false;
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
    /** A paper trade from the Virtual Hook: no money staked, not counted in the session. */
    virtual?: boolean;
};

export type ExecPhase = 'idle' | 'waiting' | 'ready' | 'buying' | 'settling';

export type Proposal = { ai?: string; market: string; contract: Contract; label: string; stake: number; recovery: boolean; step: number; triggerDigit: number; expiresAt: number };

export type VhStatus = { on: boolean; virtual: boolean; opening: boolean; open: boolean; realLosses: number; virtualWins: number; virtualDone: number };

export type ExecSnapshot = {
    running: boolean;
    phase: ExecPhase;
    config: ExecConfig;
    proposal: Proposal | null;
    consecutiveLosses: number;
    session: { trades: number; wins: number; losses: number; pnl: number };
    /** Paper trades of the Virtual Hook this run. */
    paper: { trades: number; wins: number; pnl: number };
    vh: VhStatus;
    trades: ExecTrade[];
    log: Array<{ at: number; kind: 'info' | 'warn' | 'trade' | 'win' | 'loss'; text: string }>;
    lastError: string | null;
    stopMessage: string | null;
    /** What would be bought next, shown even while waiting. */
    next: { label: string; stake: number; recovery: boolean; paper: boolean };
    /** The markets currently showing the best entries: main contract (Over 2 / Under 7) and, after a loss, recovery (Over 3 / Under 6). */
    board: { primary: Pick[]; recovery: RecoveryPick[] };
    /** Why nothing is tradable right now, or null. */
    note: string | null;
    /** The AI guard this run: signals it blocked and the last reason given. */
    aiGuard: { mode: AiMode; blocked: number; allowed: number; note: string | null };
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

export type PickRequest = Omit<PickOptions, 'candidates' | 'minTicks' | 'freshMs'>;

export type ExecIO = {
    buy: (a: { parameters: Loose; price: number }) => Promise<{ buy_price: number; contract_id: number; transaction_id: number }>;
    settle: (a: { contractId: number; fallback: Loose; onUpdate: (c: Loose) => void; signal: AbortSignal }) => Promise<Loose>;
    isAuthorized: () => boolean;
    now: () => number;
    lastTickAt: (symbol: string) => number | null;
    isFeedLive: () => boolean;
    connectFeed: () => void;
    /** Rank every market / direction / entry from the live feed (main contracts). */
    pick?: (opts: PickRequest) => Pick[];
    /** Rank Over 3 / Under 6 on every market (recovery contracts). */
    pickRecovery?: (opts: { duration: number; entries?: readonly PickEntry[] }) => RecoveryPick[];
    /** The AI guard: allow or block one signal. Absent means no guard. */
    review?: (req: GuardRequest) => GuardVerdict;
    /** Every board refresh: the full ranked lists (before one-per-market), for extra checks that read the whole book. */
    onBoard?: (ranked: readonly Pick[], recovery: readonly RecoveryPick[], now: number) => void;
    /** A real contract was bought / settled (profit null: result not confirmed). */
    onBought?: (n: { contractId: number; market: string; contract: Contract; recovery: boolean; stake: number }) => void;
    onSettled?: (n: { contractId: number; market: string; contract: Contract; recovery: boolean; stake: number; profit: number | null }) => void;
    /** Recent digits of a market (current tick included), for SMART strategy rules. */
    history?: (symbol: string) => readonly number[];
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

type VirtualOpen = { id: number; market: string; contract: Contract; stake: number; remaining: number; at: number };

type Plan = Proposal;

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
    private paper = { trades: 0, wins: 0, pnl: 0 };
    private vh: VhState = freshVh();
    private opening = false;
    private virtualOpen: VirtualOpen | null = null;
    private virtualCount = 0;
    private trades: ExecTrade[];
    private log: ExecSnapshot['log'] = [];
    private lastError: string | null = null;
    private stopMessage: string | null = null;
    private aborts = new Set<AbortController>();
    private listeners = new Set<() => void>();
    private snap: ExecSnapshot;
    private seq = 0;
    private board: ExecSnapshot['board'] = { primary: [], recovery: [] };
    private boardAt = 0;
    private note: string | null = null;
    private aiBlocked = 0;
    private aiAllowed = 0;
    private aiNote: string | null = null;
    private aiLogAt = new Map<string, number>();
    /** Real contracts awaiting their result: what was bought, for the settle notice. */
    private bought = new Map<string, { market: string; contract: Contract; recovery: boolean }>();
    private reconciling = false;
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
        this.cfg = normalizeExec({
            ...this.cfg,
            ...patch,
            recovery: { ...this.cfg.recovery, ...(patch.recovery ?? {}) },
            virtualHook: { ...this.cfg.virtualHook, ...(patch.virtualHook ?? {}) },
        });
        this.io.save(this.cfg);
        this.emit();
    }

    private entryKinds(): PickEntry[] | undefined {
        return this.cfg.entry === 'AUTO' ? undefined : [this.cfg.entry];
    }

    /** Rebuild the board: the best entry of every fresh market, top few. Never mid-contract (the choice is per tick, not per contract). */
    private refreshBoard(now: number, force = false) {
        if (!this.io.pick) return;
        if (!force && now - this.boardAt < BOARD_EVERY_MS) return;
        this.boardAt = now;
        const out = new Set(this.cfg.excluded);
        const rankedPrimary = this.io.pick({ duration: this.cfg.duration, evidenceOnly: this.cfg.evidenceOnly, directions: this.cfg.directions, entries: this.entryKinds() }).filter(p => !out.has(p.market));
        const primary = bestPerMarket(rankedPrimary).slice(0, BOARD_TOP);
        const recoveryEntries = this.entryKinds()?.filter((e): e is 'SETUP' | 'ANY' => e === 'SETUP' || e === 'ANY');
        const rankedRecovery =
            this.cfg.recovery.enabled && this.io.pickRecovery ? this.io.pickRecovery({ duration: this.cfg.duration, entries: recoveryEntries }).filter(p => !out.has(p.market)) : [];
        const recovery = bestPerMarket(rankedRecovery).slice(0, BOARD_TOP);
        try {
            this.io.onBoard?.(rankedPrimary, rankedRecovery, now);
        } catch {
            /* an extra look never stops the board */
        }
        const prevTop = this.board.primary[0]?.key;
        this.board = { primary, recovery };
        const recovering = this.cfg.recovery.enabled && this.losses > 0;
        const active = recovering ? recovery : primary;
        this.note = active.length
            ? null
            : this.cfg.evidenceOnly && !recovering
              ? 'No market beats chance after false-discovery control yet. Waiting (this is the normal result on random digits).'
              : 'Waiting for fresh data: a market needs 300+ recent ticks and a non-unstable regime.';
        if (this.running && primary[0] && primary[0].key !== prevTop && !recovering) {
            this.addLog('info', `Best entry now: ${primary[0].market} · ${primary[0].label}. ${primary[0].reason}.`);
        }
        this.emit();
    }

    private paperNow(): boolean {
        return this.cfg.virtualHook.enabled && this.vh.virtual;
    }

    private vhConfig(): VhConfig {
        const v = this.cfg.virtualHook;
        return { enterLosses: v.enterLosses, returnWins: v.returnWins, mode: v.mode, fixedCount: v.fixedCount };
    }

    private vhReturnText(): string {
        const v = this.cfg.virtualHook;
        return v.mode === 'FIXED' ? `${v.fixedCount} paper trades are done` : `${v.returnWins} paper win${v.returnWins > 1 ? 's' : ''} in a row`;
    }

    private build(): ExecSnapshot {
        const recovering = this.cfg.recovery.enabled && this.losses > 0;
        const n = nextStake(this.cfg, this.losses);
        const dirs = this.cfg.directions === 'OVER_2' ? 'Over 2' : this.cfg.directions === 'UNDER_7' ? 'Under 7' : 'Over 2 / Under 7';
        return {
            running: this.running,
            phase: this.phase,
            config: this.cfg,
            proposal: this.proposal,
            consecutiveLosses: this.losses,
            session: { ...this.session },
            paper: { ...this.paper },
            vh: { on: this.cfg.virtualHook.enabled, virtual: this.paperNow(), opening: this.opening, open: this.virtualOpen !== null, realLosses: this.vh.realLosses, virtualWins: this.vh.virtualWins, virtualDone: this.vh.virtualDone },
            trades: this.trades.slice(0, 200),
            log: this.log.slice(0, 60),
            lastError: this.lastError,
            stopMessage: this.stopMessage,
            next: { label: recovering ? 'Over 3 / Under 6' : dirs, stake: n.stake, recovery: n.recovery, paper: this.paperNow() },
            board: this.board,
            note: this.note,
            aiGuard: { mode: this.cfg.ai, blocked: this.aiBlocked, allowed: this.aiAllowed, note: this.aiNote },
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
        if (!this.io.pick) return 'Market scanning is not available in this build.';
        if (c.mode === 'AUTO' && !c.autoAuthorised) return 'Automatic trading needs your explicit authorisation: switch on "Trade automatically".';
        if (c.stopLoss === 0 && c.maxTrades === 0 && c.targetProfit === 0) return 'Set at least one limit: stop loss, take profit or max trades.';
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
        this.paper = { trades: 0, wins: 0, pnl: 0 };
        // Like Sixfold: with the Virtual Hook on, the run opens on paper and goes real after its first paper win.
        this.opening = this.cfg.virtualHook.enabled && this.cfg.virtualHook.opening;
        this.vh = this.opening ? { virtual: true, realLosses: 0, virtualWins: 0, virtualDone: 0 } : freshVh();
        this.virtualOpen = null;
        this.runToken += 1;
        this.board = { primary: [], recovery: [] };
        this.boardAt = 0;
        this.note = null;
        this.aiBlocked = 0;
        this.aiAllowed = 0;
        this.aiNote = null;
        this.aiLogAt.clear();
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
        this.addLog(
            'info',
            `Started: scanning all markets for the best entry (${this.cfg.directions === 'BOTH' ? 'Over 2 and Under 7' : this.cfg.directions === 'OVER_2' ? 'Over 2' : 'Under 7'}${this.cfg.recovery.enabled ? ', recovery with Over 3 or Under 6' : ''}), stake ${this.cfg.stake.toFixed(2)}, ${this.cfg.mode === 'AUTO' ? 'automatic' : 'you confirm each trade'}.${this.opening ? ' Opening on paper until the first paper win.' : ''}`
        );
        this.emit();
        this.refreshBoard(this.io.now(), true);
    }

    /** Immediate stop. Always works, also mid-trade: an open contract stays on the account and settles on its own. */
    stop(reason = 'Stopped') {
        if (!this.running) return;
        this.running = false;
        this.runToken += 1;
        this.phase = 'idle';
        this.proposal = null;
        this.inFlight = false;
        this.virtualOpen = null;
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

    /** What would be bought on this tick of this market, or null. Main contracts normally, Over 3 / Under 6 while recovering. */
    private plan(symbol: string, digit: number, now: number): { plan: Plan; src: Pick | RecoveryPick } | null {
        const n = nextStake(this.cfg, this.losses);
        let contract: Contract;
        let src: Pick | RecoveryPick;
        if (n.recovery) {
            const rp = this.board.recovery.find(p => p.market === symbol);
            if (!rp) return null;
            src = rp;
            contract = recoveryContract(rp.direction);
            if (!armsOn(rp, contract, digit)) return null;
        } else {
            const p = this.board.primary.find(x => x.market === symbol);
            if (!p) return null;
            src = p;
            contract = contractOf(p.direction);
            // A SMART strategy also needs its rule to hold on the recent ticks. No history: no trade.
            if (!armsOn(p, contract, digit, p.rule ? this.io.history?.(symbol) : undefined)) return null;
        }
        return { plan: { market: symbol, contract, label: labelOf(contract), stake: n.stake, recovery: n.recovery, step: n.step, triggerDigit: digit, expiresAt: now }, src };
    }

    /** The AI guard for one signal. Blocked signals are counted and logged (at most every 10 s per market). */
    private review(src: Pick | RecoveryPick, plan: Plan, now: number): GuardVerdict {
        if (this.cfg.ai === 'OFF' || !this.io.review) return { allow: true, reason: 'AI guard off' };
        let verdict: GuardVerdict;
        try {
            verdict = this.io.review({
                mode: this.cfg.ai,
                market: plan.market,
                contract: plan.contract,
                recovery: plan.recovery,
                strategyId: 'strategyId' in src ? src.strategyId : null,
                significant: 'significant' in src ? src.significant : false,
                trades: src.trades,
            });
        } catch {
            verdict = { allow: false, reason: 'the guard could not be evaluated' }; // fail closed
        }
        this.aiNote = verdict.reason;
        if (verdict.allow) {
            this.aiAllowed += 1;
        } else {
            this.aiBlocked += 1;
            const last = this.aiLogAt.get(plan.market) ?? 0;
            if (now - last >= 10_000) {
                this.aiLogAt.set(plan.market, now);
                this.addLog('info', `AI guard skipped ${plan.label} on ${plan.market}: ${verdict.reason}.`);
            }
            this.emit();
        }
        return verdict;
    }

    /** Every live tick of every market. All markets are watched; the one whose entry fires first among the best is traded. */
    handleTick(symbol: string, digit: number) {
        if (!this.running) return;
        const now = this.io.now();
        if (this.virtualOpen && now - this.virtualOpen.at > VIRTUAL_TIMEOUT_MS) {
            this.virtualOpen = null;
            this.addLog('warn', 'A paper trade never settled (no ticks arrived); it was dropped.');
            this.emit();
        }
        if (this.virtualOpen) {
            // One contract at a time, paper or real. Only its own market's ticks matter, and its settlement tick arms nothing.
            if (this.virtualOpen.market === symbol) this.virtualTick(digit);
            return;
        }
        this.refreshBoard(now);
        if (this.proposal && now > this.proposal.expiresAt) {
            this.addLog('info', `Dropped the ${this.proposal.label} signal on ${this.proposal.market}: not confirmed in time, the trigger tick is stale.`);
            this.proposal = null;
            this.phase = 'waiting';
            this.emit();
        }
        if (this.inFlight || this.proposal || now < this.cooldownUntil) return;
        if (this.limitReached()) return;
        const found = this.plan(symbol, digit, now);
        if (!found) return;
        const plan = found.plan;
        const verdict = this.review(found.src, plan, now);
        if (!verdict.allow) return;
        plan.ai = verdict.reason;
        if (this.paperNow()) return this.executeVirtual(plan);
        const check = this.stakeCheck(plan.stake);
        if (check) return this.stop(check);
        if (this.cfg.mode === 'AUTO') {
            void this.execute(plan);
        } else {
            this.proposal = { ...plan, expiresAt: now + PROPOSAL_TTL_MS };
            this.phase = 'ready';
            this.addLog('info', `Signal: ${plan.market}, entry digit ${digit}. ${plan.label}${plan.recovery ? ' (recovery)' : ''}, stake ${plan.stake.toFixed(2)} is ready. Confirm within ${PROPOSAL_TTL_MS / 1000}s.`);
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
        if (this.cfg.recovery.enabled && this.losses > this.cfg.recovery.maxSteps) return `Stopped: ${this.losses} losses in a row, past your ${this.cfg.recovery.maxSteps} recovery steps.`;
        if (this.cfg.stopLoss > 0 && this.session.pnl - stake < -this.cfg.stopLoss) return `Stopped: another stake of ${stake.toFixed(2)} could take the session loss past your stop loss of ${this.cfg.stopLoss.toFixed(2)}.`;
        return null;
    }

    private limitReached(): boolean {
        const c = this.cfg;
        if (c.targetProfit > 0 && this.session.pnl >= c.targetProfit) {
            this.stop(`Take profit reached (${this.session.pnl.toFixed(2)}).`);
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

    /** Paper trades show in the Transactions panel as Virtual rows and never reach the Run Panel totals. */
    private pushVirtual(data: Loose) {
        try {
            this.stores?.transactions.pushTransaction({ ...data, is_virtual_hook: 1, run_id: this.stores.run_panel.run_id });
        } catch {
            /* optional transactions-panel failures are ignored */
        }
    }

    private persistTrades() {
        try {
            this.io.saveTrades?.(this.trades.filter(t => !t.virtual).slice(0, HISTORY_LIMIT));
        } catch {
            /* storage may be unavailable */
        }
    }

    /** A paper trade: the same pick and entry as a real one, no purchase. It settles on the market's real ticks. */
    private executeVirtual(p: Plan) {
        const contractType = DERIV_TYPE[p.contract.side];
        if (!contractType) return;
        const id = VIRTUAL_ID_BASE + ++this.virtualCount;
        const startedAt = Math.floor(this.io.now() / 1000);
        this.virtualOpen = { id, market: p.market, contract: p.contract, stake: p.stake, remaining: Math.max(1, this.cfg.duration), at: this.io.now() };
        this.trades = [
            { id: `v${startedAt}-${++this.seq}`, contractId: id, at: this.io.now(), market: p.market, label: p.label, recovery: p.recovery, step: p.step, stake: p.stake, duration: this.cfg.duration, triggerDigit: p.triggerDigit, exitDigit: null, profit: null, status: 'open', virtual: true },
            ...this.trades,
        ].slice(0, HISTORY_LIMIT);
        this.pushVirtual({
            display_name: p.market,
            underlying_symbol: p.market,
            shortcode: `APEX_INTEL_VIRTUAL_${contractType}_${p.market}`,
            contract_type: contractType,
            contract_id: id,
            currency: this.stores?.client?.currency || 'USD',
            date_start: startedAt,
            buy_price: p.stake,
            barrier: String(p.contract.param),
            status: 'open',
            is_sold: 0,
            profit: 0,
            transaction_ids: { buy: id },
        });
        this.addLog('trade', `Paper ${p.label}${p.recovery ? ' (recovery)' : ''} on ${p.market}: no money staked.${p.ai ? ` AI: ${p.ai}.` : ''}`);
        this.phase = 'settling';
        this.emit();
    }

    private virtualTick(digit: number) {
        const v = this.virtualOpen;
        if (!v) return;
        v.remaining -= 1;
        if (v.remaining > 0) return;
        this.virtualOpen = null;
        const won = winningDigits(v.contract).includes(digit);
        const profit = won ? money(v.stake * profitMultiple(winProbability(v.contract), PAPER_MARGIN)) : -v.stake;
        const trade = this.trades.find(t => t.contractId === v.id);
        if (trade) {
            trade.profit = profit;
            trade.exitDigit = digit;
            trade.status = won ? 'won' : 'lost';
        }
        this.paper = { trades: this.paper.trades + 1, wins: this.paper.wins + (won ? 1 : 0), pnl: money(this.paper.pnl + profit) };
        this.pushVirtual({
            display_name: v.market,
            underlying_symbol: v.market,
            contract_type: DERIV_TYPE[v.contract.side],
            contract_id: v.id,
            buy_price: v.stake,
            sell_price: won ? v.stake + profit : 0,
            barrier: String(v.contract.param),
            status: won ? 'won' : 'lost',
            is_sold: 1,
            is_expired: 1,
            profit,
            exit_spot: String(digit),
            exit_digit: digit,
            virtual_result: won ? 'win' : 'loss',
            transaction_ids: { buy: v.id, sell: v.id },
        });
        this.addLog(won ? 'win' : 'loss', `Paper ${trade?.label ?? 'contract'} on ${v.market} ${won ? 'won' : 'lost'} (digit ${digit}). No money moved.`);
        if (this.opening) {
            // Opening spell: a loss means wait for a win on paper, a win means real trading starts now.
            if (won) {
                this.opening = false;
                this.vh = freshVh();
                this.addLog('info', 'Opening paper trade won. Real trading starts now.');
            } else {
                this.vh = { ...this.vh, virtualDone: this.vh.virtualDone + 1 };
                this.addLog('info', 'Opening paper trade lost. Staying on paper until one wins.');
            }
        } else {
            const step = vhAfterVirtual(this.vh, won, this.vhConfig());
            this.vh = step.state;
            if (step.event === 'returned') this.addLog('info', 'Virtual Hook: the paper trades did it. Back to real money.');
        }
        this.cooldownUntil = this.io.now() + COOLDOWN_MS;
        if (this.running) this.phase = 'waiting';
        this.emit();
    }

    private async execute(p: Proposal) {
        if (!this.running || this.inFlight) return;
        const symbol = p.market;
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
            this.bought.set(record.id, { market: symbol, contract: p.contract, recovery: p.recovery });
            try {
                this.io.onBought?.({ contractId, market: symbol, contract: p.contract, recovery: p.recovery, stake });
            } catch {
                /* never disturbs a live trade */
            }
            this.persistTrades(); // an open contract is saved, so a reload can find out how it ended
            this.addLog('trade', `Bought ${p.label}${p.recovery ? ` (recovery step ${p.step})` : ''} on ${symbol}, stake ${stake.toFixed(2)}, entry digit ${p.triggerDigit}. Confirmed in ${Math.max(0, this.io.now() - sentAt)} ms.${p.ai ? ` AI: ${p.ai}.` : ''}`);
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

    /**
     * After a page reload: any real contract saved as open is looked up on Deriv and its real result filled in. It never
     * touches a running session. A contract that cannot be confirmed is marked unconfirmed (check the Deriv statement).
     */
    async reconcile(timeoutMs = 20_000): Promise<number> {
        if (this.running || this.reconciling) return 0;
        const open = this.trades.filter(t => t.status === 'open' && !t.virtual && t.contractId);
        if (!open.length) return 0;
        this.reconciling = true;
        let done = 0;
        for (const t of open) {
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), timeoutMs);
            try {
                const settled = await this.io.settle({ contractId: t.contractId as number, fallback: { contract_id: t.contractId }, onUpdate: () => undefined, signal: abort.signal });
                const profit = Number(settled.profit);
                const final = Boolean(settled.is_sold) || ['won', 'lost', 'sold'].includes(String(settled.status ?? '').toLowerCase());
                if (final && Number.isFinite(profit)) {
                    t.profit = profit;
                    t.exitDigit = lastDigitOf(settled.exit_tick_display_value ?? settled.exit_spot_display_value ?? settled.exit_spot ?? settled.sell_spot_display_value ?? settled.sell_spot ?? settled.exit_tick);
                    t.status = profit > 0 ? 'won' : 'lost';
                    done += 1;
                    this.addLog(profit > 0 ? 'win' : 'loss', `Found the result of an earlier ${t.label} on ${t.market}: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}.`);
                } else {
                    t.status = 'unconfirmed';
                }
            } catch {
                t.status = 'unconfirmed';
            } finally {
                clearTimeout(timer);
            }
        }
        this.reconciling = false;
        this.persistTrades();
        this.emit();
        return done;
    }

    private finish(trade: ExecTrade, profit: number | null, exitDigit: number | null) {
        const meta = this.bought.get(trade.id);
        this.bought.delete(trade.id);
        if (meta) {
            try {
                this.io.onSettled?.({ contractId: trade.contractId ?? 0, ...meta, stake: trade.stake, profit });
            } catch {
                /* never disturbs a live session */
            }
        }
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
            if (this.cfg.virtualHook.enabled) {
                const step = vhAfterReal(this.vh, won, this.vhConfig());
                this.vh = step.state;
                if (step.event === 'entered') this.addLog('info', `Virtual Hook: ${this.vh.realLosses} real loss${this.vh.realLosses > 1 ? 'es' : ''} in a row. Trading on paper (no money) until ${this.vhReturnText()}.`);
            }
            this.addLog(won ? 'win' : 'loss', `${trade.label} on ${trade.market} ${won ? 'won' : 'lost'} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}${exitDigit === null ? '' : `, exit digit ${exitDigit}`}. Session ${this.session.pnl >= 0 ? '+' : ''}${this.session.pnl.toFixed(2)}.`);
        }
        this.persistTrades();
        this.emit();
        if (this.running) this.limitReached();
        if (this.running) this.refreshBoard(this.io.now(), true);
    }
}
