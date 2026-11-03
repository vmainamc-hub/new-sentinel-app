// Copies the already-built Manual Trader (Deriv DTrader build) from public/br_manual-trader into dist/br_manual-trader
// after `rsbuild build`, byte for byte. It is kept out of the bundler's own copy step (see rsbuild.config.ts).
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public', 'br_manual-trader');
const target = path.join(root, 'dist', 'br_manual-trader');

if (!existsSync(source)) {
    console.log('Manual Trader: public/br_manual-trader not found, skipping.');
    process.exit(0);
}
if (!existsSync(path.join(root, 'dist'))) {
    console.error('Manual Trader: dist/ does not exist. Run the build first.');
    process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log('Manual Trader: copied public/br_manual-trader to dist/br_manual-trader');
