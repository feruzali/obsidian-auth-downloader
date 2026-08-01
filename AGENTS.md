# AGENTS.md — `localize_images_auth.py`

Reference for an AI agent asked to run, debug, or modify this script.
Rename to `CLAUDE.md` if your tooling prefers that filename.

---

## 1. Purpose and scope

Single-file Python CLI. Scans Obsidian markdown notes for **remote image
references**, downloads each one using **browser-derived cookie credentials**,
writes it into the vault, and rewrites the note to point at the local copy.

It exists because Obsidian's built-in "Download attachments" command and the
community plugins in this space (`obsidian-attachment-download`,
`obsidian-attachmenter`) issue anonymous HTTP requests through Obsidian's
`requestUrl`, which does not share a cookie jar with any browser. They cannot
fetch images behind a session. This script can.

**In scope:** `http(s)` image URLs in markdown embeds and `<img>` tags.
**Out of scope:** `data:` URIs, `file://` paths, non-image attachments,
attachment reorganization/renaming after the fact, orphan cleanup.

Runs on the user's own machine — it needs filesystem access to their vault and
network access to arbitrary hosts, so it cannot be executed in a sandbox.

---

## 2. Dependencies

| Package | Required | Purpose |
|---|---|---|
| `requests` | yes | HTTP + cookie jar |
| `browser-cookie3` | only for `--from-browser` | reads live browser cookie DBs |

Import of `browser_cookie3` is deferred into `cookies_from_browser()` so the
script runs without it when using `--cookies-file` or `--cookie`.

---

## 3. Execution pipeline

Strictly ordered. Each stage gates the next.

```
main()
 ├─ resolve target → notes list, inject args.vault_root into the Namespace
 ├─ make_session(args)          build Session + RequestsCookieJar
 ├─ describe_jar()              print domains + cookie NAMES (never values)
 ├─ preflight()                 fetch exactly ONE image; abort run on failure
 └─ for note in notes:
      process_note()
        ├─ find_image_urls()    ordered, deduped
        ├─ per URL: domain filter → signed-URL filter → fetch() → classify()
        ├─ target_filename() → write bytes → link_for() → rewrite()
        └─ write note back only if text changed and not dry_run
```

`args.vault_root` is **not** a CLI flag. It is assigned inside `main()` and read
by `process_note()` and `preflight()`. Any refactor that calls those functions
directly must set it.

---

## 4. Function contracts

### Credentials

| Function | Contract |
|---|---|
| `cookies_from_browser(browser, domain=None)` | Returns a `CookieJar`. `sys.exit`s with a diagnostic on unknown browser name, missing `browser_cookie3`, or decryption/lock failure. `domain` filters at load time. |
| `jar_from_header(raw, domain)` | Parses `"a=b; c=d"` into a domain-scoped jar. **`sys.exit`s if `domain` is falsy** — this is the guard that prevents a raw header being broadcast to every host. Do not relax it. |
| `describe_jar(jar)` | `{domain: [cookie_name, ...]}`. Names only, by design. |
| `make_session(args)` | Merges all three cookie sources into one `RequestsCookieJar`, then applies `--bearer` and `--header`. Returns `requests.Session`. Sole place credentials are attached. |

### Fetch and classify

| Function | Contract |
|---|---|
| `note_source_url(text)` | Extracts `source:` from YAML frontmatter (Obsidian Web Clipper writes it). Returns `str \| None`. Used as `Referer`. |
| `find_image_urls(text)` | Ordered, deduplicated `list[str]`. Markdown embeds first, then `<img>` tags. |
| `looks_signed(url)` | Inspects **query string only** for expiring-signature markers. |
| `classify(response, body, min_bytes)` | `(bool, str)`. **On success the second element is the content-type**, not a message. See §7. |
| `fetch(session, url, referer, args)` | `(ok, reason, body, response)`. Follows redirects. Raises `requests.RequestException` on transport failure — callers must catch. |

### Filesystem and rewriting

| Function | Contract |
|---|---|
| `target_filename(url, content_type, prefix)` | `{prefix}{slug}-{sha1(url)[:8]}{ext}`. Deterministic in `url`, which is what makes re-runs idempotent. Extension from URL path, falling back to content-type, defaulting `.png`. |
| `link_for(note_path, asset_path, wikilinks)` | Relative markdown link (URL-encoded) or `![[name]]` wikilink. Relative path computed from the note's own directory, not the vault root. |
| `rewrite(text, url, replacement)` | Replaces only embeds whose URL is **exactly equal** to `url`. Two passes: markdown via lambda equality check, `<img>` via a regex built with `re.escape(url)` that consumes the whole tag. Plain (non-embed) links are left alone. |
| `preflight(session, notes, args)` | `bool`. Fetches the first eligible image across all notes. Reports which cookies match that host. Returns `False` if no eligible URLs exist at all. |
| `process_note(note_path, session, args, stats, consecutive)` | Mutates `stats` and `consecutive` in place. May raise `SystemExit`. |

---

## 5. Mutable state

```python
stats = {"downloaded": int, "failed": int, "skipped": int,
         "signed": int, "reasons": Counter()}   # reasons counts failures only

consecutive = [0]   # one-element list used as a mutable box, so the counter
                    # survives across process_note() calls
```

