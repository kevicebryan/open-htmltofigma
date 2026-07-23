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
| Colors, linear gradients, borders, shadows | Fills / strokes / effects |
| Text | Editable Text layers |
| SVG / images / complex backgrounds | Image fills (raster when needed) |

**Closer match:** full document + inline CSS, install page fonts in Figma, same viewport you’d design at. Try [`examples/`](examples/).

## How it works

```
HTML → isolated browser layout → measure DOM → Frames / Text / images in Figma
```

Absolute positions from real layout (not Auto Layout rewrite). That’s intentional for visual parity.

## Limits

Font substitution if faces aren’t in Figma; filters/transforms/masks/animations; CORS images; mixed inline text styles. Unsupported looks fall back to a local raster instead of disappearing.

## License

MIT — see [LICENSE](LICENSE).
