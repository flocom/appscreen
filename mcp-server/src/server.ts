#!/usr/bin/env node
// appscreen MCP server — generates App Store screenshots server-side.
// Transports: stdio (default) and Streamable HTTP (--http / MCP_TRANSPORT=http).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  OUTPUT_SIZES,
  OUTPUT_DEVICES,
  GRADIENT_PRESET_CSS,
  GRADIENT_PRESET_NAMES,
  getPresetGradient,
} from "./presets.js";
import { renderScreenshot, type RenderSpec } from "./render.js";
import { putFile, getFile } from "./filestore.js";

// ---------- Zod schemas (shared by generate_screenshot and generate_batch) ----------

const gradientStop = z.object({
  color: z.string().describe("Hex color, e.g. #667eea"),
  position: z.number().min(0).max(100).describe("Stop position, 0-100"),
});

const background = z
  .object({
    type: z.enum(["gradient", "solid", "image"]).default("gradient"),
    preset: z
      .string()
      .optional()
      .describe(`Named gradient preset. One of: ${GRADIENT_PRESET_NAMES.join(", ")}`),
    gradientCss: z
      .string()
      .optional()
      .describe('Raw CSS, e.g. "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"'),
    gradient: z
      .object({ angle: z.number(), stops: z.array(gradientStop).min(2) })
      .optional()
      .describe("Explicit gradient: angle in degrees + color stops"),
    solid: z.string().optional().describe("Solid hex color (type=solid)"),
    image: z
      .string()
      .optional()
      .describe("Background image: http(s) URL, appscreen-file:// ref (from POST /upload), data URL, raw base64, or a server file path (type=image)"),
    imageFit: z.enum(["cover", "contain", "stretch"]).optional(),
    imageBlur: z.number().min(0).optional(),
    overlayColor: z.string().optional(),
    overlayOpacity: z.number().min(0).max(100).optional(),
    noise: z.boolean().optional().describe("Add subtle noise texture"),
    noiseIntensity: z.number().min(0).max(100).optional(),
  })
  .describe("Background configuration");

