import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MACOS_VISION_MCP = "macos-vision-mcp"
const LM_STUDIO_BASE = process.env.OPENCODE_VISION_LMSTUDIO_URL || "http://localhost:1234/v1"
const LMSTUDIO_TIMEOUT_MS = Number(process.env.OPENCODE_VISION_LMSTUDIO_TIMEOUT_MS || 30000)

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

async function probeLmStudio(): Promise<{ available: boolean; model?: string; reason?: string }> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${LM_STUDIO_BASE}/models`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return { available: false, reason: `LM Studio responded ${res.status}` }
    const data = await res.json() as { data?: Array<{ id: string }> }
    const models = data.data?.map((m) => m.id) ?? []
    if (models.length === 0) return { available: false, reason: "No model loaded in LM Studio" }
    const visionHints = ["vl", "vision", "llava", "minicpm", "qwen2-vl", "qwen2.5-vl", "internvl", "cogvlm"]
    const visionModel = models.find((m) => visionHints.some((h) => m.toLowerCase().includes(h)))
    return { available: true, model: visionModel ?? models[0] }
  } catch {
    return { available: false, reason: "LM Studio not running at " + LM_STUDIO_BASE }
  }
}

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
        { role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ] },
      ],
      max_tokens: 800,
      temperature: 0.3,
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
        description: "Capture a screenshot from an Android emulator/device via ADB and save it to a temp file. Returns the file path and metadata. After calling this, use the ocr_image tool (from macos-vision-mcp) on the returned path to extract text from the screenshot. Useful for: reading Android UI screens, debugging apps visually, inspecting what's displayed on a device/emulator.",
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
            hint: "Call ocr_image with this path to extract text. Or use vlm_describe for semantic description of icons/charts.",
          })
        },
      }),

      vlm_describe: tool({
        description: "Describe an image semantically using a local vision model (VLM) running in LM Studio. Returns a natural-language description of icons, charts, photos, and layout — things OCR cannot see. Auto-detects LM Studio and any loaded vision model; if LM Studio is not running or no vision model is loaded, returns a helpful message and suggests using ocr_image instead. Recommended LM Studio models: Qwen2.5-VL-3B-Instruct (low resource, ~2.5GB RAM), LLaVA-1.5-7B (better quality, ~5GB).",
        args: {
          image_path: tool.schema.string().describe("Path to the image file to describe."),
          prompt: tool.schema.string().optional().describe("Custom prompt for the vision model. Default: 'Describe this image concisely, focusing on UI elements, icons, charts, and layout.'"),
        },
        async execute(args) {
          const prompt = args.prompt || "Describe this image concisely, focusing on UI elements, icons, charts, and layout."
          const probe = await probeLmStudio()
          if (!probe.available) {
            return JSON.stringify({
              available: false,
              reason: probe.reason,
              suggestion: "Use the ocr_image tool instead for text extraction. To enable semantic description, start LM Studio and load a vision model (e.g. Qwen2.5-VL-3B-Instruct).",
            })
          }
          const description = await describeWithVlm(args.image_path, prompt, probe.model!)
          return JSON.stringify({
            available: true,
            model: probe.model,
            description,
          })
        },
      }),
    },
  }
}

export default VisionPlugin
