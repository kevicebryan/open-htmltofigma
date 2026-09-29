// Records docs/demo.html frame by frame into docs/demo.mp4 (1920×1080, 30 fps).
// Needs Node 22+, Chrome and ffmpeg. Serve the repo root first: python3 -m http.server 8765
// Usage: node docs/record.mjs [frames]   (frames limits the run, for quick previews)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = 'http://localhost:8765/docs/demo.html';
const FPS = 30;
const dir = mkdtempSync(join(tmpdir(), 'h2f-demo-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + join(dir, 'profile'),
  '--window-size=1920,1080', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { wsUrl = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
  }
  if (!wsUrl) throw new Error('Chrome did not start');

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    for (const w of waiters) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m.params); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: PAGE });
  await loaded;
  await evaluate('window.ready');

  const total = Math.ceil((await evaluate('DURATION')) / 1000 * FPS);
  const frames = Math.min(total, Number(process.argv[2]) || total);
  for (let i = 0; i < frames; i++) {
    await evaluate('render(' + (i * 1000 / FPS).toFixed(2) + ')');
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
    writeFileSync(join(dir, String(i).padStart(5, '0') + '.jpg'), Buffer.from(data, 'base64'));
    if (i % 60 === 0) console.log('frame', i, '/', frames);
  }
  ws.close();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    new URL('demo.mp4', import.meta.url).pathname]);
  console.log('wrote docs/demo.mp4');
} finally {
  chrome.kill();
  rmSync(dir, { recursive: true, force: true });
}
