# appscreen MCP server

An [MCP](https://modelcontextprotocol.io) server that generates App Store / Play Store / web
marketing screenshots, server-side. It's a Node port of the 2D rendering pipeline from
[appscreen](../README.md) (`app.js`): same output sizes, the same 25 gradient presets, and the
same background / device-placement / text-overlay math — rendered headlessly with
[`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (no browser, no Puppeteer).

## Install & build

```bash
cd mcp-server
npm install      # also builds via the prepare script
npm run build    # or rebuild manually
```

## Run

```bash
# stdio (default) — for Claude Desktop / Claude Code
npm start

# Streamable HTTP — for remote/networked clients
npm run start:http            # listens on http://localhost:3000/mcp
PORT=8787 node dist/server.js --http
```

The transport is chosen by `--http` (or `MCP_TRANSPORT=http`); otherwise stdio.

## Tools

| Tool | What it does |
|------|--------------|
| `list_output_sizes` | All device/web output sizes (key → pixel dimensions). |
| `list_gradient_presets` | The 25 built-in presets (name → CSS + parsed angle/stops). |
| `generate_screenshot` | Render one screenshot → returns a PNG (and optionally writes `outputPath`). |
| `generate_batch` | Render up to 50 screenshots in one call. |

### `generate_screenshot` input (abridged)

```jsonc
{
  "outputDevice": "iphone-6.9",          // or omit and pass width/height
  "background": {
    "type": "gradient",                   // gradient | solid | image
    "preset": "Synthwave Dusk",           // or gradientCss / gradient / solid / image
    "noise": true, "noiseIntensity": 6
  },
  "screenshot": {                          // optional device screenshot
    "image": "/abs/path/to/shot.png",      // path | data URL | base64
    "scale": 70, "x": 50, "y": 60, "cornerRadius": 24,
    "shadow": { "enabled": true, "blur": 40, "opacity": 30, "y": 20 },
    "frame":  { "enabled": false }
  },
  "text": {
    "position": "top", "offsetY": 8,
    "headline":    { "text": "Plan your\nadventures", "size": 130, "weight": "700", "color": "#ffffff" },
    "subheadline": { "enabled": true, "text": "Offline maps included", "size": 56, "opacity": 80 }
  },
  "outputPath": "/abs/path/to/out.png"     // optional; otherwise PNG is returned inline
}
```

Defaults mirror appscreen (`scale 70`, `y 60`, `cornerRadius 24`, headline `100/600`,
subheadline `50/400` at 70% opacity, drop shadow on).

### Full parameter coverage

The server supports **every** parameter of appscreen's 2D pipeline, in the app's exact
layer order (`background → noise → elements[behind] → screenshot → elements[above-screenshot]
→ popouts → text → elements[above-text]`):

- **Background** — `gradient` (preset / raw CSS / explicit angle+stops), `solid`, or `image`
  (`cover`/`contain`/`stretch`, blur, color overlay), plus `noise` + `noiseIntensity`.
- **Screenshot** — `scale`, `x`, `y`, `rotation`, `perspective`, `cornerRadius`, `shadow`
  (color/blur/opacity/offset), `frame` (device border).
- **Text** — headline + subheadline, each with font/size/weight/italic/underline/strikethrough/
  color/opacity, plus `position`, `offsetY`, `lineHeight`.
- **`elements[]`** — free-floating overlays on any layer:
  - `text` (with per-language `texts`, and decorative `frame`: `laurel-simple`, `laurel-detailed`,
    `badge-circle`, `badge-ribbon`, append `-star` for a star — e.g. `laurel-detailed-star`),
  - `emoji`, `icon` (square, with `iconShadow`), `graphic` (aspect-preserving image).
- **`popouts[]`** — cropped zoom callouts of the screenshot (`crop*`, position/size, rotation,
  `cornerRadius`, `shadow`, `border`).
- **Multi-language** — set a top-level `language` (default `"en"`); any `texts: {en, fr, …}`
  map on a headline, subheadline, or text element is resolved against it (falls back to `en`,
  then any value, then the plain `text`). One spec → render once per locale.

Laurel frames load SVGs from appscreen's `img/` folder; override the location with
`APPSCREEN_ASSETS_DIR` if you run the server from elsewhere.

### Avoid text/screenshot overlap (`layout`)

App Store headlines wrap to different line counts per language, which can make a
fixed screenshot placement collide with the text. Turn on `layout.avoidTextOverlap`
and the renderer measures the headline+subheadline block and constrains the
screenshot to the free band below (text on top) or above (text on bottom):

```jsonc
{
  "screenshot": { "scale": 84, "y": 100 },   // generous; treated as an upper bound
  "text": { "position": "top", "headline": { "texts": { "en": "…", "fr": "…" } } },
  "layout": { "avoidTextOverlap": true, "gap": 3.5 }  // gap = % of canvas height
}
```

The screenshot only ever moves down/up and shrinks to fit — it never grows past the
requested `scale`. Set `y` toward the far edge (e.g. `100` for top text) and let the
layout pull it into place. This keeps every locale collision-free regardless of how
each headline wraps onto a different number of lines.

## Fonts

appscreen's default UI font is SF Pro, which isn't guaranteed on a server. Pass `font` per
text block, or set fonts globally:

```bash
APPSCREEN_FONT_FAMILY="Inter"                      # default family name
APPSCREEN_FONT_PATH="/path/Inter.ttf:/path/Bold.ttf"  # register .ttf/.otf files (':'-separated)
```

## Use with Claude Desktop / Claude Code

Add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "appscreen": {
      "command": "node",
      "args": ["/Users/valentinhalgand/dev/appscreen/mcp-server/dist/server.js"],
      "env": { "APPSCREEN_FONT_FAMILY": "Inter" }
    }
  }
}
```

Then ask: *"Generate a 6.9-inch App Store screenshot with the Synthwave Dusk gradient and the
headline 'Plan your adventures'."*
