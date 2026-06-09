// Persistent, on-disk project store for the appscreen MCP server.
//
// Projects used to live ONLY in the browser's IndexedDB. This module makes the
// project's *disk* the source of truth: each project is one JSON file under
// PROJECTS_DIR, in the exact shape the web app persists (see saveState() in
// app.js) plus a top-level `name` and `updatedAt`. Images are kept inline as
// data URLs so a record round-trips losslessly between the browser and disk.
//
// Both the MCP tools (for Claude) and the REST endpoints (for the web app)
// read/write through the helpers here, so the two stay in sync.

import { mkdir, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getFile as getUploadedFile } from "./filestore.js";

// ---------- Location on disk ----------

// Default: a `projects/` folder next to wherever the server is launched from
// (the repo root when started via .mcp.json). Override with APPSCREEN_PROJECTS_DIR.
export const PROJECTS_DIR = process.env.APPSCREEN_PROJECTS_DIR
  ? resolve(process.env.APPSCREEN_PROJECTS_DIR)
  : resolve(process.cwd(), "projects");

let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(PROJECTS_DIR, { recursive: true });
  dirReady = true;
}

// ids come from the app (`default`, `project_<ts>`) or a tool. Keep them to a
// filesystem-safe charset so they can never escape PROJECTS_DIR.
function safeId(id: string): string {
  const clean = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new Error("invalid project id");
  return clean;
}

function fileFor(id: string): string {
  return join(PROJECTS_DIR, `${safeId(id)}.json`);
}

// ---------- Content-addressed image blob store ----------
// Images are stored once, by content hash, in a global `.blobs` dir (dedup across
// languages AND projects). Project files keep only refs ("appdisk://<hash>.<ext>"),
// so they stay tiny — the web app uploads image bytes separately as binary,
// avoiding the giant base64 JSON that hit body-size limits and was slow.

const BLOBS_DIR = join(PROJECTS_DIR, ".blobs");
const REF_PREFIX = "appdisk://";

let blobsReady = false;
async function ensureBlobsDir(): Promise<void> {
  if (blobsReady) return;
  await mkdir(BLOBS_DIR, { recursive: true });
  blobsReady = true;
}

function safeBlobName(name: string): string {
  const clean = String(name || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!clean || clean.includes("..")) throw new Error("invalid blob name");
  return clean;
}

const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp",
};
const mimeFromExt = (ext: string) => EXT_MIME[ext.toLowerCase()] || "application/octet-stream";
const extFromMime = (m: string) =>
  (m.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");

export async function blobExists(name: string): Promise<boolean> {
  try { await stat(join(BLOBS_DIR, safeBlobName(name))); return true; } catch { return false; }
}
export async function putBlob(name: string, buf: Buffer): Promise<void> {
  await ensureBlobsDir();
  const p = join(BLOBS_DIR, safeBlobName(name));
  // Content-addressed → if it already exists the bytes are identical; skip rewrite.
  if (!(await blobExists(name))) await writeFile(p, buf);
}
export async function getBlob(name: string): Promise<Buffer | null> {
  try { return await readFile(join(BLOBS_DIR, safeBlobName(name))); } catch { return null; }
}
/** Of the given blob names, return those NOT yet on disk (so the client only uploads new ones). */
export async function missingBlobs(names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of names || []) { if (!(await blobExists(n))) out.push(n); }
  return out;
}

// ---------- Garbage collection of orphaned blobs ----------
// Blobs are content-addressed and shared across languages/screenshots/projects, so
// they are never deleted inline (a blob a user "deletes" in one place may still be
// referenced elsewhere). Instead, a mark-and-sweep reclaims blobs referenced by NO
// project. A grace period protects freshly-uploaded blobs whose project record
// hasn't been written yet (the upload→PUT window), so GC can run anytime safely.

const GC_GRACE_MS = 60 * 60 * 1000; // 1h
let gcRunning = false;

function collectRefs(obj: any, out: Set<string>): void {
  if (Array.isArray(obj)) {
    for (const v of obj) collectRefs(v, out);
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) collectRefs(obj[k], out);
  } else if (typeof obj === "string" && obj.startsWith(REF_PREFIX)) {
    out.add(obj.slice(REF_PREFIX.length));
  }
}

export interface GcResult { deleted: number; freedBytes: number; kept: number; skippedYoung: number }

