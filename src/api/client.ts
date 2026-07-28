import { requestUrl } from "obsidian";
import {
	ANTHROPIC_API_BASE,
	ANTHROPIC_VERSION,
	MAX_RESPONSE_TOKENS,
} from "../constants";
import { ScopedPayload, isScopedPayload } from "../scope/scope";
import { EditMode } from "../settings";
import { buildSystemPrompt } from "./prompt";
import { SseParser } from "./sse";

/**
 * The Anthropic Messages client. Requests go straight from this plugin to
 * api.anthropic.com on the user's own key — no middleman, no telemetry.
 *
 * INVARIANT (see scope/scope.ts): vault file content can enter a request body
 * ONLY via the `payload` parameter, which must be a genuine ScopedPayload from
 * `ScopeEngine.collectPayload()` — verified at runtime below. `history` holds
 * chat turns (text the user typed and prior assistant replies), never file
 * content. This module never touches the vault.
 *
 * The API key is used to set a request header and for nothing else: it is
 * never logged, never embedded in thrown errors (see sanitize()).
 */

export interface ChatTurn {
	role: "user" | "assistant";
	content: string;
}

export interface SendResult {
	text: string;
	/** False when the non-streaming requestUrl fallback served the reply. */
	streamed: boolean;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly apiType: string | null
	) {
		super(message);
		this.name = "ApiError";
	}
}

/** Thrown when the SSE stream dies after partial text was received. */
export class StreamInterruptedError extends Error {
	constructor(readonly partialText: string) {
		super("Connection lost mid-stream");
		this.name = "StreamInterruptedError";
	}
}

export interface SendOptions {
	payload: ScopedPayload;
	history: ChatTurn[];
	model: string;
	apiKey: string;
	editMode: EditMode;
	signal: AbortSignal;
	onDelta: (text: string) => void;
}

export async function sendChat(opts: SendOptions): Promise<SendResult> {
	// The physical gate: no genuine ScopedPayload, no request. Combined with
	// the nominal type this makes it impossible to send vault content that
	// didn't pass the scope engine.
	if (!isScopedPayload(opts.payload)) {
		throw new Error(
			"Assist Plus internal error: request payload did not come from scope.collectPayload()"
		);
	}

	const body = {
		model: opts.model,
		max_tokens: MAX_RESPONSE_TOKENS,
		system: buildSystemPrompt(opts.payload, opts.editMode),
		messages: opts.history,
	};

	let response: Response;
	try {
		// Deliberately window.fetch, not requestUrl: requestUrl cannot stream.
		// Anthropic supports CORS for browser clients when this header is
		// present, and connect failures fall back to requestUrl below.
		response = await window.fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": opts.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: JSON.stringify({ ...body, stream: true }),
			signal: opts.signal,
		});
	} catch (e) {
		if (isAbort(e)) throw e;
		// Could not connect at all (CORS/network edge cases) — automatic
		// fallback to non-streaming via Obsidian's requestUrl.
		return await sendNonStreaming(body, opts);
	}

	if (!response.ok) {
		throw await apiErrorFromResponse(response, opts.apiKey);
	}
	if (!response.body) {
		return await sendNonStreaming(body, opts);
	}

	return await readStream(response.body, opts);
}

async function readStream(
	stream: ReadableStream<Uint8Array>,
	opts: SendOptions
): Promise<SendResult> {
	const parser = new SseParser();
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const event of parser.push(decoder.decode(value, { stream: true }))) {
				if (event.event === "content_block_delta") {
					const delta = parseJson(event.data)?.["delta"] as
						| Record<string, unknown>
						| undefined;
					if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
						text += delta["text"];
						opts.onDelta(delta["text"]);
					}
				} else if (event.event === "error") {
					const err = parseJson(event.data)?.["error"] as
						| Record<string, unknown>
						| undefined;
					throw new ApiError(
						sanitize(stringOr(err?.["message"], "API stream error"), opts.apiKey),
						null,
						stringOr(err?.["type"], null)
					);
				} else if (event.event === "message_stop") {
					return { text, streamed: true };
				}
			}
		}
		return { text, streamed: true };
	} catch (e) {
		if (isAbort(e) || e instanceof ApiError) throw e;
		// The connection succeeded but broke mid-stream (e.g. network went
		// offline). Keep the partial text; the UI offers a retry.
		throw new StreamInterruptedError(text);
	} finally {
		try {
			await reader.cancel();
		} catch {
			// stream already dead — nothing to release
		}
	}
}

async function sendNonStreaming(
	body: Record<string, unknown>,
	opts: SendOptions
): Promise<SendResult> {
	const response = await requestUrl({
		url: `${ANTHROPIC_API_BASE}/v1/messages`,
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": opts.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		},
		body: JSON.stringify(body),
		throw: false,
	});

	let parsed: unknown = null;
	try {
		parsed = response.json as unknown;
	} catch {
		// non-JSON body; handled below
	}

	if (response.status >= 400) {
		throw apiErrorFromJson(parsed, response.status, opts.apiKey);
	}

	const json = (parsed ?? {}) as Record<string, unknown>;
	const content = Array.isArray(json["content"]) ? json["content"] : [];
	const text = content
		.map((block: unknown) => {
			const b = block as Record<string, unknown>;
			return b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
		})
		.join("");
	opts.onDelta(text);
	return { text, streamed: false };
}

async function apiErrorFromResponse(
	response: Response,
	apiKey: string
): Promise<ApiError> {
	let json: unknown = null;
	try {
		json = await response.json();
	} catch {
		// non-JSON error body; fall through to status-only message
	}
	return apiErrorFromJson(json, response.status, apiKey);
}

function apiErrorFromJson(
	json: unknown,
	status: number,
	apiKey: string
): ApiError {
	const err = (json as Record<string, unknown> | null)?.["error"] as
		| Record<string, unknown>
		| undefined;
	const message = stringOr(err?.["message"], `API request failed (HTTP ${status})`);
	return new ApiError(sanitize(message, apiKey), status, stringOr(err?.["type"], null));
}

/**
 * Defense in depth: strip the API key from any text that could surface in the
 * UI or console. Anthropic error bodies don't echo the key, but nothing that
 * leaves this module gets the chance to.
 */
export function sanitize(text: string, apiKey: string): string {
	if (apiKey.length === 0) return text;
	return text.split(apiKey).join("•••");
}

function isAbort(e: unknown): boolean {
	return e instanceof DOMException && e.name === "AbortError";
}

function parseJson(data: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(data);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function stringOr<T>(value: unknown, fallback: T): string | T {
	return typeof value === "string" ? value : fallback;
}
