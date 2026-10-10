// SENTINEL AI — signal mapper.
//
// Converts the engine's surfaced RankedOpportunity into the frontend's SentinelAiSignal. Read-only:
// it never changes, re-ranks or filters what the engine produced, and it never invents an entry digit.
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { SentinelAiSignal } from './sentinel-ai-types';

export const signalKeyOf = (opp: Pick<RankedOpportunity, 'symbol' | 'contract'>) =>
    `${opp.symbol}|${opp.contract.id}`;

const round = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
};

export const toSentinelAiSignal = (opp: RankedOpportunity, receivedAt: number): SentinelAiSignal => {
    const contract = opp.contract;
    const isOver = contract.side === 'OVER' || String(contract.id).startsWith('OVER');
    const barrier = Number.isFinite(Number(contract.barrier))
        ? Number(contract.barrier)
        : Number(String(contract.id).match(/\d+/)?.[0] ?? 7);

    const entry = opp.entryPoint;
    const preferred = entry?.preferred ?? null;
    const digit = preferred && Number.isInteger(preferred.digit) ? preferred.digit : null;
    const key = signalKeyOf(opp);

    return {
        id: `${key}@${receivedAt}`,
        key,
        symbol: opp.symbol,
        marketName: opp.name || opp.symbol,
        contractId: String(contract.id),
        contractType: isOver ? 'DIGITOVER' : 'DIGITUNDER',
        barrier,
        label: contract.label || `${isOver ? 'Over' : 'Under'} ${barrier}`,
        entryDigit: digit,
        entryStatus: entry?.status ?? 'UNKNOWN',
        entryWindow: entry?.window?.label ?? '',
        entryWinRate: preferred && Number.isFinite(preferred.pWin) ? Math.round(preferred.pWin * 1000) / 10 : null,
        score: round(opp.score),
        confidence: round(contract.confidence),
        status: opp.signal?.label || opp.signal?.state || 'SIGNAL',
        reason: opp.signal?.reason ?? '',
        receivedAt,
    };
};

/** Same digit derivation the engine's tick bus uses: last digit of the quote at the market's pip size. */
export const digitFromQuote = (price: number, pipSize: number): number =>
    Math.abs(Math.round(price * Math.pow(10, pipSize))) % 10;