/** Delete blobs referenced by no project (and older than the grace period). */
export async function gcBlobs(opts: { graceMs?: number } = {}): Promise<GcResult> {
  const empty: GcResult = { deleted: 0, freedBytes: 0, kept: 0, skippedYoung: 0 };
  if (gcRunning) return empty; // never overlap two sweeps
  gcRunning = true;
  try {
    await ensureDir();
    await ensureBlobsDir();
    // Mark: every blob name referenced by any project on disk.
    const referenced = new Set<string>();
    const files = (await readdir(PROJECTS_DIR)).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try { collectRefs(JSON.parse(await readFile(join(PROJECTS_DIR, f), "utf8")), referenced); }
      catch { /* skip unreadable / non-project file */ }
    }
    // Sweep: remove unreferenced blobs that are past the grace period.
    const res: GcResult = { deleted: 0, freedBytes: 0, kept: 0, skippedYoung: 0 };
    const now = Date.now();
    const grace = opts.graceMs ?? GC_GRACE_MS;
    let blobFiles: string[] = [];
    try { blobFiles = await readdir(BLOBS_DIR); } catch { blobFiles = []; }
    for (const name of blobFiles) {
      if (referenced.has(name)) { res.kept++; continue; }
      const full = join(BLOBS_DIR, name);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs < grace) { res.skippedYoung++; continue; } // may be mid-upload
        await rm(full);
        res.deleted++;
        res.freedBytes += st.size;
      } catch { /* file vanished or unreadable — ignore */ }
    }
    return res;
  } finally {
    gcRunning = false;
  }
}

const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith(REF_PREFIX);

async function walkStrings(obj: any, fn: (v: any) => Promise<any>): Promise<void> {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = await visit(obj[i], fn);
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) obj[k] = await visit(obj[k], fn);
  }
}
async function visit(v: any, fn: (v: any) => Promise<any>): Promise<any> {
  const mapped = await fn(v);
  if (mapped !== v) return mapped;
  if (v && typeof v === "object") await walkStrings(v, fn);
  return v;
}

// Replace inline data:image URLs with refs, writing each unique image to the blob
// store. Leaves existing refs untouched. Used by saveProject so MCP-tool data URLs
// are externalized too.
async function externalizeRecord(rec: ProjectRecord): Promise<void> {
  await ensureBlobsDir();
  await walkStrings(rec, async (v) => {
    if (typeof v === "string" && v.startsWith("data:image/")) {
      const comma = v.indexOf(",");
      const header = v.slice(5, comma);
      const mime = header.split(";")[0] || "image/png";
      const buf = Buffer.from(v.slice(comma + 1), /;base64/i.test(header) ? "base64" : "utf8");
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 40);
      const name = `${hash}.${extFromMime(mime)}`;
      await putBlob(name, buf);
      return REF_PREFIX + name;
    }
    return v;
  });
}

// Inverse: replace refs with reconstructed data URLs (for the browser, which
// expects data URLs in screenshot.src / localizedImages[].src).
async function inlineRecord(rec: ProjectRecord): Promise<void> {
  await walkStrings(rec, async (v) => {
    if (isRef(v)) {
      const name = v.slice(REF_PREFIX.length);
      const buf = await getBlob(name);
      if (!buf) return v; // missing blob — leave the ref rather than corrupt
      const ext = (name.split(".").pop() || "png").toLowerCase();
      return `data:${mimeFromExt(ext)};base64,${buf.toString("base64")}`;
    }
    return v;
  });
}


// ---------- Record shape (mirrors the web app's persisted project) ----------

export interface ProjectRecord {
  id: string;
  name?: string;
  formatVersion?: number;
  screenshots: any[];
  selectedIndex?: number;
  outputDevice?: string;
  customWidth?: number;
  customHeight?: number;
  currentLanguage?: string;
  projectLanguages?: string[];
  defaults?: any;
  updatedAt?: string;
  [k: string]: any;
}

// ---------- CRUD ----------

export async function listProjects(): Promise<
  { id: string; name: string; screenshotCount: number; languages: string[]; updatedAt?: string }[]
