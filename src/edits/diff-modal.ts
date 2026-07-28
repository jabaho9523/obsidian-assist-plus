import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { ScopeEngine } from "../scope/scope";
import { Conversation } from "../types";
import { ApplyResult, applySuggestHunk, checkHunkTarget } from "./apply";
import { diffLines, withCollapsedContext } from "./line-diff";
import { SuggestHunk } from "./suggest-parser";

/**
 * The diff preview. Nothing touches disk until the user clicks Apply on a
 * hunk (or "Apply all remaining", which is per-hunk apply in a loop). Hunks
 * whose target is out of scope, denied, or missing are shown blocked with the
 * reason and have no Apply button.
 */
export class SuggestDiffModal extends Modal {
	private applied = new Set<SuggestHunk>();
	/** Owns the markdown-preview child components across re-renders. */
	private renderComp = new Component();

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
		this.renderComp.load();
		this.render();
	}

	onClose(): void {
		this.renderComp.unload();
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		// Drop preview components from the previous render pass.
		this.renderComp.unload();
		this.renderComp.load();

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

	/** Unified line diff: only changed lines highlighted, long same-runs folded. */
	private renderDiffRows(pane: HTMLElement, hunk: SuggestHunk): void {
		const rows = withCollapsedContext(
			diffLines(hunk.original, hunk.replacement)
		);
		for (const row of rows) {
			if (row.type === "skip") {
				pane.createDiv({
					cls: "assist-plus-diff-skip",
					text: `⋯ ${row.count} unchanged ${row.count === 1 ? "line" : "lines"} ⋯`,
				});
				continue;
			}
			const lineEl = pane.createDiv({
				cls: `assist-plus-diff-line assist-plus-diff-line-${row.type}`,
			});
			lineEl.createSpan({
				cls: "assist-plus-diff-sign",
				text: row.type === "del" ? "−" : row.type === "add" ? "+" : " ",
			});
			lineEl.createSpan({ cls: "assist-plus-diff-text", text: row.text });
		}
	}

	private renderHunk(parent: HTMLElement, hunk: SuggestHunk): void {
		const box = parent.createDiv({ cls: "assist-plus-diff-hunk" });

		const header = box.createDiv({ cls: "assist-plus-diff-header" });
		header.createDiv({ cls: "assist-plus-diff-path", text: hunk.file });
		const status = header.createDiv({ cls: "assist-plus-diff-status" });

		const tabs = box.createDiv({ cls: "assist-plus-diff-tabs" });
		const body = box.createDiv({ cls: "assist-plus-diff-body" });

		const diffPane = body.createDiv({ cls: "assist-plus-diff-lines" });
		this.renderDiffRows(diffPane, hunk);
		const previewPane = body.createDiv({
			cls: "assist-plus-diff-preview assist-plus-hidden",
		});
		// "Normal formatting": the replacement rendered as regular markdown.
		void MarkdownRenderer.render(
			this.app,
			hunk.replacement,
			previewPane,
			"",
			this.renderComp
		);

		const diffTab = tabs.createEl("button", {
			cls: "assist-plus-diff-tab is-active",
			text: "Changes",
		});
		const previewTab = tabs.createEl("button", {
			cls: "assist-plus-diff-tab",
			text: "Result preview",
		});
		const selectTab = (showPreview: boolean): void => {
			diffPane.toggleClass("assist-plus-hidden", showPreview);
			previewPane.toggleClass("assist-plus-hidden", !showPreview);
			diffTab.toggleClass("is-active", !showPreview);
			previewTab.toggleClass("is-active", showPreview);
		};
		diffTab.addEventListener("click", () => selectTab(false));
		previewTab.addEventListener("click", () => selectTab(true));

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
