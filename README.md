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

## Install

Add to your `opencode.json` (global: `~/.config/opencode/opencode.json`, or project: `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-vision"]
}
```

That's it. On next restart, opencode:
1. Installs the plugin via bun
2. Auto-registers `macos-vision-mcp` as an MCP server (unless `OPENCODE_VISION_SKIP_MCP=1`)
3. Exposes three new tools to every model

> **macOS only.** The OCR core uses Apple's Vision framework (same engine as Live Text in Photos.app). Linux/Windows users can still use `vlm_describe` with a remote VLM endpoint.

## Tools

| Tool | Source | What it does |
|------|--------|--------------|
| `ocr_image` | macos-vision-mcp | Extract text from an image/PDF. Returns paragraphs in reading order + bounding boxes. |
| `analyze_document` | macos-vision-mcp | Full pipeline: OCR + faces + barcodes + rectangles in one call. |
| `detect_barcodes` | macos-vision-mcp | Read QR/EAN/UPC/Code128/PDF417/Aztec codes. |
| `classify_image` | macos-vision-mcp | Classify image content into 1000+ categories. |
| `adb_vision` | this plugin | Capture a screenshot from an Android emulator/device. Returns a path — chain with `ocr_image`. |
| `vlm_describe` | this plugin | Semantic image description via local LM Studio. Auto-detects; no-op if LM Studio is down. |

## Usage examples

**Read an image you pasted:**
```
What's in this image? /tmp/screenshot.png
```
The model will call `ocr_image` on the path.

**Capture and read an Android screen:**
```
Use adb_vision to capture the emulator screen, then ocr_image to read the text.
```

**Get a semantic description (icons, charts, layout):**
```
Use vlm_describe on /tmp/chart.png and tell me what the chart shows.
```

## Optional: LM Studio for semantic vision

OCR is perfect for text. For icons, charts, photos, and layout meaning, plug in a local vision model via [LM Studio](https://lmstudio.ai):

1. Download a vision model (recommended: **Qwen2.5-VL-3B-Instruct** at Q4_K_V — ~2.5 GB RAM, great on UI/code/screenshots)
2. Load it in LM Studio and start the local server (default: `http://localhost:1234/v1`)
3. `vlm_describe` auto-detects it. No config needed.

If LM Studio isn't running, `vlm_describe` returns a helpful message and the model falls back to `ocr_image` — so the plugin always works, with or without a VLM.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_VISION_SKIP_MCP` | unset | Set to `1` to skip auto-registering macos-vision-mcp (if you configure it yourself). |
| `OPENCODE_VISION_LMSTUDIO_URL` | `http://localhost:1234/v1` | LM Studio OpenAI-compatible endpoint. |
| `OPENCODE_VISION_LMSTUDIO_TIMEOUT_MS` | `30000` | Timeout for VLM calls. |

## Prerequisites

- **opencode** — [opencode.ai](https://opencode.ai)
- **macOS 13.0+** — for Apple Vision framework (OCR core)
- **ADB** (optional) — for `adb_vision` tool. Install via `brew install --cask android-platform-tools` or Android Studio.
- **LM Studio** (optional) — for `vlm_describe` semantic vision. [lmstudio.ai](https://lmstudio.ai)

## Acknowledgements

- [`woladi/macos-vision-mcp`](https://github.com/woladi/macos-vision-mcp) — the excellent Apple Vision MCP server that this plugin auto-registers.
- [`ihugang/ocrtool-mcp`](https://github.com/ihugang/ocrtool-mcp) — alternative Swift-native Vision MCP server.

## License

MIT
