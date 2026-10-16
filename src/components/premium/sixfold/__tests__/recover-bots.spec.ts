import fs from 'fs';
import path from 'path';
import {
    configureRecoverBot,
    isValidBarrier,
    readRecoverBot,
    RECOVER_BOTS,
    type RecoverSignal,
    structureOf,
    verifyRecoverBot,
} from '../recover-bots';

const LIBRARY = path.join(process.cwd(), 'public/free-bots');
const read = (asset: string) => fs.readFileSync(path.join(LIBRARY, asset), 'utf8');
const domain = JSON.parse(read('domains/apex-sentinel.json')) as {
    count: number;
    bots: { id: string; name: string; asset: string; priority: number }[];
};
const entry = (id: string) => {
    const found = domain.bots.find(bot => bot.id === id);
    if (!found) throw new Error(`${id} is not in the Ultimate Traders bot list.`);
    return found;
};
const UNDER_XML = read(entry(RECOVER_BOTS.DIGITUNDER.id).asset);
const OVER_XML = read(entry(RECOVER_BOTS.DIGITOVER.id).asset);

describe('Recover bandwagon bots in the bot list', () => {
    it('are listed as bots 106 and 107 and the count matches', () => {
        expect(entry(RECOVER_BOTS.DIGITUNDER.id).name).toMatch(/^106\. Recover Under/);
        expect(entry(RECOVER_BOTS.DIGITOVER.id).name).toMatch(/^107\. Recover Over/);
        expect(domain.count).toBe(domain.bots.length);
        expect(new Set(domain.bots.map(b => b.priority)).size).toBe(domain.bots.length);
    });
    it('read back as the original bots', () => {
        expect(readRecoverBot(UNDER_XML)).toMatchObject({
            purchases: ['DIGITUNDER'],
            list: [9, 8, 6, 5],
            start: 1,
            first: 9,
            symbol: '1HZ25V',
        });
        expect(readRecoverBot(OVER_XML)).toMatchObject({
            purchases: ['DIGITOVER'],
            list: [0, 1, 2, 4],
            start: 1,
            first: 0,
            symbol: '1HZ25V',
        });
    });
});

describe('configureRecoverBot', () => {
    const under: RecoverSignal = { symbol: 'R_50', contract: 'DIGITUNDER', barrier: 3 };
    const over: RecoverSignal = { symbol: '1HZ10V', contract: 'DIGITOVER', barrier: 2 };

    it('writes the market and the first barrier into the Under bot and leaves the rest alone', () => {
        const out = configureRecoverBot(UNDER_XML, under);
        expect(readRecoverBot(out)).toMatchObject({
            symbol: 'R_50',
            submarket: 'random_index',
            list: [3, 8, 6, 5],
            first: 3,
            purchases: ['DIGITUNDER'],
        });
        expect(structureOf(out)).toEqual(structureOf(UNDER_XML));
    });
    it('writes the market and the first barrier into the Over bot, using the 1s submarket', () => {
        const out = configureRecoverBot(OVER_XML, over);
        expect(readRecoverBot(out)).toMatchObject({
            symbol: '1HZ10V',
            submarket: 'random_index_1s',
            list: [2, 1, 2, 4],
            first: 2,
        });
        expect(structureOf(out)).toEqual(structureOf(OVER_XML));
    });
    it('keeps stake, martingale and take profit exactly as the bot has them', () => {
        const numbers = (xml: string) =>
            Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('field'))
                .filter(f => f.getAttribute('name') === 'NUM')
                .map(f => f.textContent);
        const before = numbers(UNDER_XML);
        const after = numbers(configureRecoverBot(UNDER_XML, under));
        expect(after.length).toBe(before.length);
        expect(after.filter((v, i) => v !== before[i]).length).toBe(1);
    });
    it('rejects barriers that are not real contracts', () => {
        expect(() => configureRecoverBot(OVER_XML, { ...over, barrier: 9 })).toThrow(/not a valid/);
        expect(() => configureRecoverBot(UNDER_XML, { ...under, barrier: 0 })).toThrow(/not a valid/);
        expect(isValidBarrier('DIGITOVER', 8)).toBe(true);
        expect(isValidBarrier('DIGITUNDER', 1)).toBe(true);
    });
    it('refuses to put an Over signal into the Under bot', () => {
        const out = configureRecoverBot(UNDER_XML, under);
        expect(() => verifyRecoverBot(out, { ...under, contract: 'DIGITOVER', barrier: 3 })).toThrow(/buys DIGITUNDER/);
    });
});
