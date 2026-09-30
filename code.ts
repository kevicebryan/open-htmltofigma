/**
 * HTML → Figma — main thread
 *
 * The UI renders the HTML in a real browser and sends a tree of boxes, text
 * runs, paints and SVG markup measured from that render (page coordinates).
 * This side only rebuilds it: nested Frames with parent-relative positions,
 * rich Text, native gradients/images/vectors.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type PaintSpec =
  | { type: 'SOLID'; color: Rgba }
  | { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'; gradientTransform: Transform; gradientStops: ColorStop[] }
  | { type: 'IMAGE'; scaleMode: 'FILL' | 'FIT'; imageRef?: string; url?: string };

interface Run {
  text: string;
  families: string[]; // font-family stack, first = what the browser actually rendered
  weight: number;
  italic: boolean;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  color: Rgba;
  fills?: PaintSpec[]; // background-clip: text
  decoration?: 'UNDERLINE' | 'STRIKETHROUGH';
  textCase?: TextCase;
  href?: string;
}

interface HtmlNode {
  type: 'frame' | 'text' | 'svg';
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  blend?: BlendMode;
  fills?: PaintSpec[];
  stroke?: { color: Rgba; t: number; r: number; b: number; l: number; dash?: number[] };
  radius?: number[] | null; // tl, tr, br, bl
  effects?: Effect[];
  clip?: boolean;
  transform?: { m: number[]; ox: number; oy: number }; // CSS matrix(a,b,c,d,e,f) + transform-origin
  children?: HtmlNode[];
  // text
  runs?: Run[];
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  anchor?: 'LEFT' | 'CENTER' | 'RIGHT'; // edge an auto-width line keeps when Figma's width differs
  autoWidth?: boolean;
  maxLines?: number;
  breaks?: number[]; // character offsets where the browser wrapped
  // svg
  svg?: string;
}

interface Ctx {
  images: Map<string, string>; // imageRef or url -> Figma image hash
  font: (r: Run) => FontName;
}

figma.showUI(__html__, { width: 360, height: 600, themeColors: true });

figma.ui.onmessage = async (msg: {
  type: string;
  tree?: HtmlNode;
  images?: Record<string, string>;
  viewportWidth?: number;
  asComponent?: boolean;
}) => {
  if (msg.type !== 'convert' || !msg.tree) return;
  try {
    const [images, fonts] = await Promise.all([loadImages(msg.tree, msg.images || {}), loadFonts(msg.tree)]);
    const ctx: Ctx = { images, font: fonts.get };
    let root = build(msg.tree, null, ctx) as FrameNode | ComponentNode;
    const suffix = msg.viewportWidth ? ` · ${msg.viewportWidth}px` : '';
    root.name = 'HTML Import' + suffix;
    const center = figma.viewport.center;
    root.x = Math.round(center.x - root.width / 2);
    root.y = Math.round(center.y - root.height / 2);
    figma.currentPage.appendChild(root);
    if (msg.asComponent) {
      root = figma.createComponentFromNode(root);
      root.name = 'HTML Component' + suffix;
    }
    const styles = await linkColorStyles(root);
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    figma.ui.postMessage({ type: 'done', count: countNodes(root), styles, missingFonts: fonts.missing });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

// ---------------------------------------------------------------------------
// Node building
// ---------------------------------------------------------------------------

function build(n: HtmlNode, parent: HtmlNode | null, ctx: Ctx): SceneNode {
  const relX = parent ? n.x - parent.x : 0;
  const relY = parent ? n.y - parent.y : 0;
  let node: SceneNode;

  if (n.type === 'text') {
    const t = buildText(n, ctx);
    const slack = t.textAutoResize === 'WIDTH_AND_HEIGHT' ? n.w - t.width : 0; // browser − Figma width
    const anchor = n.anchor || n.align;
    t.x = relX + (anchor === 'CENTER' ? slack / 2 : anchor === 'RIGHT' ? slack : 0);
    t.y = relY;
    node = t;
  } else if (n.type === 'svg') {
    node = buildSvg(n);
    node.x = relX;
    node.y = relY;
  } else {
    const kids = n.children || [];
    const box = kids.length || !parent ? figma.createFrame() : figma.createRectangle();
    if (n.name) box.name = n.name;
    box.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
    box.x = relX;
    box.y = relY;
    box.fills = paints(n.fills, ctx);
    applyStroke(box, n);
    applyRadius(box, n.radius);
    if (box.type === 'FRAME') {
      box.clipsContent = !!n.clip;
      for (const child of kids) box.appendChild(build(child, n, ctx));
    }
    node = box;
  }

  if (n.effects && n.effects.length && 'effects' in node) setEffects(node, n.effects);
  if (n.opacity !== undefined && n.opacity < 1) node.opacity = Math.max(0, n.opacity);
  if (n.blend) node.blendMode = n.blend;
  if (n.transform) applyTransform(node, n, relX, relY);
  return node;
}

function buildText(n: HtmlNode, ctx: Ctx): TextNode {
  const t = figma.createText();
  const runs = n.runs || [];
  t.fontName = ctx.font(runs[0]);
  t.characters = runs.map((r) => r.text).join('');
  let i = 0;
  for (const r of runs) {
    const end = i + r.text.length;
    if (end > i) {
      t.setRangeFontName(i, end, ctx.font(r));
      t.setRangeFontSize(i, end, Math.max(r.size, 1));
      t.setRangeLineHeight(i, end, { unit: 'PIXELS', value: Math.max(r.lineHeight, 0) });
      if (r.letterSpacing) t.setRangeLetterSpacing(i, end, { unit: 'PIXELS', value: r.letterSpacing });
      t.setRangeFills(i, end, r.fills ? paints(r.fills, ctx) : [solid(r.color)]);
      if (r.decoration) t.setRangeTextDecoration(i, end, r.decoration);
      if (r.textCase) t.setRangeTextCase(i, end, r.textCase);
      if (r.href) {
        try {
          t.setRangeHyperlink(i, end, { type: 'URL', value: r.href });
        } catch (e) {
          // not a URL Figma accepts; keep the text
        }
      }
    }
    i = end;
  }
  t.textAlignHorizontal = n.align || 'LEFT';
  if (n.autoWidth) {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else {
    t.resize(Math.max(n.w, 1), Math.max(n.h, 1));
    t.textAutoResize = 'HEIGHT';
    const line = Math.min(...runs.map((r) => r.lineHeight)) || 1;
    if (n.breaks && n.breaks.length && n.align !== 'JUSTIFIED' && Math.abs(t.height - n.h) > line / 2) {
      // Figma's copy of the font wraps differently: keep the browser's lines (soft breaks).
      for (const at of n.breaks.slice().sort((a, b) => b - a)) {
        let pos = Math.min(at, t.characters.length);
        if (t.characters[pos - 1] === ' ') {
          t.deleteCharacters(pos - 1, pos); // the space the browser wrapped at
          pos--;
        }
        t.insertCharacters(pos, '\u2028', pos > 0 ? 'BEFORE' : 'AFTER');
      }
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
  }
  if (n.maxLines) {
    t.textTruncation = 'ENDING';
    t.maxLines = n.maxLines;
  }
  return t;
}

function buildSvg(n: HtmlNode): FrameNode {
  let f: FrameNode;
  try {
    f = figma.createNodeFromSvg(n.svg || '');
  } catch (e) {
    f = figma.createFrame();
    f.fills = [];
    f.name = 'svg (could not import)';
  }
  if (n.name) f.name = n.name;
  f.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  f.clipsContent = !!n.clip;
  return f;
}

/** CSS transform (rotation + uniform scale) around transform-origin. */
function applyTransform(node: SceneNode, n: HtmlNode, relX: number, relY: number): void {
  const [a, b, c, d, e, f] = n.transform!.m;
  const s = Math.hypot(a, b);
  if (Math.abs(s - 1) > 0.001 && 'rescale' in node) node.rescale(s);
  const ra = a / s, rb = b / s, rc = c / s, rd = d / s;
  const { ox, oy } = n.transform!;
  node.relativeTransform = [
    [ra, rc, relX + ox - s * (ra * ox + rc * oy) + e],
    [rb, rd, relY + oy - s * (rb * ox + rd * oy) + f],
  ];
}

