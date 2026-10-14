import fs from 'fs';
import path from 'path';
import {
configureScannerBot, readScannerBot,     SCANNER_BOTS, type ScannerSignal,
structureOf, submarketFor, verifyScannerBot, } from '../scanner-bots';

const LIBRARY = path.join(process.cwd(), 'public/free-bots');
const read = (asset: string) => fs.readFileSync(path.join(LIBRARY, asset), 'utf8');
const manifest = JSON.parse(read('bots.json')) as { bots: { id: string; name: string; asset: string }[] };
const domainManifest = JSON.parse(read('domains/apex-sentinel.json')) as { bots: { id: string }[] };

const entryFor = (id: string) => {
    const entry = manifest.bots.find(bot => bot.id === id);
    if (!entry) throw new Error(`${id} is not in the free-bots manifest.`);
    return entry;
};

const UNDER_XML = read(entryFor(SCANNER_BOTS.DIGITUNDER.id).asset);
const OVER_XML = read(entryFor(SCANNER_BOTS.DIGITOVER.id).asset);

const overSignal: ScannerSignal = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 2 };
const underSignal: ScannerSignal = { symbol: '1HZ25V', contract: 'DIGITUNDER', barrier: 7 };

describe('scanner bots', () => {
    it('are bot 46 Holy Grail for Under and bot 26 for Over, by their numbers in the Free Bots list', () => {
        expect(entryFor(SCANNER_BOTS.DIGITUNDER.id).name).toMatch(/^46\. Holy Grail/);
        expect(entryFor(SCANNER_BOTS.DIGITOVER.id).name).toMatch(/^26\. /);
        expect(SCANNER_BOTS.DIGITUNDER.number).toBe(46);
        expect(SCANNER_BOTS.DIGITOVER.number).toBe(26);
    });

    it('are in both the shared and the site bot manifests, so they resolve on any site', () => {
        const siteIds = domainManifest.bots.map(bot => bot.id);
        expect(siteIds).toContain(SCANNER_BOTS.DIGITUNDER.id);
        expect(siteIds).toContain(SCANNER_BOTS.DIGITOVER.id);
    });

    it('buy only their own side as shipped', () => {
        // Holy Grail has a single standard `purchase` block; bot 26 has two `apollo_purchase` blocks.
        expect(readScannerBot(UNDER_XML, 'DIGITUNDER').purchases).toEqual(['DIGITUNDER']);
        expect(readScannerBot(OVER_XML, 'DIGITOVER').purchases).toEqual(['DIGITOVER', 'DIGITOVER']);
    });

    it('document the recovery each bot really has', () => {
        // Holy Grail sets RECOVERY PREDICTION 5 and trades Under; bot 26 uses Recovery Prediction 4 on Over.
        expect(readScannerBot(UNDER_XML, 'DIGITUNDER')).toMatchObject({ barriers: [7], recovery: 5 });
        expect(SCANNER_BOTS.DIGITUNDER.recovery).toEqual({ contract: 'DIGITUNDER', barrier: 5 });
        expect(SCANNER_BOTS.DIGITOVER.recovery).toEqual({ contract: 'DIGITOVER', barrier: 4 });
    });
});

describe('configureScannerBot (Over -> bot 26)', () => {
    it('writes the market and the main barrier and nothing else', () => {
        const out = configureScannerBot(OVER_XML, overSignal);
        const bot = readScannerBot(out, 'DIGITOVER');
        expect(bot).toMatchObject({ market: 'synthetic_index', symbol: 'R_50', submarket: 'random_index', tradeType: 'overunder' });
        expect(bot.barriers).toEqual([2]);
        expect(bot.recovery).toBe(4);
        expect(bot.purchases).toEqual(['DIGITOVER', 'DIGITOVER']);
        expect(structureOf(out)).toEqual(structureOf(OVER_XML));
    });

    it('leaves the recovery prediction and the stake logic as shipped', () => {
        const out = configureScannerBot(OVER_XML, { ...overSignal, barrier: 3 });
        expect(out).toContain('Recovery Prediction');
        const doc = new DOMParser().parseFromString(out, 'application/xml');
        const sets = Array.from(doc.getElementsByTagName('block')).filter(block => block.getAttribute('type') === 'variables_set');
        const valueOf = (variable: string) => {
            const set = sets.find(block => Array.from(block.children).some(c => c.localName === 'field' && c.textContent === variable));
            return set?.getElementsByTagName('field')[1]?.textContent;
        };
        expect(valueOf('Recovery Prediction')).toBe('4');
        expect(valueOf('Over Prediction')).toBe('3');
        expect(valueOf('Stake')).toBe('0.55');
    });
});

