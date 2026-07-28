import { App, TFile, getAllTags, normalizePath } from "obsidian";

/**
 * THE SCOPE ENGINE — the core guarantee of Assist Plus.
 *
 * Default-deny, enforced in code: no vault content ever reaches the API layer
 * unless it passed through `ScopeEngine.collectPayload()`. That guarantee is
 * structural, not behavioral:
 *
 *  1. `collectPayload()` is the ONLY code path in this plugin that reads vault
 *     file content for a request. Nothing else may call `vault.read`/
 *     `vault.cachedRead` on behalf of an outgoing message.
 *  2. Its return type, `ScopedPayload`, is nominal: the class value is not
 *     exported (only its type and an `instanceof` guard are), the constructor
 *     is unreachable outside this module, and a private brand field defeats
 *     structural typing. The API layer accepts a `ScopedPayload` and verifies
 *     it with `isScopedPayload()` at runtime — so it is physically unable to
 *     send file content that did not come from here.
 *  3. Payloads are deep-frozen. Nothing downstream can smuggle extra content
 *     into one after collection.
 *
 * Rule order (first match wins):
 *   1. DENYLIST WINS OVER EVERYTHING — a file in a denied folder or carrying a
 *      denied tag is refused, even if explicitly attached earlier, even at
 *      send time, even at suggest-apply time.
 *   2. Frontmatter `assist: false` refuses that file.
 *   3. Explicit attachment allows the file.
 *   4. The allowlist does NOT include anything by itself in M1 — it only
 *      affects what the attach picker offers prominently. Attachment is always
 *      an explicit user action; there is no ambient inclusion.
 *
 * Deny rules are re-evaluated at every collection (defense in depth): a file
 * attached yesterday and moved into `Private/` today is excluded from the very
 * next send, and the exclusion is surfaced to the user.
 */

export type DenyReason = "denied-folder" | "denied-tag" | "frontmatter";

export interface ScopeDecision {
	allowed: boolean;
	reason?: DenyReason;
	/** Human-readable explanation, e.g. which rule matched. Safe to show in UI. */
	detail?: string;
	/** M1: affects attach-picker ordering/badge only. Never grants ambient access. */
	allowlisted: boolean;
}

/** Live view of the user's scope settings. Read fresh on every evaluation. */
export interface ScopeRules {
	allowFolders: string[];
	allowTags: string[];
	denyFolders: string[];
	denyTags: string[];
}

export interface ScopedFile {
	readonly path: string;
	readonly content: string;
	readonly chars: number;
}

/** A file that was attached but refused at collection time, and why. */
export interface SkippedFile {
	readonly path: string;
	readonly reason: string;
}

/**
 * The one and only container the API layer accepts. Constructible ONLY inside
 * this module (the class value is never exported). The `declare`d private
 * brand makes the type nominal, so no structurally-similar object passes type
 * checking, and `isScopedPayload` enforces the same at runtime.
 */
class ScopedPayloadImpl {
	declare private readonly __assistPlusScopedPayloadBrand: true;
	readonly files: readonly ScopedFile[];
	readonly skipped: readonly SkippedFile[];
	readonly collectedAt: number;

	constructor(files: ScopedFile[], skipped: SkippedFile[]) {
		this.files = Object.freeze(files.map((f) => Object.freeze({ ...f })));
		this.skipped = Object.freeze(skipped.map((s) => Object.freeze({ ...s })));
		this.collectedAt = Date.now();
		Object.freeze(this);
	}
}

export type ScopedPayload = ScopedPayloadImpl;

/** Runtime gate used by the API layer before building any request body. */
export function isScopedPayload(value: unknown): value is ScopedPayload {
	return value instanceof ScopedPayloadImpl;
}

export class ScopeEngine {
	constructor(
		private readonly app: App,
		/** Called on every evaluation so settings changes apply immediately. */
		private readonly getRules: () => ScopeRules
	) {}

