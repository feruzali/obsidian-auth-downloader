import {
	App,
	FuzzySuggestModal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	requestUrl,
} from "obsidian";
import { createHash } from "crypto";
import { posix } from "path";

/* ------------------------------------------------------------------ *
 * This plugin is a port of localize_images_auth.py: it scans notes
 * for remote (http/https) image references, downloads them using
 * cookie credentials you paste in once (a cookies.txt export), and
 * rewrites the links to point at a local attachments folder.
 *
 * It never reads your browser's cookie store directly (Obsidian
 * plugins can't decrypt Chrome/Firefox/Edge's encrypted cookie DBs
 * the way the Python script's --from-browser option does) — instead
 * you export cookies.txt once from a browser extension and paste it
 * into the settings tab below.
 * ------------------------------------------------------------------ */

// ------------------------------------------------------------ patterns --

const MD_IMG =
	/!\[(?<alt>[^\]]*)\]\(\s*<?(?<url>https?:\/\/[^\s<>)]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMG =
	/<img\b[^>]*?\bsrc\s*=\s*["'](?<url>https?:\/\/[^"']+)["']/gi;

const SIGNED_HINTS = [
	"x-amz-signature",
	"x-amz-expires",
	"x-goog-signature",
	"expires=",
	"signature=",
	"token=",
	"se=",
];

const LOGIN_HINTS = [
	"<form",
	"sign in",
	"log in",
	"login",
	"password",
	"authenticate",
	"sso",
	"oauth",
];

const EXT_BY_TYPE: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/tiff": ".tiff",
	"image/x-icon": ".ico",
};

// -------------------------------------------------------------- cookies --

interface CookieEntry {
	domain: string;
	path: string;
	secure: boolean;
	name: string;
	value: string;
}

/** Parse a Netscape-format cookies.txt export (handles the #HttpOnly_ prefix
 * used by browser export extensions, and ignores comments/blank lines). */
function parseCookiesTxt(raw: string): CookieEntry[] {
	const cookies: CookieEntry[] = [];
	for (const rawLine of raw.split(/\r?\n/)) {
		let line = rawLine;
		if (!line.trim()) continue;
		if (line.startsWith("#")) {
			if (line.startsWith("#HttpOnly_")) {
				line = line.slice("#HttpOnly_".length);
			} else {
				continue;
			}
		}
		const parts = line.split("\t");
		if (parts.length < 7) continue;
		const [domain, , path, secure, , name, value] = parts;
		if (!domain || !name) continue;
		cookies.push({ domain, path, secure: secure?.toUpperCase() === "TRUE", name, value: value ?? "" });
	}
	return cookies;
}

function cookiesForUrl(cookies: CookieEntry[], url: string): CookieEntry[] {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return [];
	}
	return cookies.filter((c) => {
		const d = c.domain.toLowerCase().replace(/^\./, "");
		return host === d || host.endsWith("." + d);
	});
}

function cookieHeaderForUrl(cookies: CookieEntry[], url: string): string {
	return cookiesForUrl(cookies, url)
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");
}

function describeCookies(cookies: CookieEntry[]): Map<string, string[]> {
	const byDomain = new Map<string, string[]>();
	for (const c of cookies) {
		const d = c.domain.replace(/^\./, "");
		const arr = byDomain.get(d) ?? [];
		arr.push(c.name);
		byDomain.set(d, arr);
	}
	return byDomain;
}

// ---------------------------------------------------------------- misc --

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			}
		);
	});
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lowerHeaders(h: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(h ?? {})) out[k.toLowerCase()] = h[k];
	return out;
}

function findImageUrls(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const re of [MD_IMG, HTML_IMG]) {
		for (const m of text.matchAll(re)) {
			const groups = m.groups as Record<string, string> | undefined;
			const url = groups?.url;
			if (url && !seen.has(url)) {
				seen.add(url);
				out.push(url);
			}
		}
	}
	return out;
}

function looksSigned(url: string): boolean {
	let q = "";
	try {
		q = new URL(url).search.toLowerCase();
	} catch {
		return false;
	}
	return SIGNED_HINTS.some((h) => q.includes(h));
}

function domainAllowed(url: string, allowed: string[]): boolean {
	if (!allowed.length) return true;
	try {
		return allowed.includes(new URL(url).hostname);
	} catch {
		return false;
	}
}

