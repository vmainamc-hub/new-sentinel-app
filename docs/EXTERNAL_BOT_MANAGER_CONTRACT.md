# External Bot Manager Contract

The bot-management application lives in a separate repository. This repository (`DukeNyamasege/nnn`) is the deployment target it manages.

## Scope

Version 1 of the manager has only these responsibilities:

1. Add/upload bots to a selected domain.
2. Remove bots from a selected domain.
3. Reorder bots by drag-and-drop before publishing.

Publishing updates this repository; Netlify then deploys the affected sites from the new `main` revision.

## Sources of truth

- Managed domains: `brand.config.json -> sites.entries`
- Shared/inherited bot library: `public/free-bots/bots.json`
- Domain-specific manifest: `public/free-bots/domains/<site-id>.json`
- New domain-owned bot assets: `public/free-bots/uploads/<site-id>/<generated-file-name>.xml`

The manager must use `site.id` for storage and `display_domain` for the visible dropdown label.

If `public/free-bots/domains/<site-id>.json` does not exist, the manager should display the shared bot library as the domain's inherited starting state. On the first Publish it should write a domain manifest. An empty domain manifest is valid and means that domain intentionally has no bots.

## Manifest format

```json
{
  "version": 1,
  "site_id": "dollarsigns",
  "count": 2,
  "bots": [
    {
      "id": "stable-unique-id",
      "name": "Visible Bot Name",
      "file": "Original upload.xml",
      "asset": "uploads/dollarsigns/stable-unique-id.xml",
      "description": "Uploaded custom strategy.",
      "emoji": "CUSTOM",
      "priority": 1
    }
  ]
}
```

After drag-and-drop, the manager rewrites `priority` sequentially from `1` through `N` and sets `count` to `N`.

Raw XML uploads do not need an `encoding` field. Existing `gzip-base64` assets remain supported.

## Upload rules

Before Publish, reject files that are not XML/Blockly strategies. At minimum the uploaded content must contain an XML root/block structure. File names shown to users may preserve the original name, while the stored `asset` path should use a safe generated name.

Do not overwrite an existing asset accidentally. New assets should be site-scoped under `uploads/<site-id>/`.

## Remove rules

Removing a bot always removes it from that domain manifest. A site-owned asset under `uploads/<site-id>/` may also be deleted when it is no longer referenced. Shared legacy assets under `uploads/` should not be deleted just because one domain removes them.

## GitHub security

The GitHub token must never be included in the browser bundle, local storage, frontend environment variables exposed to the browser, or API responses. Store the token only in the manager application's server-side environment and call GitHub from server-side functions/API routes.

## Publish pipeline

The preferred one-click Publish flow is:

1. Read the current `main` SHA immediately before publishing.
2. Create a temporary `bot-manager/<timestamp>` branch from that SHA.
3. Commit uploaded/deleted assets and the selected domain manifest in one Git tree/commit.
4. Open a pull request to `main`.
5. Wait for the existing Node 22 and Node 24 compatibility workflow.
6. Merge only when the checks succeed.
7. Report the merge SHA to the manager UI.

This keeps the manager UI simple while preventing a broken bot update from reaching `main`. Netlify consumes the merged `main` update normally.

## Manager UI contract

The first screen should contain only:

- Domain dropdown populated from `brand.config.json`.
- Current bot list for the selected domain, each row/card having a delete control and drag handle.
- `Browse XML files` / drag-and-drop upload area accepting multiple XML files.
- `Publish` button.

New uploads appear immediately in the local list before Publish. Deleted items disappear locally before Publish. Reordering is local until Publish. Refreshing/reselecting a domain should reload the last published state from GitHub.
