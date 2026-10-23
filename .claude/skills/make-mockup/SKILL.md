---
name: make-mockup
description: Write a hi-fi HTML mockup (mobile app, desktop app, HTML report, invoice, slide deck, or anything the user names) to use as a fidelity fixture for the HTML → Figma plugin. Use when asked to "make a mockup", "create a test page", "generate an artifact to import", or before running figma-fidelity-test on a new kind of page.
---

# Make a mockup for fidelity testing

The goal is a page that looks like something a designer or an AI would really hand the plugin, and that exercises the features the plugin must reproduce. Save it to `examples/mockups/<kind>-<topic>.html`.

## Sizes (match the plugin's presets)

| Kind | Viewport | Body |
| --- | --- | --- |
| Mobile app | 390 × 844 | `width: 390px; height: 844px; overflow: hidden` |
| Desktop app | 1440 × 1024 | fixed 1024 height for app screens, or let a landing page grow |
| Report / article | 1440 × 1024 | centred `max-width` column, page grows |
| Invoice / document | A4 794 × 1123 or Letter 816 × 1056 | fixed page size |
| Deck | Slide 1920 × 1080 | each `<section>` 1920 × 1080, stacked (2–4 slides) |

Write the chosen size in the final message; `figma-fidelity-test` needs it.

## Rules

- **One self-contained file.** Inline `<style>`, inline `<svg>` icons, no scripts, no external images (the Figma MCP sandbox can't fetch them, and big base64 images blow the 50k script limit). Use gradients, SVG and CSS shapes for artwork.
- **Google Fonts only**, loaded with a `<link>`. Figma has them all, so a font mismatch is a real bug rather than a missing font. Vary the family between mockups (Inter, DM Sans, Plus Jakarta Sans, Manrope, Space Grotesk, Fraunces …) and use several weights.
- **Fictional data.** Invented companies, people and numbers. Label anything finance-like as illustrative. Never use a real company's name or branding with made-up figures.
- **Keep it to 60–180 elements.** Each ~35k characters of captured tree costs one Figma MCP call, and the Starter plan allows only 20 calls a month.
- **Hit a spread of features**, picking what suits the page:
  - Text: mixed inline runs (`<strong>` inside a paragraph), letter-spacing, `text-transform`, wrapped multi-line paragraphs, right-aligned numbers, tabular figures.
  - Boxes: borders (all sides and single-side), per-corner radii, pills, box-shadows, semi-transparent fills.
  - Paint: linear and radial gradients, gradient progress bars, a `::before`/`::after` pseudo-element.
  - SVG: stroke icons, a chart path with a gradient fill, a dashed line (`stroke-dasharray`), a progress ring with `stroke-dashoffset`.
  - Layout: flex and grid, tables, absolutely positioned overlays, a `transform: rotate()`.
- Make it look polished. Ugly fixtures hide real regressions because nobody can tell what "right" looks like.

## After writing

Open it in the browser pane to check it renders as intended, then hand off to `figma-fidelity-test` with the path and size.
