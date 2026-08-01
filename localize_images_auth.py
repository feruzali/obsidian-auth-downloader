#!/usr/bin/env python3
"""
localize_images_auth.py — download auth-gated images referenced in Obsidian
notes and rewrite the links to local attachments.

Built around cookie authentication. Cookies can come from three places, in
descending order of convenience:

  1. --from-browser chrome     read the live cookie jar out of your browser
                               profile (needs: pip install browser-cookie3)
  2. --cookies-file jar.txt    a Netscape cookies.txt export
  3. --cookie "k=v; k2=v2"     a raw Cookie header, scoped with --cookie-domain

Cookies are matched per-host by the cookie jar, so credentials for one site are
never sent to another. Cookie values are never printed.

Before touching the vault it runs a preflight: one image is fetched and the
result reported. If the server rejects it, nothing is written.

Requires: pip install requests
Optional: pip install browser-cookie3

Examples
--------
# Check that cookies work, change nothing:
python localize_images_auth.py ~/vault --from-browser firefox --dry-run

# Real run, with backups:
python localize_images_auth.py ~/vault --from-browser chrome --backup

# Raw header, only ever sent to one host:
python localize_images_auth.py ~/vault \
    --cookie "session=abc123" --cookie-domain images.internal.example.com
"""

import argparse
import hashlib
import os
import re
import sys
import time
import urllib.parse
from collections import Counter
from http.cookiejar import Cookie, CookieJar, MozillaCookieJar
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing dependency. Run: pip install requests")

# ---------------------------------------------------------------- patterns --

MD_IMG = re.compile(
    r'!\[(?P<alt>[^\]]*)\]\(\s*<?(?P<url>https?://[^\s<>)]+)>?(?:\s+"[^"]*")?\s*\)'
)
HTML_IMG = re.compile(
    r'<img\b[^>]*?\bsrc\s*=\s*["\'](?P<url>https?://[^"\']+)["\']', re.IGNORECASE
)
FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)
SOURCE_FIELD = re.compile(r'^source:\s*["\']?(?P<url>https?://[^"\'\s]+)', re.MULTILINE)

SIGNED_HINTS = ("x-amz-signature", "x-amz-expires", "x-goog-signature",
                "expires=", "signature=", "token=", "se=")

LOGIN_HINTS = ("<form", "sign in", "log in", "login", "password",
               "authenticate", "sso", "oauth")

EXT_BY_TYPE = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
    "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/tiff": ".tiff",
    "image/x-icon": ".ico",
}

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# ------------------------------------------------------------ cookie setup --


def cookies_from_browser(browser, domain=None):
    """Pull a live cookie jar out of a local browser profile."""
    try:
        import browser_cookie3
    except ImportError:
        sys.exit(
            "--from-browser needs browser_cookie3.\n"
            "  pip install browser-cookie3\n"
            "Or export cookies.txt from a browser extension and use --cookies-file."
        )

    loaders = {
        "chrome": browser_cookie3.chrome,
        "chromium": browser_cookie3.chromium,
        "firefox": browser_cookie3.firefox,
        "edge": browser_cookie3.edge,
        "brave": browser_cookie3.brave,
        "opera": browser_cookie3.opera,
        "safari": browser_cookie3.safari,
        "vivaldi": getattr(browser_cookie3, "vivaldi", browser_cookie3.chrome),
        "all": browser_cookie3.load,
    }
    if browser not in loaders:
        sys.exit(f"Unknown browser '{browser}'. Options: {', '.join(loaders)}")

    try:
        # domain_name filters at load time, which keeps the jar small and means
        # we never even hold cookies for unrelated sites in memory.
        return loaders[browser](domain_name=domain) if domain else loaders[browser]()
    except Exception as e:
        sys.exit(
            f"Could not read {browser} cookies: {type(e).__name__}: {e}\n"
            "Common causes: the browser is running and holding a profile lock "
            "(close it), or the OS keyring refused decryption. "
            "Falling back to --cookies-file always works."
        )


