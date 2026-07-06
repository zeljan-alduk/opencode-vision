import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFile, spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir, platform, freemem, totalmem } from "node:os"
import path from "node:path"

const MACOS_VISION_MCP = "macos-vision-mcp"
const LM_STUDIO_BASE = process.env.OPENCODE_VISION_LMSTUDIO_URL || "http://localhost:1234/v1"
const LMSTUDIO_TIMEOUT_MS = Number(process.env.OPENCODE_VISION_LMSTUDIO_TIMEOUT_MS || 120000)

function execFileAsync(file: string, args: string[], opts: { maxBuffer?: number; timeout?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: stdout as Buffer, stderr: stderr.toString() })
    })
  })
}

async function detectAdbDevice(serial?: string): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["devices"])
  const lines = stdout.toString().split("\n").slice(1).map((l) => l.trim()).filter(Boolean)
  const devices = lines.filter((l) => l.endsWith("\tdevice")).map((l) => l.split("\t")[0])
  if (devices.length === 0) throw new Error("No ADB devices connected. Start an emulator or connect a device.")
  if (serial) {
    if (!devices.includes(serial)) throw new Error(`Device '${serial}' not found. Available: ${devices.join(", ")}`)
    return serial
  }
  return devices[0]
}

// --- Hardware detection ---
interface HardwareInfo {
  platform: string
  isMacOS: boolean
  isAppleSilicon: boolean
  ramGB: number
  freeRamGB: number
  cpuCores: number
  gpu: "metal" | "cuda" | "none"
  recommendedModel: string
  recommendedQuant: string
  recommendedReason: string
}

async function detectHardware(): Promise<HardwareInfo> {
  const isMacOS = platform() === "darwin"
  const ramGB = Math.round(totalmem() / 1024 / 1024 / 1024)
  const freeRamGB = Math.round(freemem() / 1024 / 1024 / 1024)
  let cpuCores = 0
  let isAppleSilicon = false

  try {
    if (isMacOS) {
      const { stdout } = await execFileAsync("sysctl", ["-n", "hw.ncpu"])
      cpuCores = parseInt(stdout.toString().trim(), 10) || 0
      const { stdout: arm } = await execFileAsync("sysctl", ["-n", "hw.optional.arm64"])
      isAppleSilicon = arm.toString().trim() === "1"
    } else {
      cpuCores = parseInt(String(process.env.NUMBER_OF_PROCESSORS || "4"), 10)
    }
  } catch { cpuCores = 4 }

  const gpu: "metal" | "cuda" | "none" = isAppleSilicon ? "metal" : "none"

  // Model recommendation based on RAM
  let recommendedModel = "none"
  let recommendedQuant = ""
  let recommendedReason = ""

  if (ramGB >= 32) {
    recommendedModel = "qwen2.5-vl-7b-instruct"
    recommendedQuant = "Q4_K_M"
    recommendedReason = `${ramGB}GB RAM detected — Qwen2.5-VL-7B (Q4_K_M, ~6GB) gives best quality for OCR, charts, icons, documents. Plenty of headroom.`
  } else if (ramGB >= 16) {
    recommendedModel = "qwen2.5-vl-7b-instruct"
    recommendedQuant = "Q3_K_L"
    recommendedReason = `${ramGB}GB RAM detected — Qwen2.5-VL-7B (Q3_K_L, ~4.5GB) fits with headroom. Good quality on UI/screenshots.`
  } else if (ramGB >= 8) {
    recommendedModel = "qwen2.5-vl-3b-instruct"
    recommendedQuant = "Q4_K_M"
    recommendedReason = `${ramGB}GB RAM detected — Qwen2.5-VL-3B (Q4_K_M, ~2.5GB) is the safe pick. Great on text, decent on icons.`
  } else {
    recommendedModel = "none"
    recommendedReason = `${ramGB}GB RAM is below minimum (8GB) for local vision models. Using Apple Vision OCR only.`
  }

  return { platform: platform(), isMacOS, isAppleSilicon, ramGB, freeRamGB, cpuCores, gpu, recommendedModel, recommendedQuant, recommendedReason }
}

