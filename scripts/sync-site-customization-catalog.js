const { publicCatalogPath, readLiveCatalog, writePublicCatalog } = require('./site-customization-catalog');

const catalog = readLiveCatalog();
writePublicCatalog(catalog);
console.log(`Synced ${catalog.navigation_catalog.length} navigation features to ${publicCatalogPath}.`);
