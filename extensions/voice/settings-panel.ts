/**
 * Voice Settings Panel — enterprise-grade interactive overlay.
 *
 * Architecture: Follows the Pompom Settings Panel pattern.
 *   - Component interface: render(width) / handleInput(data) / invalidate()
 *   - Opened via ctx.ui.custom() with overlay: true
 *   - Tab navigation with ←→, row navigation with ↑↓
 *   - Inline sub-selectors (language picker) with fuzzy search
 *   - Responsive rendering with truncateToWidth on every line
 *   - Render caching for performance
 */

import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { VoiceConfig, VoiceSettingsScope } from "./config";
import { LOCAL_MODELS, getLanguagesForLocalModel, type LocalModelInfo, type LocalLangEntry } from "./local";
import type { DeviceProfile, ModelFitness } from "./device";
import { getFreeDiskSpace, formatBytes, getModelsDir, scanHandyModels, importHandyModel } from "./model-download";

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

// ─── Types ────────────────────────────────────────────────────────────────────

const TAB_IDS = ["general", "models", "downloaded", "device"] as const;
const TAB_LABELS = ["General", "Models", "Downloaded", "Device"];
type TabId = (typeof TAB_IDS)[number];

export type PanelAction =
	| { type: "download"; modelId: string }
	| undefined;

export interface PanelDeps {
	config: VoiceConfig;
	device: DeviceProfile;
	cwd: string;
	getModelFitness: (m: LocalModelInfo, d: DeviceProfile) => ModelFitness;
	getDownloadedModels: () => { id: string; sizeMB: number }[];
	deleteModel: (id: string) => boolean;
	isSherpaAvailable: () => boolean;
	formatDeviceSummary: (d: DeviceProfile) => string;
	saveConfig: (config: VoiceConfig, scope: VoiceSettingsScope, cwd: string) => void;
	clearRecognizerCache: () => void;
	resolveApiKey: () => string | undefined;
	deepgramLanguages: { name: string; code: string; popular?: boolean }[];
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export class VoiceSettingsPanel {
	onClose?: (result?: PanelAction) => void;

	private tab = 0;
	private row = 0;
	private sub: "main" | "lang-picker" = "main";

	// Models tab
	private modelSearch = "";
	private modelList: (LocalModelInfo & { fitness: ModelFitness })[] = [];
	private modelFiltered: (LocalModelInfo & { fitness: ModelFitness })[] = [];

	// Language sub-picker
	private langSearch = "";
	private langList: { name: string; code: string }[] = [];
	private langFiltered: { name: string; code: string }[] = [];
	private langRow = 0;

	// Render cache
	private cw?: number;
	private cl?: string[];

	constructor(private p: PanelDeps, initialTab?: number) {
		if (initialTab !== undefined && initialTab >= 0 && initialTab < TAB_IDS.length) {
			this.tab = initialTab;
		}
		this.rebuildModels();
	}

	// ─── Component interface ──────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cl && this.cw === width) return this.cl;

		const w = Math.max(36, Math.min(width - 2, 72));
		const iw = w - 4;
		const t = (s: string) => truncateToWidth(s, w);

		const lines: string[] = [];
		const { config, device } = this.p;

		// Header
		lines.push(t(`  ${bold("pi-listen")}  ${dim(this.p.formatDeviceSummary(device))}`));
		lines.push(t(dim("  " + "─".repeat(Math.min(iw, 50)))));

		// Tab bar
		const tabs = TAB_LABELS.map((label, i) =>
			i === this.tab ? cyan(` [${label}] `) : dim(` ${label} `),
		).join("");
		lines.push(t("  " + tabs));
		lines.push("");

		// Sub-mode: language picker
		if (this.sub === "lang-picker") {
			lines.push(...this.renderLangPicker(w, iw).map(t));
			this.cl = lines;
			this.cw = width;
			return lines;
		}

		// Tab content
		const tabId = TAB_IDS[this.tab]!;
		switch (tabId) {
			case "general":
				lines.push(...this.renderGeneral(w, iw).map(t));
				break;
			case "models":
				lines.push(...this.renderModels(w, iw).map(t));
				break;
			case "downloaded":
				lines.push(...this.renderDownloaded(w, iw).map(t));
				break;
			case "device":
				lines.push(...this.renderDevice(w, iw).map(t));
				break;
		}

		this.cl = lines;
		this.cw = width;
		return lines;
	}

