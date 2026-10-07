const fs = require('node:fs');
const path = require('node:path');
const { COLOR_KEYS, readLiveCatalog, writePublicCatalog } = require('./site-customization-catalog');

const root = path.resolve(__dirname, '..');
const domainsDir = path.join(root, 'public', 'site-config', 'domains');
const brandPath = path.join(root, 'brand.config.json');
const HEX = /^#[0-9a-f]{6}$/i;

// The premium runtime source is the single source of truth. This means a developer
// can add a navigation feature in site-customization.ts without also maintaining a
// second hand-written catalog file for SITE-MANAGER.
const catalog = readLiveCatalog();
writePublicCatalog(catalog);

const brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
const catalogItems = Array.isArray(catalog.navigation_catalog) ? catalog.navigation_catalog : [];
const ids = catalogItems.map(item => String(item?.id || ''));
const idSet = new Set(ids);
const required = catalogItems.filter(item => item?.required).map(item => String(item.id));
const siteIds = new Set((brand?.sites?.entries || []).map(site => String(site.id)));

if (!catalogItems.length || ids.some(id => !id)) throw new Error('Live site customization catalog is empty or contains an invalid id.');
if (idSet.size !== ids.length) throw new Error('Live site customization catalog contains duplicate navigation ids.');

const validateNavigation = (navigation, label) => {
  if (!Array.isArray(navigation) || navigation.length === 0) throw new Error(`${label}: navigation must be a non-empty array.`);
  const values = navigation.map(String);
  if (new Set(values).size !== values.length) throw new Error(`${label}: navigation contains duplicate items.`);
  for (const id of values) if (!idSet.has(id)) throw new Error(`${label}: unknown navigation item ${id}.`);
  for (const id of required) if (!values.includes(id)) throw new Error(`${label}: required navigation item ${id} is missing.`);
};

const validateColors = (colors, label) => {
  if (!colors || typeof colors !== 'object') throw new Error(`${label}: colors must be an object.`);
  for (const key of COLOR_KEYS) {
    if (!HEX.test(String(colors[key] || ''))) throw new Error(`${label}: ${key} must be a six-digit hex color.`);
  }
  for (const key of Object.keys(colors)) if (!COLOR_KEYS.includes(key)) throw new Error(`${label}: unsupported color key ${key}.`);
};

validateNavigation(catalog.defaults.navigation, 'live catalog defaults');
validateColors(catalog.defaults.colors, 'live catalog defaults');

let count = 0;
if (fs.existsSync(domainsDir)) {
  for (const file of fs.readdirSync(domainsDir).filter(name => name.endsWith('.json'))) {
    const siteId = path.basename(file, '.json');
    if (!siteIds.has(siteId)) throw new Error(`${file}: site id is not configured in brand.config.json.`);
    const payload = JSON.parse(fs.readFileSync(path.join(domainsDir, file), 'utf8'));
    if (String(payload.site_id || '') !== siteId) throw new Error(`${file}: site_id must equal ${siteId}.`);
    validateNavigation(payload.navigation, file);
    validateColors(payload.colors, file);
    count += 1;
  }
}

console.log(`Validated ${catalogItems.length} live navigation feature(s) and ${count} domain configuration(s).`);
