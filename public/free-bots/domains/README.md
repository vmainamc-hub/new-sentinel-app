# Domain bot manifests

This directory is the integration point for the external bot manager.

Each managed site may have one manifest named exactly after its `site.id` from `brand.config.json`:

`public/free-bots/domains/<site-id>.json`

Example for `dollarsigns.site`:

`public/free-bots/domains/dollarsigns.json`

If a domain manifest does not exist yet, the site inherits `public/free-bots/bots.json`. Once a domain manifest exists, including an intentionally empty manifest, that domain manifest becomes authoritative for that site.

A domain manifest may look like:

```json
{
  "version": 1,
  "site_id": "dollarsigns",
  "count": 2,
  "bots": [
    {
      "id": "my-bot-1",
      "name": "My Bot 1",
      "file": "My Bot 1.xml",
      "asset": "uploads/dollarsigns/my-bot-1.xml",
      "description": "Uploaded custom strategy.",
      "emoji": "CUSTOM",
      "priority": 1
    }
  ]
}
```

`asset` is relative to `public/free-bots/`. Reordering is controlled by `priority`; the manager should rewrite priorities as `1..N` after every drag-and-drop change.
