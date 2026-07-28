export const PLUGIN_NAME = "Assist Plus";
export const VIEW_TYPE_CHAT = "assist-plus-chat";
export const RIBBON_ICON = "bot";

/**
 * Folder the explicit export command writes to. Every write path in this
 * plugin is a single explicit click: export (export.ts), insert-at-cursor on
 * a reply (ui/messages.ts), and per-hunk Suggest apply (edits/apply.ts).
 */
export const EXPORT_FOLDER = "Assist/Chats";

export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const MAX_RESPONSE_TOKENS = 4096;

/** Rough heuristic for the context meter: ~4 characters per token. */
export const CHARS_PER_TOKEN = 4;
