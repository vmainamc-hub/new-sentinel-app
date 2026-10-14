import fs from 'fs';
import path from 'path';
import {
    MASIKA_BOT_IDS, configureMasikaBot, predictionListFor, readBot, structureOf, submarketFor, verifyBot, type BotSignal,
} from '../signal-zone-bot';
import { DEFAULT_SETTINGS } from '../signal-zone-settings';

const LIBRARY = path.join(process.cwd(), 'public/free-bots/uploads/apex-sentinel/apex-library');
const OVER = fs.readFileSync(path.join(LIBRARY, 'apex-library-the-masika-strike-over-bot-50.xml'), 'utf8');
const UNDER = fs.readFileSync(path.join(LIBRARY, 'apex-library-the-masika-strike-under-bot-51.xml'), 'utf8');

const overSignal: BotSignal = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 2, entryDigit: 7 };
const underSignal: BotSignal = { symbol: '1HZ25V', contract: 'DIGITUNDER', barrier: 8, entryDigit: 4 };
const settings = { ...DEFAULT_SETTINGS, stake: 1.5, martingaleMultiplier: 2.2, martingaleLevel: 3, takeProfit: 4, maxStake: 9 };

describe('bot ids', () => {
    it('point at the two Masika bots in the catalogue', () => {
        expect(MASIKA_BOT_IDS.DIGITOVER).toBe('apex-library-the-masika-strike-over-bot-50');
        expect(MASIKA_BOT_IDS.DIGITUNDER).toBe('apex-library-the-masika-strike-under-bot-51');
    });
});

describe('prediction list', () => {
    it('uses the signal barrier for slots 1-2 and the side\'s recovery barrier for slots 3-4', () => {
        expect(predictionListFor(overSignal, settings)).toEqual([2, 2, 3, 3]);
        expect(predictionListFor(underSignal, settings)).toEqual([8, 8, 6, 6]);
    });
});

describe('submarket', () => {
    it('uses the live active symbols when there are any, else the shipped bots\' value', () => {
        expect(submarketFor('1HZ25V', [{ symbol: '1HZ25V', submarket: 'random_index_1s' }])).toBe('random_index_1s');
        expect(submarketFor('R_50')).toBe('random_index');
    });
});

describe('configureMasikaBot', () => {
    it('writes the signal and settings into the Over bot and reads them back', () => {
        const xml = configureMasikaBot(OVER, overSignal, settings);
        expect(readBot(xml)).toEqual({
            market: 'synthetic_index', submarket: 'random_index', symbol: 'R_50', tradeType: 'overunder', purchase: 'DIGITOVER',
            variables: { Stake: 1.5, Martangle: 2.2, 'Martangle Level': 3, 'Take Profit': 4, 'Max Stake': 9, 'Entry Point': 7 },
            predictions: [2, 2, 3, 3],
        });
    });
    it('writes the signal and settings into the Under bot', () => {
        const bot = readBot(configureMasikaBot(UNDER, underSignal, settings));
        expect(bot).toMatchObject({ symbol: '1HZ25V', purchase: 'DIGITUNDER', predictions: [8, 8, 6, 6] });
        expect(bot.variables['Entry Point']).toBe(4);
    });
    it('never changes the structure of the bot', () => {
        expect(structureOf(configureMasikaBot(OVER, overSignal, settings))).toEqual(structureOf(OVER));
        expect(structureOf(configureMasikaBot(UNDER, underSignal, settings))).toEqual(structureOf(UNDER));
    });
    it('refuses a signal on the wrong bot', () => {
        expect(() => configureMasikaBot(UNDER, overSignal, settings)).toThrow('the bot buys DIGITUNDER');
        expect(() => configureMasikaBot(OVER, underSignal, settings)).toThrow('the bot buys DIGITOVER');
    });
    it('refuses contracts outside the allowed set', () => {
        expect(() => configureMasikaBot(OVER, { ...overSignal, barrier: 4 }, settings)).toThrow('not a permitted contract');
        expect(() => configureMasikaBot(UNDER, { ...underSignal, barrier: 5 }, settings)).toThrow('not a permitted contract');
    });
    it('refuses a bad entry digit, stake or recovery barrier', () => {
        expect(() => configureMasikaBot(OVER, { ...overSignal, entryDigit: 10 }, settings)).toThrow('entry digit');
        expect(() => configureMasikaBot(OVER, overSignal, { ...settings, stake: 0.1 })).toThrow('stake');
        expect(() => configureMasikaBot(OVER, overSignal, { ...settings, maxStake: 1 })).toThrow('max stake');
        expect(() => configureMasikaBot(OVER, overSignal, { ...settings, recoveryOverBarrier: 6 })).toThrow('barrier outside');
    });
    it('rejects XML that is not a bot it understands', () => {
        expect(() => configureMasikaBot('<xml><oops></xml>', overSignal, settings)).toThrow();
        expect(() => configureMasikaBot('<xml xmlns="https://developers.google.com/blockly/xml"></xml>', overSignal, settings)).toThrow();
    });
    it('catches a bot that does not carry the requested values', () => {
        const xml = configureMasikaBot(OVER, overSignal, settings);
        expect(() => verifyBot(xml, { ...overSignal, entryDigit: 3 }, settings)).toThrow('"Entry Point"');
    });
});
