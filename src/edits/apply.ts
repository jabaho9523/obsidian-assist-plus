import { App, TFile, normalizePath } from "obsidian";
import { ScopeEngine } from "../scope/scope";
import { Conversation } from "../types";
import { SuggestHunk } from "./suggest-parser";

/**
 * Applying a suggestion is the ONLY vault write path besides the export
 * command, and it only ever runs from an explicit per-hunk click in the diff
 * modal. Guards, in order:
 *
 *  1. The target must have been in scope for this conversation — either
 *     currently attached or actually sent (recorded in a sent manifest).
 *     Claude cannot direct an edit at a file it was never shown.
 *  2. Deny rules are re-evaluated at write time — denylist wins here too.
 *  3. The ORIGINAL span must still match exactly; if the file changed, the
 *     hunk fails instead of guessing. First occurrence is replaced.
 *
 * The write itself goes through vault.process (atomic read-modify-write).
 */

export type ApplyOutcome =
	| "applied"
	| "not-in-scope"
	| "denied"
	| "missing-file"
	| "not-found";

export interface ApplyResult {
	outcome: ApplyOutcome;
	detail: string;
}

/** Files this conversation may target: attached now, or actually sent. */
export function conversationScopePaths(conversation: Conversation): Set<string> {
	const paths = new Set<string>(conversation.attachments);
	for (const message of conversation.messages) {
		for (const f of message.sent?.files ?? []) {
			paths.add(f.path);
		}
	}
	return paths;
}

export function checkHunkTarget(
	app: App,
	scope: ScopeEngine,
	conversation: Conversation,
	hunk: SuggestHunk
): ApplyResult | null {
	const path = normalizePath(hunk.file.trim());
	if (!conversationScopePaths(conversation).has(path)) {
		return {
			outcome: "not-in-scope",
			detail: "this file was never in scope for the conversation",
		};
	}
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		return { outcome: "missing-file", detail: "file no longer exists" };
	}
	const decision = scope.evaluate(file);
	if (!decision.allowed) {
		return {
			outcome: "denied",
			detail: decision.detail ?? "denied by scope rules",
		};
	}
	return null;
}

export async function applySuggestHunk(
	app: App,
	scope: ScopeEngine,
	conversation: Conversation,
	hunk: SuggestHunk
): Promise<ApplyResult> {
	const blocked = checkHunkTarget(app, scope, conversation, hunk);
	if (blocked) return blocked;

	const path = normalizePath(hunk.file.trim());
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		return { outcome: "missing-file", detail: "file no longer exists" };
	}

	let found = false;
	await app.vault.process(file, (data) => {
		const index = data.indexOf(hunk.original);
		if (index < 0) return data;
		found = true;
		return (
			data.slice(0, index) +
			hunk.replacement +
			data.slice(index + hunk.original.length)
		);
	});

	return found
		? { outcome: "applied", detail: "applied" }
		: {
				outcome: "not-found",
				detail: "the original text no longer appears in the file",
			};
}
