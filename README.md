# Open HTML to Figma

<p align="center">
  <img src="docs/banner.png" alt="Claude design → Figma — Open HTML to Figma converter" width="100%" />
</p>

Open-source Figma plugin: turn a **local HTML file** into nested, editable layers that match the rendered page.

No URL crawling. No subscription. The browser lays it out; Figma gets matching Frames and Text.

If this saves you time, [★ star the repo](https://github.com/kevicebryan/open-htmltofigma) — it helps others find it.

<p align="center">
  <img src="docs/browser-source.png" alt="Source HTML in the browser" width="720" />
  &nbsp;
  <img src="docs/figma-result.png" alt="Imported result in Figma" width="720" />
</p>
<p align="center"><em>Browser → Figma import</em></p>

## Quick start

**Needs:** [Figma desktop](https://www.figma.com/downloads/) + Node 18+

```bash
git clone https://github.com/kevicebryan/open-htmltofigma.git
cd open-htmltofigma
npm install && npm run build
```

1. Figma → **Plugins → Development → Import plugin from manifest…** → `manifest.json`
2. Run **Open HTML to Figma**
3. Pick a viewport → upload/paste HTML → **Import to Figma**

## What you get

| HTML | Figma |
|------|--------|
| Flex / grid / absolute layout, `vh` units | Nested Frames at the measured positions (1440×1024 viewport on Desktop) |
| Paragraphs with `<b>`, `<i>`, links, inline `<code>` | One editable rich-text layer each, same line breaks as the browser |
| Solid, linear, radial and `background-clip: text` gradients | Native fills |
| Per-side borders, per-corner radii, shadows, rings, `blur()`, `backdrop-filter` | Strokes / corner radii / effects |
| Inline SVG, `<use>` sprites, `<img src="*.svg">` | Vector layers |
| Images, `background-image`, `<canvas>` charts | Image fills cropped like `object-fit` / `background-size` |
| `::before` / `::after`, list markers, form controls, `rotate()` | Matching layers |

**Closer match:** use the same viewport you'd design at, and have the page's fonts in Figma (fonts it can't find are listed after the import). Try [`examples/`](examples/).

**Local CSS / images / fonts:** pick the HTML together with its files, or use **pick its folder**, so relative `href`/`src`/`url()` references resolve.

**JS-rendered pages** (Tailwind Play CDN, content built by a `<script>`): tick **Execute page scripts**. Scroll-reveal and entrance animations are settled before measuring. Off by default; only enable it for HTML you trust, since it lets the page's own script run.

## How it works

```
HTML → isolated browser layout → measure DOM → Frames / Text / images in Figma
```

Absolute positions from real layout (not Auto Layout rewrite). That’s intentional for visual parity.

**Check:** `python3 -m http.server`, then open `http://localhost:8000/test/check.html` to run the capture on `examples/kitchen-sink.html` and assert the tree.

## Limits

Missing fonts are substituted, and Figma's copy of a font can be a little wider or narrower than the web version (optical sizes); line breaks are kept either way. Skew, 3D transforms, `clip-path` and masks keep the measured box, not the effect. Conic/repeating gradients and HTML inside SVG become images. Cross-origin iframes are placeholders.

## License

MIT — see [LICENSE](LICENSE).
