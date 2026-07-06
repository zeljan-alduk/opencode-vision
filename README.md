# opencode-vision

Give any opencode model **vision** — even models with no native image support.

`opencode-vision` is an opencode plugin that bridges non-vision LLMs to "see" images by combining two layers:

1. **Apple Vision** (OCR, barcodes, faces, classification) — exact text with pixel-accurate bounding boxes
2. **Local VLM** (LM Studio) — semantic description: colors, icons, charts, layout, element inventory, context

The plugin **auto-detects hardware** and recommends the best vision model for your machine. It can **auto-download** the model and **auto-load** it when needed. If LM Studio or a vision model isn't available, it gracefully falls back to Apple Vision OCR only.

All processing is local and offline. No API keys, no cloud, no per-token costs.

## How it works

```
you (paste image path) → opencode (any model) → calls vlm_describe
                                              ↓
                    ┌─────────────────────────────────────────────┐
                    │  LAYER 1: Apple Vision (instant, ~1s)       │
                    │  - exact text + pixel bounding boxes        │
                    │  - barcodes, faces, classification          │
                    ├─────────────────────────────────────────────┤
                    │  LAYER 2: Local VLM via LM Studio (~5-15s)  │
                    │  - colors (hex), icons, graphics            │
                    │  - element inventory with coords + sizes    │
                    │  - layout hierarchy, interactive elements   │
                    │  - app context, user intent                 │
                    └─────────────────────────────────────────────┘
                                              ↓
                    merged report → model reads it, "sees" the image
```

The model itself never needs vision capability. It just reads the structured text the tools return — same way it reads `read` tool output. This works with **every** opencode model: local GGUF models, OpenRouter, Anthropic, OpenAI, etc.

## Install

### Option A: From npm (recommended)

Once published to npm:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-vision"]
}
```

### Option B: From local clone (development / pre-release)

```bash
git clone https://github.com/zeljan-alduk/opencode-vision.git ~/projects/opencode-vision
cd ~/projects/opencode-vision && npm install
```

Then in your `opencode.json` (global: `~/.config/opencode/opencode.json`, or project: `opencode.json`), point the plugin at the absolute path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-vision"]
}
```

> Replace `/absolute/path/to/opencode-vision` with the actual clone path (e.g. `/Users/you/projects/opencode-vision`).

### What happens on next restart

opencode:
1. Loads the plugin (via bun — `npm install` in the plugin dir if needed)
2. Auto-registers `macos-vision-mcp` as an MCP server (unless `OPENCODE_VISION_SKIP_MCP=1`)
3. Exposes 4 tools to every model (see below)
4. On first use of `vlm_describe`: auto-detects hardware, checks LM Studio, auto-loads a vision model if available

> **macOS 13.0+ required for OCR.** The Apple Vision layer uses the Vision framework (same engine as Live Text in Photos.app). Linux/Windows users can still use `vlm_describe` with a remote VLM endpoint by setting `OPENCODE_VISION_LMSTUDIO_URL`.

## Tools

| Tool | Source | What it does |
|------|--------|--------------|
| `ocr_image` | macos-vision-mcp (auto-registered MCP) | Extract text from an image/PDF. Arg: `path`. Returns paragraphs in reading order + bounding boxes. |
| `analyze_document` | macos-vision-mcp | Full pipeline: OCR + faces + barcodes + rectangles in one call. |
| `detect_barcodes` | macos-vision-mcp | Read QR/EAN/UPC/Code128/PDF417/Aztec codes. |
| `classify_image` | macos-vision-mcp | Classify image content into 1000+ categories. |
| `adb_vision` | this plugin | Capture a screenshot from an Android emulator/device. Returns a path — chain with `vlm_describe` or `ocr_image`. Args: `device?`, `output?`. |
| `vision_setup` | this plugin | Check hardware, LM Studio, and vision model availability. Can auto-download the recommended model and auto-load it. Args: `action` = `status` \| `download` \| `install-lmstudio`. |
| `vlm_describe` | this plugin | **Full-detail image analysis.** Runs Apple Vision OCR + local VLM in parallel, merges into a structured report with: element inventory (type, text, position, size, color, state), layout, color palette, graphics, interactive elements, app context, and timing. |

## Usage

### First-time setup (one command)

```
Use vision_setup with action='status' to check what's available.
```

This returns your hardware profile, whether LM Studio is installed/running, and what vision models are available. If a model needs downloading:

```
Use vision_setup with action='download' to get the recommended vision model.
```

The plugin auto-detects your RAM and recommends the best model:

| RAM | Model | Quant | Size | Why |
|-----|-------|-------|------|-----|
| 32 GB+ | Qwen2.5-VL-7B-Instruct | Q4_K_M | ~6 GB | Best quality for OCR, charts, icons, documents. Plenty of headroom. |
| 16 GB | Qwen2.5-VL-7B-Instruct | Q3_K_L | ~4.5 GB | Fits with headroom. Good quality on UI/screenshots. |
| 8 GB | Qwen2.5-VL-3B-Instruct | Q4_K_M | ~2.5 GB | Safe pick. Great on text, decent on icons. |
| < 8 GB | (none) | — | — | Below minimum. Apple Vision OCR only. |

### Read an image with full detail

```
Use vlm_describe on /tmp/screenshot.png and tell me what you see.
```

This runs **both layers** and returns a merged report:
- **Apple Vision OCR**: exact text with pixel-accurate bounding boxes, barcodes, classification
- **VLM semantic description**: full element inventory with coordinates, sizes, hex colors, icons, graphics, layout hierarchy, interactive elements, app context
- **Timing**: how long each layer took

