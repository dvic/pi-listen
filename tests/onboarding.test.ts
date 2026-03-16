import { describe, expect, test } from "bun:test";
import { finalizeOnboardingConfig, shellEscapeSingleQuoted } from "../extensions/voice/onboarding";
import { DEFAULT_CONFIG } from "../extensions/voice/config";

describe("finalizeOnboardingConfig", () => {
	test("marks onboarding complete only after validation succeeds", () => {
		const updated = finalizeOnboardingConfig(DEFAULT_CONFIG, { validated: true, source: "setup-command" });

		expect(updated.onboarding.completed).toBe(true);
		expect(updated.onboarding.source).toBe("setup-command");
		expect(updated.onboarding.completedAt).toBeString();
		expect(updated.onboarding.lastValidatedAt).toBeString();
	});

	test("keeps onboarding incomplete when validation is still pending", () => {
		const updated = finalizeOnboardingConfig(DEFAULT_CONFIG, { validated: false, source: "first-run" });

		expect(updated.onboarding.completed).toBe(false);
		expect(updated.onboarding.source).toBe("repair");
		expect(updated.onboarding.completedAt).toBeUndefined();
	});
});

describe("shellEscapeSingleQuoted", () => {
	test("leaves plain alphanumeric strings unchanged", () => {
		expect(shellEscapeSingleQuoted("abc123def456")).toBe("abc123def456");
	});

	test("escapes single quotes", () => {
		expect(shellEscapeSingleQuoted("it's")).toBe(`it'"'"'s`);
	});

	test("handles strings with dollar signs (no change needed in single quotes)", () => {
		expect(shellEscapeSingleQuoted("key$var")).toBe("key$var");
	});

	test("handles strings with backticks (no change needed in single quotes)", () => {
		expect(shellEscapeSingleQuoted("key`cmd`")).toBe("key`cmd`");
	});

	test("handles strings with double quotes (no change needed in single quotes)", () => {
		expect(shellEscapeSingleQuoted('key"value')).toBe('key"value');
	});

	test("handles empty string", () => {
		expect(shellEscapeSingleQuoted("")).toBe("");
	});
});
