/**
 * sherpa-onnx in-process transcription engine.
 *
 * Provides zero-config local STT by loading ONNX models directly
 * into the extension process via sherpa-onnx-node (N-API bindings).
 *
 * Supports: Whisper, Moonshine v1/v2, SenseVoice, GigaAM, Parakeet
 *
 * Recognizer instances are cached and reused (model loading is expensive).
 * Destroyed on: model change, language change, extension deactivation.
 *
 * API verified against:
 *   https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
 *   - acceptWaveform({sampleRate, samples}) — object parameter
 *   - Config requires featConfig: {sampleRate: 16000, featureDim: 80}
 *   - Moonshine v2: {encoder, mergedDecoder} (2 files)
 *   - Moonshine v1: {preprocessor, encoder, uncachedDecoder, cachedDecoder} (4 files)
 *   - SenseVoice: useInverseTextNormalization is 1/0, not true/false
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { LocalModelInfo } from "./local";

// ─── Types ───────────────────────────────────────────────────────────────────

/** sherpa-onnx recognizer — opaque handle from the native module */
type SherpaRecognizer = any;

/** sherpa-onnx module — dynamically imported */
let sherpaModule: any = null;
let sherpaInitialized = false;
let sherpaError: string | null = null;

/** Cached recognizer for the currently loaded model + language */
let cachedRecognizer: { modelId: string; language: string; recognizer: SherpaRecognizer } | null = null;

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the sherpa-onnx module.
 * Must be called once before any transcription.
 *
 * Checks platform compatibility (ARM32, musl) then loads
 * the sherpa-onnx-node module.
 *
 * Returns true if initialization succeeded.
 */
export async function initSherpa(): Promise<boolean> {
	if (sherpaInitialized) return !sherpaError;
	if (sherpaError) return false;

	try {
		// Early platform checks — fail fast with clear messages
		if (process.arch === "arm") {
			throw new Error("ARM32 (armv7l) is not supported by sherpa-onnx-node. Use 64-bit OS or the Deepgram cloud backend.");
		}
		if (process.platform === "linux") {
			try {
				const ldd = fs.readFileSync("/usr/bin/ldd", "utf-8");
				if (ldd.includes("musl")) {
					throw new Error("Alpine Linux (musl libc) is not supported by sherpa-onnx-node. Use a glibc-based distribution or the Deepgram cloud backend.");
				}
			} catch (e: any) {
				if (e?.message?.includes("musl")) throw e;
				// /usr/bin/ldd not readable — not Alpine, continue
			}
		}

		// Note: LD_LIBRARY_PATH/DYLD_LIBRARY_PATH set at runtime have no effect on dlopen().
		// The native .node binary uses $ORIGIN/@loader_path to find sibling .so/.dylib files,
		// so library resolution works without env var manipulation.

		sherpaModule = await import("sherpa-onnx-node");
		sherpaInitialized = true;
		return true;
	} catch (err: any) {
		sherpaError = err?.message || String(err);
		sherpaInitialized = true;
		return false;
	}
}

/** Get the sherpa initialization error, if any. */
export function getSherpaError(): string | null {
	return sherpaError;
}

/** Check if sherpa-onnx is available. */
export function isSherpaAvailable(): boolean {
	return sherpaInitialized && !sherpaError && sherpaModule != null;
}

// ─── Recognizer management ──────────────────────────────────────────────────

/**
 * Get or create a recognizer for a model.
 * Returns a cached instance if the model hasn't changed.
 */
export function getOrCreateRecognizer(model: LocalModelInfo, modelDir: string, language: string): SherpaRecognizer {
	if (!sherpaModule) throw new Error("sherpa-onnx not initialized. Call initSherpa() first.");

	// Strip regional suffix for local models (e.g. "pt-BR" → "pt")
	const baseLang = language.split("-")[0] || language;

	if (cachedRecognizer && cachedRecognizer.modelId === model.id && cachedRecognizer.language === baseLang) {
		return cachedRecognizer.recognizer;
	}

	// Destroy previous recognizer
	clearRecognizerCache();

	const recognizer = createRecognizer(model, modelDir, baseLang);
	cachedRecognizer = { modelId: model.id, language: baseLang, recognizer };
	return recognizer;
}

