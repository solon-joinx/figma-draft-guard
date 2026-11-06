<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/logo-dark.svg"><source media="(prefers-color-scheme: light)" srcset="./.github/assets/logo-light.svg"><img alt="Figma Draft Guard" src="./.github/assets/logo-light.svg" width="96"></picture>

# Figma Draft Guard

**Always build from the latest Figma design.**

A Claude Code plugin for working from Figma drafts.
<br />
Get notified when the main file changes, with a report of what changed.

</div>

```text
⚠️ Draft out of date | Main file stable | Last change: 32 min ago | Ready to update
```

## The problem

[Figwright](https://github.com/awdr74100/figwright) reads Figma through a plugin that runs in the open file. Without a Dev seat or edit access to the main file, a common workaround is to duplicate it into your drafts and build from the copy.

That copy goes stale silently. The designer updates the main file, nothing tells you, and you keep building from the old version.

fdg needs only view access. It warns and reports, and never blocks your tools or changes your code.

## Quick start

You need [Claude Code](https://code.claude.com), [Figwright](https://github.com/awdr74100/figwright), Node.js 20 or later, and view access to the main file.

**1. Create a token.** In Figma, open **Settings → Security → Personal access tokens**. Only `file_metadata:read` is needed.

**2. Install.** In Claude Code, run the commands below and paste the token when prompted.

```text
/plugin marketplace add solon-joinx/figma-draft-guard
/plugin install fdg@figma-draft-guard-marketplace
```

**3. Bind.** In your project, tell Claude:

```text
Watch this main file: <Figma link>
```

Claude asks you to duplicate the file, then does the rest. No restart needed.

## Day to day

Work as usual. fdg checks the main file when Claude Code starts, before Claude reads the design, and every 5 minutes while it is open.

| You see | It means |
| --- | --- |
| ✅ Draft in sync | The draft matches the main file. Shown at startup. |
| 🔵 Main file being edited | Changed in the last 30 minutes, so it may not be final. |
| ⚠️ Main file stable | No changes for 30 minutes. A good time to update. |
| ⚠️ Binding incomplete | Binding did not finish, so nothing is being watched. |
| ❌ Version check failed | The check could not complete. The reason is shown. |

Out-of-date notices stay above the prompt until you update.

To update, say "update my draft". To check right away, run `/fdg:check`. Claude replies in the language of your conversation. Status lines and reports are in English or Traditional Chinese.

## Seeing what changed

Binding saves a baseline of each frame. Updating compares the new draft against it:

```text
## Previously read

- Flow / Orders / Orders (17892:2900): 2 changes

## Other

- Flow / Profile / Profile (17892:3100)

## Added to main file

- Flow / Coupon / Coupon (21431:1200)

Unchanged: 12 frames
```

**Previously read** means Claude has read that frame through Figwright, not that it is implemented. Full details are saved to `.figma-draft-guard/reports/`.

By default all pages are compared. You can choose selected pages, or only frames read before, on first use or later by asking Claude. Added and removed frames are only listed when all pages are compared.

While comparing:

- Keep the draft in front in Figma until it finishes. A file with 300 frames takes about 30 seconds.
- Frames inside visible sections are compared. Pages without sections use their top-level frames.
- Frames that cannot be read, such as ones with broken components, are listed as not compared.

## Good to know

**Figwright is only needed when binding or updating.** Version checks and notices work without it.

**Drafts are not synced automatically.** Figwright cannot read the main file, and the API for full file content is tightly limited on View seats. A fresh duplicate is always exact.

**An unfinished update keeps warning you.** A draft only counts as current after Claude confirms it.

**Each draft has a hidden marker.** A locked 1×1 frame records its source version. Please do not delete it.

**You can rename the draft after binding.** A suggested name is copied to your clipboard. Renaming earlier may be reverted.

**Changes usually appear within 10 minutes.** Figma takes a few minutes to report them, and fdg checks every 5 minutes.

**Nothing runs while Claude Code is closed.** Missed changes appear the next time you open it.

## Privacy

- Your token stays in Claude Code's secure storage and is only sent to `api.figma.com`.
- `file_metadata:read` cannot read design content.
- Records, baselines and reports stay on your machine, outside git. Baselines take about 200 KB per frame.
- fdg only writes to your own draft, and only to add the marker.

## Development

Source is in `plugins/fdg/src`. Plugin installs run no build step, so `plugins/fdg/dist` is committed.

```bash
npm install
npm run check
```

Development needs Node.js 22.18 or later. `--plugin-dir` does not load the MCP tools, so test with a local install:

```text
/plugin marketplace add ~/figma-draft-guard
/plugin install fdg@figma-draft-guard-marketplace
```

## License

[MIT](./LICENSE)
