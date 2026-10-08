const fs = require('fs');
const path = require('path');

// Netlify exposes URL for the primary deployed site. Only rewrite the production
// Apex Sentinel entry during a production build so preview builds retain their
// explicitly registered OAuth configuration.
const context = process.env.CONTEXT || '';
const deploymentUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').trim().replace(/\/$/, '');

if (context !== 'production' || !deploymentUrl) {
    console.log('Netlify brand sync: no production hostname rewrite required.');
    process.exit(0);
}

const configPath = path.resolve(__dirname, '..', 'brand.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const hostname = new URL(deploymentUrl).hostname;
const site = config.sites?.entries?.find(entry => entry.id === 'apex-sentinel');

if (!site) throw new Error('Apex Sentinel site configuration is missing.');

site.hosts = Array.from(new Set([hostname, 'localhost']));
site.website_url = deploymentUrl;
site.redirect_uri = deploymentUrl + '/callback';
config.brand_domain = hostname;
config.domain_name = hostname;
config.brand_hostname = { staging: hostname, production: hostname };
if (config.platform?.hostname) {
    config.platform.hostname.production = { com: hostname };
    config.platform.hostname.staging = { com: hostname };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\\n');
console.log('Netlify brand sync: Apex Sentinel production host set to ' + hostname);
console.log('Netlify brand sync: OAuth client ID retained from the repository configuration.');