// --- LM Studio detection ---
async function checkLmStudioInstalled(): Promise<{ installed: boolean; cliPath?: string; appPath?: string }> {
  // Check for lms CLI
  try {
    const { stdout } = await execFileAsync("which", ["lms"])
    const cliPath = stdout.toString().trim()
    const appExists = await fs.access("/Applications/LM Studio.app").then(() => true).catch(() => false)
    return { installed: true, cliPath, appPath: appExists ? "/Applications/LM Studio.app" : undefined }
  } catch {
    const appExists = await fs.access("/Applications/LM Studio.app").then(() => true).catch(() => false)
    if (appExists) return { installed: true, appPath: "/Applications/LM Studio.app" }
    return { installed: false }
  }
}

async function checkLmStudioRunning(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${LM_STUDIO_BASE}/models`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch { return false }
}

async function getLoadedModels(): Promise<string[]> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${LM_STUDIO_BASE}/models`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return []
    const data = await res.json() as { data?: Array<{ id: string }> }
    return data.data?.map((m) => m.id) ?? []
  } catch { return [] }
}

async function listLocalModels(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lms", ["ls"])
    return stdout.toString().split("\n")
      .filter((l) => l.trim() && !l.startsWith("LLM") && !l.startsWith("EMBEDDING") && !l.startsWith("You have"))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
  } catch { return [] }
}

const VISION_HINTS = ["vl", "vision", "llava", "minicpm", "qwen2-vl", "qwen2.5-vl", "internvl", "cogvlm"]

function findVisionModel(models: string[]): string | undefined {
  return models.find((m) => VISION_HINTS.some((h) => m.toLowerCase().includes(h)))
}

async function loadModel(modelKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync("lms", ["load", modelKey, "--gpu", "max", "--yes"], { timeout: 120000 })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

async function downloadModel(modelName: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Try lms get first (auto-picks quant)
    await execFileAsync("lms", ["get", modelName, "--yes", "--gguf"], { timeout: 600000 })
    return { success: true }
  } catch (e1: any) {
    // Fallback: direct HuggingFace download
    try {
      const modelsDir = path.join(process.env.HOME || "", ".lmstudio/models/lmstudio-community/Qwen2.5-VL-7B-Instruct-GGUF")
      await fs.mkdir(modelsDir, { recursive: true })
      const baseUrl = "https://huggingface.co/lmstudio-community/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main"
      const mainFile = modelName.includes("7b") ? "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf" : "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"
      const mmprojFile = modelName.includes("7b") ? "mmproj-model-f16.gguf" : "mmproj-model-f16.gguf"
      // Download both files via curl
      await execFileAsync("curl", ["-L", "-o", path.join(modelsDir, mainFile), `${baseUrl}/${mainFile}`], { timeout: 600000 })
      await execFileAsync("curl", ["-L", "-o", path.join(modelsDir, mmprojFile), `${baseUrl}/${mmprojFile}`], { timeout: 600000 })
      return { success: true }
    } catch (e2: any) {
      return { success: false, error: `lms get failed: ${e1.message}; curl fallback failed: ${e2.message}` }
    }
  }
}

// --- VLM description ---
const VLM_DETAIL_PROMPT = `You are a precise UI/screen analysis engine. Describe the image with MAXIMUM detail. Output these sections:

1. SCREEN_TYPE: What kind of screen is this? (app config, login form, list, dialog, dashboard, photo, chart, document, etc.)

2. ELEMENTS: List EVERY visible element. For each, provide:
   - type: (button, text field, label, icon, image, checkbox, toggle, dropdown, list item, tab, header, banner, logo, divider, progress bar, chart, table, etc.)
   - text: exact text content if any (verbatim)
   - position: approximate location as (x, y) in pixels from top-left corner
   - size: approximate width x height in pixels
   - color: background color and text/border color (be specific: "purple #6C5CE7", "white", "red #E74C3C")
   - state: (enabled, disabled, focused, selected, error, placeholder, etc.)
   - notes: any detail (icon shape, alignment, spacing)

3. LAYOUT: Describe the spatial structure. How are elements grouped? What's the hierarchy? Margins/padding? Grid or flex? Header/body/footer zones? Multi-column?

4. COLORS: Full color palette used. Background, primary, accent, text, borders. Give hex if possible.

5. TEXT: All text content, verbatim, in reading order. Note font size relative to other text (large/medium/small).

6. GRAPHICS: Icons, logos, images, illustrations. Describe shape, color, what they depict. (e.g. "purple circle with white 'i' inside — info icon")

7. INTERACTIVE: Which elements appear tappable/clickable? What would each do?

8. CONTEXT: What app/screen is this? What is the user trying to accomplish? What state is the UI in?

Be exhaustive. Prefer specific pixel coordinates and hex colors over vague descriptions. If unsure, say "approximate" but still give your best estimate. Do not skip elements.`

