import {
	App,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { fetchModels } from "./api/models";
import type AssistPlusPlugin from "./main";
import { EditMode } from "./settings";
import { generateId } from "./types";

type ListKey =
	| "allowFolders"
	| "allowTags"
	| "denyFolders"
	| "denyTags"
	| "defaultAttachments";

export class AssistPlusSettingTab extends PluginSettingTab {
	plugin: AssistPlusPlugin;
	private lastFetchAt = 0;
	private modelDropdownEl: HTMLSelectElement | null = null;
	private modelStatusEl: HTMLElement | null = null;
	private groupsEl: HTMLElement | null = null;

	constructor(app: App, plugin: AssistPlusPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc(
				"Create a key in your Anthropic console at console.anthropic.com (API keys section; requires a funded account). Anthropic (Claude) only — other providers are not supported. " +
					"Stored locally in your vault's plugin folder, like any plugin setting — treat your vault's storage as you would any local credential. " +
					"Requests go directly from this plugin to api.anthropic.com; usage bills to your own Anthropic account. The key is never logged and never shown in errors."
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("Paste your Anthropic API key");
				t.setValue(this.plugin.settings.apiKey);
				t.onChange(async (v) => {
					this.plugin.settings.apiKey = v.trim();
					await this.plugin.saveSettings();
				});
				t.inputEl.addEventListener("blur", () => {
					this.lastFetchAt = 0;
					void this.refreshModels();
				});
			});

		const modelSetting = new Setting(containerEl)
			.setName("Default model")
			.setDesc(
				"Fetched from your account's live model list when this tab opens (never hardcoded — model names go stale). Cached for offline use."
			);
		modelSetting.addDropdown((d) => {
			this.modelDropdownEl = d.selectEl;
			this.populateModelDropdown(d.selectEl);
			d.onChange(async (v) => {
				this.plugin.settings.defaultModel = v;
				await this.plugin.saveSettings();
			});
		});
		modelSetting.addExtraButton((b) => {
			b.setIcon("refresh-cw")
				.setTooltip("Refresh model list")
				.onClick(() => {
					this.lastFetchAt = 0;
					void this.refreshModels();
				});
		});
		this.modelStatusEl = containerEl.createDiv({
			cls: "assist-plus-model-status setting-item-description",
		});

		new Setting(containerEl)
			.setName("Custom model ID")
			.setDesc(
				"Manual escape hatch — when set, this exact model ID is used instead of the dropdown choice."
			)
			.addText((t) => {
				t.setPlaceholder("Model ID");
				t.setValue(this.plugin.settings.customModel);
				t.onChange(async (v) => {
					this.plugin.settings.customModel = v.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Edit mode")
			.setDesc(
				"Read-only: Claude can never change your vault (the export command is the only write). " +
					"Suggest: proposed edits render as diffs; nothing is written until you apply a hunk."
			)
			.addDropdown((d) => {
				d.addOption("readonly", "Read-only");
				d.addOption("suggest", "Suggest");
				d.setValue(this.plugin.settings.editMode);
				d.onChange(async (v) => {
					this.plugin.settings.editMode = v as EditMode;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				});
			});

		new Setting(containerEl).setName("Scope").setHeading();

		this.listSetting(
			"Denied folders",
			"One folder per line, as a vault path (e.g. Private). Files under these can never be attached or sent — the denylist wins over everything, including explicit attachments.",
			"denyFolders"
		);
		this.listSetting(
			"Denied tags",
			"One tag per line, with or without # (e.g. #private). Notes carrying these tags (frontmatter or inline, nested included) can never be attached or sent.",
			"denyTags"
		);
		this.listSetting(
			"Allowlisted folders",
			"One folder per line. Offered first in the attach picker. In this version the allowlist never includes anything by itself — attachment is always an explicit action.",
			"allowFolders"
		);
		this.listSetting(
			"Allowlisted tags",
			"One tag per line. Offered first in the attach picker.",
			"allowTags"
		);

		new Setting(containerEl).setName("Context").setHeading();

		this.listSetting(
			"Default notes",
			"One vault path per line (e.g. Projects/Overview.md). Attached automatically to every new conversation — still visible in the panel, removable per conversation, and the denylist still wins at send time.",
			"defaultAttachments"
		);

		new Setting(containerEl)
			.setName("Note groups")
			.setDesc(
				"Reusable sets of notes you can attach in one action from the chat panel — for example the five notes you always use as context."
			);
		this.groupsEl = containerEl.createDiv();
		this.renderGroups(this.groupsEl);
		new Setting(containerEl).addButton((b) =>
			b.setButtonText("Add group").onClick(async () => {
				this.plugin.settings.noteGroups.push({
					id: generateId(),
					name: "New group",
					paths: [],
				});
				await this.plugin.saveSettings();
				if (this.groupsEl) this.renderGroups(this.groupsEl);
				this.plugin.refreshViews();
			})
		);

		void this.refreshModels();
	}

	private renderGroups(parent: HTMLElement): void {
		parent.empty();
		for (const group of this.plugin.settings.noteGroups) {
			new Setting(parent)
				.setClass("assist-plus-group-row")
				.addText((t) => {
					t.setPlaceholder("Group name");
					t.setValue(group.name);
					t.onChange(async (v) => {
						group.name = v;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					});
				})
				.addTextArea((t) => {
					t.inputEl.rows = 3;
					t.setPlaceholder("One vault path per line");
					t.setValue(group.paths.join("\n"));
					t.onChange(async (v) => {
						group.paths = v
							.split(/\r?\n/)
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.plugin.saveSettings();
					});
				})
				.addExtraButton((b) => {
					b.setIcon("trash-2")
						.setTooltip("Delete group")
						.onClick(async () => {
							this.plugin.settings.noteGroups =
								this.plugin.settings.noteGroups.filter(
									(g) => g.id !== group.id
								);
							await this.plugin.saveSettings();
							if (this.groupsEl) this.renderGroups(this.groupsEl);
							this.plugin.refreshViews();
						});
				});
		}
	}

	private listSetting(name: string, desc: string, key: ListKey): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setValue(this.plugin.settings[key].join("\n"));
				t.onChange(async (v) => {
					this.plugin.settings[key] = v
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter((line) => line.length > 0);
					await this.plugin.saveSettings();
				});
			});
	}

	private populateModelDropdown(selectEl: HTMLSelectElement): void {
		selectEl.empty();
		const models = this.plugin.settings.modelCache?.models ?? [];
		if (models.length === 0) {
			selectEl.createEl("option", {
				value: "",
				text: "No models fetched yet — set a valid API key",
			});
		}
		const known = new Set<string>();
		for (const m of models) {
			known.add(m.id);
			selectEl.createEl("option", { value: m.id, text: `${m.name} (${m.id})` });
		}
		const current = this.plugin.settings.defaultModel;
		if (current && !known.has(current)) {
			selectEl.createEl("option", { value: current, text: current });
		}
		selectEl.value = current;
	}

	/** Refresh the /v1/models cache; throttled so tab re-opens don't hammer. */
	private async refreshModels(): Promise<void> {
		const apiKey = this.plugin.settings.apiKey;
		if (apiKey.length === 0) {
			this.setModelStatus("Set an API key to fetch the model list.");
			return;
		}
		if (Date.now() - this.lastFetchAt < 30_000) return;
		this.lastFetchAt = Date.now();
		this.setModelStatus("Fetching model list…");
		try {
			const models = await fetchModels(apiKey);
			this.plugin.settings.modelCache = { fetchedAt: Date.now(), models };
			await this.plugin.saveSettings();
			if (this.modelDropdownEl?.isConnected) {
				this.populateModelDropdown(this.modelDropdownEl);
			}
			this.setModelStatus(
				`${models.length} models available on your account.`
			);
		} catch (e) {
			const cached = this.plugin.settings.modelCache?.models.length ?? 0;
			const message = e instanceof Error ? e.message : String(e);
			this.setModelStatus(
				`Couldn't refresh model list (${message})${cached > 0 ? ` — using ${cached} cached models` : ""}.`
			);
		}
	}

	private setModelStatus(text: string): void {
		if (this.modelStatusEl?.isConnected) this.modelStatusEl.setText(text);
	}
}
