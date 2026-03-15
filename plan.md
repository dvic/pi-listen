# Fix Plan: All Audit Findings

## Files to modify (in order)

### 1. `extensions/voice/sherpa-engine.ts`
- **P0**: `decode(stream)` → `await recognizer.decodeAsync(stream)`, make `transcribeBuffer` async
- **H1**: Add `language` to cache key: `{ modelId, language, recognizer }`
- **H2**: Strip regional suffix: `language.split("-")[0]` before passing to Whisper/SenseVoice
- **P1**: `pcmToFloat32` use Int16Array typed view instead of readInt16LE loop
- **L7**: Remove dead `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` env var setting (add comment explaining why)
- **H9+M20**: Add early `process.arch === "arm"` check and musl detection in `initSherpa()`

### 2. `extensions/voice/local.ts`
- **H8**: Add `if (session.closed) return;` after each await in `stopLocalSession`
- **H7**: Wrap `transcribeInProcess` in timeout (120s)
- **M19**: Pass AbortSignal through to `ensureModelDownloaded`
- **P2**: Remove `Buffer.from(chunk)` → push `chunk` directly; clear `audioChunks` after concat
- **M2**: Fix tier: whisper-medium → "standard", sensevoice-small → "edge", gigaam-v3 → "edge"

### 3. `extensions/voice/model-download.ts`
- **H4**: Check `resp.status === 200` when `startByte > 0` → switch to overwrite mode
- **M4+L1**: Add backpressure (`drain` event) + remove `Buffer.from(value)` → write `value` directly

### 4. `extensions/voice/device.ts`
- **M10**: Add `/dev/nvidia0` pre-check before spawning `nvidia-smi`
- **L2**: Add 32-bit cgroup sentinels + heuristic (`bytes > hostRamBytes → unlimited`)
- **L4**: Add Podman detection (`/run/.containerenv`)

### 5. `extensions/voice.ts`
- **M15**: Guard `checkLocalServer` calls with `if (config.localEndpoint)` in `/voice test`
- **M17**: Add `clearRecognizerCache()` in `session_switch` handler
- **M18**: Add `clearRecognizerCache()` in `/voice-language` handler
- **H6**: Fix Windows ffmpeg: enumerate dshow devices instead of `audio=default`
