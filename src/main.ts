import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PLUGIN_NAME, RIBBON_ICON, VIEW_TYPE_CHAT } from "./constants";
import { exportConversation } from "./export";
import { ScopeEngine } from "./scope/scope";
import { AssistPlusSettings, DEFAULT_SETTINGS } from "./settings";
import { Conversation, createConversation } from "./types";
import { ChatView } from "./ui/ChatView";

export default class AssistPlusPlugin extends Plugin {
	settings!: AssistPlusSettings;
	scope!: ScopeEngine;
	/** In-memory only in M1 — the export command is the way to keep a chat. */
	conversation: Conversation = createConversation();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.scope = new ScopeEngine(this.app, () => ({
			allowFolders: this.settings.allowFolders,
			allowTags: this.settings.allowTags,
			denyFolders: this.settings.denyFolders,
			denyTags: this.settings.denyTags,
		}));

		this.registerView(
			VIEW_TYPE_CHAT,
			(leaf: WorkspaceLeaf) => new ChatView(leaf, this)
		);

		this.addRibbonIcon(RIBBON_ICON, `Open ${PLUGIN_NAME}`, () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "attach-current-note",
			name: "Attach current note",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice(`${PLUGIN_NAME}: no active note to attach.`);
					return;
				}
				this.attachFile(file);
			},
		});

		this.addCommand({
			id: "new-conversation",
			name: "New conversation",
			callback: () => {
				this.newConversation();
			},
		});

		this.addCommand({
			id: "export-conversation",
			name: "Export conversation to note",
			callback: () => {
				void (async () => {
					const file = await exportConversation(this.app, this.conversation);
					if (file) {
						await this.app.workspace.getLeaf(true).openFile(file);
					}
				})();
			},
		});

	}

	onunload(): void {
		// Views unregister themselves; nothing else holds resources.
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<AssistPlusSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Explicit attachment — the only way content enters a conversation's
	 * scope. Runs the same deny rules as the picker, send, and apply paths.
	 */
	attachFile(file: TFile): void {
		if (file.extension !== "md") {
			new Notice(`${PLUGIN_NAME}: only markdown notes can be attached in M1.`);
			return;
		}
		const decision = this.scope.evaluate(file);
		if (!decision.allowed) {
			new Notice(
				`${PLUGIN_NAME}: refusing to attach "${file.path}" — ${decision.detail ?? "denied by scope rules"}.`
			);
			return;
		}
		if (!this.conversation.attachments.includes(file.path)) {
			this.conversation.attachments.push(file.path);
			new Notice(`${PLUGIN_NAME}: attached ${file.path}`);
		}
		this.refreshViews();
	}

	newConversation(): void {
		this.conversation = createConversation();
		this.refreshViews();
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			if (leaf.view instanceof ChatView) leaf.view.refresh();
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		if (existing.length > 0 && existing[0]) {
			void workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		void workspace.revealLeaf(leaf);
	}
}
