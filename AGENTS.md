# AGENTS.md — Attachment Auth Downloader

Reference for an AI agent asked to run, debug, or modify this Obsidian plugin.
Rename to `CLAUDE.md` if your tooling prefers that filename.

---

## 1. Purpose and scope

Obsidian plugin, single source file (`main.ts`, bundled to `main.js` via
esbuild). Scans vault notes for **remote image references**, downloads each
one using **cookie credentials pasted into settings**, writes it into the
vault as an attachment, and rewrites the note to point at the local copy.

It exists because Obsidian's built-in "Download attachments" command and
community plugins in this space (`obsidian-attachment-download`,
`obsidian-attachmenter`) issue anonymous requests via `requestUrl`, which
carries no session cookies. They cannot fetch images sitting behind a login —
this plugin can, because you supply the session cookies yourself.

**In scope:** `http(s)` image URLs in markdown embeds and `<img>` tags.
**Out of scope:** `data:` URIs, `file://` paths, non-image attachments,
attachment reorganization/renaming after the fact, orphan cleanup, browser
cookie-store access (see §9).

`isDesktopOnly: true` in `manifest.json` — the plugin uses Node's `crypto`
(`createHash`) and `path` (`posix`) modules, unavailable on mobile.

---

## 2. Build

```bash
npm install
npm run build     # node esbuild.config.mjs -> bundles main.ts to main.js
```

`esbuild.config.mjs` marks `obsidian`, `electron`, and the CodeMirror/@lezer
packages as `external` — they're provided by the Obsidian runtime, not
bundled. `main.js` is a generated artifact (gitignored); never hand-edit it,
edit `main.ts` and rebuild.

---

## 3. Execution pipeline

Entry point is `AttachmentAuthDownloaderPlugin.onload()`, which registers four
commands and a settings tab. Each download command calls `runDownload(scope)`:

```
runDownload(scope, folderPath?)
 ├─ parseCookiesTxt(settings.cookiesText)   -> CookieEntry[]
 ├─ collectFiles(app, scope, folderPath)     -> TFile[]  (note | vault | folder)
 ├─ preflight()                              fetch ONE image; abort run on failure
 │                                           (skipped if settings.skipPreflight)
 └─ for file of files:
      processNote(app, file, settings, cookies, stats, consecutive, log, dryRun)
        ├─ findImageUrls(text)              ordered, deduped
        ├─ per URL: domainAllowed() -> looksSigned() -> fetchImage() -> classify()
        ├─ targetFilename() -> vault.createBinary() -> linkFor() -> rewriteText()
        └─ vault.modify(file, text) only if text changed and not dryRun
      -> writeLog()  always, win or lose
```

`testCredentials()` is a thin wrapper that runs `preflight()` alone, for
verifying cookies without touching any notes.

---

## 4. Function contracts

### Credentials

| Function | Contract |
|---|---|
| `parseCookiesTxt(raw)` | Parses a Netscape `cookies.txt` export (handles the `#HttpOnly_` prefix some export extensions add) into `CookieEntry[]`. No OS keyring access — there is no browser-read equivalent to the old Python script's `--from-browser`. |
| `cookiesForUrl(cookies, url)` | Filters to cookies whose domain matches the URL's hostname (exact or suffix match on `.domain`). |
| `cookieHeaderForUrl(cookies, url)` | Joins matching cookies into a `"name=value; ..."` header, scoped per-request. |
| `describeCookies(cookies)` | `{domain: [cookie_name, ...]}` for the settings-tab status line and the run log. Names only, never values, in the log — but see §8 for where values *do* end up. |

### Fetch and classify

| Function | Contract |
|---|---|
| `noteSourceUrl(app, file, text)` | Reads `source:` from frontmatter via `metadataCache` first, falls back to a regex scan of the raw frontmatter block. Used as `Referer`. |
| `findImageUrls(text)` | Ordered, deduplicated `string[]`. Markdown embeds first, then `<img>` tags. |
| `looksSigned(url)` | Inspects **query string only** for expiring-signature markers. |
| `classify(status, headers, buf, minBytes)` | `{ok, reason}`. On success `reason` is the content-type, not a message — mirrors the Python script's overloaded return, see §7. |
| `fetchImage(url, cookieHeader, referer, userAgent, timeoutMs)` | Wraps `requestUrl({throw: false})` in a manual `withTimeout()`, since `requestUrl` has no native timeout. Returns `{status, headers, buf}`. |

### Filesystem and rewriting

| Function | Contract |
|---|---|
| `targetFilename(url, contentType, prefix)` | `{prefix}{stem}-{sha1(url).slice(0,8)}{ext}`. Deterministic in `url` — re-runs are idempotent. Extension from the URL path if recognized, else derived from content-type, else `.png`. |
| `linkFor(notePath, assetPath, style)` | `"relative"` -> URL-encoded relative markdown link computed via `posix.relative` from the note's own directory; `"wikilink"` -> `![[name]]`. |
| `rewriteText(text, url, replacement)` | Replaces only embeds whose URL is **exactly equal** to `url` — one pass for markdown embeds (equality check inside the replacer), one regex pass (`re.escape`-equivalent) for `<img>` tags. Non-embed links are left alone. |
| `ensureFolder(app, folderPath)` | Creates the attachments folder path segment-by-segment if missing; throws if a path segment exists and isn't a folder. |
| `preflight(app, files, settings, cookies, log)` | `Promise<boolean>`. Fetches the first eligible image across all files, logs which cookies matched that host. `false` if none eligible or the fetch fails. |
| `processNote(...)` | Mutates `stats` and `consecutive` in place; may throw `AuthAbort`. |