### Capture and analyze an Android screen

```
Use adb_vision to capture the emulator screen, then vlm_describe on the returned path.
```

`adb_vision` returns a JSON with a `path` field. The model then calls `vlm_describe` with that path. Two-step, but the model handles the chaining automatically.

### Quick text extraction only (no VLM)

```
Use ocr_image on /tmp/receipt.png
```

Uses Apple Vision only — instant, precise text. Use this when you just need text, not semantic understanding.

## What the VLM describes

The `vlm_describe` tool asks the vision model for a structured, exhaustive analysis:

1. **SCREEN_TYPE** — what kind of screen (config form, login, list, dialog, dashboard, photo, chart, document)
2. **ELEMENTS** — every visible element with: type (button, text field, label, icon, image, checkbox, etc.), exact text, position `(x, y)` in pixels, size `width x height`, background/text/border color (hex), state (enabled, disabled, focused, error), and notes
3. **LAYOUT** — spatial structure, grouping, hierarchy, margins, header/body/footer zones, multi-column
4. **COLORS** — full palette with hex codes
5. **TEXT** — all text verbatim in reading order with relative font size
6. **GRAPHICS** — icons, logos, images — shape, color, what they depict
7. **INTERACTIVE** — which elements are tappable and what they'd do
8. **CONTEXT** — what app/screen, user goal, UI state

## Example output

Tested on an Android emulator screenshot of the SweePayPOS configuration screen:

**Timing:**
- Apple Vision OCR: ~1s
- VLM description (Qwen2.5-VL-7B): ~12s
- Total: ~13s

**VLM detected** (things OCR alone couldn't see):
- Purple header with SweePay logo on the left
- Info icon (circle with 'i') on the right
- QR code icon next to CONFIGURATION title
- Cancel button has red text and red border
- Confirm button has blue border
- API URL field has a dotted border (editable)
- Layout: header / config fields / action buttons zones

**OCR detected** (precise, structured):
- All text verbatim with bounding boxes
- Field values: `300`, `40`, `https://sweepay-services.ch/sweepay-pos-test/v1`
- Reading-order paragraphs

## LM Studio setup (manual, if auto-setup isn't used)

1. **Install LM Studio** — download from [lmstudio.ai](https://lmstudio.ai) or `brew install --cask lm-studio`
2. **Download a vision model** — search for `Qwen2.5-VL-7B-Instruct` in the LM Studio catalog, or use `vision_setup action='download'`
3. **Start the local server** — in LM Studio, go to the "Local Server" tab and start it (default: `http://localhost:1234/v1`)
4. **Load the vision model** — or let the plugin auto-load it on first `vlm_describe` call

If LM Studio isn't running, `vlm_describe` returns Apple Vision OCR only with a note. The plugin always works, with or without a VLM.

### Recommended LM Studio models

| Model | RAM | Good for |
|-------|-----|----------|
| Qwen2.5-VL-7B-Instruct (Q4_K_M) | ~6 GB | Best balance. Strong on UI, charts, icons, documents, OCR. |
| Qwen2.5-VL-3B-Instruct (Q4_K_M) | ~2.5 GB | Low resource. Great on text, decent on icons. |
| LLaVA-1.5-7B (Q4) | ~5 GB | Alternative. Good on photos. |
| MiniCPM-V-2.6 (Q4) | ~3 GB | Strong on OCR + description hybrid. |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_VISION_SKIP_MCP` | unset | Set to `1` to skip auto-registering macos-vision-mcp. |
| `OPENCODE_VISION_LMSTUDIO_URL` | `http://localhost:1234/v1` | LM Studio OpenAI-compatible endpoint. |
| `OPENCODE_VISION_LMSTUDIO_TIMEOUT_MS` | `120000` | Timeout for VLM calls (2 min default — large images take time). |

## Prerequisites

- **opencode** — [opencode.ai](https://opencode.ai)
- **macOS 13.0+** — for Apple Vision framework (OCR core)
- **Node.js 22+** — for the plugin and MCP server
- **ADB** (optional) — for `adb_vision` tool. Install via `brew install --cask android-platform-tools` or Android Studio.
- **LM Studio** (optional) — for `vlm_describe` semantic vision. Auto-installed via `vision_setup action='install-lmstudio'` on macOS.

## Verify it works

After install + restart:

```bash
# Check macos-vision-mcp works standalone
npx -y macos-vision-mcp <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

You should see: `ocr_image`, `detect_faces`, `detect_barcodes`, `detect_document`, `classify_image`, `analyze_document`.

Then in an opencode session:

```
Use vision_setup with action='status'
```

This returns your hardware profile and what's available.

## Project structure

```
opencode-vision/
├── src/
│   └── index.ts        # Plugin entry — 4 tools + hardware detection + auto-setup
├── package.json
├── tsconfig.json
└── README.md
```

The plugin auto-registers `macos-vision-mcp` (the OCR core) and adds:
- Hardware-aware model recommendation
- LM Studio auto-detect / auto-install / auto-load
- Combined Apple Vision + VLM analysis with timing

## Acknowledgements

- [`woladi/macos-vision-mcp`](https://github.com/woladi/macos-vision-mcp) — the Apple Vision MCP server that this plugin auto-registers. Does the OCR heavy lifting.
- [`ihugang/ocrtool-mcp`](https://github.com/ihugang/ocrtool-mcp) — alternative Swift-native Vision MCP server.
- [Qwen2.5-VL](https://github.com/QwenLM/Qwen2.5-VL) — the vision model recommended for semantic analysis.

## License

MIT
