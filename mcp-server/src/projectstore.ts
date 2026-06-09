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

import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

export async function getProject(id: string): Promise<ProjectRecord | null> {
  await ensureDir();
  try {
    return JSON.parse(await readFile(fileFor(id), "utf8")) as ProjectRecord;
  } catch {
    return null;
  }
}

export async function saveProject(rec: ProjectRecord): Promise<ProjectRecord> {
  await ensureDir();
  if (!rec || !rec.id) throw new Error("project record needs an id");
  rec.id = safeId(rec.id);
  if (!Array.isArray(rec.screenshots)) rec.screenshots = [];
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
