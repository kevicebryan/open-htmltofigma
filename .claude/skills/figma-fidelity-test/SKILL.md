---
name: figma-fidelity-test
description: Import an HTML page into real Figma through the plugin's own capture + builder code (via the Figma MCP use_figma tool) and score how faithfully it was reproduced against the browser render. Use when asked to "test the plugin in Figma", "check how well it parsed", "run a fidelity test", or after changing ui.html capture or code.ts builder logic.
---

# Figma fidelity test

This runs the plugin's own code path: `captureHtmlTree` from `ui.html` runs in headless Chrome, and the builder functions from `code.js` run inside Figma through `use_figma`. The result is compared with the browser's own render of the page. Pages usually come from the `make-mockup` skill (`examples/mockups/`).

Test file: `h69br6GXjg5xfsZOoytXqo` ("open-htmltofigma test", the user's personal team). Don't create or write to other files without asking.

## Budget first

The user's Figma plan is **Starter: 20 MCP tool calls per month**, and a rate-limit error means stop for the month. Every chunk costs one `use_figma` call. Before starting, say how many calls the run needs (chunk count, plus 1 if `chunk-00-builder.js` must be stored) and get a go-ahead when it's more than 3. Never spend calls on probes or on a separate `get_screenshot`, because the last chunk returns an inline screenshot.

## Steps

1. `npm run build` (code.js must match code.ts).
2. Capture-side regression check: serve the repo root (`python3 -m http.server 8765`), open `http://localhost:8765/test/check.html` in the browser pane and confirm `ALL PASSED`.
3. Prepare the run:
   ```bash
   node test/figma-e2e.mjs examples/mockups/<page>.html <W>x<H>
   ```
   It writes `test/out/<page>/`: `browser.png` (the reference), `tree.json`, `chunk-00-builder.js` and `chunk-01.js …` (each ≤ 34k characters, so a single Read shows all of it).
   It also prints how many pixels of `preview.png` (the tree redrawn by `test/preview.js`) differ from `browser.png`, with a red heatmap in `diff.png`. Under 1% is usually font smoothing; anything higher is a capture bug worth fixing before spending Figma calls. The preview checks the capture only, not Figma's fonts or import.
4. Load the `figma-use` skill, then run the chunks with `use_figma` (pass `skillNames: "figma-use"`):
   - `chunk-00-builder.js` stores the builder in the file under a hash of code.js. Run it only when code.js changed since the last run. If a data chunk throws `Builder … is not in this file yet`, run chunk-00 and retry.
   - Then run `chunk-01.js`, `chunk-02.js` … in order. Read each file and paste it **verbatim**, because hand edits break paths and JSON. Re-running chunk-01 replaces the previous frame named `fidelity/<page> · W×Hpx`.
   - The last chunk returns `{ rootId, missingFonts, layers }` and a screenshot.
5. Compare the Figma screenshot with `test/out/<page>/browser.png` region by region.

## Scoring

Report a short scorecard (0–10 each) and an overall score:

| Area | What to look at |
| --- | --- |
| Layout | positions, sizes, spacing, alignment, clipping |
| Typography | font family and weight, italics, size, line breaks, letter-spacing, alignment |
| Color & paint | fills, gradients, opacity, borders, radii |
| Vectors | icons, charts, dashes, rings, strokes |
| Effects | shadows, blur, transforms |

Then list each difference with a severity (**bug**: visibly wrong; **drift**: a pixel or two off; **known limit**: listed under "Current limitations" in AGENT_HANDOFF.md), and the likely cause in `ui.html` (capture) or `code.ts` (builder).

Check whether a difference comes from the test harness before blaming the plugin. `test/figma-e2e.mjs` slims the tree (drops null, empty and most `false` values, and rounds numbers). A field the builder compares against `false`, like `italic`, must survive that.

## Fixing

For a real bug: fix it in `ui.html` or `code.ts`, add an assertion to `test/check.html` when the capture side changed, re-run steps 1–4 for the affected page only, and show before and after. Keep the fixture in `examples/mockups/` so it stays a regression test.
