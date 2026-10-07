import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'src', 'xml');
const outputDir = join(root, 'public', 'free-bots');

const bots = [
    {
        id: 'martingale',
        name: 'Martingale',
        source: 'martingale.xml',
        file: 'martingale.xml',
        description: 'Official Deriv Blockly Martingale strategy.',
        emoji: 'DERIV',
        priority: 1,
    },
    {
        id: 'dalembert',
        name: "D'Alembert",
        source: 'dalembert.xml',
        file: 'dalembert.xml',
        description: "Official Deriv Blockly D'Alembert strategy.",
        emoji: 'DERIV',
        priority: 2,
    },
    {
        id: 'oscars-grind',
        name: "Oscar's Grind",
        source: 'oscars_grind.xml',
        file: 'oscars-grind.xml',
        description: "Official Deriv Blockly Oscar's Grind strategy.",
        emoji: 'DERIV',
        priority: 3,
    },
    {
        id: 'reverse-martingale',
        name: 'Reverse Martingale',
        source: 'reverse_martingale.xml',
        file: 'reverse-martingale.xml',
        description: 'Official Deriv Blockly Reverse Martingale strategy.',
        emoji: 'DERIV',
        priority: 4,
    },
    {
        id: 'reverse-dalembert',
        name: "Reverse D'Alembert",
        source: 'reverse_dalembert.xml',
        file: 'reverse-dalembert.xml',
        description: "Official Deriv Blockly Reverse D'Alembert strategy.",
        emoji: 'DERIV',
        priority: 5,
    },
    {
        id: 'martingale-max-stake',
        name: 'Martingale Max Stake',
        source: 'martingale_max-stake.xml',
        file: 'martingale-max-stake.xml',
        description: 'Official Deriv Martingale strategy with maximum-stake controls.',
        emoji: 'RISK',
        priority: 6,
    },
    {
        id: 'dalembert-max-stake',
        name: "D'Alembert Max Stake",
        source: 'dalembert_max-stake.xml',
        file: 'dalembert-max-stake.xml',
        description: "Official Deriv D'Alembert strategy with maximum-stake controls.",
        emoji: 'RISK',
        priority: 7,
    },
    {
        id: 'oscars-grind-max-stake',
        name: "Oscar's Grind Max Stake",
        source: 'oscars_grind_max-stake.xml',
        file: 'oscars-grind-max-stake.xml',
        description: "Official Deriv Oscar's Grind strategy with maximum-stake controls.",
        emoji: 'RISK',
        priority: 8,
    },
    {
        id: 'accumulator-martingale',
        name: 'Accumulator Martingale',
        source: 'accumulators_martingale.xml',
        file: 'accumulator-martingale.xml',
        description: 'Official Deriv Accumulator strategy using Martingale stake management.',
        emoji: 'ACCUMULATOR',
        priority: 9,
    },
    {
        id: 'accumulator-dalembert',
        name: "Accumulator D'Alembert",
        source: 'accumulators_dalembert.xml',
        file: 'accumulator-dalembert.xml',
        description: "Official Deriv Accumulator strategy using D'Alembert stake management.",
        emoji: 'ACCUMULATOR',
        priority: 10,
    },
];

await mkdir(outputDir, { recursive: true });

for (const bot of bots) {
    await copyFile(join(sourceDir, bot.source), join(outputDir, bot.file));
}

const manifest = {
    version: 1,
    source: 'Deriv trading-bot-template XML strategies',
    count: bots.length,
    bots: bots.map(({ source, ...bot }) => bot),
};

await writeFile(join(outputDir, 'bots.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Synced ${bots.length} XML bots to public/free-bots.`);
