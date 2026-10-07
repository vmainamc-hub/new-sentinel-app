const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'src', 'components', 'premium', 'site-customization.ts');
const publicCatalogPath = path.join(root, 'public', 'site-config', 'catalog.json');
const COLOR_KEYS = ['primary', 'secondary', 'nav_background', 'nav_text', 'header_background'];

const humanize = value => String(value || '')
  .split('_')
  .filter(Boolean)
  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

const parseSourceCatalog = source => {
  const catalogMatch = source.match(/export const NAVIGATION_CATALOG[\s\S]*?=\s*\[([\s\S]*?)\n\];/);
  if (!catalogMatch) throw new Error('Could not find NAVIGATION_CATALOG in site-customization.ts.');

  const navigationCatalog = [];
  const itemPattern = /\{\s*id:\s*['"]([^'"]+)['"]\s*,\s*label:\s*['"]([^'"]+)['"](?:\s*,\s*required:\s*(true|false))?\s*\}/g;
  let itemMatch;
  while ((itemMatch = itemPattern.exec(catalogMatch[1]))) {
    navigationCatalog.push({
      id: itemMatch[1],
      label: itemMatch[2] || humanize(itemMatch[1]),
      ...(itemMatch[3] === 'true' ? { required: true } : {}),
    });
  }
  if (!navigationCatalog.length) throw new Error('NAVIGATION_CATALOG contains no parseable navigation items.');

  const colorsMatch = source.match(/export const DEFAULT_THEME_COLORS[\s\S]*?=\s*\{([\s\S]*?)\n\};/);
  if (!colorsMatch) throw new Error('Could not find DEFAULT_THEME_COLORS in site-customization.ts.');

  const colors = {};
  for (const key of COLOR_KEYS) {
    const match = colorsMatch[1].match(new RegExp(`${key}\\s*:\\s*['\"](#[0-9a-fA-F]{6})['\"]`));
    if (!match) throw new Error(`DEFAULT_THEME_COLORS is missing ${key}.`);
    colors[key] = match[1].toLowerCase();
  }

  return {
    version: 2,
    source: 'src/components/premium/site-customization.ts',
    navigation_catalog: navigationCatalog,
    defaults: {
      navigation: navigationCatalog.map(item => item.id),
      colors,
    },
  };
};

const readLiveCatalog = () => parseSourceCatalog(fs.readFileSync(sourcePath, 'utf8'));

const writePublicCatalog = catalog => {
  fs.mkdirSync(path.dirname(publicCatalogPath), { recursive: true });
  fs.writeFileSync(publicCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
};

module.exports = {
  COLOR_KEYS,
  publicCatalogPath,
  readLiveCatalog,
  sourcePath,
  writePublicCatalog,
};
