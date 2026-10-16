import fs from 'fs';
import path from 'path';
import {
    DIGITS_BOT_IDS, configureDigitsBot, contractForTrade, marketOf, purchaseOf,
} from '../digits-analysis-loader';

const LIBRARY = path.join(process.cwd(), 'public/free-bots/uploads/apex-sentinel/apex-library');
const OVER = fs.readFileSync(path.join(LIBRARY, 'apex-library-masika-strategies-digit-over-105.xml'), 'utf8');
const UNDER = fs.readFileSync(path.join(LIBRARY, 'apex-library-masika-strategies-digit-under-104.xml'), 'utf8');

describe('bot ids', () => {
    it('point at bots 105 (Over) and 104 (Under) in the manifest', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/free-bots/domains/apex-sentinel.json'), 'utf8'));
        const byId = (id: string) => manifest.bots.find((bot: { id: string }) => bot.id === id);
        expect(byId(DIGITS_BOT_IDS.DIGITOVER)?.priority).toBe(105);
        expect(byId(DIGITS_BOT_IDS.DIGITUNDER)?.priority).toBe(104);
    });
});

describe('contractForTrade', () => {
    it('maps Over to the Over bot, Under to the Under bot and Even/Odd to nothing', () => {
        expect(contractForTrade({ side: 'over', barrier: 2, label: 'Over 2' })).toBe('DIGITOVER');
        expect(contractForTrade({ side: 'under', barrier: 7, label: 'Under 7' })).toBe('DIGITUNDER');
        expect(contractForTrade({ side: 'even', label: 'Even' })).toBeNull();
    });
});

describe('configureDigitsBot', () => {
    it('points the Over bot at the ranked market and keeps everything else', () => {
        const xml = configureDigitsBot(OVER, '1HZ10V', 'DIGITOVER');
        expect(marketOf(xml)).toEqual({ market: 'synthetic_index', submarket: 'random_index', symbol: '1HZ10V' });
        expect(purchaseOf(xml)).toBe('DIGITOVER');
        const strip = (text: string) => text.replace(/<field name="SYMBOL_LIST">[^<]*<\/field>/, '');
        expect(strip(xml).length).toBe(strip(OVER).length);
    });

    it('points the Under bot at the ranked market', () => {
        const xml = configureDigitsBot(UNDER, 'R_100', 'DIGITUNDER', [{ symbol: 'R_100', submarket: 'random_index' }]);
        expect(marketOf(xml).symbol).toBe('R_100');
        expect(purchaseOf(xml)).toBe('DIGITUNDER');
    });

    it('refuses a bot that buys the other side', () => {
        expect(() => configureDigitsBot(UNDER, 'R_100', 'DIGITOVER')).toThrow(/buys DIGITUNDER/);
        expect(() => configureDigitsBot(OVER, 'R_100', 'DIGITUNDER')).toThrow(/buys DIGITOVER/);
    });

    it('refuses invalid XML and an empty market', () => {
        expect(() => configureDigitsBot('<xml>', 'R_100', 'DIGITOVER')).toThrow();
        expect(() => configureDigitsBot(OVER, '', 'DIGITOVER')).toThrow(/no market/);
    });
});
