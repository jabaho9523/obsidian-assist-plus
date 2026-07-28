import { App, Component, MarkdownRenderer } from "obsidian";
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
