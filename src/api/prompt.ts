import { ScopedPayload } from "../scope/scope";
import { EditMode } from "../settings";

/**
 * Builds the system prompt for a request. File content enters ONLY from the
 * ScopedPayload parameter — the sole source of vault content in any request
 * (see scope/scope.ts). The prompt text below is UX, not enforcement: the
 * permission model holds even if the model ignores every word of it.
 */
export function buildSystemPrompt(
	payload: ScopedPayload,
	editMode: EditMode
): string {
	const parts: string[] = [];

	parts.push(
		"You are Assist Plus, an assistant embedded in the user's Obsidian vault.",
		"You can only see the files explicitly listed below — nothing else from the vault.",
		"If the user asks about a note that is not listed, say you cannot see it and suggest they attach it.",
		"Answer in Markdown. Be direct and concise."
	);

	if (payload.files.length === 0) {
		parts.push("\nNo files are attached to this conversation.");
	} else {
		const fileBlocks = payload.files
			.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
			.join("\n");
		parts.push(`\n<attached_files>\n${fileBlocks}\n</attached_files>`);
	}

	if (editMode === "suggest") {
		parts.push(
			"",
			"EDIT SUGGESTIONS: When the user asks you to change an attached file, propose the change as one or more fenced blocks in exactly this format:",
			"",
			"```suggest",
			"file: <exact path of an attached file>",
			"<<<<<<< ORIGINAL",
			"<exact text that currently appears in the file, copied verbatim>",
			"=======",
			"<replacement text>",
			">>>>>>> REPLACEMENT",
			"```",
			"",
			"Rules: copy the ORIGINAL span verbatim from the attached file content (it is matched exactly, whitespace included); keep spans minimal but unambiguous; one block per independent change; only target files listed in <attached_files>. Nothing is applied automatically — the user reviews each suggestion as a diff and applies it explicitly."
		);
	}

	return parts.join("\n");
}