// ---------------------------------------------------------------------------
// Paints / strokes / effects
// ---------------------------------------------------------------------------

function solid(c: Rgba): SolidPaint {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

function paints(specs: PaintSpec[] | undefined, ctx: Ctx): Paint[] {
  const out: Paint[] = [];
  for (const p of specs || []) {
    if (p.type === 'SOLID') out.push(solid(p.color));
    else if (p.type === 'IMAGE') {
      const hash = ctx.images.get(p.imageRef || p.url || '');
      if (hash) out.push({ type: 'IMAGE', scaleMode: p.scaleMode, imageHash: hash });
    } else out.push(p);
  }
  return out;
}

function applyStroke(node: FrameNode | RectangleNode, n: HtmlNode): void {
  const s = n.stroke;
  if (!s) return;
  node.strokes = [solid(s.color)];
  node.strokeAlign = 'INSIDE';
  if (s.t === s.r && s.r === s.b && s.b === s.l) node.strokeWeight = s.t;
  else {
    node.strokeTopWeight = s.t;
    node.strokeRightWeight = s.r;
    node.strokeBottomWeight = s.b;
    node.strokeLeftWeight = s.l;
  }
  if (s.dash) node.dashPattern = s.dash;
}

function applyRadius(node: FrameNode | RectangleNode, r: number[] | null | undefined): void {
  if (!r) return;
  if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) node.cornerRadius = r[0];
  else {
    node.topLeftRadius = r[0];
    node.topRightRadius = r[1];
    node.bottomRightRadius = r[2];
    node.bottomLeftRadius = r[3];
  }
}