`consecutive[0]` increments only on `401`/`403`. Any success resets it to `0`.
At `>= args.max_auth_failures` the script raises `SystemExit` — this is the
mid-run session-expiry abort, and `main()`'s per-note `except` deliberately
re-raises `SystemExit` before the generic handler.

---

## 6. Invariants — preserve these when editing

1. **Cookie values are never printed or logged.** Only domains and names.
2. **No filesystem write occurs before `preflight()` returns `True`** (unless
   `--skip-preflight`).
3. **Non-image bytes are never written.** `classify()` is the only gate; do not
   bypass it.
4. **Re-runs are idempotent.** Same URL → same filename; `dest.exists()` skips
   the write; already-rewritten links no longer match `MD_IMG` because they are
   no longer `https?://`. A run interrupted halfway can be resumed by re-running.
5. **Raw `--cookie` is never sent without an explicit `--cookie-domain`.**
6. **Notes are only written when their text actually changed.**
7. **Requests are sequential.** `--delay` between them. Not an accident.

---

## 7. Known warts

**`classify()` overloads its return value.** On success it returns
`(True, content_type)`; on failure `(False, human_message)`. `process_note()`
then passes that same variable into `target_filename()` as `content_type`:

```python
ok, reason, body, resp = fetch(...)
...
name = target_filename(url, reason, args.prefix)   # `reason` IS the content-type here
```

This works but is fragile. If you change `classify()`'s success return, fix
this call site or every downloaded file gets the `.png` fallback extension.

**Unused imports.** `Cookie`, `CookieJar` from `http.cookiejar` are imported but
unused after a refactor. Harmless.

**`stats["reasons"]` keys** are the text before `—` in the failure message, so
message rewording changes the summary grouping.

---

## 8. Failure taxonomy

What each reported failure means, and the correct remedy:

| Message | Cause | Remedy |
|---|---|---|
| `HTTP 401/403 — cookies rejected or expired` | No valid session for that host | Refresh cookies; verify the jar covers the **image host**, not just the article host |
| `HTTP 200 but served a login page` | Server returns HTML instead of 401 | Same as above; this is the silent-corruption case the classifier exists to catch |
| `HTTP 404 — gone from the server` | Resource deleted upstream | Unrecoverable |
| `skip (expiring signed URL, needs re-clipping)` | Presigned S3/GCS/SAS URL, already expired | **Unrecoverable by any script.** Revisit the page and re-clip |
| `suspiciously small (N bytes)` | Placeholder/tracking pixel, or truncated response | Lower `--min-bytes` if legitimate |
| `unexpected content-type: X` | Server sent something else | Investigate manually |
| `cookies that will be sent: NONE` (preflight) | Cookie domain scope mismatch | Most common real cause — images often live on a CDN subdomain the session cookie isn't scoped to |

**Diagnostic priority:** if the user reports total failure, check the preflight
cookie-match line first. Domain scoping accounts for more failures than
expiry does.

---

## 9. Modification guide

| Requested change | Touch |
|---|---|
| Different auth scheme (OAuth, mTLS, API key) | `make_session()` only |
| Support `data:` / `file://` sources | `find_image_urls()` + a branch before `fetch()` in `process_note()` |
| Non-image attachments (PDF, video) | `EXT_BY_TYPE`, the `image/` check in `classify()`, and `MD_IMG` (needs `!?\[` to catch non-embed links) |
| Match `obsidian-attachment-management` folder/name templates | `target_filename()` + the `attachments` path computation in `process_note()`; mirror `{root}/{path}/{name}` with `${notename}` etc. |
| Concurrency | The URL loop in `process_note()`. Must keep per-host rate limiting, and `consecutive[0]` needs a lock or a rethink |
| Progress persistence across runs | Not needed — idempotency (§6.4) already gives resume semantics |
| Per-note credentials | Thread a domain→jar map through `fetch()`; `make_session()` currently builds one global jar |

**Do not** add a flag that writes files before preflight, or that prints cookie
values for debugging. Both defeat the script's purpose.

---

## 10. Regex limitations

`MD_IMG` matches `![alt](url)` with optional `<>` wrapping and a trailing
`"title"`. It will **not** match:

- URLs containing `)`, `<`, `>`, or whitespace (rare; would need bracket counting)
- Reference-style links (`![alt][ref]` with a separate definition block)
- Embeds inside fenced code blocks — these are matched and rewritten, which is
  arguably wrong. If a user reports code samples being mangled, add a
  fence-stripping pre-pass before `find_image_urls()`.

`HTML_IMG` matches the opening tag only; `rewrite()` uses a second, wider regex
to consume the full element including any trailing attributes and `/>`.

---

## 11. Invocation reference

```bash
# Verify credentials, write nothing
python localize_images_auth.py ~/vault --from-browser firefox --dry-run

# Real run
python localize_images_auth.py ~/vault --from-browser chrome --backup

# Scoped raw header
python localize_images_auth.py ~/vault \
  --cookie "session=..." --cookie-domain cdn.example.com

# Single note, wikilink output, restricted to one host
python localize_images_auth.py ~/vault/Clippings/a.md \
  --cookies-file ~/c.txt --wikilinks --domain cdn.example.com
```

Exit codes: `0` success (including "some downloads failed"); `1` for
credential/preflight/argument errors and the consecutive-auth-failure abort.
A non-zero exit never means the vault is half-written in an inconsistent
state — §6.4 covers that.

**Operational note for agents:** always propose `--dry-run` first, and
`--backup` on the first real run. The script edits notes in place.
