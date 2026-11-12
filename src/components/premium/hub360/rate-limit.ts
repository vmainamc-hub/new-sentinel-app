// Shared by the ported 360 pages (Overlord Pro, Elite Prime Lite / Pro).
//
// Deriv gives proposal, proposal_open_contract, buy and sell ONE shared budget (360 a minute). When a page goes over it
// Deriv answers with a RateLimit error. A page that ignores that answer is stuck for good: a contract whose
// "watch this contract" request was refused never reports its result. These helpers decide what to do instead
// (wait, then repeat the refused request) and how long to wait, so the pages never hammer Deriv or reconnect in a loop.

type DerivReply = {
    error?: { code?: string; message?: string };
    echo_req?: Record<string, unknown>;
    msg_type?: string;
};

export type RateLimitPlan = {
    /** resend_contract: ask again for the contract's updates. new_proposal: start a fresh trade cycle. wait: just pause. */
    kind: 'resend_contract' | 'new_proposal' | 'wait';
    delayMs: number;
    /** The refused call, for messages ("proposal_open_contract"). */
    callName: string;
    payload?: { proposal_open_contract: 1; contract_id: number; subscribe?: 1 };
};

type BackoffOptions = { baseMs?: number; maxMs?: number; jitter?: number; random?: () => number };

const IGNORED_ECHO_KEYS = new Set(['req_id', 'passthrough', 'subscribe']);

export const isRateLimitError = (data: DerivReply | null | undefined): boolean => {
    const error = data?.error;
    if (!error) return false;
    return error.code === 'RateLimit' || /rate ?limit/i.test(String(error.message ?? ''));
};

/** Exponential delay with jitter: base, 2x base, 4x base ... capped at maxMs (jitter adds up to 25% on top). */
export const backoffDelayMs = (attempt: number, options: BackoffOptions = {}): number => {
    const { baseMs = 1000, maxMs = 30_000, jitter = 0.25, random = Math.random } = options;
    const step = Math.max(0, Math.floor(Number(attempt)) || 0);
    const raw = Math.min(maxMs, baseMs * 2 ** Math.min(step, 20));
    return Math.round(raw + raw * jitter * random());
};

/** Wait before opening a socket again: 1 s, 2 s, 4 s ... up to 30 s. */
export const reconnectDelayMs = (attempt: number, random?: () => number): number =>
    backoffDelayMs(attempt, { baseMs: 1000, maxMs: 30_000, random });

/** Wait after a RateLimit error: 3 s, 6 s, 12 s ... up to 30 s. */
export const rateLimitDelayMs = (attempt: number, random?: () => number): number =>
    backoffDelayMs(attempt, { baseMs: 3000, maxMs: 30_000, random });

type PlanContext = {
    attempt?: number;
    isRunning?: boolean;
    isContractActive?: (contractId: string) => boolean;
    random?: () => number;
};

/** What to do about a Deriv reply. null when the reply is not a rate-limit error. */
export const planRateLimitRetry = (data: DerivReply | null | undefined, context: PlanContext = {}): RateLimitPlan | null => {
    if (!isRateLimitError(data)) return null;

    const { attempt = 0, isRunning = false, isContractActive = () => false, random } = context;
    const echo = data?.echo_req ?? {};
    const callName = Object.keys(echo).find(key => !IGNORED_ECHO_KEYS.has(key)) ?? data?.msg_type ?? 'request';
    const delayMs = rateLimitDelayMs(attempt, random);

    if (echo.proposal_open_contract !== undefined && echo.contract_id !== undefined) {
        const contractId = Number(echo.contract_id);
        if (!Number.isFinite(contractId) || !isContractActive(String(echo.contract_id))) {
            return { kind: 'wait', delayMs, callName };
        }
        return {
            kind: 'resend_contract',
            delayMs,
            callName,
            payload: { proposal_open_contract: 1, contract_id: contractId, ...(echo.subscribe ? { subscribe: 1 as const } : {}) },
        };
    }

    // A refused proposal or purchase bought nothing: the next cycle simply starts again after the pause.
    if ((echo.proposal !== undefined || echo.buy !== undefined) && isRunning) {
        return { kind: 'new_proposal', delayMs, callName };
    }

    return { kind: 'wait', delayMs, callName };
};
