const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'brand.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const entries = config?.sites?.entries;

if (!Array.isArray(entries) || entries.length === 0) {
  throw new Error('brand.config.json must contain sites.entries.');
}

const normalizeHost = value => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .split('/')[0]
  .replace(/^www\./, '')
  .replace(/\.$/, '');

const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const seenIds = new Set();
const seenHosts = new Map();

for (const [index, site] of entries.entries()) {
  const label = `sites.entries[${index}]`;
  const id = String(site?.id || '');
  if (!idPattern.test(id)) throw new Error(`${label}.id is invalid: ${id}`);
  if (seenIds.has(id)) throw new Error(`${label}.id duplicates ${id}.`);
  seenIds.add(id);

  if (!Array.isArray(site?.hosts) || site.hosts.length === 0) {
    throw new Error(`${label}.hosts must contain at least one hostname.`);
  }

  for (const hostValue of site.hosts) {
    const host = normalizeHost(hostValue);
    if (!host || !host.includes('.')) throw new Error(`${label}.hosts contains an invalid hostname: ${hostValue}`);
    const owner = seenHosts.get(host);
    if (owner && owner !== id) throw new Error(`Hostname ${host} is assigned to both ${owner} and ${id}.`);
    seenHosts.set(host, id);
  }

  const displayDomain = String(site?.display_domain || '').trim();
  if (!normalizeHost(displayDomain)) throw new Error(`${label}.display_domain is required.`);

  let website;
  let redirect;
  try { website = new URL(String(site?.website_url || '')); }
  catch { throw new Error(`${label}.website_url must be an absolute HTTPS URL.`); }
  try { redirect = new URL(String(site?.redirect_uri || '')); }
  catch { throw new Error(`${label}.redirect_uri must be an absolute HTTPS URL.`); }

  if (website.protocol !== 'https:') throw new Error(`${label}.website_url must use HTTPS.`);
  if (redirect.protocol !== 'https:') throw new Error(`${label}.redirect_uri must use HTTPS.`);
  if (normalizeHost(website.hostname) !== normalizeHost(displayDomain)) {
    throw new Error(`${label}.website_url hostname must match display_domain.`);
  }
  if (normalizeHost(redirect.hostname) !== normalizeHost(displayDomain)) {
    throw new Error(`${label}.redirect_uri hostname must match display_domain.`);
  }
  if (redirect.pathname !== '/callback') throw new Error(`${label}.redirect_uri must end with /callback.`);

  const clientId = String(site?.client_id || '').trim();
  if (!clientId) throw new Error(`${label}.client_id is required.`);

  if (!Array.isArray(site?.scopes) || site.scopes.length === 0) {
    throw new Error(`${label}.scopes must contain at least one OAuth scope.`);
  }
  const scopes = site.scopes.map(String);
  if (new Set(scopes).size !== scopes.length) throw new Error(`${label}.scopes contains duplicates.`);
  if (!scopes.includes('trade')) throw new Error(`${label}.scopes must include trade for the trading platform.`);

  if (!['production', 'staging'].includes(String(site?.environment || ''))) {
    throw new Error(`${label}.environment must be production or staging.`);
  }
}

const defaultSite = String(config?.sites?.default_site || '');
if (!seenIds.has(defaultSite)) throw new Error(`sites.default_site (${defaultSite}) does not match a configured site id.`);

console.log(`Validated ${entries.length} managed site registry entries.`);
