import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AssistPlusPlugin from "../main";
import { PLUGIN_NAME, VIEW_TYPE_CHAT } from "../constants";
import {
	ApiError,
	ChatTurn,
	StreamInterruptedError,
	sanitize,
	sendChat,
} from "../api/client";
import { SuggestDiffModal } from "../edits/diff-modal";
import { effectiveDefaultModel } from "../settings";
import { ChatMessage, Conversation, generateId } from "../types";
import { AttachFileModal } from "./attach-modal";
import { MessageDeps, StreamingRenderer, renderMessage } from "./messages";
import { ScopePanel } from "./scope-panel";

/**
 * The chat leaf. Sends go: user text → scope.collectPayload() → api.sendChat().
 * This view never reads vault content itself — everything Claude sees comes
 * from the scope engine, and everything sent is recorded on the user message
 * as a SentManifest before the request leaves.
 */
export class ChatView extends ItemView {
	private scopePanel: ScopePanel | null = null;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private modelSelect!: HTMLSelectElement;
	private abortController: AbortController | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: AssistPlusPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return PLUGIN_NAME;
	}

	getIcon(): string {
		return "bot";
	}

	private get conversation(): Conversation {
		return this.plugin.conversation;
	}

	onOpen(): Promise<void> {
		this.buildLayout();
		this.refresh();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.abortController?.abort();
		this.abortController = null;
		this.contentEl.empty();
		return Promise.resolve();
	}

	/** Full re-render; also called from commands (new conversation, attach). */
	refresh(): void {
		this.updateModelSelect();
		this.scopePanel?.render();
		this.renderMessages();
	}

	private buildLayout(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("assist-plus-view");

		const header = root.createDiv({ cls: "assist-plus-header" });
		this.modelSelect = header.createEl("select", {
			cls: "dropdown assist-plus-model-select",
			attr: { "aria-label": "Model for this conversation" },
		});
		this.modelSelect.addEventListener("change", () => {
			this.conversation.modelOverride =
				this.modelSelect.value === "" ? null : this.modelSelect.value;
		});
		const newChat = header.createEl("button", {
			cls: "assist-plus-icon-btn",
			attr: { "aria-label": "New conversation" },
		});
		setIcon(newChat, "plus");
		newChat.addEventListener("click", () => {
			this.plugin.newConversation();
		});

		this.scopePanel = new ScopePanel(root, {
			app: this.app,
			component: this,
			scope: this.plugin.scope,
			getConversation: () => this.conversation,
			onRemove: (path) => {
				this.conversation.attachments = this.conversation.attachments.filter(
					(p) => p !== path
				);
				this.refresh();
			},
			onAttachFile: (file) => {
				this.plugin.attachFile(file);
			},
			openPicker: () => {
				this.openAttachPicker();
			},
		});

		this.messagesEl = root.createDiv({ cls: "assist-plus-messages" });

		const composer = root.createDiv({ cls: "assist-plus-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "assist-plus-input",
			attr: {
				placeholder: "Ask about your attached notes… (Enter to send)",
				rows: "3",
			},
		});
		this.registerDomEvent(this.inputEl, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		});
		this.sendBtn = composer.createEl("button", {
			cls: "mod-cta assist-plus-send",
			text: "Send",
		});
		this.sendBtn.addEventListener("click", () => {
			if (this.abortController) {
				this.abortController.abort();
			} else {
				void this.send();
			}
		});
	}

	openAttachPicker(): void {
		new AttachFileModal(
			this.app,
			this.plugin.scope,
			new Set(this.conversation.attachments),
			(file) => this.plugin.attachFile(file)
		).open();
	}

	private updateModelSelect(): void {
		const settings = this.plugin.settings;
		this.modelSelect.empty();
		const fallback = effectiveDefaultModel(settings);
		this.modelSelect.createEl("option", {
			value: "",
			text: `Default${fallback ? ` (${fallback})` : " (not set)"}`,
		});
		const known = new Set<string>();
		for (const m of settings.modelCache?.models ?? []) {
			known.add(m.id);
			this.modelSelect.createEl("option", { value: m.id, text: m.name });
		}
		const custom = settings.customModel.trim();
		if (custom.length > 0 && !known.has(custom)) {
			known.add(custom);
			this.modelSelect.createEl("option", { value: custom, text: custom });
		}
		const override = this.conversation.modelOverride;
		if (override && !known.has(override)) {
			this.modelSelect.createEl("option", { value: override, text: override });
		}
		this.modelSelect.value = override ?? "";
	}

	private renderMessages(): HTMLElement | null {
		this.messagesEl.empty();
		if (this.conversation.messages.length === 0) {
			this.messagesEl.createDiv({
				cls: "assist-plus-empty",
				text: "Attach a note above, then ask about it. Claude only ever sees the files listed in the panel — nothing else from your vault.",
			});
			return null;
		}
		const deps: MessageDeps = {
			app: this.app,
			component: this,
			onRetry: (m) => void this.retry(m),
		};
		// The apply path exists only in Suggest mode; Read-only mode passes no
		// handler, so suggestions render as inert text.
		if (this.plugin.settings.editMode === "suggest") {
			deps.onReviewSuggestions = (hunks) => {
				new SuggestDiffModal(
					this.app,
					this.plugin.scope,
					this.conversation,
					hunks
				).open();
			};
		}
		let streamingBody: HTMLElement | null = null;
		for (const message of this.conversation.messages) {
			const { bodyEl } = renderMessage(this.messagesEl, message, deps);
			if (message.status === "streaming") streamingBody = bodyEl;
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		return streamingBody;
	}

	private resolveModel(): string | null {
		return (
			this.conversation.modelOverride ??
			(effectiveDefaultModel(this.plugin.settings) || null)
		);
	}

	private async send(): Promise<void> {
		if (this.abortController) return;
		const text = this.inputEl.value.trim();
		if (text.length === 0) return;

		if (this.plugin.settings.apiKey.trim().length === 0) {
			new Notice(`${PLUGIN_NAME}: set your Anthropic API key in the plugin settings first.`);
			return;
		}
		const model = this.resolveModel();
		if (!model) {
			new Notice(`${PLUGIN_NAME}: pick a model in the plugin settings first.`);
			return;
		}

		const userMessage: ChatMessage = {
			id: generateId(),
			role: "user",
			text,
			status: "complete",
		};
		this.conversation.messages.push(userMessage);
		if (this.conversation.title.length === 0) {
			this.conversation.title = text.slice(0, 60);
		}
		this.inputEl.value = "";
		await this.dispatch(userMessage, model);
	}

	/** Re-send for an errored assistant message: drop it and dispatch again. */
	private async retry(assistantMessage: ChatMessage): Promise<void> {
		if (this.abortController) return;
		const messages = this.conversation.messages;
		const index = messages.indexOf(assistantMessage);
		if (index <= 0) return;
		const userMessage = messages[index - 1];
		if (!userMessage || userMessage.role !== "user") return;
		messages.splice(index, 1);
		const model = this.resolveModel();
		if (!model) return;
		await this.dispatch(userMessage, model);
	}

	private async dispatch(
		userMessage: ChatMessage,
		model: string
	): Promise<void> {
		const conversation = this.conversation;
		const assistantMessage: ChatMessage = {
			id: generateId(),
			role: "assistant",
			text: "",
			status: "streaming",
		};
		conversation.messages.push(assistantMessage);

		// THE choke point: the only source of vault content for this request.
		const payload = await this.plugin.scope.collectPayload(conversation);

		// Record the manifest BEFORE the request leaves — the "sent" disclosure
		// reflects exactly what the payload carries, not what we hoped.
		userMessage.sent = {
			at: Date.now(),
			model,
			streamed: true,
			files: payload.files.map((f) => ({ path: f.path, chars: f.chars })),
		};
		if (payload.skipped.length > 0) {
			new Notice(
				`${PLUGIN_NAME} excluded from this send:\n` +
					payload.skipped.map((s) => `${s.path} — ${s.reason}`).join("\n"),
				8000
			);
		}

		this.setSending(true);
		this.scopePanel?.render();
		const streamingBody = this.renderMessages();
		const renderer = new StreamingRenderer(
			this.app,
			streamingBody ?? this.messagesEl.createDiv(),
			this
		);

		const history = buildHistory(conversation, assistantMessage);
		this.abortController = new AbortController();
		const apiKey = this.plugin.settings.apiKey;

		try {
			const result = await sendChat({
				payload,
				history,
				model,
				apiKey,
				editMode: this.plugin.settings.editMode,
				signal: this.abortController.signal,
				onDelta: (delta) => {
					renderer.append(delta);
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
				},
			});
			assistantMessage.text = result.text;
			assistantMessage.status = "complete";
			if (userMessage.sent) userMessage.sent.streamed = result.streamed;
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") {
				assistantMessage.text = renderer.current;
				assistantMessage.status = "complete";
				assistantMessage.stopped = true;
			} else if (e instanceof StreamInterruptedError) {
				assistantMessage.text = e.partialText;
				assistantMessage.status = "error";
				assistantMessage.errorText =
					"Connection lost mid-stream. Check your network, then retry.";
			} else if (e instanceof ApiError) {
				assistantMessage.status = "error";
				assistantMessage.errorText = describeApiError(e);
			} else {
				assistantMessage.status = "error";
				assistantMessage.errorText = sanitize(
					e instanceof Error ? e.message : String(e),
					apiKey
				);
			}
		} finally {
			this.abortController = null;
			this.setSending(false);
			this.refresh();
		}
	}

	private setSending(sending: boolean): void {
		this.sendBtn.setText(sending ? "Stop" : "Send");
		this.sendBtn.toggleClass("assist-plus-sending", sending);
	}
}

/**
 * Chat history for the API: completed, non-empty turns only (errored replies
 * drop out), merged so roles strictly alternate starting with "user".
 */
function buildHistory(
	conversation: Conversation,
	exclude: ChatMessage
): ChatTurn[] {
	const turns: ChatTurn[] = [];
	for (const message of conversation.messages) {
		if (message === exclude) continue;
		if (message.status !== "complete") continue;
		if (message.text.length === 0) continue;
		const last = turns[turns.length - 1];
		if (last && last.role === message.role) {
			last.content += "\n\n" + message.text;
		} else {
			turns.push({ role: message.role, content: message.text });
		}
	}
	while (turns.length > 0 && turns[0]?.role !== "user") {
		turns.shift();
	}
	return turns;
}

function describeApiError(e: ApiError): string {
	if (e.status === 401) {
		return "Authentication failed — check your API key in the plugin settings.";
	}
	if (e.status === 429) {
		return `Rate limited by the API: ${e.message}`;
	}
	return e.message;
}
