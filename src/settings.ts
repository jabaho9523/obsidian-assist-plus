export type EditMode = "readonly" | "suggest";

export interface CachedModel {
	id: string;
	name: string;
}

/** A named, reusable set of notes attachable in one action from the panel. */
export interface NoteGroup {
	id: string;
	name: string;
	paths: string[];
}

export interface AssistPlusSettings {
	/**
	 * Stored in the vault's plugin data (data.json), like any plugin setting.
	 * Never logged, never included in errors, never exported. See settings tab
	 * for the user-facing warning.
	 */
	apiKey: string;
	/** Model id picked from the fetched /v1/models list. "" until the user picks one. */
	defaultModel: string;
	/** Manual escape hatch; when non-empty it takes precedence over defaultModel. */
	customModel: string;
	editMode: EditMode;
	/** Scope rules. Folders are vault-root path prefixes; tags match nested tags too. */
	allowFolders: string[];
	allowTags: string[];
	denyFolders: string[];
	denyTags: string[];
	/**
	 * Attached automatically to every NEW conversation. Still explicit (the
	 * user typed these exact paths), still visible in the panel, still
	 * removable per conversation, and deny rules still win at send time.
	 */
	defaultAttachments: string[];
	noteGroups: NoteGroup[];
	/** Cached /v1/models response so settings work offline after first fetch. */
	modelCache: { fetchedAt: number; models: CachedModel[] } | null;
}

export const DEFAULT_SETTINGS: AssistPlusSettings = {
	apiKey: "",
	defaultModel: "",
	customModel: "",
	editMode: "readonly",
	allowFolders: [],
	allowTags: [],
	denyFolders: ["Private"],
	denyTags: [],
	defaultAttachments: [],
	noteGroups: [],
	modelCache: null,
};

/** The model used when a conversation has no override. */
export function effectiveDefaultModel(settings: AssistPlusSettings): string {
	const custom = settings.customModel.trim();
	return custom.length > 0 ? custom : settings.defaultModel;
}