function setEffects(node: SceneNode & BlendMixin, effects: Effect[]): void {
  try {
    node.effects = effects;
  } catch (e) {
    // Figma only accepts shadow spread on filled, clipping frames; drop it elsewhere.
    node.effects = effects.map((fx) =>
      fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW' ? Object.assign({}, fx, { spread: 0 }) : fx
    );
  }
}

// ---------------------------------------------------------------------------
// Images / fonts (resolved once, up front)
// ---------------------------------------------------------------------------

function walk(n: HtmlNode, fn: (n: HtmlNode) => void): void {
  fn(n);
  for (const c of n.children || []) walk(c, fn);
}

async function loadImages(tree: HtmlNode, b64: Record<string, string>): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const id of Object.keys(b64)) {
    try {
      hashes.set(id, figma.createImage(figma.base64Decode(b64[id])).hash);
    } catch (e) {
      console.warn('Failed to create image', id, e);
    }
  }
  // Images the UI couldn't read (no CORS): let Figma fetch them itself.
  const urls = new Set<string>();
  walk(tree, (n) => {
    const all = (n.fills || []).concat(...(n.runs || []).map((r) => r.fills || []));
    for (const p of all) if (p.type === 'IMAGE' && p.url) urls.add(p.url);
  });
  await Promise.all(
    Array.from(urls).map((url) =>
      figma
        .createImageAsync(url)
        .then((img) => hashes.set(url, img.hash))
        .catch(() => console.warn('Could not fetch image', url))
    )
  );
  return hashes;
}

const INTER: FontName = { family: 'Inter', style: 'Regular' };
let fontIndex: Map<string, FontName[]> | null = null;

// Generic / system families → what to look for in Figma, in order.
const SYSTEM_SANS = ['SF Pro', 'SF Pro Text', 'Inter'];
const FONT_ALIASES: Record<string, string[]> = {
  'system-ui': SYSTEM_SANS,
  '-apple-system': SYSTEM_SANS,
  blinkmacsystemfont: SYSTEM_SANS,
  'ui-sans-serif': SYSTEM_SANS,
  'sans-serif': ['Helvetica', 'Arial', 'Inter'],
  serif: ['Times New Roman', 'Times', 'Georgia', 'Noto Serif'],
  'ui-serif': ['New York', 'Times New Roman', 'Georgia'],
  monospace: ['Menlo', 'Courier New', 'Roboto Mono'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Roboto Mono'],
  sfmono: ['SF Mono', 'Menlo', 'Roboto Mono'],
  'sfmono-regular': ['SF Mono', 'Menlo', 'Roboto Mono'],
  cursive: ['Comic Sans MS'],
};
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|blinkmacsystemfont|emoji|math)$/i;
const EMOJI = /emoji|symbol/i;

async function loadFonts(tree: HtmlNode): Promise<{ get: (r: Run) => FontName; missing: string[] }> {
  if (!fontIndex) {
    fontIndex = new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const key = f.fontName.family.toLowerCase();
      const list = fontIndex.get(key);
      if (list) list.push(f.fontName);
      else fontIndex.set(key, [f.fontName]);
    }
  }
  const index = fontIndex;
  const runKey = (r: Run) => r.families.join(',') + '|' + r.weight + '|' + r.italic;
  const chosen = new Map<string, FontName>();
  const missing = new Set<string>();
  walk(tree, (n) => {
    for (const r of n.runs || []) {
      const key = runKey(r);
      if (chosen.has(key)) continue;
      let styles: FontName[] | undefined;
      for (const fam of r.families) {
        if (EMOJI.test(fam)) continue;
        for (const cand of FONT_ALIASES[fam.toLowerCase()] || [fam]) {
          styles = index.get(cand.toLowerCase());
          if (styles) break;
        }
        if (styles) break;
        if (!GENERIC.test(fam)) missing.add(fam);
      }
      chosen.set(key, pickStyle(styles || index.get('inter') || [INTER], r.weight, r.italic));
    }
  });
  const failed = new Set<string>();
  const unique = new Map<string, FontName>();
  chosen.forEach((f) => unique.set(f.family + '::' + f.style, f));
  unique.set('Inter::Regular', INTER);
  await Promise.all(
    Array.from(unique.entries()).map(([k, f]) => figma.loadFontAsync(f).catch(() => failed.add(k)))
  );
  return {
    get: (r) => {
      const f = r && chosen.get(runKey(r));
      return f && !failed.has(f.family + '::' + f.style) ? f : INTER;
    },
    missing: Array.from(missing),
  };
}