function noteSourceUrl(app: App, file: TFile, text: string): string | undefined {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (fm && typeof fm.source === "string" && /^https?:\/\//.test(fm.source)) {
		return fm.source;
	}
	const m = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
	if (m) {
		const sm = /^source:\s*["']?(https?:\/\/[^"'\s]+)/m.exec(m[1]);
		if (sm) return sm[1];
	}
	return undefined;
}

interface ClassifyResult {
	ok: boolean;
	reason: string;
}

function classify(
	status: number,
	headers: Record<string, string>,
	buf: ArrayBuffer,
	minBytes: number
): ClassifyResult {
	if (status === 401 || status === 403) {
		return { ok: false, reason: `HTTP ${status} — cookies rejected or expired` };
	}
	if (status === 404) return { ok: false, reason: "HTTP 404 — gone from the server" };
	if (status >= 400) return { ok: false, reason: `HTTP ${status}` };

	const ctype = (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

	if (ctype.startsWith("text/html")) {
		const head = new TextDecoder("utf-8", { fatal: false })
			.decode(buf.slice(0, 2048))
			.toLowerCase();
		if (LOGIN_HINTS.some((h) => head.includes(h))) {
			return { ok: false, reason: "HTTP 200 but served a login page — cookies not applied" };
		}
		return { ok: false, reason: "HTTP 200 but served HTML, not an image" };
	}
	if (ctype && !ctype.startsWith("image/") && !ctype.includes("octet-stream")) {
		return { ok: false, reason: `unexpected content-type: ${ctype}` };
	}
	if (buf.byteLength < minBytes) {
		return { ok: false, reason: `suspiciously small (${buf.byteLength} bytes)` };
	}
	return { ok: true, reason: ctype };
}

async function fetchImage(
	url: string,
	cookieHeader: string,
	referer: string | undefined,
	userAgent: string,
	timeoutMs: number
): Promise<{ status: number; headers: Record<string, string>; buf: ArrayBuffer }> {
	const headers: Record<string, string> = {
		"User-Agent": userAgent,
		Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
	};
	if (cookieHeader) headers["Cookie"] = cookieHeader;
	if (referer) headers["Referer"] = referer;

	const resp = await withTimeout(
		requestUrl({ url, method: "GET", headers, throw: false }),
		timeoutMs
	);
	return { status: resp.status, headers: lowerHeaders(resp.headers ?? {}), buf: resp.arrayBuffer };
}

function targetFilename(url: string, contentType: string, prefix: string): string {
	let pathname = "";
	try {
		pathname = decodeURIComponent(new URL(url).pathname);
	} catch {
		pathname = url;
	}
	const base = pathname.substring(pathname.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");

	let stem = dot >= 0 ? base.substring(0, dot) : base;
	stem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 60);
	if (!stem) stem = "image";

	let ext = dot >= 0 ? base.substring(dot).toLowerCase() : "";
	const knownExts = new Set(Object.values(EXT_BY_TYPE));
	if (!knownExts.has(ext)) {
		ext = EXT_BY_TYPE[(contentType ?? "").toLowerCase()] ?? ".png";
	}

	const digest = createHash("sha1").update(url, "utf8").digest("hex").slice(0, 8);
	return `${prefix}${stem}-${digest}${ext}`;
}

type LinkStyle = "relative" | "wikilink";

function linkFor(notePath: string, assetPath: string, style: LinkStyle): string {
	if (style === "wikilink") {
		const name = assetPath.split("/").pop() ?? assetPath;
		return `![[${name}]]`;
	}
	const noteDir = notePath.split("/").slice(0, -1).join("/");
	const rel = posix.relative(noteDir, assetPath) || assetPath;
	return `![](${encodeURI(rel)})`;
}

function rewriteText(text: string, url: string, replacement: string): string {
	text = text.replace(MD_IMG, (match: string, ...rest: unknown[]) => {
		const groups = rest[rest.length - 1] as Record<string, string> | undefined;
		return groups?.url === url ? replacement : match;
	});
	const htmlRe = new RegExp(
		`<img\\b[^>]*?\\bsrc\\s*=\\s*["']${escapeRegExp(url)}["'][^>]*/?>`,
		"gi"
	);
	text = text.replace(htmlRe, replacement);
	return text;
}

// -------------------------------------------------------------- settings --

interface PluginSettings {
	cookiesText: string;
	attachmentsFolder: string;
	defaultFolder: string;
	prefix: string;
	linkStyle: LinkStyle;
	domainFilter: string;
	forceSigned: boolean;
	minBytes: number;
	maxAuthFailures: number;
	delayMs: number;
	timeoutMs: number;
	refererOverride: string;
	userAgent: string;
	backup: boolean;
	dryRun: boolean;
	skipPreflight: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	cookiesText: "",
	attachmentsFolder: "Clippings/attachments",
	defaultFolder: "Clippings",
	prefix: "",
	linkStyle: "relative",
	domainFilter: "",
	forceSigned: false,
	minBytes: 512,
	maxAuthFailures: 5,
	delayMs: 300,
	timeoutMs: 30000,
	refererOverride: "",
	userAgent:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	backup: true,
	dryRun: true,
	skipPreflight: false,
};

// ------------------------------------------------------------- core run --

interface Stats {
	downloaded: number;
	failed: number;
	skipped: number;
	signed: number;
	reasons: Map<string, number>;
}

class AuthAbort extends Error {}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	if (!folderPath) return;
	const existing = app.vault.getAbstractFileByPath(folderPath);
	if (existing instanceof TFolder) return;
	const parts = folderPath.split("/").filter(Boolean);
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		const af = app.vault.getAbstractFileByPath(cur);
		if (!af) {
			await app.vault.createFolder(cur);
		} else if (!(af instanceof TFolder)) {
			throw new Error(`Path exists and is not a folder: ${cur}`);
		}
	}
}

