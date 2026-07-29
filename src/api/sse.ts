/**
 * Minimal SSE (text/event-stream) parser for the Anthropic streaming API.
 * Fed decoded chunks; emits complete events. Tolerates events split across
 * chunk boundaries by buffering until a blank-line terminator.
 */

export interface SseEvent {
	event: string;
	data: string;
}

export class SseParser {
	private buffer = "";

	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const events: SseEvent[] = [];

		let boundary = this.findBoundary();
		while (boundary !== null) {
			const rawEvent = this.buffer.slice(0, boundary.index);
			this.buffer = this.buffer.slice(boundary.index + boundary.length);
			const parsed = parseEvent(rawEvent);
			if (parsed) events.push(parsed);
			boundary = this.findBoundary();
		}
		return events;
	}

	private findBoundary(): { index: number; length: number } | null {
		const lf = this.buffer.indexOf("\n\n");
		const crlf = this.buffer.indexOf("\r\n\r\n");
		if (lf === -1 && crlf === -1) return null;
		if (crlf !== -1 && (lf === -1 || crlf < lf)) {
			return { index: crlf, length: 4 };
		}
		return { index: lf, length: 2 };
	}
}

function parseEvent(raw: string): SseEvent | null {
	let event = "";
	const dataLines: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("event:")) {
			event = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			// Per SSE spec, a single space after the colon is not payload.
			dataLines.push(line.slice(5).replace(/^ /, ""));
		}
	}
	if (event === "" && dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}
