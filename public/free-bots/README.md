# Free Bots XML library

This directory contains 10 Blockly XML strategies exposed by the Free Bots page. Each `LOAD BOT` action fetches the matching local XML file and imports it into the native Deriv Bot Builder workspace through the existing `load(...)` strategy loader.

The XML files are synchronized from the official strategy XMLs already shipped in `src/xml` by running:

```bash
node scripts/sync-free-bots.mjs
```
