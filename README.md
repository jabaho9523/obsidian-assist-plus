# Assist Plus

Chat with Claude (Anthropic) inside your Obsidian vault — on your own API key, with strict control over what it can see and change.

Assist Plus is built around one idea: **an AI assistant in your vault must be default-deny.** Claude sees nothing unless you explicitly attach it, every request's exact contents are inspectable before and after sending, and nothing is ever written to your vault without a click.

> **Status: v0.1 (M1, private dogfood).** This is the trust core — chat, the permission model, and Read-only/Suggest edit modes. Not yet released publicly.

## What it does

- **Chat sidebar** — a right-sidebar leaf (drag it to the center for a full tab) with streamed markdown replies, a model picker, an edit-mode switcher (Read-only ↔ Suggest, right in the header), and a context meter (files in scope, approximate tokens).
- **Copy & insert** — every reply has copy and insert-at-cursor buttons. Mark (select) part of a reply first and they act on just that part; otherwise the whole reply. Insert drops the markdown into your open note at the cursor (undo with the editor's normal undo).
- **Explicit scope** — attach the active note with one click, pick from the fuzzy picker (the open note sorts first), use the "Attach current note" command, or drag a note onto the panel. The **"What Claude can see"** panel lists every in-scope file with per-file remove.
- **Note groups & default notes** — define reusable groups in settings (say, the five notes you always use as context) and attach a whole group from the panel in one action. "Default notes" are attached automatically to every new conversation — still visible in the panel, removable per conversation, and the denylist still wins at send time.
- **Allowlist / denylist** — folders and tags. The denylist (default: `Private/`) wins over everything: denied files are greyed out in the picker, refused on attach, and excluded at send time even if they were attached earlier. A note with `assist: false` in its frontmatter is likewise refused. The allowlist only affects what the picker offers first — in M1 it never includes anything by itself.
- **Sent-files disclosure** — after every send, the message shows "sent: N files" with the exact list (and whether it went streamed or via the fallback).
- **Edit modes** — **Read-only** (default): Claude can never change your vault. **Suggest**: proposed edits show in the chat as a compact "Suggested edit" callout (not raw code) with a Review button. The review modal shows a real line-by-line diff — only changed lines highlighted, long unchanged runs folded — plus a "Result preview" tab that renders the outcome as normal markdown. You apply per hunk (or all), and applies only ever target files that were in scope for the conversation.
- **Export** — "Export conversation to note" writes the transcript (including the sent-files record) to `Assist/Chats/`.

## What gets sent, where, when

- **Where:** requests go **directly from the plugin to `api.anthropic.com`** using your own API key. There is no middleman server, no proxy, no telemetry — nothing else receives anything, ever.
- **What:** exactly (1) the messages you type in the chat, (2) the full content of the files listed in "What Claude can see" at the moment you press send, and (3) a fixed system prompt. Nothing else — not your vault name, not your file tree, not unattached notes.
- **When:** only when you press send. There is no background traffic except fetching the model list from your account (`/v1/models`) when you open the settings tab.
- **Verify it:** every message records its exact payload in the "sent: N files" disclosure, written from the very object the request was built from.
- **Costs:** usage bills to your own Anthropic account at Anthropic's API rates. This plugin adds no fees.

## What this plugin will never do

- **No telemetry, no middleman.** Your notes and your key talk to `api.anthropic.com` and nowhere else.
- **No reads outside scope.** The enforcement is structural, not a prompt: the API layer only accepts payloads produced by the scope engine's single `collectPayload` choke point, and that engine applies denylist → `assist: false` → explicit-attachment rules on every send. There is no code path that reads other vault content into a request.
- **No writes without a click.** Every write path is a single explicit click by you: the export command, the insert-at-cursor button on a reply (into your open editor, undoable there), and — in Suggest mode only — Apply on a specific hunk, only on files that were in scope, with deny rules re-checked at write time. There is no auto-apply and no background write of any kind.
- **No key leakage.** The API key is stored in the plugin's local data in your vault, is only ever used to set a request header, is never logged, and is scrubbed from any error text.

## Setup

### Getting an API key

1. Create an account at [console.anthropic.com](https://console.anthropic.com).
2. Add billing (**Settings → Billing** — a few dollars of credit is plenty to start; usage is pay-per-use at [Anthropic's API rates](https://www.anthropic.com/pricing#api)).
3. Go to **Settings → API keys → Create key**, and copy the key (it starts with `sk-ant-`). You'll only see it once.
4. Paste it into **Settings → Assist Plus** in Obsidian.

**Can I use OpenAI / Gemini / a local model instead?** No — this plugin is Anthropic-only, by design, in this version. Multi-provider support was deliberately left out of M1; the "custom model ID" field is for Anthropic model IDs only. Your ChatGPT/Claude.ai *subscription* won't work either — this uses the API, which is billed separately.

### Install and go

1. Install and enable the plugin (manual install for now: `main.js`, `manifest.json`, `styles.css` into `<Vault>/.obsidian/plugins/assist-plus/`).
2. In **Settings → Assist Plus**, paste your Anthropic API key. It is stored locally in your vault's plugin folder — treat your vault's storage as you would any local credential.
3. Pick a default model (fetched live from your account; there's a custom-model escape hatch).
4. Open the chat (ribbon icon or "Open chat" command), attach a note, ask away.

### Scope rules, precisely

1. **Denylist wins over everything** — folder prefixes (e.g. `Private`) and tags (e.g. `#private`, nested tags included).
2. **`assist: false`** in a note's frontmatter refuses that note.
3. **Explicit attachment** is the only way content enters scope.
4. **Allowlist** entries are offered first in the picker — nothing more.

Deny rules re-run at attach, send, and apply time, so moving a file into a denied folder takes effect on the very next action.

## M1 scope (honest edition)

Included: chat with streaming (with automatic non-streaming fallback and a retry affordance on dropped connections), the scope engine above, Read-only/Suggest modes, per-hunk diff apply, export command.

Not in M1 (deliberately): Write/auto-apply mode, undo journal, Claude-initiated vault search or tool use, saved-chat browser (conversations live in memory; export is the way to keep one), slash-commands, multi-provider support, embeddings/RAG.

**Phone & tablet:** the plugin works on Obsidian mobile (no desktop-only APIs, touch-sized controls). On mobile, Enter makes a newline — send with the Send button. Attach via the button or the "Attach current note" command (drag-and-drop is a desktop thing).

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # type-check + production build
npm run lint
```

Source layout: `src/scope/` (the permission engine — read this first), `src/api/` (Anthropic Messages + models), `src/ui/` (chat leaf, scope panel, picker), `src/edits/` (suggest parsing, diff modal), `src/settings*.ts`, `src/main.ts` (lifecycle only).

## License

[0BSD](LICENSE)
