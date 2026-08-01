# obsidian-auth-downloader

A single-file Python CLI that scans Obsidian vault notes for remote image references, downloads them using **browser-derived cookie credentials**, saves them into the vault, and rewrites each note to point at the local copy.

It exists because Obsidian's built-in "Download attachments" command and community plugins (`obsidian-attachment-download`, `obsidian-attachmenter`) send anonymous requests through Obsidian's `requestUrl`, which doesn't share a cookie jar with any browser — so they can't fetch images sitting behind a login (paywalled articles, internal wikis, session-gated CDNs, etc.). This script can, because it authenticates the same way your browser does.

**In scope:** `http(s)` image URLs in markdown embeds and `<img>` tags.
**Out of scope:** `data:` URIs, `file://` paths, non-image attachments, attachment reorganization/renaming, orphan cleanup.

Runs on your own machine — it needs filesystem access to your vault and network access to arbitrary hosts, so it can't be run in a sandbox.

## Prerequisites

- Python 3.8+
- `pip install requests`
- `pip install browser-cookie3` (optional, only needed for `--from-browser`)

## Usage

```bash
# Dry run first — verifies credentials, writes nothing
python localize_images_auth.py ~/vault --from-browser firefox --dry-run

# Real run, with .bak backups of every edited note
python localize_images_auth.py ~/vault --from-browser chrome --backup

# Using an exported cookies.txt instead of reading the browser directly
python localize_images_auth.py ~/vault --cookies-file cookies.txt --backup

# Raw Cookie header, scoped to exactly one host
python localize_images_auth.py ~/vault \
  --cookie "session=..." --cookie-domain cdn.example.com

# Single note, wikilink-style output, restricted to one host
python localize_images_auth.py ~/vault/Clippings/a.md \
  --cookies-file cookies.txt --wikilinks --domain cdn.example.com
```

Cookies can come from three places, in descending order of convenience:

1. `--from-browser chrome|firefox|edge|brave|opera|safari|vivaldi|all` — reads the live cookie jar out of a local browser profile
2. `--cookies-file jar.txt` — a Netscape-format `cookies.txt` export (e.g. from a "Get cookies.txt" browser extension)
3. `--cookie "k=v; k2=v2" --cookie-domain host` — a raw Cookie header, scoped to a single host so it's never sent anywhere else

Cookies are matched per-host by the cookie jar, so credentials for one site are never sent to another. **Cookie values are never printed or logged** — only domains and cookie names.

Before touching the vault it runs a preflight: one image is fetched and the result reported. If the server rejects it, nothing is written. Full flag reference is in `AGENTS.md`.

## Security notes

- Any file with `cookies` in its name is gitignored (no exceptions, not even a sample). Never commit a real cookie export — treat it like a password, since a live session cookie can be used to impersonate you on that site until it expires or you sign out elsewhere.
- If you ever accidentally commit real cookies or tokens, rotate/invalidate that session immediately (sign out of the site everywhere) — removing the file in a later commit does not erase it from git history.
- `--cookie` refuses to run without `--cookie-domain`, so a raw header can't accidentally be broadcast to every host the script touches.

## Exit codes

`0` on success (including "some downloads failed"); `1` for credential/preflight/argument errors and the consecutive-auth-failure abort. A non-zero exit never leaves the vault half-written in an inconsistent state — re-running is idempotent (same URL always maps to the same filename, and already-rewritten links are skipped).

See `AGENTS.md` for the full function-by-function reference, failure taxonomy, and modification guide.
