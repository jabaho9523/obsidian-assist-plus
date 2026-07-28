import { App, Notice, TFile, moment, normalizePath } from "obsidian";
import { EXPORT_FOLDER, PLUGIN_NAME } from "./constants";
import { Conversation } from "./types";

/**
 * "Export conversation to note" — an explicit-click write path (alongside
 * insert-at-cursor on replies; Suggest mode adds per-hunk apply). Only runs
 * when the user invokes the command. Writes a transcript (including the
 * per-send sent-files record) to Assist/Chats/. The API key never appears in
 * conversation data, so it cannot end up here.
 */
export async function exportConversation(
	app: App,
	conversation: Conversation
): Promise<TFile | null> {
	if (conversation.messages.length === 0) {
		new Notice(`${PLUGIN_NAME}: nothing to export yet.`);
		return null;
	}

	await ensureFolder(app, EXPORT_FOLDER);

	const date = moment(conversation.createdAt).format("YYYY-MM-DD");
	const title = slugify(conversation.title) || "chat";
	let path = normalizePath(`${EXPORT_FOLDER}/${date}-${title}.md`);
	for (let n = 2; app.vault.getAbstractFileByPath(path) !== null; n++) {
		path = normalizePath(`${EXPORT_FOLDER}/${date}-${title}-${n}.md`);
	}

	const file = await app.vault.create(path, renderTranscript(conversation));
	new Notice(`${PLUGIN_NAME}: exported to ${path}`);
	return file;
}

function renderTranscript(conversation: Conversation): string {
	const lines: string[] = [
		"---",
		`created: ${moment(conversation.createdAt).toISOString(true)}`,
		`exported: ${moment().toISOString(true)}`,
		`plugin: assist-plus`,
		"---",
		"",
		`# ${conversation.title || "Assist Plus chat"}`,
		"",
	];

	for (const message of conversation.messages) {
		lines.push(`## ${message.role === "user" ? "You" : "Claude"}`);
		lines.push("");
		lines.push(message.text.length > 0 ? message.text : "*(empty)*");
		if (message.stopped) lines.push("", "*(stopped mid-reply)*");
		if (message.status === "error") {
			lines.push("", `*(failed: ${message.errorText ?? "unknown error"})*`);
		}
		if (message.sent) {
			const files =
				message.sent.files.length > 0
					? message.sent.files.map((f) => `[[${f.path}]]`).join(", ")
					: "none";
			lines.push(
				"",
				`> sent files: ${files} · model \`${message.sent.model}\``
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/");
	let current = "";
	for (const part of parts) {
		current = current.length === 0 ? part : `${current}/${part}`;
		if (app.vault.getAbstractFileByPath(current) === null) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// created concurrently — fine
			}
		}
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}
