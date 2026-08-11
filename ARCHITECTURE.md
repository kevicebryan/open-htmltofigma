# Architecture

## Goal

Local HTML file → Figma layers that **look like the rendered page**.

Not in scope: URL crawling, site-wide import, or rewriting flex as Figma Auto Layout.

## Pipeline

1. **UI** loads the HTML into a sandboxed iframe at a chosen viewport width (so media queries match desktop/tablet/mobile).
2. Wait for **fonts**, expand collapsed panels if needed.
3. Walk the DOM. For each visible element, record:
   - `getBoundingClientRect()` (x, y, width, height vs page origin)
   - computed styles (fill, per-corner radius, opacity, effects, type, direction, whitespace)
   - visual text lines grouped by vertical position so bidi fragments do not look like extra lines
   - inline SVG with recursively resolved computed paint styles
   - rasterized `<img>` and unsupported background subtrees as PNG bytes
4. **Main thread** inventories available fonts, resolves the closest CSS-compatible face, and rebuilds Frames, direction-aware Text, native vectors, and rectangles with image fills.
5. Child positions are **parent-relative** (`child.x - parent.x`), so nesting matches the DOM while layout matches the browser.

Flex, grid, absolute CSS, etc. are handled by the browser. We only measure the result.

The iframe uses an explicit width and height for each preset. Its viewport is not resized to the document after load because doing so changes `vh`, fixed-height layouts, and document `scrollHeight`.

## Fidelity fallbacks

Native Figma layers are preferred whenever their rendering model can represent the browser result. SVGs use `createNodeFromSvg` inside a separate viewport wrapper so Figma's inferred vector bounds cannot hide artwork. Simple blur/filter effects use native effects; complex background layers use a local raster fallback. Symbol-only runs that depend on per-glyph browser font fallback use transparent 2× raster layers. The completion message reports vector counts, raster fallbacks, SVG approximations, and exact font-face substitutions so fidelity loss is never silent.

## Why not Auto Layout?

Auto Layout is useful for *editing* later. For *matching* a finished page, absolute positions from real layout are more reliable. That is the intentional v1 approach.