> {
  await ensureDir();
  const files = (await readdir(PROJECTS_DIR)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await readFile(join(PROJECTS_DIR, f), "utf8")) as ProjectRecord;
      out.push({
        id: rec.id || f.replace(/\.json$/, ""),
        name: rec.name || rec.id || f.replace(/\.json$/, ""),
        screenshotCount: Array.isArray(rec.screenshots) ? rec.screenshots.length : 0,
        languages: rec.projectLanguages || ["en"],
        updatedAt: rec.updatedAt,
      });
    } catch {
      // skip unreadable / non-project files
    }
  }
  out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return out;
}

export async function getProject(
  id: string,
  opts: { inline?: boolean } = {},
): Promise<ProjectRecord | null> {
  await ensureDir();
  let rec: ProjectRecord;
  try {
    rec = JSON.parse(await readFile(fileFor(id), "utf8")) as ProjectRecord;
  } catch {
    return null;
  }
  // inline=true rebuilds data URLs from the blob store (for the browser). Default
  // returns refs (compact — used by listing and MCP read-modify-write tools).
  if (opts.inline) await inlineRecord(rec);
  return rec;
}

export async function saveProject(rec: ProjectRecord): Promise<ProjectRecord> {
  await ensureDir();
  if (!rec || !rec.id) throw new Error("project record needs an id");
  rec.id = safeId(rec.id);
  if (!Array.isArray(rec.screenshots)) rec.screenshots = [];
  // Externalize any inline data URLs to the blob store (no-op for refs the web
  // app already uploaded). Keeps project.json tiny and dedups image bytes.
  await externalizeRecord(rec);
  rec.updatedAt = new Date().toISOString();
  await writeFile(fileFor(rec.id), JSON.stringify(rec));
  return rec;
}

