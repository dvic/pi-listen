import type { VoiceBackend, VoiceStatusLabelStyle } from "./config";

export type VoiceStatusState = "idle" | "warmup" | "recording" | "finalizing";

export interface FormatVoiceStatusInput {
	state: VoiceStatusState;
	enabled: boolean;
	onboardingCompleted: boolean;
	backend?: VoiceBackend;
	style?: VoiceStatusLabelStyle;
	nowMs?: number;
	recordingStartMs?: number;
	audioLevelSmoothed?: number;
}

const DEFAULT_STYLE: VoiceStatusLabelStyle = "icons";

export function formatVoiceStatus(input: FormatVoiceStatusInput): string | undefined {
	if (!input.enabled) return undefined;

	const style = input.style ?? DEFAULT_STYLE;
	const backend = input.backend === "local" ? "local" : "deepgram";

	switch (input.state) {
		case "idle":
			if (!input.onboardingCompleted) return style === "classic" ? "MIC SETUP" : "󰍬 Setup";
			if (style === "classic") return backend === "local" ? "MIC LOCAL" : "MIC STREAM";
			return backend === "local" ? "󰍬 Local" : "󰍬 Cloud";
		case "warmup":
			return style === "classic" ? "MIC HOLD..." : "󱑁 Hold…";
		case "recording": {
			const nowMs = input.nowMs ?? Date.now();
			const recordingStartMs = input.recordingStartMs ?? nowMs;
			const secs = Math.round((nowMs - recordingStartMs) / 1000);
			const meterLen = 4;
			const level = Math.max(0, Math.min(input.audioLevelSmoothed ?? 0, 1));
			const meterFilled = Math.round(level * meterLen);
			const meter = "█".repeat(meterFilled) + "░".repeat(meterLen - meterFilled);
			return style === "classic"
				? `REC ${secs}s ${meter}`
				: ` ${secs}s ${meter}`;
		}
		case "finalizing":
			if (backend !== "local") return "";
			return style === "classic" ? "STT..." : "󰔟 STT…";
	}
}
