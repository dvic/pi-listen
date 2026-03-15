# Plan: Seamless Local Model Setup — Auto-Download, Device Detection, Server Management

## Problem Statement

The local transcription backend requires users to manually:
1. Clone and build whisper.cpp (or another server)
2. Download model files from HuggingFace
3. Start the server on the correct port
4. Know which models fit their device

This makes local mode unusable for most users. We need a seamless "pick a model → it works" experience.

## Research Evidence

### whisper.cpp Binary Distribution (Verified)
- **Pre-built binaries confirmed** on GitHub Releases (v1.7.5+)
- 6 platform zips: `whisper-v{ver}-bin-{platform}-{arch}.zip` (1-10 MB each)
- Platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64, win-arm64
- CUDA variants: linux-x64-cuda-12, win-x64-cuda-12
- Binary name: **`whisper-server`** (inside zip alongside `whisper-cli`)
- Natively supports `/v1/audio/transcriptions` — matches our existing code
- Startup: `whisper-server -m /path/to/model.bin --port 8080 --host 127.0.0.1 -t $(nproc)`
- Need GitHub API (`/repos/ggerganov/whisper.cpp/releases/latest`) to resolve version dynamically

### GGML Model Files (Verified on HuggingFace)
All at `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{filename}` — public, no auth, supports HTTP Range (resume).

| Filename | Actual Size | Our catalog says |  Status |
|----------|------------|-----------------|---------|
| ggml-small.bin | 488 MB | 487 MB | OK |
| ggml-medium.bin | **1.53 GB** | 492 MB | **BUG — must fix** |
| ggml-large-v3.bin | **3.09 GB** | 1.1 GB | **BUG — must fix** |
| ggml-large-v3-turbo.bin | 1.62 GB | 1.6 GB | OK |

### Runtime RAM (from whisper.cpp docs — peak during inference)
Formula: **~1.7x model file size** (weights + KV cache + audio buffer + runtime overhead).

| Model file | File Size | Runtime RAM (CPU) | Source |
|-----------|-----------|-------------------|--------|
| ggml-tiny | 77 MB | ~390 MB | whisper.cpp README |
| ggml-base | 148 MB | ~500 MB | whisper.cpp README |
| ggml-small | 488 MB | ~1.0 GB | whisper.cpp README |
| ggml-medium | 1.53 GB | ~2.6 GB | whisper.cpp README |
| ggml-large | 3.09 GB | ~4.7 GB | whisper.cpp README |

### Best UX Patterns (from Ollama, MacWhisper, LM Studio)
- **Download on first use** — not pre-download (Ollama pattern)
- **Warn but don't block** model selection (Ollama, LM Studio — user override always allowed)
- **Color-code fitness**: green (recommended) / yellow (compatible) / red (incompatible) (LM Studio)
- **Direct HTTP fetch** from HuggingFace — no library needed, Range resume, Content-Length progress
- **Start server on demand, stop when done** — not a permanent system service
- **SHA-256 verification** after download (HuggingFace LFS metadata provides checksums)

### Device Detection in Node.js (Verified)
- `os.totalmem()`: physical RAM — **but reports host RAM in containers** (need cgroup fallback)
- `os.freemem()`: available RAM snapshot — useful for "can I load this now" checks
- `process.arch`: `'arm64'` on RPi 4/5 (64-bit OS) and Apple Silicon, `'x64'` on Intel
- RPi detection: `/proc/device-tree/model` → `"Raspberry Pi 5 Model B Rev 1.0"` (most reliable)
- RPi fallback: `/proc/cpuinfo` → `Hardware: BCM2712` (Pi 5)
- NVIDIA GPU: `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
- Apple Metal: always available on `darwin` + `arm64` (Apple Silicon); unified memory = RAM is VRAM
- Container detection: check `/.dockerenv` or `/proc/1/cgroup` for docker/containerd
- Container RAM limit: `/sys/fs/cgroup/memory.max` (cgroups v2) or `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1)

### Model Fitness Thresholds (evidence-based, from LM Studio/Ollama/GPT4All)
- `peakRAM > 80% totalRAM` → **incompatible** (system will thrash)
- `peakRAM > freeRAM` → **warning** (might work if other apps close)
- `peakRAM = 50-80% totalRAM` → **compatible** (works but tight)
- `peakRAM < 50% totalRAM` → **recommended** (plenty of headroom)

## Architecture Decision: Why whisper.cpp Server

| Option | Pros | Cons |
|--------|------|------|
| **whisper.cpp server** | Pre-built binaries (1-10 MB), all platforms incl. RPi, OpenAI-compatible API, CPU-optimized, CUDA support | Only supports Whisper models |
| faster-whisper-server | Python, good accuracy | Requires Python + pip, heavy install |
| transcribe-rs (Handy) | Supports ALL 20 models (Moonshine, SenseVoice, etc.) | No standalone server binary published |
| ollama-style approach | Familiar UX | Would need to build from scratch |

