// Sixfold: the small piece of the digit engine the simulator needs.
export type ContractSide = 'OVER' | 'UNDER' | 'EVEN' | 'ODD' | 'MATCHES' | 'DIFFERS';

/** Did this contract win on `digit`? `barrier` is the Over/Under barrier or the Matches/Differs digit. */
export function outcome(side: ContractSide, digit: number, barrier: number): boolean {
    switch (side) {
        case 'OVER':
            return digit > barrier;
        case 'UNDER':
            return digit < barrier;
        case 'EVEN':
            return digit % 2 === 0;
        case 'ODD':
            return digit % 2 === 1;
        case 'MATCHES':
            return digit === barrier;
        case 'DIFFERS':
            return digit !== barrier;
    }
}

/** Last digit of a quote at the market's number of decimals. */
export function digitFromQuote(quote: number, decimals: number): number {
    const places = Math.max(0, Math.min(10, Math.trunc(decimals)));
    const digits = Number(quote).toFixed(places).replace(/\D/g, '');
    return Number(digits.at(-1) ?? 0);
}

export function parseDigitsText(text: string): number[] {
    const values = text
        .split(/[\s,;\n\r]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(Number);
    if (values.some(n => !Number.isInteger(n) || n < 0 || n > 9)) {
        throw new Error('Import must contain only digits 0–9 separated by spaces, commas, or new lines.');
    }
    return values;
}
