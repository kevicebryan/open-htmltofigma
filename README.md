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
| Structure, flex/grid layout | Nested Frames at measured positions |
| Colors, gradients, asymmetric radii, shadows | Fills / strokes / effects |
| LTR and RTL text | Direction-aware editable Text layers with browser whitespace and closest available font weights |
| SVG | Editable vectors with computed colors, rotation, opacity, and brightness |
| Images / complex backgrounds | Correctly fitted image fills; selective raster fallback when needed |
| Fallback-only symbols and emoji | Crisp transparent glyph layers rendered by the browser |

**Closer match:** use a full document with inline CSS, install page fonts in Figma, and choose the matching viewport preset. Mobile capture uses a `390 × 844` viewport so fixed-height app screens and viewport units are measured predictably. Try [`examples/`](examples/).

After each import, the plugin reports vector SVGs, raster fallbacks, approximated SVGs, and font-face substitutions. A substitution includes the requested and selected family, style, and numeric weight; treat it as a signal to install the requested face before comparing visual fidelity.

**JS-rendered pages** (content built by an inline `<script>`, not present in the raw HTML): tick **Execute page scripts** before importing. Off by default — only enable it for HTML you trust, since it lets the page’s own script run.

## How it works

```
HTML → isolated browser layout → measure DOM → Frames / Text / images in Figma
```

Absolute positions from real layout (not Auto Layout rewrite). That’s intentional for visual parity.

## Fidelity behavior

The converter favors editable native Figma layers. It resolves logical `start` / `end` text alignment from each element's computed direction, applies computed CSS whitespace rules, groups bidi fragments into visual lines, and protects browser-single-line text from Figma rewrapping. Text-only flex, grid, padded, and painted elements remain Frames with independently measured text children, preserving internal alignment and spacing. Browser text bounds and line-height leading are translated into Figma coordinates to reduce baseline drift.

Numeric or neutral text that cannot communicate its paragraph direction to Figma receives a zero-width Unicode direction hint. This preserves browser ordering for RTL percentages such as `١٠٠٪` without changing ordinary Arabic text. Font faces are selected from Figma's available-font inventory using CSS weight fallback order, so a missing `600` face prefers `700` before a lighter face.

Supported inline SVGs remain vectors. Their imported artwork is kept unclipped inside a separate wrapper that owns the browser's SVG viewport, opacity, and effects. Unsupported visual backgrounds are rasterized at the smallest useful subtree. Symbol-only runs that depend on browser font fallback are rendered as transparent 2× glyph layers because Figma cannot reproduce per-glyph browser fallback reliably.

## Limits

Font substitution if faces aren’t in Figma; complex 3D transforms, masks, animations, and some multi-layer CSS paints; CORS-restricted images; mixed inline text styles. Supported opacity, brightness, layer blur, and backdrop blur are translated to Figma effects. Unsupported looks and fallback-dependent symbol runs use a local raster instead of disappearing and are reported after import.

## License

MIT — see [LICENSE](LICENSE).