describe('configureScannerBot (Under -> bot 46 Holy Grail)', () => {
    it('writes the market and the main barrier, keeping the Under 5 recovery', () => {
        const out = configureScannerBot(UNDER_XML, { ...underSignal, barrier: 8 });
        const bot = readScannerBot(out, 'DIGITUNDER');
        expect(bot).toMatchObject({ market: 'synthetic_index', symbol: '1HZ25V', submarket: 'random_index_1s', tradeType: 'overunder' });
        expect(bot.barriers).toEqual([8]);
        expect(bot.purchases).toEqual(['DIGITUNDER']);
        expect(structureOf(out)).toEqual(structureOf(UNDER_XML));
        // the recovery barrier (Under 5) is untouched, and the bot as shipped trades Under 7
        expect(bot.recovery).toBe(5);
        expect(readScannerBot(UNDER_XML, 'DIGITUNDER').barriers).toEqual([7]);
    });

    it('leaves the stake, martingale, target profit and recovery as shipped', () => {
        const out = configureScannerBot(UNDER_XML, { ...underSignal, barrier: 6 });
        const valueOf = (xml: string, variable: string) => {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const set = Array.from(doc.getElementsByTagName('block')).find(block =>
                block.getAttribute('type') === 'variables_set'
                && Array.from(block.children).some(c => c.localName === 'field' && c.textContent === variable));
            return set?.getElementsByTagName('field')[1]?.textContent;
        };
        ['Stake', 'Martingale', 'Target Profit', 'RECOVERY PREDICTION'].forEach(variable => {
            expect(valueOf(out, variable)).toBe(valueOf(UNDER_XML, variable));
        });
        expect(valueOf(out, 'STARTING PREDICTION')).toBe('6');
    });

    it('uses the live submarket when the active symbols supply one', () => {
        const out = configureScannerBot(UNDER_XML, { ...underSignal, submarket: 'random_index' });
        expect(readScannerBot(out, 'DIGITUNDER').submarket).toBe('random_index');
    });
});

describe('safety checks', () => {
    it('refuses a bot that buys the wrong side for the signal', () => {
        expect(() => configureScannerBot(OVER_XML, { ...underSignal })).toThrow();
        expect(() => configureScannerBot(UNDER_XML, { ...overSignal })).toThrow();
    });

    it('refuses barriers that are not digits', () => {
        expect(() => configureScannerBot(OVER_XML, { ...overSignal, barrier: 10 })).toThrow(/valid digit/);
        expect(() => configureScannerBot(OVER_XML, { ...overSignal, barrier: 1.5 })).toThrow(/valid digit/);
    });

    it('verifyScannerBot catches a bot that does not match the signal', () => {
        const out = configureScannerBot(OVER_XML, overSignal);
        expect(() => verifyScannerBot(out, { ...overSignal, symbol: 'R_100' })).toThrow(/market symbol/);
        expect(() => verifyScannerBot(out, { ...overSignal, barrier: 3 })).toThrow(/barrier is 2/);
    });

    it('refuses invalid XML', () => {
        expect(() => configureScannerBot('<xml', overSignal)).toThrow(/not valid/);
    });
});

describe('submarketFor', () => {
    it('prefers the live value, then falls back by symbol family', () => {
        expect(submarketFor('1HZ10V', 'random_index')).toBe('random_index');
        expect(submarketFor('1HZ10V')).toBe('random_index_1s');
        expect(submarketFor('R_100')).toBe('random_index');
    });
});
