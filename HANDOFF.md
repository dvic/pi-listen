# Handoff

## 2026-03-26 22:02 IST

- Most recent work: implemented the env-derived Deepgram key persistence fix
  and verified it with tests and typecheck.
- User prompts:
  - "impliment it"
- Changes made:
  - Removed the `session_start` code path in `extensions/voice.ts` that copied
    `process.env.DEEPGRAM_API_KEY` into config and saved it to global settings.
  - Added `getSessionStartPersistedConfig()` in `extensions/voice/config.ts`
    so startup-triggered saves keep stored keys but strip env-only keys.
  - Added regression tests in `tests/config.test.ts` for env-only vs stored-key
    startup persistence.
  - Bumped package version to `5.0.5` and added a changelog entry.
- Verification performed:
  - `bun test tests/config.test.ts` passed
  - `bun test tests/onboarding.test.ts` passed
  - `pnpm typecheck` passed
  - `bun test` passed: 79 tests, 0 failures

## 2026-03-26 21:55 IST

- Most recent work: wrote and reviewed an ExecPlan for fixing the
  env-derived Deepgram key persistence bug.
- User prompts:
  - "but the env can be added directly when using pi and so it saves it in
    env.secrets - how would be a better implimentation?"
  - "build a implimentation plan and cross review it"
- Artifacts:
  - Plan saved to
    `docs/superpowers/plans/2026-03-26-deepgram-env-runtime-only.md`
- Review conclusion:
  - Preferred implementation is the smallest fix: remove the
    `session_start` env-to-config mutation in `extensions/voice.ts`.
  - A helper should stay optional and only be added if needed for testing or
    clarity.
  - Explicit onboarding saves to `~/.env.secrets` / `~/.zshrc` should remain.

## 2026-03-26 21:40 IST

- Most recent work: verified the reported `DEEPGRAM_API_KEY` persistence bug in
  `pi-listen` without changing runtime code.
- User prompts:
  - "Summary ... Suggested fix ... - is it true?"
- Verification performed:
  - Read `extensions/voice.ts` startup flow and confirmed env-derived
    `DEEPGRAM_API_KEY` is copied into config, then saved to global settings when
    `configSource === "global"` at lines 1807-1810.
  - Read the onboarding auto-activation path and confirmed first-run/default
    startup also persists config through `saveConfig(...)` at line 1828 when a
    Deepgram key is present via env.
  - Read `extensions/voice/config.ts` and confirmed serialization only strips
    `deepgramApiKey` for project scope; global saves keep the key.
  - Read `extensions/voice/deepgram.ts` and confirmed runtime resolution already
    prefers `process.env.DEEPGRAM_API_KEY` before stored config.
  - Read changelog and tests confirming 5.0.1 fixed only project-scope leakage,
    not global-scope persistence.
- Conclusion:
  - The report is true in substance.
  - The env-derived Deepgram key is still persisted into
    `~/.pi/agent/settings.json`.
  - The likely-cause note is slightly incomplete because there are two write
    paths: direct global save on `session_start` for global config sources, and
    onboarding migration save on first-run/default startup.

## 2026-03-18 23:59 IST

- Most recent work: full bug audit of the `pi-voice` codebase with code
  evidence, test evidence, and official documentation checks, followed by fixes
  for the confirmed runtime issues.
- User prompts:
  - "I want you to audit entire code for bugs and possible errors"
  - "I want you to audit entire code for bugs and possible errors verify with
    evidence and official documentations"
- Verification performed:
  - `bun test --run tests/sherpa-engine.test.ts` passed after adding the
    regression for odd-offset PCM buffers
  - `bun test --run` passed: 77 tests, 0 failures
  - `bun run typecheck` failed in this environment because Bun reported its
    postinstall script was not run; this looked like a local toolchain issue,
    not a repo type error proven from source
  - Local repros run for:
    - Node WebSocket upgrade request headers
    - TypedArray misalignment crash (`Int16Array` with odd `byteOffset`)
- Main fixes applied:
  - Deepgram stop now waits for socket close or a short finalize timeout after
    `CloseStream`
  - Deepgram streaming errors now go through a single close-and-report path
  - `pcmToFloat32()` now handles odd `Buffer.byteOffset` values safely
  - `package.json` version bumped to `5.0.4`
  - `CHANGELOG.md` updated with the patch release entry
- Useful references gathered:
  - Deepgram finalize docs
  - Deepgram CloseStream docs
  - WHATWG WebSocket spec on `error` then `close`
  - Node Buffer docs
  - TypedArray docs for byte-offset alignment
