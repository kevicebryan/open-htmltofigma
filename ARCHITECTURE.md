# Architecture

## Goal

Local HTML file → Figma layers that **look like the rendered page**.

Not in scope: URL crawling, site-wide import, or rewriting flex as Figma Auto Layout.

## Pipeline

1. **UI** loads the HTML into a sandboxed iframe at a chosen viewport width (so media queries match desktop/tablet/mobile).
2. Wait for **fonts**, expand collapsed panels if needed.
3. Walk the DOM. For each visible element, record:
   - `getBoundingClientRect()` (x, y, width, height vs page origin)
   - computed styles (fill, border, radius, opacity, shadow, type)
   - rasterized SVG / `<img>` as PNG bytes
4. **Main thread** rebuilds Frames / Text / rectangles with image fills.
5. Child positions are **parent-relative** (`child.x - parent.x`), so nesting matches the DOM while layout matches the browser.

Flex, grid, absolute CSS, etc. are handled by the browser. We only measure the result.

## Why not Auto Layout?

Auto Layout is useful for *editing* later. For *matching* a finished page, absolute positions from real layout are more reliable. That is the intentional v1 approach.