export async function deleteProject(id: string): Promise<boolean> {
  await ensureDir();
  try {
    await rm(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

// ---------- Defaults for new projects / screenshots ----------
// Kept in lock-step with state.defaults in app.js so server-created projects
// open cleanly in the web app.

function defaultRecord(id: string, name: string): ProjectRecord {
  return {
    id: safeId(id),
    name,
    formatVersion: 2,
    screenshots: [],
    selectedIndex: 0,
    outputDevice: "iphone-6.9",
    customWidth: 1290,
    customHeight: 2796,
    currentLanguage: "en",
    projectLanguages: ["en"],
    defaults: defaultSettings(),
  };
}

function defaultSettings() {
  return {
    background: {
      type: "gradient",
      gradient: { angle: 135, stops: [{ color: "#667eea", position: 0 }, { color: "#764ba2", position: 100 }] },
      solid: "#1a1a2e",
      image: null,
      imageFit: "cover",
      imageBlur: 0,
      overlayColor: "#000000",
      overlayOpacity: 0,
      noise: false,
      noiseIntensity: 10,
    },
    screenshot: {
      scale: 70, y: 60, x: 50, rotation: 0, perspective: 0, cornerRadius: 24,
      deviceModel2D: "iphone", bezelEnabled: false, spanScreens: 1,
      use3D: false, device3D: "iphone", rotation3D: { x: 0, y: 0, z: 0 },
      shadow: { enabled: true, color: "#000000", blur: 40, opacity: 30, x: 0, y: 20 },
      frame: { enabled: false, color: "#1d1d1f", width: 12, opacity: 100, notch: "none" },
    },
    text: {
      headlineEnabled: true, headlineBgColor: "#000000", headlineBgOpacity: 0,
      subheadlineBgColor: "#000000", subheadlineBgOpacity: 0, subheadlineSpacing: 0,
      perScreenText: false, panelHeadlines: {}, panelSubheadlines: {},
      headlines: { en: "" }, headlineLanguages: ["en"], currentHeadlineLang: "en",
      headlineFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
      headlineSize: 100, headlineWeight: "600", headlineItalic: false,
      headlineUnderline: false, headlineStrikethrough: false, headlineColor: "#ffffff",
      perLanguageLayout: false,
      languageSettings: { en: { headlineSize: 100, subheadlineSize: 50, position: "top", offsetY: 12, lineHeight: 110 } },
      currentLayoutLang: "en", position: "top", offsetY: 12, lineHeight: 110,
      subheadlineEnabled: false, subheadlines: { en: "" }, subheadlineLanguages: ["en"],
      currentSubheadlineLang: "en", subheadlineFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
      subheadlineSize: 50, subheadlineWeight: "400", subheadlineItalic: false,
      subheadlineUnderline: false, subheadlineStrikethrough: false,
      subheadlineColor: "#ffffff", subheadlineOpacity: 70,
    },
    elements: [],
    popouts: [],
  };
}

export async function createProject(name: string, id?: string): Promise<ProjectRecord> {
  const newId = id || `project_${Date.now()}`;
  if (await getProject(newId)) throw new Error(`project already exists: ${newId}`);
  return saveProject(defaultRecord(newId, name || "Untitled Project"));
}

function newScreenshot(rec: ProjectRecord, name: string): any {
  const d = rec.defaults || defaultSettings();
  const clone = (o: any) => JSON.parse(JSON.stringify(o));
  return {
    src: "",
    name: name || `Screen ${rec.screenshots.length + 1}`,
    deviceType: undefined,
    localizedImages: {},
    background: clone(d.background),
    screenshot: clone(d.screenshot),
    text: clone(d.text),
    elements: [],
    popouts: [],
    overrides: {},
  };
}

// ---------- Per-language mutation helpers ----------

function addLanguage(rec: ProjectRecord, lang: string): void {
  if (!lang) return;
  if (!Array.isArray(rec.projectLanguages)) rec.projectLanguages = ["en"];
  if (!rec.projectLanguages.includes(lang)) rec.projectLanguages.push(lang);
}

function ensureLangArray(obj: any, key: string, lang: string): void {
  if (!Array.isArray(obj[key])) obj[key] = [];
  if (!obj[key].includes(lang)) obj[key].push(lang);
}

/** Set headline and/or subheadline text on a screenshot, for one or many languages. */
export function setScreenshotText(
  rec: ProjectRecord,
  index: number,
  opts: {
    language?: string;
    headline?: string;
    subheadline?: string;
    headlines?: Record<string, string>;
    subheadlines?: Record<string, string>;
  },
): void {
  const s = rec.screenshots[index];
  if (!s) throw new Error(`no screenshot at index ${index}`);
  if (!s.text) s.text = JSON.parse(JSON.stringify((rec.defaults || defaultSettings()).text));
  const t = s.text;
  if (!t.headlines) t.headlines = {};
  if (!t.subheadlines) t.subheadlines = {};

  const lang = opts.language || rec.currentLanguage || "en";

  const headMap = opts.headlines || (opts.headline !== undefined ? { [lang]: opts.headline } : null);
  if (headMap) {
    for (const [l, v] of Object.entries(headMap)) {
      t.headlines[l] = v;
      ensureLangArray(t, "headlineLanguages", l);
      addLanguage(rec, l);
    }
    t.headlineEnabled = true;
  }

  const subMap = opts.subheadlines || (opts.subheadline !== undefined ? { [lang]: opts.subheadline } : null);
  if (subMap) {
    for (const [l, v] of Object.entries(subMap)) {
      t.subheadlines[l] = v;
      ensureLangArray(t, "subheadlineLanguages", l);
      addLanguage(rec, l);
    }
    t.subheadlineEnabled = true;
  }
}

/**
 * Set a screenshot's background (gradient or solid). `target` is a screenshot
 * index, or "all" to apply the same background to every screenshot (the app's
 * "Sync design to all screens"). Only the fields present in `patch` are changed;
 * the rest of the background (overlay, noise, image-fit, …) is preserved.
 * Returns the list of screenshot indices that were updated.
 */
export function setScreenshotBackground(
  rec: ProjectRecord,
  target: number | "all",
  patch: {
    type?: "gradient" | "solid" | "image";
    gradient?: { angle: number; stops: { color: string; position: number }[] };
    solid?: string;
    overlayColor?: string;
    overlayOpacity?: number;
    noise?: boolean;
    noiseIntensity?: number;
  },
): number[] {
  const idxs = target === "all" ? rec.screenshots.map((_, i) => i) : [target];
  if (idxs.length === 0) throw new Error("project has no screenshots");
  const applied: number[] = [];
  for (const i of idxs) {
    const s = rec.screenshots[i];
    if (!s) throw new Error(`no screenshot at index ${i}`);
    if (!s.background) s.background = JSON.parse(JSON.stringify(defaultSettings().background));
    const b = s.background;
    if (patch.type) b.type = patch.type;
    if (patch.gradient) b.gradient = patch.gradient;
    if (patch.solid != null) b.solid = patch.solid;
    if (patch.overlayColor != null) b.overlayColor = patch.overlayColor;
    if (patch.overlayOpacity != null) b.overlayOpacity = patch.overlayOpacity;
    if (patch.noise != null) b.noise = patch.noise;
    if (patch.noiseIntensity != null) b.noiseIntensity = patch.noiseIntensity;
    applied.push(i);
  }
  return applied;
}

/** Set the screenshot image for a given language (data URL). */
export function setScreenshotImage(
  rec: ProjectRecord,
  index: number,
  dataUrl: string,
  opts: { language?: string; name?: string } = {},
): void {
  const s = rec.screenshots[index];
  if (!s) throw new Error(`no screenshot at index ${index}`);
  const lang = opts.language || rec.currentLanguage || "en";
  const name = opts.name || s.name || `image_${lang}`;
  if (!s.localizedImages) s.localizedImages = {};
  s.localizedImages[lang] = { src: dataUrl, name };
  // Keep the legacy single-image field pointed at the project's current language
  // so older render paths and previews still find an image.
  if (lang === (rec.currentLanguage || "en") || !s.src) s.src = dataUrl;
  addLanguage(rec, lang);
}

/** Append a new (optionally image-bearing) screenshot; returns its index. */
export function addScreenshot(
  rec: ProjectRecord,
  opts: { name?: string; image?: string; language?: string } = {},
): number {
  const s = newScreenshot(rec, opts.name || "");
  rec.screenshots.push(s);
  const index = rec.screenshots.length - 1;
  if (opts.image) setScreenshotImage(rec, index, opts.image, { language: opts.language, name: opts.name });
  return index;
}

// ---------- Image resolution (input form → data URL) ----------

function detectMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return "image/webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  const head = buf.slice(0, 64).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return "image/png";
}

// Accepts the same image forms as render.ts (data URL, appscreen-file:// ref,
// http(s) URL, raw base64, or a server path) and returns an inline data URL
// suitable for storing in a project record.
export async function resolveImageToDataUrl(input: string): Promise<string> {
  if (input.startsWith("data:")) return input;

  let buf: Buffer;
  let mime: string | undefined;

  if (input.startsWith("appscreen-file://")) {
    const id = input.slice("appscreen-file://".length).replace(/\.[a-z0-9]+$/i, "");
    const f = getUploadedFile(id);
    if (!f) throw new Error(`appscreen-file not found or expired: ${id}`);
    buf = f.buf;
    mime = f.mime;
  } else if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch image (HTTP ${res.status}): ${input}`);
    buf = Buffer.from(await res.arrayBuffer());
    mime = res.headers.get("content-type")?.split(";")[0] || undefined;
  } else {
    const compact = input.replace(/\s+/g, "");
    if (/^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|Qk[01]|AAAA)/.test(compact)) {
      buf = Buffer.from(compact, "base64");
    } else {
      buf = await readFile(input);
    }
  }

  if (!mime) mime = detectMime(buf);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ---------- Summaries (compact view for tool responses) ----------

// Replace inline data URLs with a short descriptor so tool output stays small.
function shrinkImageRef(src: any): any {
  if (typeof src !== "string") return src;
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    const approxBytes = Math.floor(((src.length - comma - 1) * 3) / 4);
    return `<inline image, ~${approxBytes} bytes>`;
  }
  return src;
}

export function summarizeProject(rec: ProjectRecord): any {
  return {
    id: rec.id,
    name: rec.name,
    outputDevice: rec.outputDevice,
    currentLanguage: rec.currentLanguage,
    projectLanguages: rec.projectLanguages || ["en"],
    screenshotCount: rec.screenshots.length,
    updatedAt: rec.updatedAt,
    screenshots: rec.screenshots.map((s: any, i: number) => ({
      index: i,
      name: s.name,
      languages: s.localizedImages ? Object.keys(s.localizedImages) : [],
      images: s.localizedImages
        ? Object.fromEntries(
            Object.entries(s.localizedImages).map(([l, v]: [string, any]) => [
              l,
              { name: v?.name, image: shrinkImageRef(v?.src) },
            ]),
          )
        : {},
      headlines: s.text?.headlines || {},
      subheadlines: s.text?.subheadlines || {},
      headlineEnabled: s.text?.headlineEnabled ?? true,
      subheadlineEnabled: s.text?.subheadlineEnabled ?? false,
    })),
  };
}