const shadow = z.object({
  enabled: z.boolean().optional(),
  color: z.string().optional(),
  blur: z.number().optional(),
  opacity: z.number().min(0).max(100).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

const frame = z.object({
  enabled: z.boolean().optional(),
  color: z.string().optional(),
  width: z.number().optional(),
  opacity: z.number().min(0).max(100).optional(),
});

const screenshot = z
  .object({
    image: z
      .string()
      .optional()
      .describe("App screenshot: http(s) URL, appscreen-file:// ref (from POST /upload), data URL, raw base64, or a server file path"),
    scale: z.number().min(1).max(200).optional().describe("% of canvas width (default 70)"),
    x: z.number().min(0).max(100).optional().describe("Horizontal position, 50=center"),
    y: z.number().min(0).max(100).optional().describe("Vertical position (default 60)"),
    rotation: z.number().optional().describe("Rotation in degrees"),
    perspective: z.number().optional(),
    cornerRadius: z.number().min(0).optional().describe("Corner radius (default 24)"),
    shadow: shadow.optional(),
    frame: frame.optional(),
  })
  .describe("Device/screenshot placement");

const textStyle = z.object({
  text: z.string().optional(),
  texts: z
    .record(z.string())
    .optional()
    .describe('Per-language map, e.g. {"en":"Hi","fr":"Salut"}; selected by top-level `language`.'),
  enabled: z.boolean().optional(),
  font: z.string().optional(),
  size: z.number().optional(),
  weight: z.string().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  color: z.string().optional(),
  opacity: z.number().min(0).max(100).optional(),
});

const text = z
  .object({
    position: z.enum(["top", "center", "bottom"]).optional(),
    offsetY: z.number().optional().describe("Distance from edge, in %"),
    lineHeight: z.number().optional(),
    headline: textStyle.optional(),
    subheadline: textStyle.optional(),
  })
  .describe("Headline / subheadline overlay");

const LAYERS = ["behind-screenshot", "above-screenshot", "above-text"] as const;

const element = z
  .object({
    type: z.enum(["text", "emoji", "icon", "graphic"]),
    layer: z.enum(LAYERS).optional().describe("Z-order layer (default above-text)"),
    x: z.number().min(0).max(100).optional().describe("Center X, % (default 50)"),
    y: z.number().min(0).max(100).optional().describe("Center Y, % (default 50)"),
    width: z.number().optional().describe("Width as % of canvas width"),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(100).optional(),
    // text
    text: z.string().optional(),
    texts: z.record(z.string()).optional().describe("Per-language text map"),
    font: z.string().optional(),
    fontSize: z.number().optional(),
    fontWeight: z.string().optional(),
    fontColor: z.string().optional(),
    italic: z.boolean().optional(),
    frame: z
      .string()
      .optional()
      .describe(
        "Text frame: none | laurel-simple | laurel-detailed | badge-circle | badge-ribbon (append -star for a star)",
      ),
    frameColor: z.string().optional(),
    frameScale: z.number().optional(),
    // emoji
    emoji: z.string().optional(),
    // icon / graphic
    image: z.string().optional().describe("Image: http(s) URL, appscreen-file:// ref, data URL, raw base64, or a server file path"),
    iconShadow: shadow.optional(),
  })
  .describe("A free-floating overlay element");

const popout = z
  .object({
    cropX: z.number().optional().describe("Crop origin X, % of screenshot (default 25)"),
    cropY: z.number().optional().describe("Crop origin Y, % (default 25)"),
    cropWidth: z.number().optional().describe("Crop width, % (default 30)"),
    cropHeight: z.number().optional().describe("Crop height, % (default 30)"),
    x: z.number().optional().describe("Display center X, % of canvas (default 70)"),
    y: z.number().optional().describe("Display center Y, % (default 30)"),
    width: z.number().optional().describe("Display width, % of canvas (default 30)"),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(100).optional(),
    cornerRadius: z.number().optional(),
    shadow: shadow.optional(),
    border: z
      .object({
        enabled: z.boolean().optional(),
        color: z.string().optional(),
        width: z.number().optional(),
        opacity: z.number().min(0).max(100).optional(),
      })
      .optional(),
  })
  .describe("A cropped zoom ('popout') of the main screenshot");

const renderShape = {
  outputDevice: z
    .enum(OUTPUT_DEVICES as [string, ...string[]])
    .optional()
    .describe("Named output size. Omit and pass width/height for custom."),
  width: z.number().optional(),
  height: z.number().optional(),
  language: z
    .string()
    .optional()
    .describe('Language key for `texts` maps (default "en").'),
  background,
  screenshot: screenshot.optional(),
  text: text.optional(),
  elements: z.array(element).optional().describe("Overlay elements (text/emoji/icon/graphic)"),
  popouts: z.array(popout).optional().describe("Cropped zoom callouts of the screenshot"),
  layout: z
    .object({
      avoidTextOverlap: z
        .boolean()
        .optional()
        .describe(
          "Constrain the screenshot so it never overlaps the headline/subheadline. It only moves/shrinks, never grows past the requested scale.",
        ),
      gap: z
        .number()
        .optional()
        .describe("Min gap between text and screenshot, as % of canvas height (default 3)."),
    })
    .optional()
    .describe("Automatic layout safeguards"),
  outputPath: z
    .string()
    .optional()
    .describe("If set, also write the PNG to this absolute file path (on the server)."),
  deliver: z
    .enum(["inline", "url", "both"])
    .optional()
    .describe(
      "How to return the PNG: 'inline' base64 (default), 'url' = a temporary download link that auto-deletes after ttlSeconds (HTTP transport only), or 'both'.",
    ),
  ttlSeconds: z
    .number()
    .int()
    .min(10)
    .max(86400)
    .optional()
    .describe("Lifetime of the temporary download URL, in seconds (default 600 = 10 min)."),
};

// ---------- Delivery helper -----------

interface ServerCtx {
  publicBaseUrl?: string;
}

interface DeliveryOpts {
  deliver?: "inline" | "url" | "both";
  ttlSeconds?: number;
  outputPath?: string;
}

// Turn a rendered PNG into MCP content according to the requested delivery mode.
async function deliver(
  png: Buffer,
  width: number,
  height: number,
  opts: DeliveryOpts,
  ctx: ServerCtx,
): Promise<{ content: any[]; url?: string; savedTo?: string }> {
  const mode = opts.deliver ?? "inline";
  const content: any[] = [];
  const notes: string[] = [];

  let savedTo: string | undefined;
  if (opts.outputPath) {
    savedTo = resolve(opts.outputPath);
    await writeFile(savedTo, png);
  }

  let url: string | undefined;
  const wantUrl = mode === "url" || mode === "both";
  if (wantUrl && ctx.publicBaseUrl) {
    const ttlSec = Math.max(10, Math.min(opts.ttlSeconds ?? 600, 86400));
    const id = putFile(png, "image/png", ttlSec * 1000);
    url = `${ctx.publicBaseUrl}/files/${id}.png`;
    notes.push(`Download (expires in ${ttlSec}s): ${url}`);
  }
  const urlUnavailable = wantUrl && !ctx.publicBaseUrl;
  if (urlUnavailable) {
    notes.push("URL delivery needs the HTTP transport — returning the image inline instead.");
  }

  const wantInline = mode === "inline" || mode === "both" || urlUnavailable;
  if (wantInline) {
    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }
  if (savedTo) notes.push(`Saved ${width}×${height} PNG to ${savedTo}`);
  if (notes.length) content.push({ type: "text", text: notes.join("\n") });

  return { content, url, savedTo };
}

// ---------- Build the MCP server ----------

function buildServer(ctx: ServerCtx = {}): McpServer {
  const server = new McpServer({
    name: "appscreen-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "list_output_sizes",
    {
      title: "List output sizes",
      description:
        "List all supported App Store / Play Store / web output sizes (device key → pixel dimensions).",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(OUTPUT_SIZES, null, 2) }],
    }),
  );

  server.registerTool(
    "list_gradient_presets",
    {
      title: "List gradient presets",
      description:
        "List the 25 built-in gradient presets (name → CSS and parsed angle/stops).",
      inputSchema: {},
    },
    async () => {
      const out = GRADIENT_PRESET_NAMES.map((name) => ({
        name,
        css: GRADIENT_PRESET_CSS[name],
        ...getPresetGradient(name),
      }));
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "generate_screenshot",
    {
      title: "Generate App Store screenshot",
      description:
        "Render a single marketing screenshot: background (gradient/preset/solid/image), " +
        "optional device screenshot with placement/shadow/border, and headline/subheadline text. " +
        "Returns the PNG inline (base64) by default, or as a temporary download URL (deliver='url').",
      inputSchema: renderShape,
    },
    async (args) => {
      const { outputPath, deliver: deliverMode, ttlSeconds, ...spec } = args;
      const result = await renderScreenshot(spec as RenderSpec);
      const { content } = await deliver(
        result.png,
        result.width,
        result.height,
        { deliver: deliverMode, ttlSeconds, outputPath },
        ctx,
      );
      return { content };
    },
  );

  server.registerTool(
    "generate_batch",
    {
      title: "Generate a batch of screenshots",
      description:
        "Render multiple screenshots in one call. Each item is a full screenshot spec " +
        "(supports outputPath, deliver, ttlSeconds). Returns a per-item summary plus any " +
        "inline images / download URLs.",
      inputSchema: {
        screenshots: z
          .array(z.object(renderShape))
          .min(1)
          .max(50)
          .describe("Array of screenshot specs (same shape as generate_screenshot)."),
      },
    },
    async ({ screenshots }) => {
      const results: any[] = [];
      const images: any[] = [];
      for (let i = 0; i < screenshots.length; i++) {
        const { outputPath, deliver: deliverMode, ttlSeconds, ...spec } = screenshots[i] as any;
        try {
          const r = await renderScreenshot(spec as RenderSpec);
          const d = await deliver(
            r.png,
            r.width,
            r.height,
            { deliver: deliverMode, ttlSeconds, outputPath },
            ctx,
          );
          for (const c of d.content) if (c.type === "image") images.push(c);
          results.push({ index: i, ok: true, width: r.width, height: r.height, url: d.url, savedTo: d.savedTo });
        } catch (e: any) {
          results.push({ index: i, ok: false, error: String(e?.message ?? e) });
        }
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(results, null, 2) },
          ...images,
        ],
      };
    },
  );

  return server;
}

