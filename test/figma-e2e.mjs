// Prepares an HTML page for a real-Figma fidelity test through the Figma MCP (`use_figma`).
// Renders the page in headless Chrome, runs the plugin's own capture (ui.html → captureHtmlTree),
// screenshots the browser render, then splits builder + tree into self-contained `use_figma`
// scripts under the 50k limit. chunk-00-builder.js stores the builder in the file (once per
// code.js version, keyed by hash); then paste chunk-01.js, chunk-02.js, … in order. The last one
// returns the root id and an inline screenshot.
// Needs Node 22+, Chrome and python3. Run `npm run build` first so code.js is current.
// Usage: node test/figma-e2e.mjs examples/mockups/mobile-app.html 390x844
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const [page, size = '1440x1024'] = process.argv.slice(2);
if (!page) throw new Error('usage: node test/figma-e2e.mjs <page.html> [WxH]');
const [W, H] = size.split('x').map(Number);
const name = basename(page).replace(/\.[^.]+$/, '');
const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'test/out', name);
const LIMIT = 34000; // use_figma takes 50k chars; 34k also fits one Read of the chunk
const PORT = 8766;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Builder = code.js minus the plugin UI wiring, with whole-line comments dropped to save budget.
const code = readFileSync(join(root, 'code.js'), 'utf8');
const builder = code.slice(code.indexOf('function build('))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => l.trim()).join('\n');
const KEY = 'builder-' + createHash('sha1').update(builder).digest('hex').slice(0, 10);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
const dir = mkdtempSync(join(tmpdir(), 'h2f-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + join(dir, 'profile'),
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { wsUrl = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
  }
  if (!wsUrl) throw new Error('Chrome did not start');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const open = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 100 && (await evaluate('document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

  // Capture with the plugin's real code path
  await open(`http://localhost:${PORT}/ui.html`);
  const { tree, images } = await evaluate(`(async () => {
    const html = await (await fetch('/${page}')).text();
    const tree = await captureHtmlTree(html, { width: ${W}, height: ${H}, runScripts: false });
    return { tree, images: imageStore };
  })()`);

  // Browser reference at the same size
  await open(`http://localhost:${PORT}/${page}`);
  await evaluate('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)))');
  const clip = { x: 0, y: 0, width: W, height: tree.h, scale: 1 };
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });

  // Capture preview: the tree redrawn by test/preview.js in a shadow root over the same page,
  // so the page's web fonts are loaded but its CSS can't reach the preview.
  await evaluate(`(() => {
    ${readFileSync(join(root, 'test/preview.js'), 'utf8')}
    scrollTo(0, 0);
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:${W}px;height:${tree.h}px;z-index:2147483647;overflow:hidden';
    host.attachShadow({ mode: 'open' }).appendChild(renderTree(${JSON.stringify(tree)}, ${JSON.stringify(images)}));
    document.documentElement.appendChild(host);
    return document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)));
  })()`);
  const preview = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });

  // Share of pixels that differ by more than 10% in any channel, plus a heatmap of where.
  const diff = await evaluate(`(async () => {
    const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
    const [a, b] = await Promise.all([load(${JSON.stringify(shot.data)}), load(${JSON.stringify(preview.data)})]);
    const c = document.createElement('canvas');
    c.width = a.width; c.height = a.height;
    const x = c.getContext('2d');
    x.drawImage(a, 0, 0); const pa = x.getImageData(0, 0, c.width, c.height);
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(b, 0, 0); const pb = x.getImageData(0, 0, c.width, c.height);
    const heat = x.createImageData(c.width, c.height);
    let bad = 0;
    for (let i = 0; i < pa.data.length; i += 4) {
      const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]));
      const g = 255 - pa.data[i + 1] / 4;
      if (d > 25) { bad++; heat.data.set([255, 0, 0, 255], i); } else heat.data.set([g, g, g, 255], i);
    }
    x.putImageData(heat, 0, 0);
    return { pct: Math.round(bad / (pa.data.length / 4) * 10000) / 100, png: c.toDataURL('image/png').split(',')[1] };
  })()`);
  ws.close();

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'browser.png'), Buffer.from(shot.data, 'base64'));
  writeFileSync(join(out, 'preview.png'), Buffer.from(preview.data, 'base64'));
  writeFileSync(join(out, 'diff.png'), Buffer.from(diff.png, 'base64'));

  // Smaller JSON: drop empty values, round numbers
  const slim = (v) => {
    if (Array.isArray(v)) return v.map(slim);
    if (typeof v === 'number') return Math.round(v * 1000) / 1000;
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'z' || x == null || (x === false && k !== 'italic') || (Array.isArray(x) && !x.length)) continue; // z: capture-only; italic: pickStyle compares it
      o[k] = slim(x);
    }
    return o;
  };
  const t = slim(tree);
  writeFileSync(join(out, 'tree.json'), JSON.stringify(t));

  // Plan ops: each builds one subtree under the node at `path` (null = new root).
  // A subtree too big for one script is built shallow and its children get their own ops.
  const refs = (n, set = new Set()) => {
    for (const p of (n.fills || []).concat(...(n.runs || []).map((r) => r.fills || []))) if (p.imageRef) set.add(p.imageRef);
    for (const c of n.children || []) refs(c, set);
    return set;
  };
  const frameName = `fidelity/${name} · ${W}×${H}px`;
  const head = (ops, imgs, first, last) => `const SRC = figma.root.getSharedPluginData('h2f', '${KEY}');
if (!SRC) throw new Error('Builder ${KEY} is not in this file yet: run chunk-00-builder.js first');
const { build, loadImages, loadFonts, linkColorStyles, countNodes } =
  new Function(SRC + '\\nreturn { build, loadImages, loadFonts, linkColorStyles, countNodes };')();
const NAME = ${JSON.stringify(frameName)};
const OPS = ${JSON.stringify(ops)};
const IMAGES = ${JSON.stringify(imgs)};
const page = figma.currentPage;
${first ? `for (const old of page.findAll((n) => n.parent === page && n.name === NAME)) old.remove();` : ''}
let root = page.children.find((n) => n.name === NAME);
const all = { type: 'frame', x: 0, y: 0, w: 0, h: 0, children: OPS.map((o) => o.node) };
const [images, fonts] = await Promise.all([loadImages(all, IMAGES), loadFonts(all)]);
const ctx = { images, font: fonts.get };
for (const op of OPS) {
  // ponytail: a shallow frame gets a throwaway child so build() makes a Frame, not a Rectangle
  const n = op.shallow ? Object.assign({}, op.node, { children: [{ type: 'frame', x: op.node.x, y: op.node.y, w: 1, h: 1 }] }) : op.node;
  const made = build(n, op.parent, ctx);
  if (op.shallow) made.children[0].remove();
  if (!op.path) {
    made.name = NAME;
    made.x = Math.max(0, ...page.children.map((c) => c.x + c.width)) + 200;
    made.y = 0;
    page.appendChild(made);
    root = made;
  } else {
    let p = root;
    for (const i of op.path.slice(0, -1)) p = p.children[i];
    p.appendChild(made);
  }
}
${last ? `await linkColorStyles(root);
page.selection = [root];
figma.viewport.scrollAndZoomIntoView([root]);
await root.screenshot({ scale: Math.min(2, 1800 / Math.max(root.width, root.height)) });` : ''}
return { rootId: root.id, missingFonts: fonts.missing${last ? ', layers: countNodes(root)' : ''} };`;

  const budget = LIMIT - head([], {}, true, true).length;
  const chunks = [];
  let cur = { ops: [], imgs: {}, size: 0 };
  const dropped = [];
  const flush = () => { if (cur.ops.length) chunks.push(cur); cur = { ops: [], imgs: {}, size: 0 }; };
  const add = (op) => {
    const imgs = {};
    for (const ref of refs(op.shallow ? { ...op.node, children: [] } : op.node)) {
      if (!images[ref] || cur.imgs[ref]) continue;
      if (images[ref].length > budget / 2) { dropped.push(ref); continue; }
      imgs[ref] = images[ref];
    }
    const size = JSON.stringify(op).length + Object.values(imgs).reduce((s, b) => s + b.length + 40, 0);
    if (cur.size + size > budget) flush();
    Object.assign(cur.imgs, imgs);
    cur.ops.push(op);
    cur.size += size;
    return size;
  };
  const plan = (node, path, parent) => {
    const op = { path, parent, node };
    const kids = node.children || [];
    if (path && (!kids.length || JSON.stringify(op).length < budget / 1.5)) return add(op);
    const { children, ...shallow } = node;
    add({ path, parent, node: shallow, shallow: true });
    kids.forEach((c, i) => plan(c, path ? [...path, i] : [i], { x: node.x, y: node.y }));
  };
  plan(t, null, null);
  flush();
  writeFileSync(join(out, 'chunk-00-builder.js'),
    `const SRC = ${JSON.stringify(builder)};\nif (SRC.length !== ${builder.length}) throw new Error('builder pasted wrong: ' + SRC.length + ' chars, expected ${builder.length}');\nfigma.root.setSharedPluginData('h2f', '${KEY}', SRC);\nreturn '${KEY} stored';`);
  chunks.forEach((c, i) => writeFileSync(join(out, `chunk-${String(i + 1).padStart(2, '0')}.js`), head(c.ops, c.imgs, i === 0, i === chunks.length - 1)));

  let count = 0;
  (function walk(n) { count++; (n.children || []).forEach(walk); })(t);
  console.log(`${name}: ${count} nodes, ${W}×${Math.round(t.h)}px, preview differs on ${diff.pct}% of pixels, ${chunks.length} chunk(s) → test/out/${name}/`);
  if (dropped.length) console.log(`images too large for use_figma, left out: ${dropped.length}`);
} finally {
  server.kill();
  await new Promise((r) => { chrome.once('exit', r); chrome.kill(); });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