def jar_from_header(raw, domain):
    """Turn a raw 'a=b; c=d' Cookie header into a domain-scoped jar."""
    if not domain:
        sys.exit(
            "--cookie requires --cookie-domain, so the credentials are only "
            "ever sent to that host. Example:\n"
            '  --cookie "session=abc" --cookie-domain cdn.example.com'
        )
    jar = requests.cookies.RequestsCookieJar()
    for pair in raw.split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        name, _, value = pair.partition("=")
        jar.set(name.strip(), value.strip(), domain=domain, path="/")
    return jar


def describe_jar(jar):
    """Summarise a jar by domain and cookie name only — never values."""
    by_domain = {}
    for c in jar:
        by_domain.setdefault(c.domain.lstrip("."), []).append(c.name)
    return by_domain


def make_session(args):
    s = requests.Session()
    s.headers["User-Agent"] = args.user_agent
    s.headers["Accept"] = "image/avif,image/webp,image/*,*/*;q=0.8"

    jar = requests.cookies.RequestsCookieJar()

    if args.from_browser:
        loaded = cookies_from_browser(args.from_browser, args.cookie_domain)
        for c in loaded:
            jar.set_cookie(c)
    if args.cookies_file:
        mj = MozillaCookieJar()
        # ignore_discard keeps session cookies, which browsers export with an
        # expiry of 0 — and those are usually the ones that matter.
        mj.load(args.cookies_file, ignore_discard=True, ignore_expires=True)
        for c in mj:
            jar.set_cookie(c)
    if args.cookie:
        for c in jar_from_header(args.cookie, args.cookie_domain):
            jar.set_cookie(c)

    s.cookies = jar

    if args.bearer:
        s.headers["Authorization"] = f"Bearer {args.bearer}"
    for raw in args.header or []:
        name, _, value = raw.partition(":")
        s.headers[name.strip()] = value.strip()

    return s


# ----------------------------------------------------------------- helpers --


def note_source_url(text):
    fm = FRONTMATTER.match(text)
    if not fm:
        return None
    m = SOURCE_FIELD.search(fm.group(1))
    return m.group("url") if m else None


def find_image_urls(text):
    seen, out = set(), []
    for pattern in (MD_IMG, HTML_IMG):
        for m in pattern.finditer(text):
            url = m.group("url")
            if url not in seen:
                seen.add(url)
                out.append(url)
    return out


def looks_signed(url):
    q = urllib.parse.urlparse(url).query.lower()
    return any(h in q for h in SIGNED_HINTS)


def classify(response, body, min_bytes):
    """Return (ok, reason). Distinguishes a real image from a login page."""
    if response.status_code in (401, 403):
        return False, f"HTTP {response.status_code} — cookies rejected or expired"
    if response.status_code == 404:
        return False, "HTTP 404 — gone from the server"
    if response.status_code >= 400:
        return False, f"HTTP {response.status_code}"

    ctype = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if ctype.startswith("text/html"):
        head = body[:2048].decode("utf-8", "ignore").lower()
        if any(h in head for h in LOGIN_HINTS):
            return False, "HTTP 200 but served a login page — cookies not applied"
        return False, "HTTP 200 but served HTML, not an image"
    if ctype and not ctype.startswith("image/") and "octet-stream" not in ctype:
        return False, f"unexpected content-type: {ctype}"
    if len(body) < min_bytes:
        return False, f"suspiciously small ({len(body)} bytes)"
    return True, ctype


def fetch(session, url, referer, args):
    headers = {"Referer": referer} if referer else {}
    r = session.get(url, headers=headers, timeout=args.timeout,
                    allow_redirects=True)
    body = r.content
    ok, reason = classify(r, body, args.min_bytes)
    return ok, reason, body, r


def target_filename(url, content_type, prefix):
    path = urllib.parse.urlparse(url).path
    stem = Path(urllib.parse.unquote(path)).stem or "image"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")[:60] or "image"

    ext = Path(path).suffix.lower()
    if ext not in EXT_BY_TYPE.values():
        ext = EXT_BY_TYPE.get((content_type or "").lower(), ".png")

    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]
    return f"{prefix}{stem}-{digest}{ext}"