async function processNote(
	app: App,
	file: TFile,
	settings: PluginSettings,
	cookies: CookieEntry[],
	stats: Stats,
	consecutive: { n: number },
	log: string[],
	dryRun: boolean
): Promise<void> {
	const original = await app.vault.read(file);
	let text = original;
	const urls = findImageUrls(text);
	if (urls.length === 0) return;

	const referer = settings.refererOverride || noteSourceUrl(app, file, text);
	const allowedDomains = settings.domainFilter
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	log.push(`\n${file.path}  (${urls.length} image(s))`);

	for (const url of urls) {
		if (!domainAllowed(url, allowedDomains)) {
			stats.skipped++;
			continue;
		}
		if (looksSigned(url) && !settings.forceSigned) {
			log.push(`  skip (expiring signed URL, needs re-clipping)  ${url.slice(0, 66)}`);
			stats.signed++;
			continue;
		}

		let status = 0;
		let headers: Record<string, string> = {};
		let buf: ArrayBuffer = new ArrayBuffer(0);
		try {
			const r = await fetchImage(
				url,
				cookieHeaderForUrl(cookies, url),
				referer,
				settings.userAgent,
				settings.timeoutMs
			);
			status = r.status;
			headers = r.headers;
			buf = r.buf;
		} catch (e) {
			const err = e as Error;
			log.push(`  FAIL ${err?.name ?? "Error"}  ${url.slice(0, 74)}`);
			stats.failed++;
			continue;
		}

		const { ok, reason } = classify(status, headers, buf, settings.minBytes);
		if (!ok) {
			log.push(`  FAIL ${reason}  ${url.slice(0, 60)}`);
			stats.failed++;
			const key = reason.split("—")[0].trim();
			stats.reasons.set(key, (stats.reasons.get(key) ?? 0) + 1);
			if (reason.includes("rejected or expired")) {
				consecutive.n++;
				if (consecutive.n >= settings.maxAuthFailures) {
					throw new AuthAbort(
						`Stopped: ${consecutive.n} consecutive auth failures. Your session has ` +
							`probably expired mid-run — refresh cookies in settings and run again. ` +
							`Notes edited so far are already saved.`
					);
				}
			}
			continue;
		}

		consecutive.n = 0;
		const filename = targetFilename(url, reason, settings.prefix);
		const destPath = `${settings.attachmentsFolder.replace(/\/+$/, "")}/${filename}`;
		const replacement = linkFor(file.path, destPath, settings.linkStyle);

		if (dryRun) {
			log.push(`  would save ${filename}  (${Math.round(buf.byteLength / 1024)} KB)`);
		} else {
			await ensureFolder(app, settings.attachmentsFolder);
			const existingDest = app.vault.getAbstractFileByPath(destPath);
			if (!existingDest) {
				await app.vault.createBinary(destPath, buf);
			}
			log.push(`  saved ${filename}  (${Math.round(buf.byteLength / 1024)} KB)`);
		}

		text = rewriteText(text, url, replacement);
		stats.downloaded++;
		if (settings.delayMs > 0) await sleep(settings.delayMs);
	}

	if (text !== original && !dryRun) {
		if (settings.backup) {
			const bakPath = `${file.path}.bak`;
			const existingBak = app.vault.getAbstractFileByPath(bakPath);
			if (existingBak instanceof TFile) {
				await app.vault.modify(existingBak, original);
			} else {
				await app.vault.create(bakPath, original);
			}
		}
		await app.vault.modify(file, text);
	}
}

