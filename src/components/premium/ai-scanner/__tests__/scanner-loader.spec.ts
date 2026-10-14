import fs from 'fs';
import path from 'path';
import { readScannerBot,SCANNER_BOTS } from '../scanner-bots';

const LIBRARY = path.join(process.cwd(), 'public/free-bots');
const manifest = JSON.parse(fs.readFileSync(path.join(LIBRARY, 'bots.json'), 'utf8')) as { bots: { id: string; name: string; asset: string }[] };
const xmlFor = (id: string) => fs.readFileSync(path.join(LIBRARY, manifest.bots.find(bot => bot.id === id)!.asset), 'utf8');
const nameFor = (id: string) => manifest.bots.find(bot => bot.id === id)!.name;

const mockFetchFreeBotById = jest.fn();
const mockLoadBotXmlIntoBuilder = jest.fn();

jest.mock('../../pages/FreeBotsPage', () => ({
    fetchFreeBotById: (...args: unknown[]) => mockFetchFreeBotById(...args),
    loadBotXmlIntoBuilder: (...args: unknown[]) => mockLoadBotXmlIntoBuilder(...args),
}));

// The loader keeps downloaded bots in module memory, so each test gets a fresh copy of it.
const freshLoader = () => {
    let loader: typeof import('../scanner-loader');
    jest.isolateModules(() => { loader = require('../scanner-loader'); });
    return loader!;
};

const serve = () => mockFetchFreeBotById.mockImplementation(async (id: string) => ({
    bot: { id, name: nameFor(id), file: `${id}.xml` },
    xml: xmlFor(id),
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    mockFetchFreeBotById.mockReset();
    mockLoadBotXmlIntoBuilder.mockReset().mockResolvedValue(undefined);
});

describe('loadSignalIntoScannerBot', () => {
    it('loads bot 26 for an Over signal, configured for the scanned market and barrier', async () => {
        serve();
        const open = jest.fn();
        const { loadSignalIntoScannerBot } = freshLoader();
        const outcome = await loadSignalIntoScannerBot({ symbol: 'R_75', contract: 'DIGITOVER', barrier: 2 }, open);

        expect(mockFetchFreeBotById).toHaveBeenCalledWith(SCANNER_BOTS.DIGITOVER.id);
        expect(outcome.bot.number).toBe(26);
        expect(open).toHaveBeenCalledTimes(1);
        const [xml, fileName] = mockLoadBotXmlIntoBuilder.mock.calls[0];
        expect(fileName).toBe('AI R_75 Over 2 (bot 26).xml');
        expect(readScannerBot(xml, 'DIGITOVER')).toMatchObject({ symbol: 'R_75', barriers: [2], recovery: 4 });
    });

    it('loads bot 11 for an Under signal', async () => {
        serve();
        const open = jest.fn();
        const { loadSignalIntoScannerBot } = freshLoader();
        const outcome = await loadSignalIntoScannerBot({ symbol: '1HZ10V', contract: 'DIGITUNDER', barrier: 7, submarket: 'random_index_1s' }, open);

        expect(mockFetchFreeBotById).toHaveBeenCalledWith(SCANNER_BOTS.DIGITUNDER.id);
        expect(outcome.bot.number).toBe(11);
        const [xml, fileName] = mockLoadBotXmlIntoBuilder.mock.calls[0];
        expect(fileName).toBe('AI 1HZ10V Under 7 (bot 11).xml');
        expect(readScannerBot(xml, 'DIGITUNDER')).toMatchObject({ symbol: '1HZ10V', submarket: 'random_index_1s', recovery: 4 });
    });

    it('opens Bot Builder only after the bot is configured and checked', async () => {
        mockFetchFreeBotById.mockResolvedValue({ bot: { id: 'x', name: 'x', file: 'x.xml' }, xml: '<xml' });
        const open = jest.fn();
        const { loadSignalIntoScannerBot } = freshLoader();
        await expect(loadSignalIntoScannerBot({ symbol: 'R_50', contract: 'DIGITOVER', barrier: 2 }, open)).rejects.toThrow(/not valid/);
        expect(open).not.toHaveBeenCalled();
        expect(mockLoadBotXmlIntoBuilder).not.toHaveBeenCalled();
    });
});

describe('when the site starts refusing requests (HTTP 401)', () => {
    it('still loads a bot that was downloaded earlier by the prefetch', async () => {
        serve();
        const { loadSignalIntoScannerBot, prefetchScannerBots } = freshLoader();
        prefetchScannerBots();
        await flush();
        expect(mockFetchFreeBotById).toHaveBeenCalledTimes(2); // both bots, once each

        mockFetchFreeBotById.mockReset().mockRejectedValue(new Error('Bot manifest could not be loaded (HTTP 401).'));
        const open = jest.fn();
        await expect(loadSignalIntoScannerBot({ symbol: 'R_100', contract: 'DIGITOVER', barrier: 3 }, open)).resolves.toBeDefined();
        await expect(loadSignalIntoScannerBot({ symbol: 'R_100', contract: 'DIGITUNDER', barrier: 6 }, open)).resolves.toBeDefined();
        expect(mockFetchFreeBotById).not.toHaveBeenCalled();
        expect(mockLoadBotXmlIntoBuilder).toHaveBeenCalledTimes(2);
    });

    it('says what to do when nothing was downloaded yet, and never opens Bot Builder', async () => {
        mockFetchFreeBotById.mockRejectedValue(new Error('Bot manifest could not be loaded (HTTP 401).'));
        const open = jest.fn();
        const { loadSignalIntoScannerBot } = freshLoader();
        await expect(loadSignalIntoScannerBot({ symbol: 'R_50', contract: 'DIGITUNDER', barrier: 8 }, open))
            .rejects.toThrow(/Bot 11 \(D2 BY MR\.DUKE\) was refused by the site .*Reload the page/);
        expect(open).not.toHaveBeenCalled();
    });

    it('reports other failures as they are', async () => {
        mockFetchFreeBotById.mockRejectedValue(new Error('Bot manifest could not be loaded (HTTP 500).'));
        const { loadSignalIntoScannerBot } = freshLoader();
        await expect(loadSignalIntoScannerBot({ symbol: 'R_50', contract: 'DIGITOVER', barrier: 2 }, jest.fn()))
            .rejects.toThrow('Bot manifest could not be loaded (HTTP 500).');
    });

    it('prefetch never throws when the downloads are refused', async () => {
        mockFetchFreeBotById.mockRejectedValue(new Error('HTTP 401'));
        const { prefetchScannerBots } = freshLoader();
        expect(() => prefetchScannerBots()).not.toThrow();
        await flush();
    });
});
