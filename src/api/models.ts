import { requestUrl } from "obsidian";
import { ANTHROPIC_API_BASE, ANTHROPIC_VERSION } from "../constants";
import { CachedModel } from "../settings";
import { sanitize } from "./client";

/**
 * Model list from GET /v1/models — fetched at settings-open time and cached,
 * never hardcoded (model names go stale). Uses requestUrl (no CORS concerns,
 * no streaming needed). Reads nothing from the vault.
 */
export async function fetchModels(apiKey: string): Promise<CachedModel[]> {
	const response = await requestUrl({
		url: `${ANTHROPIC_API_BASE}/v1/models?limit=1000`,
		method: "GET",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		},
		throw: false,
	});

	let parsed: unknown = null;
	try {
		parsed = response.json as unknown;
	} catch {
		// non-JSON body; handled below
	}

	if (response.status >= 400) {
		const err = (parsed as Record<string, unknown> | null)?.["error"] as
			| Record<string, unknown>
			| undefined;
		const message =
			typeof err?.["message"] === "string"
				? err["message"]
				: `could not fetch models (HTTP ${response.status})`;
		throw new Error(sanitize(message, apiKey));
	}

	const data = ((parsed ?? {}) as Record<string, unknown>)["data"];
	if (!Array.isArray(data)) return [];
	const models: CachedModel[] = [];
	for (const entry of data) {
		const m = entry as Record<string, unknown>;
		if (typeof m["id"] !== "string") continue;
		models.push({
			id: m["id"],
			name: typeof m["display_name"] === "string" ? m["display_name"] : m["id"],
		});
	}
	return models;
}