	handleInput(data: string): void {
		if (this.sub === "lang-picker") {
			this.handleLangInput(data);
			this.invalidate();
			return;
		}

		const tabId = TAB_IDS[this.tab]!;

		// Tab navigation: ←→
		if (matchesKey(data, Key.left)) {
			this.tab = (this.tab - 1 + TAB_IDS.length) % TAB_IDS.length;
			this.row = 0;
			this.modelSearch = "";
			this.filterModels();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.tab = (this.tab + 1) % TAB_IDS.length;
			this.row = 0;
			this.modelSearch = "";
			this.filterModels();
			this.invalidate();
			return;
		}

		// Close
		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}

		// Row navigation: ↑↓
		if (matchesKey(data, Key.up)) {
			const max = this.getRowCount(tabId);
			if (max > 0) this.row = this.row === 0 ? max - 1 : this.row - 1;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			const max = this.getRowCount(tabId);
			if (max > 0) this.row = this.row === max - 1 ? 0 : this.row + 1;
			this.invalidate();
			return;
		}

		// Enter = select/toggle
		if (matchesKey(data, Key.enter)) {
			this.handleSelect(tabId);
			this.invalidate();
			return;
		}

		// Tab-specific keys
		if (tabId === "models") {
			// Backspace = delete char from search
			if (matchesKey(data, Key.backspace)) {
				this.modelSearch = this.modelSearch.slice(0, -1);
				this.filterModels();
				this.row = 0;
				this.invalidate();
				return;
			}
			// Printable = search
			if (data.length === 1 && data >= " " && data <= "~") {
				this.modelSearch += data;
				this.filterModels();
				this.row = 0;
				this.invalidate();
				return;
			}
		}

