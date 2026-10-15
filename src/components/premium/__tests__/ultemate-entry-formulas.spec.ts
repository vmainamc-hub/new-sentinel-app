// Free bots 103-105 (Ultemate profit bot v3 / v4 / v5): each has its own ENTRY FORMULA, a gate placed right before the purchase.
// Plain text checks on the bot XML (no DOM needed). The gate must only decide WHEN the bot buys: the purchase stays DIGITUNDER.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.cwd(), 'public/free-bots/uploads/apex-sentinel/apex-library');
const read = (name: string) => fs.readFileSync(path.join(dir, `apex-library-ultemate-profit-bot-${name}.xml`), 'utf8');

/** The digits a list variable is initialised with (only its own STACK, never the blocks chained after it). */
const listDigits = (xml: string, variable: string): number[] => {
    const match = new RegExp(`name="VARIABLE" id="ent_v\\d+">${variable}</field><statement name="STACK">(.*?)</statement>`, 's').exec(xml);
    if (!match) throw new Error(`list "${variable}" not found`);
    return Array.from(match[1].matchAll(/<field name="NUM">(\d+)<\/field>/g)).map(item => Number(item[1]));
};

const numberVariable = (xml: string, variable: string): number => {
    const match = new RegExp(`<field name="VAR" id="ent_v\\d+">${variable}</field><value name="VALUE"><block type="math_number" id="[^"]+"><field name="NUM">(\\d+)</field>`).exec(xml);
    if (!match) throw new Error(`number variable "${variable}" not found`);
    return Number(match[1]);
};

const BOTS = [
    { version: 'v3', file: 'v3-multimarket-70' },
    { version: 'v4', file: 'v4-heat-ranked-71' },
    { version: 'v5', file: 'v5-transition-72' },
];

describe.each(BOTS)('Ultemate profit bot $version entry formula', ({ file }) => {
    const xml = read(file);

    it('keeps buying Digit Under and adds the gate before the purchase', () => {
        expect(Array.from(xml.matchAll(/name="PURCHASE_LIST">([A-Z]+)</g)).map(item => item[1])).toEqual(['DIGITUNDER']);
        expect(xml).toContain('>Entry formula enabled</field>');
        expect(numberVariable(xml, 'Entry formula enabled')).toBe(1);
        // The gate: the existing purchase condition AND Entry OK = 1.
        expect(xml).toMatch(/<block type="logic_operation" id="ent_fix_and"><field name="OP">AND<\/field><value name="A"><block type="logic_operation"/);
        expect(xml).toMatch(/<field name="VAR" id="ent_v\d+">Entry OK<\/field>/);
        expect(xml.indexOf('type="purchase"')).toBeGreaterThan(xml.indexOf('>Entry OK</field><value name="VALUE"><block type="logic_ternary"'));
    });

    it('applies Entry OK to the buy condition only, never to the in-flight reset', () => {
        const blockXml = (id: string): string => {
            const start = xml.indexOf(`id="${id}"`);
            if (start < 0) throw new Error(`block ${id} not found`);
            const open = xml.lastIndexOf('<block ', start);
            let depth = 0;
            const tags = /<block\b|<\/block>/g;
            tags.lastIndex = open;
            for (let tag = tags.exec(xml); tag; tag = tags.exec(xml)) {
                depth += tag[0] === '</block>' ? -1 : 1;
                if (depth === 0) return xml.slice(open, tags.lastIndex);
            }
            throw new Error(`block ${id} is not closed`);
        };
        const condition = (id: string) => /<value name="IF0">([^]*?)<statement name="DO0">/.exec(blockXml(id))?.[1] ?? '';
        // vh_if_1 only clears a stuck "In flight" state: it must not wait for Entry OK.
        expect(condition('vh_if_1')).not.toContain('>Entry OK<');
        // pon_final_01470 is the buy decision: its condition carries the Entry OK = 1 check and wraps the purchase.
        expect(condition('pon_final_01470')).toContain('>Entry OK<');
        expect(blockXml('pon_final_01470')).toContain('type="purchase"');
        expect(blockXml('ent_fix_and')).toContain('id="pon_final_01471"');
    });

    it('keeps the procedure calls and else-branches Blockly needs (mutation tags are not rewritten)', () => {
        // Re-serialising the XML once turned <mutation xmlns="..xhtml"/> into <html:mutation/>, which Blockly ignores:
        // the bot then failed on Run with "pon_final_01662 is not defined".
        expect(xml).not.toContain('html:');
        expect(xml).toContain('<mutation xmlns="http://www.w3.org/1999/xhtml" name="Validate settings and risk"/>');
        expect(xml).toContain('<mutation xmlns="http://www.w3.org/1999/xhtml" name="Evaluate market"/>');
        expect(xml).toContain('<mutation xmlns="http://www.w3.org/1999/xhtml" else="1"/>');
    });

    it('counts digits of the market being traded, and never in an empty history', () => {
        expect(xml).toMatch(/type="market_digit_count"[^]*?<field name="VAR" id="[^"]+">Trade market<\/field>/);
    });
});

describe('entry formula settings', () => {
    it('v3: the last 3 digits must all be in 6-9', () => {
        const xml = read('v3-multimarket-70');
        expect(listDigits(xml, 'Entry digits')).toEqual([6, 7, 8, 9]);
        expect(numberVariable(xml, 'Entry digits needed')).toBe(3);
    });

    it('v4: entry digits 4, 7 or 9, touched', () => {
        expect(listDigits(read('v4-heat-ranked-71'), 'Entry digits')).toEqual([4, 7, 9]);
    });

    it('v5: at least 3 digits in 6-9, then a digit in 0-5', () => {
        const xml = read('v5-transition-72');
        expect(listDigits(xml, 'Entry loss digits')).toEqual([6, 7, 8, 9]);
        expect(listDigits(xml, 'Entry win digits')).toEqual([0, 1, 2, 3, 4, 5]);
        expect(numberVariable(xml, 'Entry losses needed')).toBe(3);
    });
});