/** Destroy cached recognizer and free memory. */
export function clearRecognizerCache(): void {
	if (cachedRecognizer) {
		// sherpa-onnx-node recognizers are garbage-collected via N-API Release
		// No explicit free/delete method exists in the Node.js API
		cachedRecognizer = null;
	}
}

// ─── Transcription ───────────────────────────────────────────────────────────

/**
 * Transcribe PCM audio buffer using a sherpa recognizer.
 *
 * @param pcmData - Raw 16-bit signed LE PCM at 16kHz mono
 * @param recognizer - sherpa OfflineRecognizer instance
 * @returns Transcribed text
 */
export async function transcribeBuffer(pcmData: Buffer, recognizer: SherpaRecognizer): Promise<string> {
	if (!sherpaModule) throw new Error("sherpa-onnx not initialized");

	// Convert 16-bit PCM to Float32Array (sherpa expects float samples in [-1, 1])
	const samples = pcmToFloat32(pcmData);

	// Create a stream, accept waveform, decode asynchronously
	// API: stream.acceptWaveform({sampleRate, samples}) — verified from official examples
	// decodeAsync runs inference on ONNX Runtime's background thread pool (N-API AsyncWorker),
	// keeping the event loop free for UI updates during the 5-15s decode
	const stream = recognizer.createStream();
	stream.acceptWaveform({ sampleRate: 16000, samples });
	await recognizer.decodeAsync(stream);

	const result = recognizer.getResult(stream);
	return (result?.text || "").trim();
}

// ─── Internal: Recognizer creation per model type ────────────────────────────

function createRecognizer(model: LocalModelInfo, modelDir: string, language: string): SherpaRecognizer {
	const modelType = model.sherpaModel?.type;

	switch (modelType) {
		case "whisper":
			return createWhisperRecognizer(model, modelDir, language);
		case "moonshine":
			return createMoonshineRecognizer(model, modelDir);
		case "sense_voice":
			return createSenseVoiceRecognizer(model, modelDir, language);
		case "nemo_ctc":
			return createNemoCtcRecognizer(model, modelDir);
		case "transducer":
			return createTransducerRecognizer(model, modelDir);
		default:
			throw new Error(`Unknown sherpa model type: ${modelType} for model ${model.id}`);
	}
}

// Verified against: nodejs-addon-examples/test_asr_non_streaming_whisper.js
function createWhisperRecognizer(model: LocalModelInfo, modelDir: string, language: string): SherpaRecognizer {
	const files = model.sherpaModel!.files;
	return new sherpaModule.OfflineRecognizer({
		featConfig: {
			sampleRate: 16000,
			featureDim: 80,
		},
		modelConfig: {
			whisper: {
				encoder: path.join(modelDir, files.encoder!),
				decoder: path.join(modelDir, files.decoder!),
				language: language || "en",
				task: "transcribe",
			},
			tokens: path.join(modelDir, files.tokens!),
			numThreads: getNumThreads(),
			provider: "cpu",
		},
	});
}