// ---------- Transport wiring ----------

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[appscreen-mcp] listening on stdio");
}

async function runHttp(port: number) {
  const app = express();

  // CORS so a browser (e.g. the appscreen web app's Settings → MCP connection)
  // can reach this server. Override the allowed origin with MCP_CORS_ORIGIN.
  const corsOrigin = process.env.MCP_CORS_ORIGIN || "*";
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", corsOrigin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, mcp-session-id, mcp-protocol-version, last-event-id",
    );
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    res.header("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Public base URL used to build links. Prefer an explicit PUBLIC_BASE_URL
  // (correct behind proxies/tunnels); otherwise derive it from the request,
  // honoring X-Forwarded-* set by reverse proxies.
  const publicBaseUrlFor = (req: express.Request): string | undefined => {
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
    return host ? `${proto}://${host}` : undefined;
  };

  // Binary upload endpoint (raw image bytes — no base64). Must come before the
  // JSON parser so it isn't intercepted. Returns a reference to pass as an
  // `image` field, avoiding huge base64 in the MCP request.
  app.post("/upload", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: "empty body — POST the raw image bytes" });
      return;
    }
    const mime = (req.headers["content-type"] || "image/png").split(";")[0].trim();
    const ttlSec = Math.max(10, Math.min(parseInt(String(req.query.ttl || "3600"), 10) || 3600, 86400));
    const id = putFile(buf, mime, ttlSec * 1000);
    const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const base = publicBaseUrlFor(req);
    res.json({
      id,
      ref: `appscreen-file://${id}`, // pass this as an `image` field (no round-trip)
      url: base ? `${base}/files/${id}.${ext}` : undefined,
      mime,
      bytes: buf.length,
      expiresIn: ttlSec,
    });
  });

  app.use(express.json({ limit: "50mb" }));

  // Stateless: a fresh server+transport per request (simple and robust).
  app.post("/mcp", async (req, res) => {
    const server = buildServer({ publicBaseUrl: publicBaseUrlFor(req) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[appscreen-mcp] request error:", e);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  // Temporary download endpoint for deliver:'url'. Auto-expires (see filestore).
  app.get("/files/:id", (req, res) => {
    const id = req.params.id.replace(/\.[a-z0-9]+$/i, "");
    const f = getFile(id);
    if (!f) {
      res.status(404).json({ error: "not found or expired" });
      return;
    }
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Cache-Control", "no-store");
    res.send(f.buf);
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.listen(port, () => {
    console.error(`[appscreen-mcp] HTTP listening on http://localhost:${port}/mcp`);
  });
}

const useHttp =
  process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";
const port = parseInt(process.env.PORT || "3000", 10);

(useHttp ? runHttp(port) : runStdio()).catch((e) => {
  console.error("[appscreen-mcp] fatal:", e);
  process.exit(1);
});
