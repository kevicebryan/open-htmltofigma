# Architecture

## Goal

Local HTML file → Figma layers that **look like the rendered page**.

Not in scope: URL crawling, site-wide import, or rewriting flex as Figma Auto Layout.

## Pipeline

1. **UI** (`ui.html`) loads the HTML into a sandboxed iframe sized like a real window (e.g. 1440×1024), so media queries, `vh` units and fixed elements match a browser. Picked local files are inlined first; with **Execute page scripts**, an `IntersectionObserver` shim runs before the page's own scripts.
2. Wait for fonts and images (lazy images forced eager), then settle the page: finish entrance animations and transitions, pause loops at their first frame, and stop timers.
3. Walk the DOM (including open shadow roots). For each rendered box, record:
   - its border box from `getBoundingClientRect()`, measured with rotation/scale temporarily cleared (the transform is sent separately and re-applied in Figma)
   - paints, bottom → top: background color, gradients converted to Figma gradient transforms, and `url()` / `<img>` pixels drawn exactly as `background-size` / `object-fit` place them
   - per-side strokes and per-corner radii, shadows, blurs, opacity and blend mode
4. `::before` / `::after` are turned into real elements (all computed styles copied) while their parent is measured, so the browser lays them out.
5. Inline content (text plus inline elements) becomes **one rich-text layer** per block, with a run per style. Line boxes come from `Range.getClientRects()`, and inline padding is carried as letter-spacing. The layer also records where the browser broke lines; if Figma's copy of the font would wrap differently, the main thread re-applies those breaks as soft line breaks.
6. SVG is sent as markup with computed styles baked into attributes and `<use>` resolved, then imported with `figma.createNodeFromSvg`. Native form controls, CSS triangles and multi-colour borders are drawn as small SVGs too.
7. The **main thread** (`code.ts`) resolves fonts once (`listAvailableFontsAsync`), creates images, and rebuilds Frames / Text / vectors with parent-relative positions.

Flex, grid, absolute CSS, etc. are handled by the browser. We only measure the result.

## Why not Auto Layout?

Auto Layout is useful for *editing* later. For *matching* a finished page, absolute positions from real layout are more reliable. That is the intentional v1 approach.
