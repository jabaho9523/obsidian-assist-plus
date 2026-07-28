export const PLUGIN_NAME = "Assist Plus";
export const VIEW_TYPE_CHAT = "assist-plus-chat";
export const RIBBON_ICON = "bot";

/** Folder the explicit export command writes to. The only write path in Read-only mode. */
export const EXPORT_FOLDER = "Assist/Chats";

export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const MAX_RESPONSE_TOKENS = 4096;

/** Rough heuristic for the context meter: ~4 characters per token. */
export const CHARS_PER_TOKEN = 4;
