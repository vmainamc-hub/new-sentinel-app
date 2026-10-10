// Isolates the Sentinel Signal Engine from the zip into <dest>/src/sentinel-engine/.
// Only import specifiers are rewritten; everything else stays byte-identical.
// usage: node scripts/vendor-sentinel-engine.mjs <zipSrcRoot> <destSrcRoot> [--verify]
// See src/sentinel-engine/README.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [zipSrc, destSrc, flag] = process.argv.slice(2);
const verify = flag === '--verify';
const ENTRIES = ['lib/apex/core', 'lib/apex/scan', 'lib/apex/surface-vetting', 'lib/deriv/tick-bus', 'lib/apex/types'];
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const ENGINE_PREFIXES = ['lib/', 'types/sentinel', 'hooks/useDerivStream'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const resolveFile = base => {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const e of EXTS) if (fs.existsSync(base + e)) return base + e;
  return null;
};
const specRe = /(from\s+|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g;

const files = new Set();
const externals = new Map();
const unresolved = [];
const visit = file => {
  if (files.has(file)) return;
  files.add(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(specRe)) {
    const spec = m[3];
    let target = null;
    if (spec.startsWith('@/')) {
      const rel = spec.slice(2);
      if (!ENGINE_PREFIXES.some(p => rel.startsWith(p))) { externals.set(spec, (externals.get(spec) || new Set()).add(path.relative(zipSrc, file))); continue; }
      target = resolveFile(path.join(zipSrc, rel));
    } else if (spec.startsWith('.')) {
      target = resolveFile(path.resolve(path.dirname(file), spec));
    } else continue;
    if (!target) unresolved.push(`${path.relative(zipSrc, file)} -> ${spec}`);
    else visit(target);
  }
};
for (const e of ENTRIES) { const f = resolveFile(path.join(zipSrc, e)); if (!f) throw new Error('missing entry ' + e); visit(f); }

const rewrite = text => text
  .replace(/(['"])@\/lib\//g, '$1@/sentinel-engine/lib/')
  .replace(/(['"])@\/types\/sentinel(['"])/g, '$1@/sentinel-engine/types/sentinel$2')
  .replace(/(['"])@\/hooks\/useDerivStream(['"])/g, '$1@/sentinel-engine/hooks/useDerivStream$2');
const unrewrite = text => text
  .replace(/(['"])@\/sentinel-engine\/lib\//g, '$1@/lib/')
  .replace(/(['"])@\/sentinel-engine\/types\/sentinel(['"])/g, '$1@/types/sentinel$2')
  .replace(/(['"])@\/sentinel-engine\/hooks\/useDerivStream(['"])/g, '$1@/hooks/useDerivStream$2');

const outRoot = path.join(destSrc, 'sentinel-engine');
const manifest = [];
let bad = 0;
for (const f of [...files].sort()) {
  const rel = path.relative(zipSrc, f);
  const original = fs.readFileSync(f);
  const dest = path.join(outRoot, rel);
  if (verify) {
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (have === null || unrewrite(have) !== original.toString('utf8')) { bad++; console.log('MISMATCH', rel); }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewrite(original.toString('utf8')));
    manifest.push({ file: rel, sourceSha256: sha(original) });
  }
}
if (!verify) fs.writeFileSync(path.join(outRoot, 'MANIFEST.json'), JSON.stringify({ source: 'Sentinel-Signal-Engine-and-Sentinel-Forge-source.zip / apexsentinel-main', note: 'Only import specifiers were rewritten (@/lib -> @/sentinel-engine/lib etc.). sourceSha256 is of the ORIGINAL file.', files: manifest }, null, 1) + '\n');
console.log(`${verify ? 'verified' : 'wrote'} ${files.size} files, ${bad} mismatches`);
console.log('external @/ specifiers used by the engine:');
for (const [k, v] of externals) console.log('  ', k, '<-', [...v].slice(0, 3).join(', '), v.size > 3 ? `(+${v.size - 3})` : '');
if (unresolved.length) console.log('UNRESOLVED:', unresolved);