def link_for(note_path, asset_path, wikilinks):
    if wikilinks:
        return f"![[{asset_path.name}]]"
    rel = os.path.relpath(asset_path, note_path.parent).replace(os.sep, "/")
    return "![](" + urllib.parse.quote(rel) + ")"


def rewrite(text, url, replacement):
    text = MD_IMG.sub(
        lambda m: replacement if m.group("url") == url else m.group(0), text
    )
    text = re.sub(
        r'<img\b[^>]*?\bsrc\s*=\s*["\']' + re.escape(url) + r'["\'][^>]*/?>',
        replacement, text, flags=re.IGNORECASE,
    )
    return text


# -------------------------------------------------------------- preflight --


def preflight(session, notes, args):
    """Fetch exactly one image and report, before anything is written."""
    for note in notes:
        text = note.read_text(encoding="utf-8")
        for url in find_image_urls(text):
            if looks_signed(url) and not args.force_signed:
                continue
            if args.domain and urllib.parse.urlparse(url).netloc not in args.domain:
                continue

            host = urllib.parse.urlparse(url).netloc
            matching = [c.name for c in session.cookies
                        if host.endswith(c.domain.lstrip("."))]
            print(f"\nPreflight against {host}")
            print(f"  cookies that will be sent: "
                  f"{', '.join(matching) if matching else 'NONE'}")

            referer = args.referer or note_source_url(text)
            if referer:
                print(f"  referer: {referer}")

            try:
                ok, reason, body, _ = fetch(session, url, referer, args)
            except requests.RequestException as e:
                print(f"  FAILED: {type(e).__name__}: {e}")
                return False

            if ok:
                print(f"  OK — {reason}, {len(body) // 1024} KB. Proceeding.")
                return True

            print(f"  FAILED: {reason}")
            if not matching:
                print("  No cookies matched this host. Note that images often "
                      "live on a different domain than the article — you may "
                      "need cookies for the CDN host specifically.")
            return False

    print("No downloadable image URLs found.")
    return False


# ------------------------------------------------------------------- main --