function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/(extra|ultra)light/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/(semi|demi)bold/.test(s)) return 600;
  if (/(extra|ultra)bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}

/** Closest weight, matching italic; plain styles beat Condensed/Display/etc. */
function pickStyle(styles: FontName[], weight: number, italic: boolean): FontName {
  let best = styles[0];
  let bestScore = Infinity;
  for (const f of styles) {
    const isItalic = /italic|oblique/i.test(f.style);
    const extra = f.style
      .replace(/italic|oblique|regular|normal|book|roman|thin|hairline|extra|ultra|semi|demi|light|medium|bold|black|heavy/gi, '')
      .trim();
    const score =
      Math.abs(styleWeight(f.style) - weight) + (isItalic !== italic ? 1000 : 0) + (extra ? 50 : 0);
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Local color styles
// ---------------------------------------------------------------------------

interface ColorUse {
  color: RGB;
  opacity: number;
  links: ((styleId: string) => Promise<void>)[];
}

/**
 * Turns the import's most-used solid colors into `HTML/` paint styles and links every
 * layer (fill, stroke or text run) with that color to its style, so editing one style
 * recolors the whole import.
 */
async function linkColorStyles(root: SceneNode): Promise<number> {
  const uses = new Map<string, ColorUse>();
  const note = (p: ReadonlyArray<Paint> | PluginAPI['mixed'], link: ColorUse['links'][number]) => {
    // Gradients, images and stacked paints keep their own fills: a style would replace all of them.
    if (p === figma.mixed || p.length !== 1) return;
    const s = p[0];
    const a = s.opacity === undefined ? 1 : s.opacity;
    if (s.type !== 'SOLID' || s.visible === false || (s.blendMode || 'NORMAL') !== 'NORMAL' || a < 0.05) return;
    const key = colorKey(s.color, a);
    const use = uses.get(key) || { color: s.color, opacity: a, links: [] };
    use.links.push(link);
    uses.set(key, use);
  };
  const nodes = 'findAll' in root ? [root, ...root.findAll()] : [root];
  for (const n of nodes) {
    if (n.type === 'TEXT') {
      for (const seg of n.getStyledTextSegments(['fills']))
        note(seg.fills, (id) => n.setRangeFillStyleIdAsync(seg.start, seg.end, id));
    } else if ('fills' in n) note(n.fills, (id) => n.setFillStyleIdAsync(id));
    if ('strokes' in n) note(n.strokes, (id) => n.setStrokeStyleIdAsync(id));
  }

  // Reuse an earlier import's style only while it still holds the exact color, so a
  // style the user has since recolored never changes this import.
  const existing = new Map<string, string>();
  for (const s of await figma.getLocalPaintStylesAsync()) {
    const p = s.paints[0];
    if (s.name.startsWith('HTML/') && s.paints.length === 1 && p.type === 'SOLID')
      existing.set(colorKey(p.color, p.opacity === undefined ? 1 : p.opacity), s.id);
  }
  // Most-used first, capped so imports don't flood the file with near-duplicate styles.
  const top = Array.from(uses.entries())
    .sort((x, y) => y[1].links.length - x[1].links.length)
    .slice(0, 40);
  const pending: Promise<void>[] = [];
  for (const [key, use] of top) {
    let id = existing.get(key);
    if (!id) {
      const style = figma.createPaintStyle();
      style.name = 'HTML/' + rgbToHex(use.color) + (use.opacity < 0.999 ? ` @${Math.round(use.opacity * 100)}%` : '');
      style.paints = [{ type: 'SOLID', color: use.color, opacity: use.opacity }];
      id = style.id;
    }
    for (const link of use.links) pending.push(link(id));
  }
  await Promise.all(pending);
  return top.length;
}

function colorKey(c: RGB, a: number): string {
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), Math.round(a * 100)].join(',');
}

function rgbToHex(c: RGB): string {
  const h = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
  return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}

function countNodes(node: BaseNode): number {
  let n = 1;
  if ('children' in node) for (const child of node.children) n += countNodes(child);
  return n;
}
