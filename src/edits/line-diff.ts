/**
 * Line-level LCS diff for the suggestion preview: even when a hunk spans a
 * whole section, only the lines that actually changed light up, and long
 * unchanged runs collapse. Pure string work, presentation only — applying
 * still replaces the exact ORIGINAL span.
 */

export type DiffRowType = "same" | "del" | "add";

export interface DiffRow {
	type: DiffRowType;
	text: string;
}

export type DisplayRow = DiffRow | { type: "skip"; count: number };

export function diffLines(before: string, after: string): DiffRow[] {
	const a = before.split("\n");
	const b = after.split("\n");

	// Pathological-size guard: fall back to plain removed-then-added blocks.
	if (a.length * b.length > 1_000_000) {
		return [
			...a.map((text) => ({ type: "del" as const, text })),
			...b.map((text) => ({ type: "add" as const, text })),
		];
	}

	const n = a.length;
	const m = b.length;
	const width = m + 1;
	const dp = new Int32Array((n + 1) * width);
	const at = (k: number): number => dp[k] ?? 0;

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? at((i + 1) * width + j + 1) + 1
					: Math.max(at((i + 1) * width + j), at(i * width + j + 1));
		}
	}

	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const ai = a[i];
		const bj = b[j];
		if (ai === undefined || bj === undefined) break;
		if (ai === bj) {
			rows.push({ type: "same", text: ai });
			i++;
			j++;
		} else if (at((i + 1) * width + j) >= at(i * width + j + 1)) {
			rows.push({ type: "del", text: ai });
			i++;
		} else {
			rows.push({ type: "add", text: bj });
			j++;
		}
	}
	for (; i < n; i++) rows.push({ type: "del", text: a[i] ?? "" });
	for (; j < m; j++) rows.push({ type: "add", text: b[j] ?? "" });
	return rows;
}

/**
 * Collapse long unchanged runs to "⋯ N lines ⋯", keeping `context` visible
 * lines next to each change (none at the document edges).
 */
export function withCollapsedContext(
	rows: DiffRow[],
	context = 2
): DisplayRow[] {
	if (!rows.some((r) => r.type !== "same")) return rows;

	const display: DisplayRow[] = [];
	let k = 0;
	while (k < rows.length) {
		const row = rows[k];
		if (row === undefined) break;
		if (row.type !== "same") {
			display.push(row);
			k++;
			continue;
		}
		let end = k;
		while (end < rows.length && rows[end]?.type === "same") end++;
		const runLength = end - k;
		const keepHead = k === 0 ? 0 : context;
		const keepTail = end === rows.length ? 0 : context;
		if (runLength <= keepHead + keepTail + 1) {
			for (let r = k; r < end; r++) {
				const same = rows[r];
				if (same) display.push(same);
			}
		} else {
			for (let r = k; r < k + keepHead; r++) {
				const same = rows[r];
				if (same) display.push(same);
			}
			display.push({ type: "skip", count: runLength - keepHead - keepTail });
			for (let r = end - keepTail; r < end; r++) {
				const same = rows[r];
				if (same) display.push(same);
			}
		}
		k = end;
	}
	return display;
}