**Decision**: Auto-manage **whisper.cpp server** for Whisper models (4 models, pre-built binaries). For non-Whisper models (Moonshine, SenseVoice, GigaAM, Parakeet — 16 models), preserve the manual server option and provide setup guidance. This covers the most common case seamlessly while not blocking power users.

## Implementation Plan

### Step 0: Fix Model Catalog Bugs (`extensions/voice/local.ts`)

Fix incorrect sizes discovered during research:
- `whisper-medium`: "492 MB" → "1.53 GB"
- `whisper-large`: "1.1 GB" → "3.09 GB"

Add new fields to `LocalModelInfo`:
```typescript
export interface LocalModelInfo {
  id: string;
  name: string;
  size: string;                    // display size (human-readable)
  sizeBytes: number;               // actual file size in bytes (for download/fitness)
  runtimeRamMB: number;            // peak RAM during inference (~1.7x file size)
  notes: string;
  langSupport: "whisper" | "english-only" | ...;
  tier: "edge" | "standard" | "heavy";  // device class
  autoManaged: boolean;            // true = whisper.cpp auto-download/server; false = manual server
  ggmlFile?: string;               // GGML filename on HuggingFace (whisper models only)
}
```

### Step 1: Device Detection Module (`extensions/voice/device.ts`)

```typescript
export interface DeviceProfile {
  platform: NodeJS.Platform;
  arch: string;
  totalRamMB: number;        // container-aware (cgroup fallback)
  freeRamMB: number;         // current snapshot
  cpuCores: number;
  cpuModel: string;
  isRaspberryPi: boolean;
  piModel?: string;           // "Raspberry Pi 5 Model B" etc.
  gpu: {
    hasNvidia: boolean;
    hasMetal: boolean;        // Apple Silicon (darwin + arm64)
    vramMB?: number;          // NVIDIA only; Apple Silicon = totalRamMB
    gpuName?: string;
  };
  isContainer: boolean;
}

export function detectDevice(): DeviceProfile
export function getModelFitness(model: LocalModelInfo, device: DeviceProfile):
  'recommended' | 'compatible' | 'warning' | 'incompatible'
```

Detection methods:
1. RAM: `os.totalmem()` with cgroup override for containers
2. RPi: `/proc/device-tree/model` → `/proc/cpuinfo` BCM check → arch heuristic
3. NVIDIA: `nvidia-smi` exec with 5s timeout
4. Metal: `process.platform === 'darwin' && process.arch === 'arm64'`
5. Container: `/.dockerenv` file or `/proc/1/cgroup` docker string

### Step 2: Model Download Manager (`extensions/voice/model-download.ts`)

Downloads GGML model files from HuggingFace for auto-managed Whisper models.

```typescript
export async function downloadModel(
  modelId: string,
  onProgress: (downloadedMB: number, totalMB: number) => void,
): Promise<string>  // returns path to downloaded file

export function isModelDownloaded(modelId: string): boolean
export function getModelPath(modelId: string): string | null
export function getModelsDir(): string           // ~/.pi/models/
export function deleteModel(modelId: string): boolean
export function getDownloadedModels(): { id: string; sizeMB: number }[]
```

**Storage**: `~/.pi/models/{ggmlFile}` (e.g., `~/.pi/models/ggml-small.bin`)

**Download flow**:
1. Check if file exists at expected path → return early if complete
2. Check for partial file → resume with `Range: bytes={existing}-` header
3. Stream response to file via `Bun.write()` or Node writable stream
4. Verify file size matches `sizeBytes` from catalog
5. Return path

**Whisper GGML mappings** (from HuggingFace `ggerganov/whisper.cpp`):
| Model ID | GGML filename | Size |
|----------|--------------|------|
| whisper-small | ggml-small.bin | 488 MB |
| whisper-medium | ggml-medium.bin | 1.53 GB |
| whisper-large | ggml-large-v3.bin | 3.09 GB |
| whisper-turbo | ggml-large-v3-turbo.bin | 1.62 GB |

### Step 3: Server Binary Manager (`extensions/voice/server-manager.ts`)

Auto-downloads and manages the whisper.cpp server binary.

```typescript
export async function ensureServerBinary(): Promise<string>
export async function startServer(opts: {
  modelPath: string;
  port: number;
  host?: string;
  threads?: number;
}): Promise<{ process: ChildProcess; port: number }>
export async function stopServer(): Promise<void>
export async function isServerRunning(port: number): Promise<boolean>
export async function waitForServerReady(port: number, timeoutMs?: number): Promise<boolean>
```

**Binary resolution**:
1. Check `~/.pi/bin/whisper-server` (or `.exe` on Windows) → use if exists
2. Fetch latest version from `https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest`
3. Download correct zip for `{platform}-{arch}` (1-10 MB)
4. Extract `whisper-server` binary, `chmod +x`
5. Cache version in `~/.pi/bin/.whisper-server-version`

