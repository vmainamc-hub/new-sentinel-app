// A contract the run panel never saw finish (lost sell event, closed tab, ...) stays "pending" in the saved
// transaction list and is shown on every visit. No bot here holds a contract open for a day, so an unfinished
// contract older than this is dead data and is dropped.
export const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

type TStoredElement = {
    type: string;
    data?: unknown;
};

// Stored start times look like "2026-11-5 07:55:07 GMT" (month and day are not zero padded).
export const parseStoredGmtDate = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/.exec(String(value ?? ''));
    if (!match) return NaN;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return Date.UTC(year, month - 1, day, hour, minute, second);
};

export const isStalePendingContract = (element: TStoredElement, now = Date.now()): boolean => {
    const contract = element?.data as { is_completed?: boolean; date_start?: unknown } | undefined;
    if (element?.type !== 'contract' || !contract || typeof contract !== 'object') return false;
    if (contract.is_completed) return false;

    const started = parseStoredGmtDate(contract.date_start);
    // Unknown start time: keep it, we cannot prove it is stale.
    return Number.isFinite(started) && now - started > STALE_PENDING_MS;
};

export const removeStalePendingContracts = <T extends TStoredElement>(elements: T[], now = Date.now()): T[] =>
    Array.isArray(elements) ? elements.filter(element => !isStalePendingContract(element, now)) : elements;

export const removeStalePendingFromCache = (cache: Record<string, any[]>, now = Date.now()) => {
    const cleaned: Record<string, any[]> = {};
    Object.keys(cache || {}).forEach(account => {
        cleaned[account] = removeStalePendingContracts(cache[account], now);
    });
    return cleaned;
};