	/**
	 * Apply the rule order to one file. Used by the attach picker (to grey out
	 * and refuse), by the attach commands, by `collectPayload` (send time) and
	 * by the suggest-apply path (write time). One implementation, everywhere.
	 */
	evaluate(file: TFile): ScopeDecision {
		const rules = this.getRules();
		const tags = this.tagsOf(file);

		const deniedFolder = matchFolder(file.path, rules.denyFolders);
		if (deniedFolder !== null) {
			return {
				allowed: false,
				reason: "denied-folder",
				detail: `in denied folder "${deniedFolder}"`,
				allowlisted: false,
			};
		}

		const deniedTag = matchTag(tags, rules.denyTags);
		if (deniedTag !== null) {
			return {
				allowed: false,
				reason: "denied-tag",
				detail: `has denied tag #${deniedTag}`,
				allowlisted: false,
			};
		}

		if (this.frontmatterRefuses(file)) {
			return {
				allowed: false,
				reason: "frontmatter",
				detail: `frontmatter "assist: false"`,
				allowlisted: false,
			};
		}

		const allowlisted =
			matchFolder(file.path, rules.allowFolders) !== null ||
			matchTag(tags, rules.allowTags) !== null;
		return { allowed: true, allowlisted };
	}

	/**
	 * THE SINGLE CHOKE POINT.
	 *
	 * Turns a conversation's explicit attachments into the exact byte-for-byte
	 * set of files a request may carry. Every send goes through here, every
	 * time — results are never cached across sends, so deny rules and file
	 * edits always apply. The returned `ScopedPayload` is the only value the
	 * API layer will accept, and its `files` list is exactly what the UI
	 * records in the per-message "sent" disclosure.
	 *
	 * No other code in this plugin may read vault content into a request.
	 */
	async collectPayload(conversation: {
		attachments: string[];
	}): Promise<ScopedPayload> {
		const files: ScopedFile[] = [];
		const skipped: SkippedFile[] = [];
		const seen = new Set<string>();

		for (const path of conversation.attachments) {
			if (seen.has(path)) continue;
			seen.add(path);

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				skipped.push({ path, reason: "no longer exists" });
				continue;
			}

			// Deny rules re-checked at send time — denylist wins over the
			// earlier explicit attachment (rule 1).
			const decision = this.evaluate(file);
			if (!decision.allowed) {
				skipped.push({ path, reason: decision.detail ?? "denied" });
				continue;
			}

			const content = await this.app.vault.cachedRead(file);
			files.push({ path: file.path, content, chars: content.length });
		}

		return new ScopedPayloadImpl(files, skipped);
	}

	private tagsOf(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		return getAllTags(cache) ?? [];
	}

	private frontmatterRefuses(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return fm?.["assist"] === false;
	}
}

/**
 * Folder rules are vault-root path prefixes: "Private" (or "Private/") matches
 * "Private/a.md" and "Private/sub/b.md" but not "MyPrivate/x.md".
 * Returns the matching entry, or null.
 */
function matchFolder(filePath: string, folders: string[]): string | null {
	for (const raw of folders) {
		const entry = normalizePath(raw.trim());
		if (entry.length === 0 || entry === "/") continue;
		if (filePath === entry || filePath.startsWith(entry + "/")) {
			return entry;
		}
	}
	return null;
}

/**
 * Tag rules match Obsidian tag semantics: entry "private" (with or without a
 * leading #, any case) matches #private and nested #private/sub anywhere in
 * the note (frontmatter or inline). Returns the matching entry, or null.
 */
function matchTag(fileTags: string[], tagRules: string[]): string | null {
	if (tagRules.length === 0 || fileTags.length === 0) return null;
	const normalizedFileTags = fileTags.map((t) =>
		t.replace(/^#/, "").toLowerCase()
	);
	for (const raw of tagRules) {
		const entry = raw.trim().replace(/^#/, "").toLowerCase();
		if (entry.length === 0) continue;
		for (const tag of normalizedFileTags) {
			if (tag === entry || tag.startsWith(entry + "/")) {
				return entry;
			}
		}
	}
	return null;
}