async function describeWithVlm(imagePath: string, prompt: string, model: string): Promise<string> {
  const imgBuf = await fs.readFile(imagePath)
  const b64 = imgBuf.toString("base64")
  const ext = path.extname(imagePath).slice(1).toLowerCase() || "png"
  const dataUrl = `data:image/${ext};base64,${b64}`

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), LMSTUDIO_TIMEOUT_MS)
  const res = await fetch(`${LM_STUDIO_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: ctrl.signal,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a UI/screen analysis engine. You output structured, exhaustive descriptions. You never skip details. You always give coordinates, colors, sizes, and text for every element." },
        { role: "user", content: [
          { type: "text", text: prompt || VLM_DETAIL_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ] },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    }),
  })
  clearTimeout(t)
  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    throw new Error(`LM Studio vision call failed (${res.status}): ${txt.slice(0, 300)}`)
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content?.trim() ?? "(empty response from VLM)"
}

// --- Apple Vision OCR via macos-vision-mcp (local subprocess call) ---
async function runOcrViaMcp(imagePath: string): Promise<{ fullText: string; blocks: any[]; paragraphs: any[]; lineCount: number } | { error: string; fullText: null; blocks: any[] }> {
  const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "opencode-vision", version: "0.1.0" } } })
  const readyMsg = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  const callMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ocr_image", arguments: { path: imagePath } } })
  const input = `${initMsg}\n${readyMsg}\n${callMsg}\n`

  return new Promise((resolve) => {
    const child = spawn("npx", ["-y", "macos-vision-mcp"], { stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); resolve({ error: "OCR timed out after 60s", fullText: null, blocks: [] }) }
    }, 60000)

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
      // Look for the id:2 response (the tool call result)
      const lines = out.split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed)
          if (msg.id === 2 && msg.result) {
            if (!settled) {
              settled = true
              clearTimeout(timeout)
              child.kill()
              const text = msg.result.content?.[0]?.text || ""
              try {
                const parsed = JSON.parse(text)
                const paragraphs = parsed.pages?.flatMap((p: any) => p.paragraphs || []) || []
                const blocks = parsed.pages?.flatMap((p: any) => p.textBlocks || []) || []
                const fullText = paragraphs.map((p: any) => p.text).join("\n") || text
                resolve({ fullText, blocks, paragraphs, lineCount: blocks.length })
              } catch {
                resolve({ fullText: text, blocks: [], paragraphs: [], lineCount: 0 })
              }
            }
            return
          }
        } catch { /* partial line, ignore */ }
      }
    })

    child.on("error", (err) => {
      if (!settled) { settled = true; clearTimeout(timeout); resolve({ error: err.message, fullText: null, blocks: [] }) }
    })
    child.on("close", () => {
      if (!settled) { settled = true; clearTimeout(timeout); resolve({ error: "MCP server closed without response", fullText: null, blocks: [] }) }
    })

    child.stdin.write(input)
  })
}

// --- Ensure a vision model is available (auto-load if needed) ---
async function ensureVisionModel(): Promise<{ available: boolean; model?: string; status: string; needsInstall?: boolean }> {
  // 1. Check if LM Studio is running and has a vision model loaded
  const running = await checkLmStudioRunning()
  if (running) {
    const loaded = await getLoadedModels()
    const vision = findVisionModel(loaded)
    if (vision) return { available: true, model: vision, status: `Vision model '${vision}' is loaded in LM Studio.` }
    // 2. Check local models on disk
    const local = await listLocalModels()
    const localVision = findVisionModel(local)
    if (localVision) {
      const result = await loadModel(localVision)
      if (result.success) return { available: true, model: localVision, status: `Loaded vision model '${localVision}' from disk.` }
      return { available: false, status: `Found '${localVision}' on disk but failed to load: ${result.error}` }
    }
    return { available: false, status: "LM Studio is running but no vision model found locally. Use vision_setup to download one.", needsInstall: true }
  }
  // 3. LM Studio not running — check if installed
  const installed = await checkLmStudioInstalled()
  if (!installed.installed) {
    return { available: false, status: "LM Studio is not installed. Use vision_setup to install it.", needsInstall: true }
  }
  return { available: false, status: "LM Studio is installed but not running. Start it and load a vision model, or use vision_setup.", needsInstall: true }
}

const VisionPlugin: Plugin = async (ctx) => {
  return {
    config: async (cfg) => {
      if (process.env.OPENCODE_VISION_SKIP_MCP === "1") return
      cfg.mcp = cfg.mcp ?? {}
      if (cfg.mcp[MACOS_VISION_MCP]) return
      cfg.mcp[MACOS_VISION_MCP] = {
        type: "local",
        command: ["npx", "-y", MACOS_VISION_MCP],
        enabled: true,
      } as any
    },

    tool: {
      adb_vision: tool({
        description: "Capture a screenshot from an Android emulator/device via ADB and save it to a temp file. Returns the file path and metadata. After calling this, use the ocr_image tool (from macos-vision-mcp) on the returned path to extract text, or vlm_describe for semantic description of icons/charts/layout.",
        args: {
          device: tool.schema.string().optional().describe("ADB device serial (optional). If omitted, uses the first connected device."),
          output: tool.schema.string().optional().describe("Output file path (optional). If omitted, saves to a temp file."),
        },
        async execute(args) {
          const device = await detectAdbDevice(args.device)
          const { stdout } = await execFileAsync("adb", ["-s", device, "exec-out", "screencap", "-p"])
          if (stdout.length === 0) throw new Error("adb screencap returned empty (is the device authorized?)")
          const outPath = args.output || path.join(tmpdir(), `adb_screenshot_${Date.now()}.png`)
          await fs.writeFile(outPath, stdout)
          return JSON.stringify({
            path: outPath,
            device,
            bytes: stdout.length,
            hint: "Call ocr_image with this path to extract text. Or use vlm_describe for semantic description of icons/charts/layout.",
          })
        },
      }),

      vision_setup: tool({
        description: "Check hardware, LM Studio installation, and vision model availability. Recommends the best vision model for your hardware and can auto-download it. Returns a status report. Call this first if you want to enable semantic image description (vlm_describe).",
        args: {
          action: tool.schema.enum(["status", "download", "install-lmstudio"]).describe("'status' = check what's available (default). 'download' = download the recommended vision model. 'install-lmstudio' = install LM Studio (macOS only)."),
        },
        async execute(args) {
          const action = args.action || "status"
          const hw = await detectHardware()

          if (action === "install-lmstudio") {
            if (!hw.isMacOS) return JSON.stringify({ error: "LM Studio auto-install is macOS only. Download from https://lmstudio.ai for other platforms." })
            const installed = await checkLmStudioInstalled()
            if (installed.installed) return JSON.stringify({ already: true, message: "LM Studio is already installed.", cliPath: installed.cliPath })
            try {
              await execFileAsync("brew", ["install", "--cask", "lm-studio"], { timeout: 300000 })
              return JSON.stringify({ success: true, message: "LM Studio installed via Homebrew. Open the app, then run vision_setup with action='download'." })
            } catch (e: any) {
              return JSON.stringify({ error: "Auto-install failed. Download manually from https://lmstudio.ai", details: e.message })
            }
          }

          if (action === "download") {
            if (hw.recommendedModel === "none") return JSON.stringify({ error: hw.recommendedReason })
            const installed = await checkLmStudioInstalled()
            if (!installed.installed) return JSON.stringify({ error: "LM Studio not installed. Run vision_setup with action='install-lmstudio' first.", hardware: hw })
            const dlResult = await downloadModel(hw.recommendedModel)
            if (!dlResult.success) return JSON.stringify({ error: "Download failed.", details: dlResult.error, hardware: hw })
            const loadResult = await loadModel(hw.recommendedModel)
            return JSON.stringify({
              success: true,
              hardware: hw,
              model: hw.recommendedModel,
              quant: hw.recommendedQuant,
              loaded: loadResult.success,
              loadError: loadResult.error,
              message: `Downloaded ${hw.recommendedModel} (${hw.recommendedQuant}). ${loadResult.success ? "Loaded and ready." : "Downloaded but auto-load failed — open LM Studio to load manually."}`,
            })
          }

          // action === "status"
          const installed = await checkLmStudioInstalled()
          const running = await checkLmStudioRunning()
          const loaded = running ? await getLoadedModels() : []
          const local = await listLocalModels()
          const loadedVision = findVisionModel(loaded)
          const localVision = findVisionModel(local)
          return JSON.stringify({
            hardware: hw,
            lmStudio: { installed, running, loadedModels: loaded, localModels: local },
            visionModel: {
              loaded: loadedVision,
              onDisk: localVision,
              recommended: hw.recommendedModel,
              recommendedQuant: hw.recommendedQuant,
              reason: hw.recommendedReason,
            },
            nextStep: loadedVision ? "Ready — use vlm_describe." : localVision ? `Run: vision_setup action='download' is not needed, model '${localVision}' is on disk. Use vision_setup action='status' to auto-load.` : hw.recommendedModel !== "none" ? "Run: vision_setup action='download' to get the recommended vision model." : "Hardware too limited for local VLM. Use ocr_image (Apple Vision) instead.",
          })
        },
      }),

      vlm_describe: tool({
        description: "Describe an image with MAXIMUM detail using both Apple Vision (exact text + pixel-precise bounding boxes + barcodes) AND a local vision model (semantic: colors, icons, layout, graphics, element types). Merges both into one structured report. Auto-detects and auto-loads a vision model if available. If no VLM available, returns Apple Vision OCR only. Use this when you need full understanding of a screen, diagram, chart, photo, or document — not just text.",
        args: {
          image_path: tool.schema.string().describe("Path to the image file to describe."),
          prompt: tool.schema.string().optional().describe("Custom prompt for the vision model. Default: structured full-detail analysis (elements, coordinates, colors, graphics, layout, context)."),
        },
        async execute(args) {
          const prompt = args.prompt || VLM_DETAIL_PROMPT
          const tStart = Date.now()
          // Run OCR (Apple Vision) and VLM ensure-check in parallel
          const tOcrStart = Date.now()
          const tEnsureStart = Date.now()
          const [ocrResult, ensure] = await Promise.all([
            runOcrViaMcp(args.image_path).catch((e) => ({ error: e.message, fullText: null, blocks: [] })),
            ensureVisionModel(),
          ])
          const ocrMs = Date.now() - tOcrStart
          const ensureMs = Date.now() - tEnsureStart
          // VLM call (sequential after ensure, since it needs the model id)
          const tVlmStart = Date.now()
          const vlmPromise = ensure.available
            ? describeWithVlm(args.image_path, prompt, ensure.model!).catch((e) => ({ error: e.message }))
            : Promise.resolve(null)
          const vlmResult = await vlmPromise
          const vlmMs = Date.now() - tVlmStart
          const totalMs = Date.now() - tStart

          const report: any = {
            image: { path: args.image_path },
            timing: {
              apple_vision_ocr_ms: ocrMs,
              lmstudio_ensure_ms: ensureMs,
              vlm_describe_ms: vlmMs,
              total_ms: totalMs,
              total_human: `${(totalMs / 1000).toFixed(1)}s`,
            },
            layers: {
              apple_vision_ocr: ocrResult,
              vlm_semantic: ensure.available ? { model: ensure.model, status: ensure.status, description: vlmResult } : { available: false, status: ensure.status, suggestion: "Run vision_setup action='download' to enable semantic vision. Apple Vision OCR is still available above." },
            },
            combined_summary: null as any,
          }
          // Build combined summary
          const ocrText = (ocrResult as any)?.fullText || ""
          const vlmText = typeof vlmResult === "string" ? vlmResult : (vlmResult as any)?.error || ""
          report.combined_summary = [
            `=== TIMING ===`,
            `Apple Vision OCR: ${ocrMs}ms (${(ocrMs/1000).toFixed(1)}s)`,
            `LM Studio model check/load: ${ensureMs}ms (${(ensureMs/1000).toFixed(1)}s)`,
            `VLM description: ${vlmMs}ms (${(vlmMs/1000).toFixed(1)}s)`,
            `Total: ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`,
            ``,
            `=== APPLE VISION OCR (precise text + pixel-accurate bounding boxes) ===`,
            ocrText || "(no text detected)",
            ``,
            `=== VLM SEMANTIC DESCRIPTION (colors, icons, layout, element inventory, context) ===`,
            ensure.available ? vlmText : "(VLM not available — run vision_setup action='download')",
          ].join("\n")
          return JSON.stringify(report)
        },
      }),
    },
  }
}

export default VisionPlugin