**Platform mapping**:
| process.platform | process.arch | Zip suffix |
|-----------------|-------------|-----------|
| linux | x64 | linux-x64 |
| linux | arm64 | linux-arm64 |
| darwin | arm64 | macos-arm64 |
| darwin | x64 | macos-x64 |
| win32 | x64 | win-x64 |
| win32 | arm64 | win-arm64 |

**Lifecycle**:
- Start on first transcription attempt (lazy)
- Keep running between transcriptions (model loading is expensive)
- Stop on extension deactivation or backend switch
- Auto-restart on crash (once, then error)
- Thread count: default to `Math.max(1, Math.floor(cpuCores * 0.75))`

### Step 4: Update `local.ts` — Auto-Server Integration

Add `ensureAutoServer()` to transcription flow:

```typescript
// Before transcribing, ensure server is running for auto-managed models
async function ensureAutoServer(config: VoiceConfig): Promise<void> {
  const model = LOCAL_MODELS.find(m => m.id === config.localModel);
  if (!model?.autoManaged) return; // manual server, user's responsibility

  if (await isServerRunning(port)) return; // already running

  const modelPath = getModelPath(model.id);
  if (!modelPath) throw new Error(`Model ${model.id} not downloaded`);

  const binaryPath = await ensureServerBinary();
  await startServer({ modelPath, port, threads });
  await waitForServerReady(port, 30_000);
}
```

Modify `transcribeWithServer()` to call `ensureAutoServer()` before HTTP request.

### Step 5: Update Onboarding Flow (`extensions/voice/onboarding.ts`)

New local setup experience:

1. **Detect device** → `detectDevice()` → show summary ("8 GB RAM, Apple M2, macOS")
2. **Show model list** → sorted by fitness:
   - Recommended models first (green)
   - Compatible models next (yellow)
   - Incompatible at bottom with warning (red) — still selectable
   - Auto-managed models marked with "auto-download" badge
3. **User picks model** →
   - If auto-managed: "Download whisper-small (488 MB)? [Y/n]" → download with progress → auto-start server → test transcription → done
   - If manual: show server setup instructions (whisper.cpp/transcribe-rs/Handy) → wait for server → test connection → done
4. **Confirm** → "Local transcription ready! Using whisper-small"

### Step 6: Add `/voice-models` Command

Model management utility:
- `List downloaded models and disk usage`
- `Download a model (with progress)`
- `Delete cached models`
- `Show device profile and model recommendations`
- `Check server status`

### Step 7: Tests (incremental with each step)

| Test file | What it tests |
|-----------|--------------|
| `tests/device.test.ts` | Mock os.totalmem/cpus, cgroup reads, RPi detection, fitness scoring |
| `tests/model-download.test.ts` | Mock fetch, progress tracking, resume logic, path resolution, cleanup |
| `tests/server-manager.test.ts` | Mock spawn/exec, lifecycle, platform mapping, version resolution |
| `tests/onboarding.test.ts` | Update: filtered model list, auto-download flow, device-aware selection |

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `extensions/voice/local.ts` | **Edit** | Fix whisper-medium/large sizes; add sizeBytes, runtimeRamMB, tier, autoManaged, ggmlFile to LocalModelInfo; add ensureAutoServer() |
| `extensions/voice/device.ts` | **New** | Device detection (RAM, CPU, GPU, RPi, container) + model fitness scoring |
| `extensions/voice/model-download.ts` | **New** | GGML model download from HuggingFace with progress + resume |
| `extensions/voice/server-manager.ts` | **New** | whisper.cpp binary download + server process management |
| `extensions/voice/onboarding.ts` | **Edit** | Device-aware model list, auto-download flow, fitness indicators |
| `extensions/voice.ts` | **Edit** | Hook server lifecycle into extension activate/deactivate |
| `tests/device.test.ts` | **New** | Device detection tests |
| `tests/model-download.test.ts` | **New** | Download manager tests |
| `tests/server-manager.test.ts` | **New** | Server lifecycle tests |
| `tests/onboarding.test.ts` | **Edit** | Update for device-aware onboarding |

## Execution Order

1. **Step 0** (fix catalog bugs) — immediate, no dependencies
2. **Step 1** (device.ts) — foundational, no dependencies
3. **Step 2** (model-download.ts) — foundational, no dependencies
4. **Step 3** (server-manager.ts) — depends on step 2 for model paths
5. **Step 4** (local.ts auto-server) — depends on steps 2+3
6. **Step 5** (onboarding updates) — depends on steps 1-4
7. **Step 6** (/voice-models command) — depends on steps 1+2
8. **Step 7** (tests) — done incrementally with each step

Steps 1 and 2 can be done in parallel. Steps 0 and 1 can also be parallel.
