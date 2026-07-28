import { App, Component, TFile, setIcon } from "obsidian";
import { CHARS_PER_TOKEN } from "../constants";
import { ScopeEngine } from "../scope/scope";
import { NoteGroup } from "../settings";
import { Conversation } from "../types";

/**
 * "What Claude can see" — the pre-send half of the nothing-invisible pillar.
 * Lists every file currently in scope for the conversation with per-file
 * remove, shows the context meter, and re-runs the deny rules on render so a
 * file that became denied after attachment is visibly flagged as excluded
 * before the next send (collectPayload will skip it).
 */
export interface ScopePanelDeps {
	app: App;
	component: Component;
	scope: ScopeEngine;
	getConversation: () => Conversation;
	onRemove: (path: string) => void;
	onAttachFile: (file: TFile) => void;
	onAttachActive: () => void;
	getGroups: () => NoteGroup[];
	onAttachGroup: (groupId: string) => void;
	openPicker: () => void;
}

export class ScopePanel {
	private rootEl: HTMLElement;

	constructor(parent: HTMLElement, private readonly deps: ScopePanelDeps) {
		this.rootEl = parent.createEl("details", { cls: "assist-plus-scope" });
		this.rootEl.setAttribute("open", "");
		this.registerDropTarget();
		this.render();
	}

	render(): void {
		const conversation = this.deps.getConversation();
		this.rootEl.empty();

		const summary = this.rootEl.createEl("summary", {
			cls: "assist-plus-scope-summary",
		});
		const icon = summary.createSpan({ cls: "assist-plus-scope-icon" });
		setIcon(icon, "eye");
		summary.createSpan({ text: "What Claude can see" });
		summary.createSpan({
			cls: "assist-plus-scope-meter",
			text: this.meterText(conversation),
		});

		const list = this.rootEl.createDiv({ cls: "assist-plus-scope-list" });
		if (conversation.attachments.length === 0) {
			list.createDiv({
				cls: "assist-plus-scope-empty",
				text: "No files attached — Claude sees nothing from your vault. Attach a note or drop one here.",
			});
		}

		for (const path of conversation.attachments) {
			const row = list.createDiv({ cls: "assist-plus-scope-row" });
			const file = this.deps.app.vault.getAbstractFileByPath(path);

			const name = row.createDiv({ cls: "assist-plus-scope-name" });
			name.setText(path);
			name.setAttribute("title", path);

			if (!(file instanceof TFile)) {
				row.addClass("assist-plus-scope-excluded");
				row.createDiv({
					cls: "assist-plus-scope-note",
					text: "excluded: no longer exists",
				});
			} else {
				const decision = this.deps.scope.evaluate(file);
				if (!decision.allowed) {
					row.addClass("assist-plus-scope-excluded");
					row.createDiv({
						cls: "assist-plus-scope-note",
						text: `excluded: ${decision.detail ?? "denied"}`,
					});
				}
			}

			const remove = row.createEl("button", {
				cls: "assist-plus-icon-btn",
				attr: { "aria-label": `Remove ${path} from scope` },
			});
			setIcon(remove, "x");
			remove.addEventListener("click", (e) => {
				e.preventDefault();
				this.deps.onRemove(path);
			});
		}

		const actions = this.rootEl.createDiv({ cls: "assist-plus-scope-actions" });
		const attachActive = actions.createEl("button", {
			text: "Attach active note",
		});
		attachActive.addEventListener("click", (e) => {
			e.preventDefault();
			this.deps.onAttachActive();
		});
		const attach = actions.createEl("button", { text: "Attach note…" });
		attach.addEventListener("click", (e) => {
			e.preventDefault();
			this.deps.openPicker();
		});
		const groups = this.deps.getGroups();
		if (groups.length > 0) {
			const select = actions.createEl("select", {
				cls: "dropdown",
				attr: { "aria-label": "Attach note group" },
			});
			select.createEl("option", { value: "", text: "Attach group…" });
			for (const group of groups) {
				select.createEl("option", { value: group.id, text: group.name });
			}
			select.addEventListener("change", () => {
				if (select.value.length > 0) {
					this.deps.onAttachGroup(select.value);
					select.value = "";
				}
			});
		}
	}

	private meterText(conversation: Conversation): string {
		let chars = 0;
		for (const path of conversation.attachments) {
			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) chars += file.stat.size;
		}
		for (const message of conversation.messages) {
			chars += message.text.length;
		}
		const tokens = Math.round(chars / CHARS_PER_TOKEN);
		const files = conversation.attachments.length;
		return `${files} ${files === 1 ? "file" : "files"} · ~${formatTokens(tokens)} tokens`;
	}

	/** Dropping a note from the file explorer or a tab header attaches it. */
	private registerDropTarget(): void {
		this.deps.component.registerDomEvent(this.rootEl, "dragover", (e) => {
			e.preventDefault();
			this.rootEl.addClass("assist-plus-drop-active");
		});
		this.deps.component.registerDomEvent(this.rootEl, "dragleave", () => {
			this.rootEl.removeClass("assist-plus-drop-active");
		});
		this.deps.component.registerDomEvent(this.rootEl, "drop", (e) => {
			e.preventDefault();
			this.rootEl.removeClass("assist-plus-drop-active");
			const file = this.resolveDraggedFile(e);
			if (file) this.deps.onAttachFile(file);
		});
	}

	private resolveDraggedFile(e: DragEvent): TFile | null {
		// Obsidian's internal drag manager knows the dragged file directly.
		const dragManager = (
			this.deps.app as unknown as {
				dragManager?: { draggable?: { file?: unknown } | null };
			}
		).dragManager;
		const dragged = dragManager?.draggable?.file;
		if (dragged instanceof TFile) return dragged;

		// Fallback: resolve dropped text (a path or link) against the vault.
		const text = e.dataTransfer?.getData("text/plain")?.trim() ?? "";
		if (text.length === 0) return null;
		const linkpath = text.replace(/^\[\[/, "").replace(/\]\]$/, "");
		return this.deps.app.metadataCache.getFirstLinkpathDest(linkpath, "");
	}
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}