async function preflight(
	app: App,
	files: TFile[],
	settings: PluginSettings,
	cookies: CookieEntry[],
	log: string[]
): Promise<boolean> {
	const allowedDomains = settings.domainFilter
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	for (const file of files) {
		const text = await app.vault.read(file);
		const urls = findImageUrls(text);
		for (const url of urls) {
			if (looksSigned(url) && !settings.forceSigned) continue;
			if (!domainAllowed(url, allowedDomains)) continue;

			let host = "";
			try {
				host = new URL(url).hostname;
			} catch {
				continue;
			}
			const matching = cookiesForUrl(cookies, url).map((c) => c.name);
			log.push(`\nPreflight against ${host}`);
			log.push(`  cookies that will be sent: ${matching.length ? matching.join(", ") : "NONE"}`);

			const referer = settings.refererOverride || noteSourceUrl(app, file, text);
			if (referer) log.push(`  referer: ${referer}`);

			try {
				const r = await fetchImage(
					url,
					cookieHeaderForUrl(cookies, url),
					referer,
					settings.userAgent,
					settings.timeoutMs
				);
				const { ok, reason } = classify(r.status, r.headers, r.buf, settings.minBytes);
				if (ok) {
					log.push(`  OK — ${reason}, ${Math.round(r.buf.byteLength / 1024)} KB. Proceeding.`);
					return true;
				}
				log.push(`  FAILED: ${reason}`);
				if (!matching.length) {
					log.push(
						"  No cookies matched this host. Images often live on a different domain " +
							"than the article — you may need cookies for that CDN host specifically."
					);
				}
				return false;
			} catch (e) {
				const err = e as Error;
				log.push(`  FAILED: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`);
				return false;
			}
		}
	}
	log.push("No downloadable image URLs found.");
	return false;
}

type DownloadScope = "note" | "vault" | "folder";

function collectFiles(app: App, scope: DownloadScope, folderPath?: string): TFile[] {
	if (scope === "note") {
		const af = app.workspace.getActiveFile();
		return af ? [af] : [];
	}
	if (scope === "vault") {
		return app.vault.getMarkdownFiles();
	}
	const clean = (folderPath ?? "").replace(/\/+$/, "");
	const prefix = clean + "/";
	return app.vault.getMarkdownFiles().filter((f) => f.path === clean || f.path.startsWith(prefix));
}

// -------------------------------------------------------------- folder ui --

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onChoose: (folder: TFolder) => void) {
		super(app);
		this.setPlaceholder("Choose a folder to process…");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const walk = (folder: TFolder) => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
			}
		};
		walk(this.app.vault.getRoot());
		return folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path || "/ (vault root)";
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

// ---------------------------------------------------------------- plugin --

export default class AttachmentAuthDownloaderPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AttachmentAuthDownloaderSettingTab(this.app, this));

		this.addCommand({
			id: "download-current-note",
			name: "Download remote images: current note",
			callback: () => this.runDownload("note"),
		});

		this.addCommand({
			id: "download-vault",
			name: "Download remote images: entire vault",
			callback: () => this.runDownload("vault"),
		});

		this.addCommand({
			id: "download-folder",
			name: "Download remote images: specific folder…",
			callback: () => {
				new FolderSuggestModal(this.app, (folder) => {
					this.runDownload("folder", folder.path);
				}).open();
			},
		});

		this.addCommand({
			id: "test-credentials",
			name: "Test credentials (preflight only)",
			callback: () => this.testCredentials(),
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async writeLog(lines: string[]): Promise<void> {
		const path = "Attachment Auth Downloader Log.md";
		const content = "```\n" + lines.join("\n") + "\n```\n";
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	async testCredentials(): Promise<void> {
		const settings = this.settings;
		const cookies = parseCookiesTxt(settings.cookiesText);
		if (!cookies.length) {
			new Notice("No cookies configured — paste your cookies.txt export in plugin settings first.");
			return;
		}
		const files = this.app.vault.getMarkdownFiles();
		const log: string[] = [];
		new Notice("Running preflight check…");
		const ok = await preflight(this.app, files, settings, cookies, log);
		await this.writeLog(log);
		new Notice(
			ok
				? "Preflight OK — see 'Attachment Auth Downloader Log' note for details."
				: "Preflight FAILED — see 'Attachment Auth Downloader Log' note for details."
		);
	}

	async runDownload(scope: DownloadScope, folderPath?: string): Promise<void> {
		const settings = this.settings;
		const cookies = parseCookiesTxt(settings.cookiesText);
		if (!cookies.length) {
			new Notice("No cookies configured — paste your cookies.txt export in plugin settings first.");
			return;
		}

		const files = collectFiles(this.app, scope, folderPath);
		if (!files.length) {
			new Notice(
				scope === "note"
					? "No active note, or it has no remote images."
					: "No markdown files found for that scope."
			);
			return;
		}

		const log: string[] = [];
		const byDomain = describeCookies(cookies);
		if (byDomain.size) {
			log.push("Cookies loaded:");
			for (const [domain, names] of [...byDomain.entries()].sort()) {
				const shown = names.slice(0, 6).join(", ");
				const more = names.length > 6 ? ` (+${names.length - 6} more)` : "";
				log.push(`  ${domain}: ${shown}${more}`);
			}
		} else {
			log.push("No cookies loaded — requests will be anonymous.");
		}

		if (!settings.skipPreflight) {
			new Notice("Running preflight check…");
			const ok = await preflight(this.app, files, settings, cookies, log);
			if (!ok) {
				await this.writeLog(log);
				new Notice("Preflight failed — nothing was written. See the log note for details.");
				return;
			}
		}

		const stats: Stats = { downloaded: 0, failed: 0, skipped: 0, signed: 0, reasons: new Map() };
		const consecutive = { n: 0 };
		let aborted = false;

		new Notice(`${settings.dryRun ? "Previewing" : "Downloading"} across ${files.length} note(s)…`);

		for (const file of files) {
			try {
				await processNote(this.app, file, settings, cookies, stats, consecutive, log, settings.dryRun);
			} catch (e) {
				if (e instanceof AuthAbort) {
					log.push(`\n${e.message}`);
					aborted = true;
					break;
				}
				const err = e as Error;
				log.push(`  ERROR on ${file.path}: ${err?.message ?? String(e)}`);
			}
		}

		log.push(
			`\n${settings.dryRun ? "Would download" : "Downloaded"}: ${stats.downloaded} | ` +
				`failed: ${stats.failed} | skipped: ${stats.skipped} | expiring URLs: ${stats.signed}`
		);
		for (const [reason, n] of [...stats.reasons.entries()].sort((a, b) => b[1] - a[1])) {
			log.push(`  ${n}x ${reason}`);
		}
		if (settings.dryRun) log.push("Dry run — nothing written.");

		await this.writeLog(log);
		new Notice(
			(aborted
				? "Stopped early (see log): "
				: settings.dryRun
				? "Preview complete: "
				: "Done: ") +
				`${stats.downloaded} downloaded, ${stats.failed} failed, ${stats.signed} skipped (signed)`
		);
	}
}

// ------------------------------------------------------------ settings ui --

class AttachmentAuthDownloaderSettingTab extends PluginSettingTab {
	private cookieFileInputEl!: HTMLInputElement;

	constructor(app: App, private plugin: AttachmentAuthDownloaderPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Attachment Auth Downloader" });

		// Created once per render and kept in the settings pane itself (not
		// document.body) for the lifetime of this tab, so the button's click
		// handler always has a live, attached element to trigger.
		this.cookieFileInputEl = containerEl.createEl("input", { type: "file" });
		this.cookieFileInputEl.accept = ".txt,text/plain";
		this.cookieFileInputEl.style.display = "none";
		this.cookieFileInputEl.addEventListener("change", async () => {
			const file = this.cookieFileInputEl.files?.[0];
			if (!file) return;
			const text = await file.text();
			this.plugin.settings.cookiesText = text;
			await this.plugin.saveSettings();
			const n = parseCookiesTxt(text).length;
			new Notice(`Loaded ${file.name}: ${n} cookie(s).`);
			this.display();
		});

		const cookieCount = parseCookiesTxt(this.plugin.settings.cookiesText).length;
		const cookieStatus = cookieCount
			? `${cookieCount} cookie(s) currently loaded.`
			: "No cookies loaded yet.";

		new Setting(containerEl)
			.setName("Cookies.txt file")
			.setDesc(
				`${cookieStatus} Attach the cookies.txt export for the site you're downloading from, ` +
					"exported from a browser extension. Stored locally in this vault's plugin data only."
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.plugin.settings.cookiesText ? "Replace file…" : "Attach file…")
					.onClick(() => {
						new Notice("Opening file picker…");
						// A persistent input that lives in the settings pane for as
						// long as this tab is open, instead of one created and
						// discarded per click — some Electron/Obsidian renderer
						// contexts don't reliably deliver the native dialog's
						// change event to an element that was created fresh and
						// appended to document.body just before .click().
						this.cookieFileInputEl.click();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("trash-2")
					.setTooltip("Clear cookies")
					.onClick(async () => {
						this.plugin.settings.cookiesText = "";
						await this.plugin.saveSettings();
						new Notice("Cookies cleared.");
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Cookies.txt contents (advanced)")
			.setDesc("You can also paste or edit the raw contents directly instead of attaching a file.")
			.addTextArea((text) => {
				text
					.setPlaceholder("# Netscape HTTP Cookie File\n...")
					.setValue(this.plugin.settings.cookiesText)
					.onChange(async (value) => {
						this.plugin.settings.cookiesText = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 8;
				text.inputEl.cols = 50;
			});

		new Setting(containerEl)
			.setName("Attachments folder")
			.setDesc("Vault-relative path where downloaded images are saved.")
			.addText((t) =>
				t.setValue(this.plugin.settings.attachmentsFolder).onChange(async (v) => {
					this.plugin.settings.attachmentsFolder = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Default folder (for "specific folder" command)')
			.setDesc("Just a starting point in the folder picker.")
			.addText((t) =>
				t.setValue(this.plugin.settings.defaultFolder).onChange(async (v) => {
					this.plugin.settings.defaultFolder = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Filename prefix")
			.addText((t) =>
				t.setValue(this.plugin.settings.prefix).onChange(async (v) => {
					this.plugin.settings.prefix = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Link style")
			.setDesc("How to rewrite embeds once an image is downloaded.")
			.addDropdown((d) =>
				d
					.addOption("relative", "Relative markdown link  ![](attachments/x.png)")
					.addOption("wikilink", "Obsidian wikilink  ![[x.png]]")
					.setValue(this.plugin.settings.linkStyle)
					.onChange(async (v) => {
						this.plugin.settings.linkStyle = v as LinkStyle;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Domain filter")
			.setDesc("Comma-separated hostnames to restrict downloads to. Leave blank for no restriction.")
			.addText((t) =>
				t.setValue(this.plugin.settings.domainFilter).onChange(async (v) => {
					this.plugin.settings.domainFilter = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Force signed URLs")
			.setDesc("Attempt to fetch expiring/presigned URLs instead of skipping them.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.forceSigned).onChange(async (v) => {
					this.plugin.settings.forceSigned = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Minimum bytes")
			.setDesc("Responses smaller than this are treated as placeholders/tracking pixels, not real images.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.minBytes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n)) {
						this.plugin.settings.minBytes = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Max consecutive auth failures")
			.setDesc("Abort the run after this many 401/403s in a row (the session has likely expired).")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxAuthFailures)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n)) {
						this.plugin.settings.maxAuthFailures = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Delay between requests (ms)")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.delayMs)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n)) {
						this.plugin.settings.delayMs = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Request timeout (ms)")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.timeoutMs)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n)) {
						this.plugin.settings.timeoutMs = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Referer override")
			.setDesc("Leave blank to use each note's frontmatter `source:` field automatically.")
			.addText((t) =>
				t.setValue(this.plugin.settings.refererOverride).onChange(async (v) => {
					this.plugin.settings.refererOverride = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("User-Agent")
			.addText((t) =>
				t.setValue(this.plugin.settings.userAgent).onChange(async (v) => {
					this.plugin.settings.userAgent = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Write .bak backups")
			.setDesc("Keep a copy of each note before rewriting its links.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.backup).onChange(async (v) => {
					this.plugin.settings.backup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Dry run")
			.setDesc(
				"Preview only — downloads nothing and writes nothing, just logs what would happen. " +
					"Turn off once you've checked the log and are ready for a real run."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.dryRun).onChange(async (v) => {
					this.plugin.settings.dryRun = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Skip preflight")
			.setDesc("Skip the single-image credential check that normally runs before a batch download.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.skipPreflight).onChange(async (v) => {
					this.plugin.settings.skipPreflight = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
