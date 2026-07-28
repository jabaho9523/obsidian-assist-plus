import { App, Modal } from "obsidian";
import { ScopeEngine } from "../scope/scope";
import { Conversation } from "../types";
import { ApplyResult, applySuggestHunk, checkHunkTarget } from "./apply";
import { SuggestHunk } from "./suggest-parser";

/**
 * The diff preview. Nothing touches disk until the user clicks Apply on a
 * hunk (or "Apply all remaining", which is per-hunk apply in a loop). Hunks
 * whose target is out of scope, denied, or missing are shown blocked with the
 * reason and have no Apply button.
 */
export class SuggestDiffModal extends Modal {
	private applied = new Set<SuggestHunk>();

	constructor(
		app: App,
		private readonly scopeEngine: ScopeEngine,
		private readonly conversation: Conversation,
		private readonly hunks: SuggestHunk[]
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(
			`Review ${this.hunks.length} suggested ${this.hunks.length === 1 ? "edit" : "edits"}`
		);
		this.modalEl.addClass("assist-plus-diff-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		for (const hunk of this.hunks) {
			this.renderHunk(contentEl, hunk);
		}

		const remaining = this.hunks.filter(
			(h) =>
				!this.applied.has(h) &&
				checkHunkTarget(this.app, this.scopeEngine, this.conversation, h) === null
		);
		if (remaining.length > 1) {
			const footer = contentEl.createDiv({ cls: "assist-plus-diff-actions" });
			const all = footer.createEl("button", {
				cls: "mod-cta",
				text: `Apply all remaining (${remaining.length})`,
			});
			all.addEventListener("click", () => {
				void (async () => {
					for (const hunk of remaining) {
						if (this.applied.has(hunk)) continue;
						const result = await applySuggestHunk(
							this.app,
							this.scopeEngine,
							this.conversation,
							hunk
						);
						if (result.outcome === "applied") this.applied.add(hunk);
					}
					this.render();
				})();
			});
		}
	}

	private renderHunk(parent: HTMLElement, hunk: SuggestHunk): void {
		const box = parent.createDiv({ cls: "assist-plus-diff-hunk" });

		const header = box.createDiv({ cls: "assist-plus-diff-header" });
		header.createDiv({ cls: "assist-plus-diff-path", text: hunk.file });
		const status = header.createDiv({ cls: "assist-plus-diff-status" });

		const body = box.createDiv({ cls: "assist-plus-diff-body" });
		body.createEl("pre", {
			cls: "assist-plus-diff-block assist-plus-diff-before",
			text: hunk.original,
		});
		body.createEl("pre", {
			cls: "assist-plus-diff-block assist-plus-diff-after",
			text: hunk.replacement,
		});

		if (this.applied.has(hunk)) {
			status.setText("Applied ✓");
			status.addClass("assist-plus-diff-status-ok");
			return;
		}

		const blocked = checkHunkTarget(
			this.app,
			this.scopeEngine,
			this.conversation,
			hunk
		);
		if (blocked) {
			status.setText(`Blocked: ${blocked.detail}`);
			status.addClass("assist-plus-diff-status-error");
			return;
		}

		const actions = box.createDiv({ cls: "assist-plus-diff-actions" });
		const apply = actions.createEl("button", { cls: "mod-cta", text: "Apply" });
		apply.addEventListener("click", () => {
			void (async () => {
				apply.setAttribute("disabled", "");
				const result: ApplyResult = await applySuggestHunk(
					this.app,
					this.scopeEngine,
					this.conversation,
					hunk
				);
				if (result.outcome === "applied") {
					this.applied.add(hunk);
				} else {
					status.setText(result.detail);
					status.addClass("assist-plus-diff-status-error");
					apply.removeAttribute("disabled");
				}
				this.render();
			})();
		});
	}
}