---

## 5. Mutable state

```ts
stats = { downloaded, failed, skipped, signed, reasons: Map<string, number> }
consecutive = { n: number }   // object box so the counter survives across
                               // processNote() calls in the runDownload loop
```

`consecutive.n` increments only on a reason containing `"rejected or expired"`
(401/403). Any success resets it to `0`. At `>= settings.maxAuthFailures` a
`AuthAbort` is thrown — caught in `runDownload()`'s loop, which logs the
message, sets `aborted = true`, and breaks (does not re-throw past the loop).

---

## 6. Invariants — preserve these when editing

1. **No filesystem write occurs before `preflight()` returns `true`** (unless
   `settings.skipPreflight` is on).
2. **Non-image bytes are never written.** `classify()` is the only gate; don't
   bypass it.
3. **Re-runs are idempotent.** Same URL -> same filename; `getAbstractFileByPath()`
   check skips re-download; already-rewritten links no longer match `MD_IMG`/
   `HTML_IMG` because they're no longer `https?://`.
4. **Raw cookie values never appear in the log note** (`Attachment Auth
   Downloader Log.md`) — only domains and cookie *names* via `describeCookies()`.
   Do not add a debug path that logs `cookieHeaderForUrl()`'s output.
5. **Notes are only written when their text actually changed** (`text !== original`).
6. **Requests are sequential**, throttled by `settings.delayMs`. Not an accident —
   avoid switching to `Promise.all()` without re-adding per-host rate limiting.

---

## 7. Known warts

**`classify()` overloads its return value**, same as the original Python
script it was ported from: on success `reason` is the content-type, not a
message, and `processNote()` passes that value straight into
`targetFilename()`. If you change what `classify()` returns on success, fix
that call site or every downloaded file falls back to the `.png` extension.

**`stats.reasons` keys** are the text before `—` in the failure message, so
rewording a failure message changes how the run-summary groups it.

---

## 8. Known warts specific to the port (read before touching credentials code)

**Cookies are stored in plaintext in this plugin's `data.json`**, inside
`.obsidian/plugins/attachment-auth-downloader/` in the vault, via
`saveData()`. This is a real behavior change from the Python script, which
never persisted cookies to disk itself (they came fresh from the browser or a
file the user pointed at each run). Anything with filesystem access to the
vault — other plugins, a sync client, a backup tool — can read `data.json`.
This is documented in the README's Security notes section; don't remove that
warning, and don't add a feature that copies `cookiesText` anywhere else
(clipboard, another note, console) without equally prominent warning.

**No OS keyring / browser cookie-store access.** The Python original's
`--from-browser` read Chrome/Firefox/Edge's encrypted cookie DB directly.
Obsidian plugins run in a sandboxed renderer with no such access — cookies
must be exported to a file and pasted/attached once. If a request author asks
for "read cookies from my browser automatically," that's not implementable
here without a native companion process; say so rather than half-implementing
it.

---

## 9. Modification guide

| Requested change | Touch |
|---|---|
| Different auth scheme (OAuth, bearer token, custom header) | Add a settings field + thread it through `fetchImage()`'s `headers` object |
| Support `data:` / `file://` sources | `findImageUrls()` + a branch before `fetchImage()` in `processNote()` |
| Non-image attachments (PDF, video) | `EXT_BY_TYPE`, the `image/` check in `classify()`, and `MD_IMG` (needs `!?\[` to catch non-embed links) |
| Concurrency | The URL loop in `processNote()`. Must keep per-host rate limiting, and `consecutive.n` needs a rethink if parallelized |
| Progress persistence across runs | Not needed — idempotency (§6.3) already gives resume semantics |
| Per-note credentials | Thread a domain->cookie-list map through instead of one global `cookies` array |
| Encrypt stored cookies | Would need a passphrase prompt each session, since Obsidian's `saveData()` has no built-in encryption — significant UX change, discuss before implementing |

**Do not** add a flag that writes files before preflight, or that prints/logs
cookie values anywhere (log note, console, `Notice`). Both defeat the point of
the preflight and the "names only" logging invariant.

---

## 10. Regex limitations

`MD_IMG` matches `![alt](url)` with optional `<>` wrapping and a trailing
`"title"`. It will **not** match:

- URLs containing `)`, `<`, `>`, or whitespace (rare; would need bracket counting)
- Reference-style links (`![alt][ref]` with a separate definition block)
- Embeds inside fenced code blocks — these are matched and rewritten, which is
  arguably wrong. If a user reports code samples being mangled, add a
  fence-stripping pre-pass before `findImageUrls()`.

`HTML_IMG` matches the opening tag only; `rewriteText()` uses a second, wider
regex to consume the full element including trailing attributes and `/>`.

---

## 11. Settings reference

See `main.ts`'s `PluginSettings` interface and `DEFAULT_SETTINGS` for the
full, current list — this is the single source of truth and will drift from
any copy pasted here. The README's "Settings reference" table is kept
human-readable in sync with it; update both when adding a setting.

**Operational note for agents