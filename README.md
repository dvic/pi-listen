# pi-listen

<p align="center">
  <img src="assets/banner.png" alt="pi-listen — Voice input for the Pi coding agent" width="100%" />
</p>

**Hold-to-talk voice input for [Pi](https://github.com/mariozechner/pi-coding-agent).**

[![npm version](https://img.shields.io/npm/v/@codexstar/pi-listen.svg)](https://www.npmjs.com/package/@codexstar/pi-listen)
[![npm downloads](https://img.shields.io/npm/dm/@codexstar/pi-listen.svg)](https://www.npmjs.com/package/@codexstar/pi-listen)
[![license](https://img.shields.io/npm/l/@codexstar/pi-listen.svg)](https://github.com/codexstar69/pi-listen/blob/main/LICENSE)

---

## Setup (2 minutes)

### 1. Install the extension

```bash
# In a regular terminal (not inside Pi)
pi install npm:@codexstar/pi-listen
```

### 2. Install SoX (microphone capture)

```bash
brew install sox          # macOS
sudo apt install sox      # Ubuntu/Debian
choco install sox         # Windows
```

### 3. Get a Deepgram API key

Sign up at [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — $200 free credit, no card needed.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # add to ~/.zshrc or ~/.bashrc
```

### 4. Open Pi

If `DEEPGRAM_API_KEY` is set, voice auto-activates with a keybinding guide. Otherwise run `/voice-setup` inside Pi to paste your key interactively.

### Verify everything works

```bash
/voice test    # Inside Pi — checks SoX, mic, and validates API key
```

---

## Usage

### Keybindings

| Action | Key | Notes |
|--------|-----|-------|
| **Record to editor** | Hold `SPACE` (≥1.2s) | Release to finalize. Pre-records during warmup so you don't miss words. |
| **Toggle recording** | `Ctrl+Shift+V` | Works in all terminals — press to start, press again to stop. |
| **Clear editor** | `Escape` × 2 | Double-tap within 500ms to clear all text. |

### How recording works

1. **Hold SPACE** — warmup countdown appears, audio capture starts immediately (pre-recording)
2. **Keep holding** — live transcription streams into the editor as you speak
3. **Release SPACE** — recording continues for 1.5s (tail recording) to catch your last word, then finalizes
4. Text appears in the editor, ready to send

### Commands

| Command | Description |
|---------|-------------|
| `/voice-setup` | Interactive setup wizard (Deepgram key, scope) |
| `/voice test` | Full diagnostics — SoX, mic capture, API key validation |
| `/voice on` / `off` | Enable or disable voice |
| `/voice dictate` | Continuous dictation (no key hold needed) |
| `/voice stop` | Stop active recording or dictation |
| `/voice info` | Show current config and status |
| `/voice history` | Recent transcriptions |
| `/voice` | Toggle on/off |

### Voice commands

Say these during recording — detected and executed automatically:

| Say this | Does this |
|----------|-----------|
| "hey pi, run tests" | Inserts `bun run test` |
| "hey pi, ..." | Sends any message to the agent |
| "undo" / "undo that" | Removes last word |
| "clear" | Clears editor |
| "submit" / "send it" | Submits editor content |
| "new line" | Inserts newline |
| "period" / "comma" / "question mark" | Inserts punctuation |

---

## Features

| Feature | Description |
|---------|-------------|
| **Pre-recording** | Audio capture starts during warmup countdown — you never miss the first word |
| **Tail recording** | Keeps recording 1.5s after release so your last word isn't clipped |
| **Live streaming** | Deepgram Nova 3 WebSocket — interim transcripts appear as you speak |
| **Reactive waveform** | Audio-level-driven animation with fast attack / slow decay |
| **Voice commands** | "hey pi, run tests", "undo", "submit", punctuation shortcuts |
| **Continuous dictation** | `/voice dictate` for long-form input without holding keys |
| **Double-escape clear** | Press Escape twice to clear the editor |
| **Zero-config start** | Auto-activates if `DEEPGRAM_API_KEY` is set — no wizard needed |
| **First-run hint** | Shows setup instructions with Deepgram signup link on first launch |
| **API key validation** | `/voice test` validates your key against the live Deepgram API |
| **Typing cooldown** | Space holds within 400ms of typing are ignored — voice never fires mid-sentence |
| **Sound feedback** | macOS system sounds for start, stop, and error events |
| **Session corruption guard** | Overlapping recording requests abort the stale session first |
| **Cross-platform** | macOS, Windows, Linux — Kitty protocol + non-Kitty fallback |

---

## How It Works

```
Hold SPACE → warmup countdown (pre-recording starts)
                ↓ (≥1.2s)
         SoX captures PCM audio
                ↓
         Streams to Deepgram Nova 3 via WebSocket
                ↓
         Interim transcripts update editor in real time
                ↓
Release SPACE → tail recording (1.5s) → CloseStream → final transcript
```

### Hold detection

**Kitty protocol** (Ghostty, Kitty, WezTerm, Windows Terminal 1.22+):
True key-down/repeat/release events. First press enters warmup immediately. Release stops recording.

**Non-Kitty** (macOS Terminal, older terminals):
Gap-based detection. Counts rapid key-repeat events to confirm hold. Gap in repeats = released.

Both modes: ≥1.2s hold to activate. Quick taps type a normal space.

### Architecture

```
extensions/voice.ts              Main extension — state machine, recording, UI
extensions/voice/config.ts       Config loading, saving, migration
extensions/voice/onboarding.ts   First-run setup wizard
extensions/voice/deepgram.ts     Deepgram URL builder, API key resolver
extensions/voice/text-processing.ts  Voice command detection, punctuation shortcuts
```

---

## Configuration

Settings in Pi's settings files under the `voice` key:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/settings.json` |
| Project | `<project>/.pi/settings.json` |

```json
{
  "voice": {
    "version": 2,
    "enabled": true,
    "language": "en",
    "scope": "global",
    "onboarding": { "completed": true, "schemaVersion": 2 }
  }
}
```

---

## Troubleshooting

Run `/voice test` inside Pi for full diagnostics. It checks SoX, mic capture, and validates your Deepgram API key against the live API.

| Problem | Solution |
|---------|----------|
| "DEEPGRAM_API_KEY not set" | [Get a key](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` in `~/.zshrc` |
| "INVALID KEY" | Check at [console.deepgram.com](https://console.deepgram.com) |
| "SoX error" / "rec not found" | `brew install sox` / `apt install sox` / `choco install sox` |
| Space doesn't activate voice | Run `/voice info` — voice may be disabled or onboarding incomplete |
| Voice triggers in fuzzy search | Typing cooldown should prevent this — try `Ctrl+Shift+V` instead |

See [docs/troubleshooting.md](docs/troubleshooting.md) for more.

---

## Security

- **Cloud STT** — audio is sent to Deepgram for transcription
- **No telemetry** — pi-listen does not collect or transmit usage data
- **API key** — stored in env var or Pi settings, never logged or exposed in errors

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

---

## License

[MIT](LICENSE) © 2026 codexstar69

---

## Links

- **npm:** [npmjs.com/package/@codexstar/pi-listen](https://www.npmjs.com/package/@codexstar/pi-listen)
- **GitHub:** [github.com/codexstar69/pi-listen](https://github.com/codexstar69/pi-listen)
- **Deepgram:** [dpgr.am/pi-voice](https://dpgr.am/pi-voice) ($200 free credit)
- **Pi CLI:** [github.com/mariozechner/pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)
