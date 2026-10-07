const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const libraryDir = path.join(root, 'public', 'free-bots');
const domainDir = path.join(libraryDir, 'domains');
const brandConfig = JSON.parse(fs.readFileSync(path.join(root, 'brand.config.json'), 'utf8'));
const configuredSites = Array.isArray(brandConfig?.sites?.entries) ? brandConfig.sites.entries : [];
const configuredSiteIds = new Set(configuredSites.map(site => site.id));
const validatedAssets = new Set();

const readManifestBots = (manifest, label, allowEmpty) => {
    const bots = Array.isArray(manifest) ? manifest : manifest?.bots;
    if (!Array.isArray(bots)) {
        throw new Error(`${label}: manifest must contain a bots array.`);
    }
    if (!allowEmpty && bots.length === 0) {
        throw new Error(`${label}: manifest does not contain any bots.`);
    }
    if (Number.isFinite(Number(manifest?.count)) && Number(manifest.count) !== bots.length) {
        throw new Error(`${label}: count=${manifest.count} but contains ${bots.length} entries.`);
    }
    return bots;
};

const validateBot = (bot, index, label) => {
    if (!bot || typeof bot.file !== 'string' || bot.file.trim() === '') {
        throw new Error(`${label}: bot entry ${index + 1} is missing a file name.`);
    }

    const asset = bot.asset || bot.file;
    const assetPath = path.join(libraryDir, asset);
    if (!assetPath.startsWith(`${libraryDir}${path.sep}`)) {
        throw new Error(`${label}: ${bot.name || bot.file} points outside the free-bots directory.`);
    }
    if (!fs.existsSync(assetPath)) {
        throw new Error(`${label}: ${bot.name || bot.file} is missing asset ${asset}.`);
    }

    const assetKey = `${asset}:${bot.encoding || 'plain'}`;
    if (validatedAssets.has(assetKey)) return;

    let xml;
    if (bot.encoding === 'gzip-base64') {
        const encoded = fs.readFileSync(assetPath, 'utf8').replace(/\s+/g, '');
        const compressed = Buffer.from(encoded, 'base64');
        xml = zlib.gunzipSync(compressed).toString('utf8');
    } else {
        xml = fs.readFileSync(assetPath, 'utf8');
    }

    if (!/<xml[\s>]/i.test(xml) || !/<block[\s>]/i.test(xml)) {
        throw new Error(`${label}: ${bot.name || bot.file} is not valid Blockly XML.`);
    }

    validatedAssets.add(assetKey);
};

const validateManifestFile = (manifestPath, { allowEmpty = false, expectedSiteId = '' } = {}) => {
    const label = path.relative(root, manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bots = readManifestBots(manifest, label, allowEmpty);

    if (expectedSiteId) {
        if (!configuredSiteIds.has(expectedSiteId)) {
            throw new Error(`${label}: ${expectedSiteId} is not defined in brand.config.json.`);
        }
        if (manifest.site_id && manifest.site_id !== expectedSiteId) {
            throw new Error(`${label}: site_id=${manifest.site_id} does not match ${expectedSiteId}.`);
        }
    }

    const ids = new Set();
    const priorities = new Set();
    bots.forEach((bot, index) => {
        if (bot?.id) {
            if (ids.has(bot.id)) throw new Error(`${label}: duplicate bot id ${bot.id}.`);
            ids.add(bot.id);
        }
        if (Number.isFinite(Number(bot?.priority))) {
            const priority = Number(bot.priority);
            if (priorities.has(priority)) throw new Error(`${label}: duplicate priority ${priority}.`);
            priorities.add(priority);
        }
        validateBot(bot, index, label);
    });

    return bots.length;
};

const sharedManifestPath = path.join(libraryDir, 'bots.json');
let manifestCount = 1;
let botReferenceCount = validateManifestFile(sharedManifestPath);

if (fs.existsSync(domainDir)) {
    const domainManifests = fs.readdirSync(domainDir)
        .filter(file => file.endsWith('.json'))
        .sort();

    for (const file of domainManifests) {
        const siteId = path.basename(file, '.json');
        botReferenceCount += validateManifestFile(path.join(domainDir, file), {
            allowEmpty: true,
            expectedSiteId: siteId,
        });
        manifestCount += 1;
    }
}

console.log(
    `Validated ${validatedAssets.size} bot assets across ${manifestCount} manifests (${botReferenceCount} bot references).`
);