		if (tabId === "downloaded") {
			if (data === "x" || data === "d") {
				const dl = this.getDownloaded();
				const item = dl[this.row];
				if (item) {
					const wasActive = this.p.config.localModel === item.id;
					this.p.deleteModel(item.id);
					if (wasActive) {
						try { this.p.clearRecognizerCache(); } catch {}
						// Pick another downloaded model, or clear selection
						const remaining = this.p.getDownloadedModels();
						this.p.config.localModel = remaining.length > 0 ? remaining[0]!.id : undefined;
						this.save();
					}
					this.row = Math.max(0, Math.min(this.row, dl.length - 2));
				}
				this.invalidate();
				return;
			}
		}
	}

	invalidate(): void {
		this.cw = undefined;
		this.cl = undefined;
	}

	// ─── Tab renderers ────────────────────────────────────────────────────

	private renderGeneral(_w: number, iw: number): string[] {
		const lines: string[] = [];
		const { config } = this.p;
		const isLocal = config.backend === "local";
		const useShort = iw < 42;

		const rows: { label: string; value: string; hint?: string }[] = [
			{
				label: "Backend",
				value: isLocal
					? green("Local (offline, batch)")
					: cyan("Deepgram (cloud, live streaming)"),
				hint: "toggle",
			},
			{
				label: isLocal ? "Model" : "API Key",
				value: isLocal
					? (LOCAL_MODELS.find(m => m.id === config.localModel)?.name || config.localModel || "whisper-small")
					: (() => {
						const key = this.p.resolveApiKey();
						return key ? green(`set (${key.slice(0, 8)}…)`) : red("NOT SET");
					})(),
				hint: isLocal ? "go to Models tab" : undefined,
			},
			{
				label: "Language",
				value: this.getLangDisplay(),
				hint: "change",
			},
			{
				label: "Scope",
				value: config.scope === "project"
					? (useShort ? "Project" : "Project (this repo)")
					: (useShort ? "Global" : "Global (all projects)"),
				hint: "toggle",
			},
			{
				label: "Voice",
				value: config.enabled ? green("Enabled") : red("Disabled"),
				hint: "toggle",
			},
		];

		const labelW = 12;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i]!;
			const prefix = i === this.row ? cyan("  → ") : "    ";
			const label = r.label.padEnd(labelW);
			const hint = (i === this.row && r.hint) ? dim(` [↵ ${r.hint}]`) : "";
			lines.push(`${prefix}${label}${r.value}${hint}`);
		}

		lines.push("");
		lines.push(dim("  ↵ change  ←→ tabs  ↑↓ navigate  esc close"));
		return lines;
	}

	private renderModels(_w: number, iw: number): string[] {
		const lines: string[] = [];
		const currentId = this.p.config.localModel || "parakeet-v3";
		const downloadedMap = new Map(this.p.getDownloadedModels().map(d => [d.id, d.sizeMB]));

		// Search bar
		const cursor = this.modelSearch ? this.modelSearch : dim("type to search…");
		lines.push(`  ${dim("Search:")} ${cursor}`);
		lines.push("");

		// Model list
		const maxVisible = 12;
		const total = this.modelFiltered.length;
		const start = Math.max(0, Math.min(this.row - Math.floor(maxVisible / 2), total - maxVisible));
		const end = Math.min(start + maxVisible, total);

		for (let i = start; i < end; i++) {
			const m = this.modelFiltered[i]!;
			const isSelected = i === this.row;
			const isCurrent = m.id === currentId;
			const isDl = downloadedMap.has(m.id);

			const prefix = isSelected ? cyan("  → ") : "    ";
			const name = isSelected ? cyan(m.name) : m.name;
			const size = dim(` — ${m.size}`);
			const badge = this.fitnessBadge(m.fitness);
			const acc = this.compactRating(m.accuracy);
			const spd = this.compactRating(m.speed);
			const status = isCurrent ? green(" ● active")
				: isDl ? green(" ✓ ready")
				: dim(" ○");
			lines.push(`${prefix}${name}${size} ${badge} ${acc}${dim("/")}${spd}${status}`);
			// Expanded detail for selected item
			if (isSelected) {
				const accBar = this.ratingBar(m.accuracy, "Accuracy");
				const spdBar = this.ratingBar(m.speed, "Speed   ");
				lines.push(`      ${accBar}  ${spdBar}`);
				lines.push(`      ${dim(m.notes)}`);
			}
		}

		if (total === 0) {
			lines.push(dim("    No matching models"));
		} else if (start > 0 || end < total) {
			lines.push(dim(`    (${this.row + 1}/${total})`));
		}

		lines.push("");
		lines.push(dim("  ↵ activate + download  ←→ tabs  ↑↓ navigate  esc close"));
		return lines;
	}

	private renderDownloaded(_w: number, _iw: number): string[] {
		const lines: string[] = [];
		const dl = this.getDownloaded();
		const currentId = this.p.config.localModel || "parakeet-v3";
		const handy = scanHandyModels();
		const handyNotImported = handy.filter(h => !h.imported);

		if (dl.length === 0 && handyNotImported.length === 0) {
			lines.push(dim("    No downloaded models yet."));
			lines.push(dim("    Models download automatically on first recording."));
			lines.push(dim("    Use the Models tab to browse and install."));
		} else {
			// Pi models
			if (dl.length > 0) {
				let totalMB = 0;
				for (let i = 0; i < dl.length; i++) {
					const d = dl[i]!;
					totalMB += d.sizeMB;
					const isSelected = i === this.row;
					const isCurrent = d.id === currentId;
					const prefix = isSelected ? cyan("  → ") : "    ";
					const name = isSelected ? cyan(d.name) : d.name;
					const size = dim(` — ${d.sizeMB} MB`);
					const status = isCurrent ? green(" ● active") : "";
					lines.push(`${prefix}${name}${size}${status}`);
				}
				lines.push(dim(`    Total: ${totalMB} MB on disk`));
			}

			// Handy models available for import
			if (handyNotImported.length > 0) {
				lines.push("");
				lines.push(dim("    ── Available from Handy ──"));
				for (let i = 0; i < handyNotImported.length; i++) {
					const h = handyNotImported[i]!;
					const idx = dl.length + i;
					const isSelected = idx === this.row;
					const prefix = isSelected ? cyan("  → ") : "    ";
					const name = isSelected ? cyan(h.name) : h.name;
					const size = dim(` — ${h.sizeMB} MB`);
					lines.push(`${prefix}${name}${size}${yellow(" ↵ import")}`);
				}
			}
		}

		lines.push("");
		const hasItems = dl.length > 0 || handyNotImported.length > 0;
		const hint = hasItems
			? "  ↵ activate/import  x delete  ←→ tabs  ↑↓ navigate  esc close"
			: "  ←→ tabs  esc close";
		lines.push(dim(hint));
		return lines;
	}

	private renderDevice(_w: number, _iw: number): string[] {
		const lines: string[] = [];
		const { device } = this.p;
		const labelW = 14;

		const gpuLabel = device.gpu.hasNvidia
			? (device.gpu.gpuName || "NVIDIA")
			: device.gpu.hasMetal ? "Apple Silicon (Metal)" : "none";

		// Hardware
		lines.push(dim("    ── Hardware ──"));
		const hwRows: [string, string][] = [
			["Platform", `${device.platform} ${device.arch}`],
			["RAM", `${(device.totalRamMB / 1024).toFixed(1)} GB total, ${(device.freeRamMB / 1024).toFixed(1)} GB free`],
			["CPU", `${device.cpuCores} cores — ${device.cpuModel}`],
			["GPU", gpuLabel],
		];
		if (device.gpu.vramMB) hwRows.push(["VRAM", `${device.gpu.vramMB} MB`]);
		if (device.isRaspberryPi) hwRows.push(["Raspberry Pi", device.piModel || "yes"]);
		hwRows.push(["Container", device.isContainer ? "yes" : "no"]);
		hwRows.push(["Locale", device.systemLocale]);

		for (const [label, value] of hwRows) {
			lines.push(`    ${label.padEnd(labelW)}${value}`);
		}

		// Dependencies
		lines.push("");
		lines.push(dim("    ── Dependencies ──"));
		const sherpaOk = this.p.isSherpaAvailable();
		lines.push(`    ${"sherpa-onnx".padEnd(labelW)}${sherpaOk ? green("ready") : green("standby — loads on first recording")}`);

		// Disk space
		const freeSpace = getFreeDiskSpace(getModelsDir());
		const diskLabel = freeSpace !== null ? formatBytes(freeSpace) + " free" : "unknown";
		const diskWarn = freeSpace !== null && freeSpace < 500 * 1024 * 1024; // <500MB
		lines.push(`    ${"Disk space".padEnd(labelW)}${diskWarn ? yellow(diskLabel + " (low)") : diskLabel}`);

		// Downloaded models total
		const downloaded = this.p.getDownloadedModels();
		const totalMB = downloaded.reduce((sum, d) => sum + d.sizeMB, 0);
		lines.push(`    ${"Models".padEnd(labelW)}${downloaded.length} downloaded (${totalMB} MB)`);

		lines.push("");
		lines.push(dim("  ←→ tabs  esc close"));
		return lines;
	}

	// ─── Language sub-picker ──────────────────────────────────────────────

	private renderLangPicker(_w: number, _iw: number): string[] {
		const lines: string[] = [];
		const currentCode = this.p.config.language || "en";

		lines.push(`  ${bold("Select language")}`);
		const cursor = this.langSearch ? this.langSearch : dim("type to filter…");
		lines.push(`  ${dim("Search:")} ${cursor}`);
		lines.push("");

		const maxVisible = 10;
		const total = this.langFiltered.length;
		const start = Math.max(0, Math.min(this.langRow - Math.floor(maxVisible / 2), total - maxVisible));
		const end = Math.min(start + maxVisible, total);

		for (let i = start; i < end; i++) {
			const lang = this.langFiltered[i]!;
			const isSelected = i === this.langRow;
			const isCurrent = lang.code === currentCode;
			const prefix = isSelected ? cyan("  → ") : "    ";
			const text = isSelected ? cyan(`${lang.name} (${lang.code})`) : `${lang.name} (${lang.code})`;
			const check = isCurrent ? green(" ✓") : "";
			lines.push(`${prefix}${text}${check}`);
		}

		if (total === 0) {
			lines.push(dim("    No matching languages"));
		} else if (start > 0 || end < total) {
			lines.push(dim(`    (${this.langRow + 1}/${total})`));
		}

		lines.push("");
		lines.push(dim("  ↵ select  esc back  type to filter"));
		return lines;
	}

	private handleLangInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.sub = "main";
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.langFiltered.length > 0) {
				this.langRow = this.langRow === 0 ? this.langFiltered.length - 1 : this.langRow - 1;
			}
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.langFiltered.length > 0) {
				this.langRow = this.langRow === this.langFiltered.length - 1 ? 0 : this.langRow + 1;
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const lang = this.langFiltered[this.langRow];
			if (lang) {
				this.p.config.language = lang.code;
				this.p.saveConfig(
					this.p.config,
					this.p.config.scope === "project" ? "project" : "global",
					this.p.cwd,
				);
				if (this.p.config.backend === "local") {
					try { this.p.clearRecognizerCache(); } catch {}
				}
			}
			this.sub = "main";
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.langSearch = this.langSearch.slice(0, -1);
			this.filterLangs();
			this.langRow = 0;
			return;
		}
		if (data.length === 1 && data >= " " && data <= "~") {
			this.langSearch += data;
			this.filterLangs();
			this.langRow = 0;
		}
	}

	// ─── Actions ──────────────────────────────────────────────────────────

	private handleSelect(tabId: TabId): void {
		if (tabId === "general") {
			const { config } = this.p;
			switch (this.row) {
				case 0: // Backend toggle
					config.backend = config.backend === "local" ? "deepgram" : "local";
					this.save();
					break;
				case 1: // Model (local) or API Key (deepgram)
					if (config.backend === "local") {
						// Jump to Models tab
						this.tab = 1;
						this.row = 0;
						this.modelSearch = "";
						this.filterModels();
					}
					break;
				case 2: // Language picker
					this.openLangPicker();
					break;
				case 3: // Scope toggle
					config.scope = config.scope === "project" ? "global" : "project";
					this.save();
					break;
				case 4: // Voice toggle
					config.enabled = !config.enabled;
					this.save();
					break;
			}
		} else if (tabId === "models") {
			const model = this.modelFiltered[this.row];
			if (model) {
				this.activateModel(model.id);
				// If not downloaded, close panel and trigger download
				const downloaded = new Set(this.p.getDownloadedModels().map(d => d.id));
				if (!downloaded.has(model.id)) {
					this.onClose?.({ type: "download", modelId: model.id });
					return;
				}
			}
		} else if (tabId === "downloaded") {
			const dl = this.getDownloaded();
			if (this.row < dl.length) {
				// Activate an already-downloaded model
				const item = dl[this.row];
				if (item) this.activateModel(item.id);
			} else {
				// Import from Handy
				const handyNotImported = scanHandyModels().filter(h => !h.imported);
				const handyIdx = this.row - dl.length;
				const h = handyNotImported[handyIdx];
				if (h) {
					const result = importHandyModel(h.handyId);
					if (result.ok) {
						this.activateModel(h.piModelId);
					}
					// Panel will re-render and show the imported model
				}
			}
		}
	}

	private activateModel(modelId: string): void {
		const { config } = this.p;
		if (config.localModel !== modelId) {
			try { this.p.clearRecognizerCache(); } catch {}
		}
		config.localModel = modelId;
		config.backend = "local";
		config.localEndpoint = undefined;
		this.save();
		this.rebuildModels();
	}

	private openLangPicker(): void {
		const { config } = this.p;
		if (config.backend === "local" && config.localModel) {
			const { languages, englishOnly } = getLanguagesForLocalModel(config.localModel);
			if (englishOnly) return; // Single language, nothing to pick
			this.langList = languages;
		} else {
			this.langList = this.p.deepgramLanguages;
		}
		this.langSearch = "";
		this.langFiltered = this.langList;
		this.langRow = 0;
		// Pre-select current language
		const idx = this.langList.findIndex(l => l.code === config.language);
		if (idx >= 0) this.langRow = idx;
		this.sub = "lang-picker";
	}

	private save(): void {
		const { config, cwd } = this.p;
		this.p.saveConfig(config, config.scope === "project" ? "project" : "global", cwd);
	}

	// ─── Helpers ──────────────────────────────────────────────────────────

	private getRowCount(tabId: TabId): number {
		switch (tabId) {
			case "general": return 5;
			case "models": return this.modelFiltered.length;
			case "downloaded": {
				const dl = this.getDownloaded().length;
				const handy = scanHandyModels().filter(h => !h.imported).length;
				return dl + handy;
			}
			case "device": return 0;
		}
	}

	private rebuildModels(): void {
		const fitnessOrder = { recommended: 0, compatible: 1, warning: 2, incompatible: 3 } as const;
		this.modelList = LOCAL_MODELS.map(m => ({
			...m,
			fitness: this.p.getModelFitness(m, this.p.device) as ModelFitness,
		}));
		this.modelList.sort((a, b) => {
			const fd = fitnessOrder[a.fitness] - fitnessOrder[b.fitness];
			return fd !== 0 ? fd : b.sizeBytes - a.sizeBytes;
		});
		this.filterModels();
	}

	private filterModels(): void {
		if (!this.modelSearch) {
			this.modelFiltered = this.modelList;
		} else {
			const q = this.modelSearch.toLowerCase();
			this.modelFiltered = this.modelList.filter(m =>
				`${m.name} ${m.id} ${m.notes} ${m.langSupport}`.toLowerCase().includes(q),
			);
		}
		this.row = Math.min(this.row, Math.max(0, this.modelFiltered.length - 1));
	}

	private filterLangs(): void {
		if (!this.langSearch) {
			this.langFiltered = this.langList;
		} else {
			const q = this.langSearch.toLowerCase();
			this.langFiltered = this.langList.filter(l =>
				`${l.name} ${l.code}`.toLowerCase().includes(q),
			);
		}
		this.langRow = Math.min(this.langRow, Math.max(0, this.langFiltered.length - 1));
	}

	private getDownloaded(): { id: string; name: string; sizeMB: number; isCurrent: boolean }[] {
		const currentId = this.p.config.localModel || "parakeet-v3";
		return this.p.getDownloadedModels().map(d => ({
			...d,
			name: LOCAL_MODELS.find(m => m.id === d.id)?.name || d.id,
			isCurrent: d.id === currentId,
		}));
	}

	private getLangDisplay(): string {
		const code = this.p.config.language || "en";
		// Check all language sources for display name
		const allLangs = [...this.p.deepgramLanguages];
		for (const m of LOCAL_MODELS) {
			const { languages } = getLanguagesForLocalModel(m.id);
			allLangs.push(...languages);
		}
		const entry = allLangs.find(l => l.code === code);
		return entry ? `${entry.name} (${code})` : code;
	}

	/** Compact inline rating: "●●●●○" — shown on every model row */
	private compactRating(value: 1 | 2 | 3 | 4 | 5): string {
		return "●".repeat(value) + dim("○".repeat(5 - value));
	}

	/** Labeled rating bar for expanded detail: "Accuracy ●●●●○" */
	private ratingBar(value: 1 | 2 | 3 | 4 | 5, label: string): string {
		const filled = "●".repeat(value);
		const empty = dim("○".repeat(5 - value));
		return dim(label + " ") + filled + empty;
	}

	private fitnessBadge(f: ModelFitness): string {
		switch (f) {
			case "recommended": return green("[recommended]");
			case "compatible": return cyan("[compatible]");
			case "warning": return yellow("[may be slow]");
			case "incompatible": return red("[too large]");
		}
	}
}
