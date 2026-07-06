# opencode-vision

Give any opencode model **vision** — even models with no native image support.

`opencode-vision` is an opencode plugin that bridges non-vision LLMs to "see" images via:
- **Apple Vision framework** (OCR, barcodes, faces, classification) — via [`macos-vision-mcp`](https://github.com/woladi/macos-vision-mcp), auto-registered
- **Android ADB screenshots** — capture a screen from any emulator/device, then OCR it
- **Optional local VLM** (LM Studio) — semantic description of icons, charts, photos that OCR can't see

All processing is local and offline. No API keys, no cloud, no per-token costs.

## How it works

```
you (paste image path) → opencode (any model) → calls ocr_image / adb_vision / vlm_describe
                                              ↓
                              Apple Vision extracts text + structure (instant)
                              LM Studio VLM adds semantic description (optional)
                                              ↓
                              model reads rich text output, "sees" the image
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
3. Fetches `macos-vision-mcp` on first call via `npx -y macos-vision-mcp` (cached after)
4. Exposes the tools below to every model

> **macOS only for OCR.** The OCR core uses Apple's Vision framework (same engine as Live Text in Photos.app). Linux/Windows users can still use `vlm_describe` with a remote VLM endpoint by setting `OPENCODE_VISION_LMSTUDIO_URL`.

## Tools

| Tool | Source | What it does |
|------|--------|--------------|
| `ocr_image` | macos-vision-mcp | Extract text from an image/PDF. Arg: `path`. Returns paragraphs in reading order + bounding boxes. |
| `analyze_document` | macos-vision-mcp | Full pipeline: OCR + faces + barcodes + rectangles in one call. |
| `detect_barcodes` | macos-vision-mcp | Read QR/EAN/UPC/Code128/PDF417/Aztec codes. |
| `detect_faces` | macos-vision-mcp | Detect faces and return positions. |
| `detect_document` | macos-vision-mcp | Find document corner points (for crop/deskew before OCR). |
| `classify_image` | macos-vision-mcp | Classify image content into 1000+ categories. |
| `adb_vision` | this plugin | Capture a screenshot from an Android emulator/device. Returns a path — chain with `ocr_image`. Args: `device?`, `output?`. |
| `vlm_describe` | this plugin | Semantic image description via local LM Studio. Auto-detects; no-op if LM Studio is down. Args: `image_path`, `prompt?`. |

## Usage

### Read an image you pasted

Just include the image path in your prompt:

```
What's in this image? /tmp/screenshot.png
```

The model will call `ocr_image` on the path and read the extracted text. Works for: screenshots, receipts, documents, photos of screens, diagrams with text.

### Capture and read an Android screen

```
Use adb_vision to capture the emulator screen, then ocr_image to read the text.
```

`adb_vision` returns a JSON with a `path` field. The model then calls `ocr_image` with that path. Two-step, but the model handles the chaining automatically.

### Get a semantic description (icons, charts, layout)

```
Use vlm_describe on /tmp/chart.png and tell me what the chart shows.
```

OCR can't describe icons or interpret charts. `vlm_describe` calls a local vision model that can. If LM Studio isn't running, it returns a helpful message and the model falls back to `ocr_image`.

### Verified example

We tested this on an Android emulator screenshot that showed a 16KB page-size compatibility dialog. The model (which has no vision capability) successfully extracted the full dialog text:

```
Android App Compatibility
This app isn't 16 KB compatible. APK alignment check failed.
This app will be run using page size compatible mode...
The following libraries are not 16 KB aligned:
• lib/arm64-v8a/libzksensorcore.so : Uncompressed library not aligned
• lib/arm64-v8a/libhardreader.so : Unknown error
...
[OK] [Don't Show Again]
```

The model could then reason about the dialog — all without ever "seeing" the image, just from the tool's text output.

## Optional: LM Studio for semantic vision

OCR is perfect for text. For icons, charts, photos, and layout meaning, plug in a local vision model via [LM Studio](https://lmstudio.ai):

1. Download a vision model (recommended: **Qwen2.5-VL-3B-Instruct** at Q4_K_V — ~2.5 GB RAM, great on UI/code/screenshots)
2. Load it in LM Studio and start the local server (default: `http://localhost:1234/v1`)
3. `vlm_describe` auto-detects it. No config needed.

If LM Studio isn't running, `vlm_describe` returns a helpful message and the model falls back to `ocr_image` — so the plugin always works, with or without a VLM.

### Recommended LM Studio models (low resource)

| Model | RAM | Good for |
|-------|-----|----------|
| Qwen2.5-VL-3B-Instruct (Q4_K_V) | ~2.5 GB | UI screenshots, code, receipts. Best quality/resource ratio. |
| LLaVA-1.5-7B (Q4) | ~5 GB | Better on photos, charts. |
| MiniCPM-V-2.6 (Q4) | ~3 GB | Strong on OCR + description hybrid. |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_VISION_SKIP_MCP` | unset | Set to `1` to skip auto-registering macos-vision-mcp (if you configure it yourself). |
| `OPENCODE_VISION_LMSTUDIO_URL` | `http://localhost:1234/v1` | LM Studio OpenAI-compatible endpoint. |
| `OPENCODE_VISION_LMSTUDIO_TIMEOUT_MS` | `30000` | Timeout for VLM calls. |

## Prerequisites

- **opencode** — [opencode.ai](https://opencode.ai)
- **macOS 13.0+** — for Apple Vision framework (OCR core)
- **Node.js 22+** — for the plugin and MCP server
- **ADB** (optional) — for `adb_vision` tool. Install via `brew install --cask android-platform-tools` or Android Studio.
- **LM Studio** (optional) — for `vlm_describe` semantic vision. [lmstudio.ai](https://lmstudio.ai)

## Verify it works

After install + restart, check that the tools are available:

```bash
# Verify macos-vision-mcp works standalone
npx -y macos-vision-mcp <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

You should see: `ocr_image`, `detect_faces`, `detect_barcodes`, `detect_document`, `classify_image`, `analyze_document`.

Then in an opencode session, just paste an image path and ask about it. The model will use the tools.

## Project structure

```
opencode-vision/
├── src/index.ts        # Plugin entry — registers MCP + adds adb_vision, vlm_describe tools
├── package.json
├── tsconfig.json
└── README.md
```

The plugin is ~150 lines of TypeScript. The heavy lifting (OCR, barcodes, faces) is done by `macos-vision-mcp`, which this plugin auto-registers. The plugin itself only adds the Android glue and the optional LM Studio VLM bridge.

## Acknowledgements

- [`woladi/macos-vision-mcp`](https://github.com/woladi/macos-vision-mcp) — the excellent Apple Vision MCP server that this plugin auto-registers. Does 95% of the work.
- [`ihugang/ocrtool-mcp`](https://github.com/ihugang/ocrtool-mcp) — alternative Swift-native Vision MCP server.

## License

MIT