def process_note(note_path, session, args, stats, consecutive):
    text = original = note_path.read_text(encoding="utf-8")
    urls = find_image_urls(text)
    if not urls:
        return

    referer = args.referer or note_source_url(text)
    attachments = (Path(args.attachments) if os.path.isabs(args.attachments)
                   else args.vault_root / args.attachments)

    print(f"\n{note_path.relative_to(args.vault_root)}  ({len(urls)} image(s))")

    for url in urls:
        if args.domain and urllib.parse.urlparse(url).netloc not in args.domain:
            stats["skipped"] += 1
            continue
        if looks_signed(url) and not args.force_signed:
            print(f"  skip (expiring signed URL, needs re-clipping)  {url[:66]}")
            stats["signed"] += 1
            continue

        try:
            ok, reason, body, resp = fetch(session, url, referer, args)
        except requests.RequestException as e:
            print(f"  FAIL {type(e).__name__}  {url[:74]}")
            stats["failed"] += 1
            continue

        if not ok:
            print(f"  FAIL {reason}  {url[:60]}")
            stats["failed"] += 1
            stats["reasons"][reason.split("—")[0].strip()] += 1
            if "rejected or expired" in reason:
                consecutive[0] += 1
                if consecutive[0] >= args.max_auth_failures:
                    raise SystemExit(
                        f"\nStopped: {consecutive[0]} consecutive auth failures. "
                        "Your session has probably expired mid-run — refresh "
                        "your cookies and run again. Notes edited so far are "
                        "already saved; re-running skips what succeeded."
                    )
            continue

        consecutive[0] = 0
        name = target_filename(url, reason, args.prefix)
        dest = attachments / name
        replacement = link_for(note_path, dest, args.wikilinks)

        if args.dry_run:
            print(f"  would save {name}  ({len(body) // 1024} KB)")
        else:
            attachments.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                dest.write_bytes(body)
            print(f"  saved {name}  ({len(body) // 1024} KB)")

        text = rewrite(text, url, replacement)
        stats["downloaded"] += 1
        time.sleep(args.delay)

    if text != original and not args.dry_run:
        if args.backup:
            note_path.with_suffix(note_path.suffix + ".bak").write_text(
                original, encoding="utf-8")
        note_path.write_text(text, encoding="utf-8")


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("target", help="Vault folder or a single .md file")
    p.add_argument("--attachments", default="attachments",
                   help="Save location, relative to vault root (default: attachments)")
    p.add_argument("--prefix", default="", help="Filename prefix")
    p.add_argument("--wikilinks", action="store_true",
                   help="Write ![[file.png]] instead of a relative markdown link")

    c = p.add_argument_group("cookies / credentials")
    c.add_argument("--from-browser", metavar="NAME",
                   help="chrome, chromium, firefox, edge, brave, opera, safari, "
                        "vivaldi, or all")
    c.add_argument("--cookies-file", help="Netscape-format cookies.txt")
    c.add_argument("--cookie", help='Raw Cookie header; requires --cookie-domain')
    c.add_argument("--cookie-domain",
                   help="Restrict --cookie to this host, and filter --from-browser")
    c.add_argument("--bearer", help="Bearer token for the Authorization header")
    c.add_argument("--header", action="append",
                   help='Extra header, repeatable: --header "X-Api-Key: ..."')
    c.add_argument("--referer",
                   help="Force a Referer (default: the note's `source:` frontmatter)")
    c.add_argument("--user-agent", default=DEFAULT_UA)

    p.add_argument("--domain", action="append", help="Only fetch these hosts, repeatable")
    p.add_argument("--force-signed", action="store_true",
                   help="Try expiring signed URLs instead of skipping them")
    p.add_argument("--min-bytes", type=int, default=512)
    p.add_argument("--max-auth-failures", type=int, default=5,
                   help="Abort after N consecutive 401/403s (default: 5)")
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--delay", type=float, default=0.3)
    p.add_argument("--skip-preflight", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--backup", action="store_true",
                   help="Write a .bak beside each edited note")
    args = p.parse_args()

    target = Path(args.target).expanduser().resolve()
    if not target.exists():
        sys.exit(f"No such path: {target}")

    if target.is_file():
        notes, args.vault_root = [target], target.parent
    else:
        notes = [n for n in sorted(target.rglob("*.md"))
                 if ".obsidian" not in n.parts and ".trash" not in n.parts]
        args.vault_root = target

    session = make_session(args)

    loaded = describe_jar(session.cookies)
    if loaded:
        print("Cookies loaded:")
        for domain, names in sorted(loaded.items()):
            shown = ", ".join(sorted(names)[:6])
            more = f" (+{len(names) - 6} more)" if len(names) > 6 else ""
            print(f"  {domain}: {shown}{more}")
    else:
        print("No cookies loaded — requests will be anonymous.")

    if not args.skip_preflight and not preflight(session, notes, args):
        sys.exit("\nPreflight failed. Nothing was written. Fix credentials "
                 "and retry, or use --skip-preflight to force.")

    stats = {"downloaded": 0, "failed": 0, "skipped": 0, "signed": 0,
             "reasons": Counter()}
    consecutive = [0]

    for note in notes:
        try:
            process_note(note, session, args, stats, consecutive)
        except SystemExit:
            raise
        except Exception as e:
            print(f"  ERROR on {note}: {type(e).__name__}: {e}")

    print(f"\n{'Would download' if args.dry_run else 'Downloaded'}: "
          f"{stats['downloaded']} | failed: {stats['failed']} | "
          f"skipped: {stats['skipped']} | expiring URLs: {stats['signed']}")
    for reason, n in stats["reasons"].most_common():
        print(f"  {n}x {reason}")
    if args.dry_run:
        print("Dry run — nothing written.")


if __name__ == "__main__":
    main()
