export type Role = "user" | "assistant";

export type MessageStatus = "streaming" | "complete" | "error";

/**
 * Record of exactly what left the vault with one send: which files, how big,
 * which model, when. Written at the moment the request body is built and
 * surfaced in the UI as the per-message "sent: N files" disclosure.
 */
export interface SentManifest {
	at: number;
	model: string;
	streamed: boolean;
	files: { path: string; chars: number }[];
}

export interface ChatMessage {
	id: string;
	role: Role;
	text: string;
	status: MessageStatus;
	/** Present on user messages once their send has been dispatched. */
	sent?: SentManifest;
	/** Sanitized, key-free description of what went wrong. */
	errorText?: string;
	/** True when the user pressed Stop mid-stream; text is partial. */
	stopped?: boolean;
}

export interface Conversation {
	id: string;
	title: string;
	createdAt: number;
	/** Vault paths the user explicitly attached. This IS the conversation's scope. */
	attachments: string[];
	/** Model id override for this conversation; null = use the settings default. */
	modelOverride: string | null;
	messages: ChatMessage[];
}

export function createConversation(): Conversation {
	return {
		id: generateId(),
		title: "",
		createdAt: Date.now(),
		attachments: [],
		modelOverride: null,
		messages: [],
	};
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
