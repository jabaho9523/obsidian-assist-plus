/**
 * Parser for the ```suggest blocks the system prompt asks for in Suggest mode:
 *
 *   ```suggest
 *   file: Path/To/Note.md
 *   <<<<<<< ORIGINAL
 *   exact current text
 *   =======
 *   replacement text
 *   >>>>>>> REPLACEMENT
 *   ```
 *
 * Strictly best-effort: anything that doesn't match the shape exactly is NOT
 * a hunk — it stays plain text in the chat and can never be applied. Parsing
 * is pure string work; no vault access happens here.
 */

export interface SuggestHunk {
	file: string;
	original: string;
	replacement: string;
}

const FENCE_RE = /```suggest[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * For chat display in Suggest mode: swap each VALID suggest block for a
 * compact callout so replies read as normal prose instead of raw code (the
 * diff modal is where the change itself is inspected). Invalid blocks are
 * left untouched — they stay visible as plain code, matching the rule that
 * anything unparseable is inert.
 */
export function stripSuggestBlocks(markdown: string): string {
	return markdown.replace(FENCE_RE, (whole: string, inner: string) => {
		const hunk = parseInner(inner);
		if (!hunk) return whole;
		return `> [!note] Suggested edit — \`${hunk.file}\`\n> Review and apply it with the button below.`;
	});
}

export function parseSuggestBlocks(markdown: string): SuggestHunk[] {
	const hunks: SuggestHunk[] = [];
	for (const match of markdown.matchAll(FENCE_RE)) {
		const inner = match[1];
		if (inner === undefined) continue;
		const hunk = parseInner(inner);
		if (hunk) hunks.push(hunk);
	}
	return hunks;
}

function parseInner(inner: string): SuggestHunk | null {
	const lines = inner.split(/\r?\n/);

	let i = 0;
	while (i < lines.length && lines[i]?.trim() === "") i++;
	const fileLine = lines[i];
	if (fileLine === undefined) return null;
	const fileMatch = /^file:\s*(.+)$/.exec(fileLine);
	if (!fileMatch || !fileMatch[1]) return null;
	const file = fileMatch[1].trim();
	i++;

	if (lines[i]?.trim() !== "<<<<<<< ORIGINAL") return null;
	i++;
	const original: string[] = [];
	while (i < lines.length && lines[i]?.trim() !== "=======") {
		original.push(lines[i] ?? "");
		i++;
	}
	if (i >= lines.length) return null;
	i++; // skip =======
	const replacement: string[] = [];
	while (i < lines.length && lines[i]?.trim() !== ">>>>>>> REPLACEMENT") {
		replacement.push(lines[i] ?? "");
		i++;
	}
	if (i >= lines.length) return null;

	if (original.length === 0) return null;
	return {
		file,
		original: original.join("\n"),
		replacement: replacement.join("\n"),
	};
}
