# Attachment Auth Downloader

An Obsidian plugin that scans your notes for remote image references, downloads them using **cookie credentials you supply**, saves them into your vault, and rewrites the links to point at the local copy.

It exists because Obsidian's built-in "Download attachments" command and community plugins like `obsidian-attachment-download` and `obsidian-attachmenter` send anonymous requests, which can't fetch images sitting behind a login — paywalled articles, internal wikis, session-gated CDNs (e.g. Cisco Tech Zone clippings), and so on. This plugin authenticates those requests the same way your browser would.

**In scope:** `http(s)` image URLs in markdown embeds and `<img>` tags.
**Out of scope:** `data:` URIs, `file://` paths, non-image attachments, attachment reorganization/renaming, orphan cleanup.

`isDesktopOnly` — it needs Node's `crypto`/`path` modules, so it doesn't run on mobile.

## Install

Not yet on the community plugin list. Install manually:

1. Build it (see below), or download `main.js`, `manifest.json`, and `styles.css` (if present) from a release.
2. Copy them into `<your vault>/.obsidian/plugins/attachment-auth-downloader/`.
3. Reload Obsidian and enable **Attachment Auth Downloader** in Settings → Community plugins.

## Build from source

```bash
npm install
npm run build      # bundles main.ts -> main.js via esbuild
```

`main.js` is a build artifact and is gitignored — always rebuild it rather than expecting it to be tracked in this repo.

## Setup

1. Export your session's cookies for the target site into a Netscape-format `cookies.txt` (e.g. with a "Get cookies.txt LOCALLY" browser extension) while logged in.
2. Open Settings → Attachment Auth Downloader, and either attach that file or paste its contents into "Cookies.txt contents (advanced)".
3. Set the attachments folder (default `ciscodocs/Clippings/attachments`) and other options as needed.
4. Run **Test credentials (preflight only)** from the command palette to confirm the cookies work against one image before doing a real run.

## Commands

- **Download remote images: current note**
- **Download remote images: entire vault**
- **Download remote images: specific folder…** — opens a folder picker
- **Test credentials (preflight only)** — fetches exactly one image and reports the result; nothing is written

Every run (dry or real) writes its log to a note called `Attachment Auth Downloader Log.md` in the vault root.

## Settings reference

| Setting | Purpose |
|---|---|
| Cookies.txt file / contents | Session credentials, matched per-host — a cookie for one domain is never sent to another |
| Attachments folder | Vault-relative path where downloaded images land |
| Default folder | Starting point for the folder-picker command |
| Filename prefix | Prepended to every saved filename |
| Link style | `![](relative/link.png)` or `![[wikilink.png]]` |
| Domain filter | Comma-separated allowlist of hostnames; blank = no restriction |
| Force signed URLs | Try expiring/presigned URLs instead of skipping them |
| Minimum bytes | Responses smaller than this are treated as placeholders, not real images |
| Max consecutive auth failures | Abort the run after this many 401/403s in a row |
| Delay between requests | Throttle, in ms |
| Request timeout | Per-request timeout, in ms |
| Referer override | Defaults to each note's frontmatter `source:` field |
| User-Agent | Sent with every request |
| Write .bak backups | Keep a copy of each note before rewriting its links |
| Dry run | Preview only — downloads and writes nothing, just logs what would happen. **On by default** |
| Skip preflight | Skip the single-image credential check that normally runs before a batch |

## How it works

Before touching the vault, `preflight()` fetches exactly one eligible ima