// Verified against: nodejs-addon-examples/test_asr_non_streaming_moonshine_v2.js
// Moonshine v2: {encoder, mergedDecoder} — 2 files
// Moonshine v1: {preprocessor, encoder, uncachedDecoder, cachedDecoder} — 4 files
function createMoonshineRecognizer(model: LocalModelInfo, modelDir: string): SherpaRecognizer {
	const files = model.sherpaModel!.files;

	// Detect v1 vs v2 by presence of mergedDecoder field
	const moonshineConfig: Record<string, string> = {};

	if (files.mergedDecoder) {
		// Moonshine v2: encoder + mergedDecoder
		moonshineConfig.encoder = path.join(modelDir, files.encoder!);
		moonshineConfig.mergedDecoder = path.join(modelDir, files.mergedDecoder!);
	} else {
		// Moonshine v1: preprocessor + encoder + uncachedDecoder + cachedDecoder
		moonshineConfig.preprocessor = path.join(modelDir, files.preprocessor!);
		moonshineConfig.encoder = path.join(modelDir, files.encoder!);
		moonshineConfig.uncachedDecoder = path.join(modelDir, files.uncachedDecoder!);
		moonshineConfig.cachedDecoder = path.join(modelDir, files.cachedDecoder!);
	}

	return new sherpaModule.OfflineRecognizer({
		featConfig: {
			sampleRate: 16000,
			featureDim: 80,
		},
		modelConfig: {
			moonshine: moonshineConfig,
			tokens: path.join(modelDir, files.tokens!),
			numThreads: getNumThreads(),
			provider: "cpu",
		},
	});
}

// Verified against: nodejs-addon-examples/test_asr_non_streaming_sense_voice.js
function createSenseVoiceRecognizer(model: LocalModelInfo, modelDir: string, language: string): SherpaRecognizer {
	const files = model.sherpaModel!.files;
	return new sherpaModule.OfflineRecognizer({
		featConfig: {
			sampleRate: 16000,
			featureDim: 80,
		},
		modelConfig: {
			senseVoice: {
				model: path.join(modelDir, files.model!),
				language: language || "auto",
				useInverseTextNormalization: 1,
			},
			tokens: path.join(modelDir, files.tokens!),
			numThreads: getNumThreads(),
			provider: "cpu",
		},
	});
}

// Verified against: nodejs-addon-examples/test_asr_non_streaming_nemo_ctc.js
function createNemoCtcRecognizer(model: LocalModelInfo, modelDir: string): SherpaRecognizer {
	const files = model.sherpaModel!.files;
	return new sherpaModule.OfflineRecognizer({
		featConfig: {
			sampleRate: 16000,
			featureDim: 80,
		},
		modelConfig: {
			nemoCtc: {
				model: path.join(modelDir, files.model!),
			},
			tokens: path.join(modelDir, files.tokens!),
			numThreads: getNumThreads(),
			provider: "cpu",
		},
	});
}

// Verified against: nodejs-addon-examples/test_asr_non_streaming_transducer.js
function createTransducerRecognizer(model: LocalModelInfo, modelDir: string): SherpaRecognizer {
	const files = model.sherpaModel!.files;
	return new sherpaModule.OfflineRecognizer({
		featConfig: {
			sampleRate: 16000,
			featureDim: 80,
		},
		modelConfig: {
			transducer: {
				encoder: path.join(modelDir, files.encoder!),
				decoder: path.join(modelDir, files.decoder!),
				joiner: path.join(modelDir, files.joiner!),
			},
			tokens: path.join(modelDir, files.tokens!),
			numThreads: getNumThreads(),
			provider: "cpu",
		},
	});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert 16-bit signed LE PCM buffer to Float32Array.
 * Uses Int16Array typed view for ~5-10x speedup over per-sample readInt16LE.
 * Safe on all sherpa-onnx platforms (x86/ARM LE). Respects Buffer.byteOffset for pooled buffers.
 */
function pcmToFloat32(pcm: Buffer): Float32Array {
	const numSamples = pcm.length / 2;
	const float32 = new Float32Array(numSamples);
	const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, numSamples);
	for (let i = 0; i < numSamples; i++) {
		float32[i] = int16[i]! / 32768.0;
	}
	return float32;
}

/** Get optimal thread count for inference (leave 1-2 cores free). */
function getNumThreads(): number {
	const cpus = os.cpus().length || 2;
	if (cpus <= 2) return 1;
	if (cpus <= 4) return 2;
	return Math.min(4, cpus - 2);
}

