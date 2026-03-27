import { describe, expect, test } from "bun:test";
import { formatVoiceStatus } from "../extensions/voice/status-labels";

describe("formatVoiceStatus", () => {
	test("renders icon labels by default", () => {
		expect(formatVoiceStatus({
			state: "idle",
			enabled: true,
			onboardingCompleted: true,
			backend: "deepgram",
			style: "icons",
		})).toBe("󰍬 Cloud");
	});

	test("renders setup, warmup, recording, and finalizing icon labels", () => {
		expect(formatVoiceStatus({
			state: "idle",
			enabled: true,
			onboardingCompleted: false,
			backend: "deepgram",
			style: "icons",
		})).toBe("󰍬 Setup");

		expect(formatVoiceStatus({
			state: "warmup",
			enabled: true,
			onboardingCompleted: true,
			backend: "deepgram",
			style: "icons",
		})).toBe("󱑁 Hold…");

		expect(formatVoiceStatus({
			state: "recording",
			enabled: true,
			onboardingCompleted: true,
			backend: "deepgram",
			style: "icons",
			nowMs: 6100,
			recordingStartMs: 1000,
			audioLevelSmoothed: 0.5,
		})).toBe(" 5s ██░░");

		expect(formatVoiceStatus({
			state: "finalizing",
			enabled: true,
			onboardingCompleted: true,
			backend: "local",
			style: "icons",
		})).toBe("󰔟 STT…");
	});

	test("preserves classic labels when configured", () => {
		expect(formatVoiceStatus({
			state: "idle",
			enabled: true,
			onboardingCompleted: true,
			backend: "local",
			style: "classic",
		})).toBe("MIC LOCAL");

		expect(formatVoiceStatus({
			state: "warmup",
			enabled: true,
			onboardingCompleted: true,
			backend: "deepgram",
			style: "classic",
		})).toBe("MIC HOLD...");
	});

	test("hides status when disabled or deepgram is finalizing", () => {
		expect(formatVoiceStatus({
			state: "idle",
			enabled: false,
			onboardingCompleted: true,
			backend: "deepgram",
			style: "icons",
		})).toBeUndefined();

		expect(formatVoiceStatus({
			state: "finalizing",
			enabled: true,
			onboardingCompleted: true,
			backend: "deepgram",
			style: "icons",
		})).toBe("");
	});
});
