import {
	App,
	Component,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	setIcon,
} from "obsidian";
import { SuggestHunk, parseSuggestBlocks } from "../edits/suggest-parser";
import { ChatMessage } from "../types";

/**
 * Message rendering: markdown bodies, the per-message "sent: N files"
 * disclosure (the post-send half of the nothing-invisible pillar), error
 * states with a retry affordance.
 */
export interface MessageDeps {
	app: App;
	component: Component;
	onRetry: (assistantMessage: ChatMessage) => void;
	/**
	 * Present ONLY in Suggest mode. When absent (Read-only), suggest blocks
	 * render as plain fenced code and there is no path to an apply.
	 */
	onReviewSuggestions?: (hunks: SuggestHunk[]) => void;
}

export function renderMessage(
	parent: HTMLElement,
	message: ChatMessage,
	deps: MessageDeps
): { bodyEl: HTMLElement } {
	const wrapper = parent.createDiv({
		cls: `assist-plus-message assist-plus-message-${message.role}`,
	});

	const header = wrapper.createDiv({ cls: "assist-plus-message-header" });
	header.createSpan({
		cls: "assist-plus-message-role",
		text: message.role === "user" ? "You" : "Claude",
	});

	if (message.sent) {
		const details = header.createEl("details", { cls: "assist-plus-sent" });
		const n = message.sent.files.length;
		details.createEl("summary", {
			text: `sent: ${n} ${n === 1 ? "file" : "files"}`,
		});
		const list = details.createEl("ul", { cls: "assist-plus-sent-list" });
		for (const f of message.sent.files) {
			list.createEl("li", { text: `${f.path} (${f.chars.toLocaleString()} chars)` });
		}
		list.createEl("li", {
			cls: "assist-plus-sent-meta",
			text: `model ${message.sent.model} · ${
				message.sent.streamed ? "streamed" : "non-streaming fallback"
			}`,
		});
	}

	const bodyEl = wrapper.createDiv({ cls: "assist-plus-message-body" });
	if (message.status !== "streaming" && message.text.length > 0) {
		void MarkdownRenderer.render(
			deps.app,
			message.text,
			bodyEl,
			"",
			deps.component
		);
	}

	if (
		message.role === "assistant" &&
		message.status !== "streaming" &&
		message.text.length > 0
	) {
		renderReplyActions(header, bodyEl, message, deps);
	}

	if (
		message.role === "assistant" &&
		message.status === "complete" &&
		deps.onReviewSuggestions
	) {
		const hunks = parseSuggestBlocks(message.text);
		if (hunks.length > 0) {
			const review = wrapper.createEl("button", {
				cls: "mod-cta assist-plus-suggest-review",
				text: `Review ${hunks.length} suggested ${hunks.length === 1 ? "edit" : "edits"}…`,
			});
			review.addEventListener("click", () => deps.onReviewSuggestions?.(hunks));
		}
	}

	if (message.stopped) {
		wrapper.createDiv({ cls: "assist-plus-message-note", text: "(stopped)" });
	}

	if (message.status === "error") {
		const errorEl = wrapper.createDiv({ cls: "assist-plus-message-error" });
		errorEl.createSpan({
			text: message.errorText ?? "Something went wrong.",
		});
		const retry = errorEl.createEl("button", { text: "Retry" });
		retry.addEventListener("click", () => deps.onRetry(message));
	}

	return { bodyEl };
}

/**
 * Copy / insert-at-cursor for a reply. Both act on the text the user marked
 * inside this reply, or the whole reply when nothing is marked. Insert is an
 * explicit-click write into the open editor at the cursor (undoable there) —
 * one of the three explicit-click write paths alongside export and per-hunk
 * apply. Copying/inserting the raw markdown source, not the rendered HTML.
 */
function renderReplyActions(
	header: HTMLElement,
	bodyEl: HTMLElement,
	message: ChatMessage,
	deps: MessageDeps
): void {
	const actions = header.createDiv({ cls: "assist-plus-message-actions" });

	const pickText = (): string => selectionWithin(bodyEl) || message.text;

	const copy = actions.createEl("button", {
		cls: "assist-plus-icon-btn",
		attr: { "aria-label": "Copy reply or marked text" },
	});
	setIcon(copy, "copy");
	copy.addEventListener("click", () => {
		void navigator.clipboard
			.writeText(pickText())
			.then(() => new Notice("Copied to clipboard"))
			.catch(() => new Notice("Copy failed"));
	});

	const insert = actions.createEl("button", {
		cls: "assist-plus-icon-btn",
		attr: { "aria-label": "Insert into the active note" },
	});
	setIcon(insert, "text-cursor-input");
	insert.addEventListener("click", () => {
		const editor = mostRecentMarkdownEditor(deps.app);
		if (!editor) {
			new Notice("Open a note in the editor to insert into.");
			return;
		}
		editor.replaceSelection(pickText());
	});
}

/** Text the user has marked inside this element, or "" when none. */
function selectionWithin(el: HTMLElement): string {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return "";
	}
	const range = selection.getRangeAt(0);
	if (!el.contains(range.commonAncestorContainer)) return "";
	return selection.toString();
}

/**
 * The editor to insert into. Clicking a sidebar button moves focus here, so
 * "active view" would be this leaf — use the most recent main-area leaf.
 */
function mostRecentMarkdownEditor(app: App) {
	const leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
	const view = leaf?.view;
	return view instanceof MarkdownView ? view.editor : null;
}

/**
 * Streamed markdown: deltas append into a buffer that is re-rendered as
 * markdown at most every 250ms, with a guaranteed final render. Keeps
 * streaming smooth without re-parsing on every token.
 */
export class StreamingRenderer {
	private text = "";
	private timer: number | null = null;
	private rendering = false;
	private dirty = false;

	constructor(
		private readonly app: App,
		private readonly el: HTMLElement,
		private readonly component: Component
	) {}

	get current(): string {
		return this.text;
	}

	append(delta: string): void {
		this.text += delta;
		this.dirty = true;
		if (this.timer === null) {
			this.timer = window.setTimeout(() => {
				this.timer = null;
				void this.render();
			}, 250);
		}
	}

	async finish(finalText?: string): Promise<void> {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		if (finalText !== undefined) this.text = finalText;
		this.dirty = true;
		await this.render();
	}

	private async render(): Promise<void> {
		if (this.rendering) return;
		this.rendering = true;
		while (this.dirty) {
			this.dirty = false;
			const snapshot = this.text;
			this.el.empty();
			await MarkdownRenderer.render(
				this.app,
				snapshot,
				this.el,
				"",
				this.component
			);
		}
		this.rendering = false;
	}
}
