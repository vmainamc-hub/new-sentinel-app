// Shared classification of Deriv trade-request failures.
//
// Why this exists: a rejected contract (e.g. `InvalidContractProposal`: Deriv does not offer that contract right
// now), a request that never answered (outcome UNKNOWN: it may or may not have been bought) and a fatal account
// problem all need different handling. Treating them alike either stopped whole sessions over one bad signal, or
// risked buying a second contract after a timeout.

export type TradeStage = 'proposal' | 'buy' | 'request';

/** What the caller should do next. */
export type TradeFailureKind =
    /** Deriv explicitly refused this contract. Nothing was bought. Skip this signal, keep the session alive. */
    | 'rejected'
    /** No answer in time. For `buy` the contract MAY exist: never retry blindly. */
    | 'timeout'
    /** Account / balance / permission problem. Retrying cannot help. Stop. */
    | 'fatal'
    /** Anything else (network blip, rate limit). Safe to try again later. */
    | 'transient';

export class TradeRequestError extends Error {
    readonly stage: TradeStage;
    readonly kind: TradeFailureKind;
    readonly code?: string;
    /** True only when a purchase was sent and we do not know whether it went through. */
    readonly outcomeUnknown: boolean;

    constructor(
        message: string,
        options: { stage: TradeStage; kind: TradeFailureKind; code?: string; outcomeUnknown?: boolean }
    ) {
        super(message);
        this.name = 'TradeRequestError';
        this.stage = options.stage;
        this.kind = options.kind;
        this.code = options.code;
        this.outcomeUnknown = Boolean(options.outcomeUnknown);
    }
}

/** Deriv error codes that mean "this exact contract cannot be offered / bought right now". Nothing was bought. */
export const REJECTED_CODES = new Set([
    'InvalidContractProposal',
    'OfferingsValidationError',
    'ContractCreationFailure',
    'ContractBuyValidationError',
    'MarketIsClosed',
    'InvalidSymbol',
    'InvalidtoBuy',
    'PriceMoved',
    'ProposalExpired',
]);

/** Deriv error codes that cannot be fixed by retrying: stop the session. */
export const FATAL_CODES = new Set([
    'InvalidToken',
    'AuthorizationRequired',
    'AccountDisabled',
    'PermissionDenied',
    'InsufficientBalance',
    'TradingDisabled',
]);

export const FATAL_MESSAGE = /balance|authori[sz]|not logged|log in|insufficient|account|permission/i;
export const REJECTED_MESSAGE =
    /unknown contract proposal|invalid ?contract ?proposal|not offered|market is presently closed/i;

export const classifyApiError = (code: string | undefined, message: string): TradeFailureKind => {
    if (code && FATAL_CODES.has(code)) return 'fatal';
    if (code && REJECTED_CODES.has(code)) return 'rejected';
    if (REJECTED_MESSAGE.test(message)) return 'rejected';
    if (FATAL_MESSAGE.test(message)) return 'fatal';
    return 'transient';
};

export type TradeFailure = { kind: TradeFailureKind; message: string; outcomeUnknown: boolean };

/** Works for TradeRequestError, plain Errors and Deriv's raw `{ error: { code, message } }` rejections. */
export const describeTradeFailure = (error: unknown, fallback = 'Contract purchase failed.'): TradeFailure => {
    if (error instanceof TradeRequestError) {
        return { kind: error.kind, message: error.message, outcomeUnknown: error.outcomeUnknown };
    }
    const raw = error as { error?: { code?: string; message?: string }; message?: string; code?: string } | null;
    const code = raw?.error?.code ?? raw?.code;
    const text =
        error instanceof Error && error.message ? error.message : raw?.error?.message || raw?.message || fallback;
    const message = code && !text.includes(code) ? `${text} (${code})` : text;
    return { kind: classifyApiError(code, message), message, outcomeUnknown: false };
};
