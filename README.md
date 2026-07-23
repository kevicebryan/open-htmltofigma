# Open HTML to Figma

Open-source Figma desktop plugin that turns a **local HTML file** into nested, editable Figma layers that match the rendered page.

Upload or paste HTML. The plugin lays it out in a real browser document at your chosen viewport, measures computed geometry and styles, then rebuilds the page as Frames, Text, and image fills — without rewriting flex/grid into Auto Layout.

**Vibe coded by [Kevin](https://kevbry.in)** · [kevbry.in](https://kevbry.in)

<p align="center">
  <img src="docs/browser-source.png" alt="Source HTML page rendered in the browser" width="720" />
</p>

<p align="center"><em>Source HTML in the browser</em></p>

<p align="center">
  <img src="docs/figma-result.png" alt="Same page imported into Figma as nested layers via Open HTML to Figma" width="720" />
</p>

<p align="center"><em>Same page imported into Figma (1440×6389 nested layers)</em></p>

---

## Features

- **Local HTML only** — paste or upload `.html` / `.htm` (no URL crawling)
- **Viewport presets** — Desktop 1440 · Laptop 1280 · Tablet 768 · Mobile 390
- **Browser-accurate layout** — flex, grid, padding, and positioning come from real layout, not a CSS reimplementation
- **Editable output** — nested Frames + Text layers (not a flat screenshot of the whole page)
- **Visual fidelity** — colors, linear gradients, borders, radii, shadows, opacity
- **Complex backgrounds** — radial / layered photo blocks rasterized when needed
- **SVG & images** — rasterized into image fills
- **Optional component** — import the root as a Figma Component
- **Color styles** — unique colors collected under `HTML/…`

---

## Requirements

- [Figma desktop](https://www.figma.com/downloads/) (plugins need the desktop app)
- Node.js 18+

---

## Install (development)

```bash
git clone <this-repo-url>
cd open-htmltofigma
npm install
npm run build
```

1. Open Figma desktop → **Plugins → Development → Import plugin from manifest…**
2. Select this repo’s `manifest.json`
3. Run **Plugins → Development → Open HTML to Figma**

After code changes, run `npm run build` and relaunch the plugin. Re-import the manifest if `networkAccess` in `manifest.json` changes (needed for Google Fonts).

---

## Usage

1. Pick a viewport (Desktop is a good default)
2. Upload an `.html` file, or paste HTML into the text area
3. Optionally check **Create the imported desktop as a component**
4. Click **Import to Figma**

The plugin selects and zooms to the imported frame when it’s done.

### Tips for a close match

- Prefer a **full HTML document** with inline `<style>` (and font `<link>`s for web fonts)
- **Install the page fonts in Figma** (e.g. Playfair Display, Figtree) so type isn’t substituted
- Use the same viewport width you’d design at
- Self-contained assets (inline CSS, data-URL images) import more reliably than cross-origin URLs

Try the files in [`examples/`](examples/) for a quick smoke test.

---

## How it works

```
Local HTML
  → render in an isolated browser document at the chosen width
  → wait for fonts / images
  → measure DOM (getBoundingClientRect + getComputedStyle)
  → send a serializable tree + raster bytes to the Figma main thread
  → create Frames / Text / image rectangles with parent-relative positions
```

The browser is the layout engine. Imported layers use **absolute positions** that match the measured page. Responsive reflow is not rebuilt as Figma Auto Layout (by design for v1 visual parity).

---

## Project layout

| Path | Role |
|------|------|
| `ui.html` | Plugin UI, file validation, isolated render + DOM capture |
| `code.ts` → `code.js` | Figma main thread — builds nodes from the serialized tree |
| `manifest.json` | Plugin entry + network permissions (Google Fonts) |
| `examples/` | Sample HTML for manual testing |
| `docs/` | README screenshots |

```bash
npm run build   # compile code.ts → code.js
npm run watch   # rebuild on change
```

---

## Limitations

Exact browser pixels are not always representable as editable Figma objects. Expect to refine:

- Page fonts that aren’t installed in Figma (substituted faces / metrics)
- CSS filters, transforms, blend modes, masks, animations
- Very complex clipping
- Externally hosted images blocked by CORS or missing from the local file
- Mixed inline text styles inside one element (e.g. `<p><strong>…</strong></p>`) — not fully preserved as range styles yet
- Decorative `::before` / `::after` may be approximated

When something can’t be rebuilt as editable layers, the plugin prefers a **localized raster fallback** over dropping the visual.

---

## Contributing

Issues and PRs are welcome. For visual changes, test against `examples/` in Figma desktop and include a before/after note when you can.

Suggested directions (also sketched in `AGENT_HANDOFF.md`):

- Native `figma.createNodeFromSvg()` for inline SVG
- Mixed text range styles
- High-confidence Auto Layout inference for simple flex containers
- Golden tests for serialized layout snapshots

---

## License

MIT © [Kevin Bryan](https://kevbry.in) — see [LICENSE](LICENSE).

Vibe coded by [Kevin](https://kevbry.in).
