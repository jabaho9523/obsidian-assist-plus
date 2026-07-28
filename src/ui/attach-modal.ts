import { App, FuzzyMatch, FuzzySuggestModal, Notice, TFile } from "obsidian";
import { ScopeDecision, ScopeEngine } from "../scope/scope";

/**
 * The attach picker. Offers every markdown note (allowlisted ones first, with
 * a badge); files denied by scope rules are greyed out and REFUSED on
 * selection with a warning — the deny decision comes from the same
 * `ScopeEngine.evaluate` used at send and apply time.
 */
export class AttachFileModal extends FuzzySuggestModal<TFile> {
	private decisions = new Map<string, ScopeDecision>();
	/** The open note sorts first — it's the most common pick. */
	private readonly activePath: string | null;

	constructor(
		app: App,
		private readonly scopeEngine: ScopeEngine,
		private readonly attached: ReadonlySet<string>,
		private readonly onPick: (file: TFile) => void
	) {
		super(app);
		this.activePath = app.workspace.getActiveFile()?.path ?? null;
		this.setPlaceholder("Attach a note to this conversation…");
	}

	private decisionFor(file: TFile): ScopeDecision {
		let decision = this.decisions.get(file.path);
		if (!decision) {
			decision = this.scopeEngine.evaluate(file);
			this.decisions.set(file.path, decision);
		}
		return decision;
	}

	getItems(): TFile[] {
		const rank = (f: TFile): number => {
			if (f.path === this.activePath) return 0;
			return this.decisionFor(f).allowlisted ? 1 : 2;
		};
		const files = this.app.vault.getMarkdownFiles();
		return files.sort((a, b) => {
			const byRank = rank(a) - rank(b);
			if (byRank !== 0) return byRank;
			return a.path.localeCompare(b.path);
		});
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		const decision = this.decisionFor(match.item);
		if (!decision.allowed) {
			el.addClass("assist-plus-suggestion-denied");
			el.createSpan({
				cls: "assist-plus-suggestion-badge",
				text: `denied — ${decision.detail ?? "scope rule"}`,
			});
		} else if (this.attached.has(match.item.path)) {
			el.createSpan({ cls: "assist-plus-suggestion-badge", text: "attached" });
		} else if (match.item.path === this.activePath) {
			el.createSpan({ cls: "assist-plus-suggestion-badge", text: "active note" });
		} else if (decision.allowlisted) {
			el.createSpan({ cls: "assist-plus-suggestion-badge", text: "allowlisted" });
		}
	}

	onChooseItem(file: TFile): void {
		const decision = this.scopeEngine.evaluate(file);
		if (!decision.allowed) {
			new Notice(
				`Assist Plus: refusing to attach "${file.path}" — ${decision.detail ?? "denied by scope rules"}.`
			);
			return;
		}
		this.onPick(file);
	}
}
