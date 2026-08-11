/**
 * HTML → Figma — main thread
 *
 * Local HTML is measured in the UI iframe (browser does flex/grid/CSS layout).
 * We rebuild those boxes as nested Frames/Text with parent-relative positions
 * so the canvas matches what the HTML looked like.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface GradientStop {
  position: number;
  color: Rgba;
}

interface LinearGradientPaint {
  angleDeg: number;
  stops: GradientStop[];
}

interface BoxShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: Rgba;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
}

interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

interface SerializedHtmlNode {
  tag: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  filterOpacity?: number;
  filterBrightness?: number;
  layerBlur?: number;
  backdropBlur?: number;
  backgroundColor: Rgba | null;
  gradient?: LinearGradientPaint | null;
  boxShadows?: BoxShadowEffect[];
  borderWidth: number;
  borderColor: Rgba | null;
  borderRadius: number;
  cornerRadii?: CornerRadii;
  overflow?: string;
  zIndex?: number;
  isText: boolean;
  isImage: boolean;
  isSvg?: boolean;
  svgMarkup?: string;
  imageRef?: string | null;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: string;
  direction?: 'ltr' | 'rtl';
  singleLine?: boolean;
  textColor?: Rgba | null;
  imageSrc?: string;
  strokeColor?: Rgba | null;
  strokeWidth?: number;
  children: SerializedHtmlNode[];
}

type ImageMap = Record<string, string>; // id -> raw base64 PNG

interface CaptureStats {
  vectorSvgs: number;
  rasterImages: number;
  rasterBackgrounds: number;
}

// ---------------------------------------------------------------------------
// Plugin bootstrap
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

const imageHashCache: Record<string, string> = {};
interface ResolvedFontFace {
  fontName: FontName;
  weight: number;
  italic: boolean;
}

const fontFaceCache = new Map<string, ResolvedFontFace>();
const fontAvailability = new Map<string, boolean>();
const fontSubstitutions = new Set<string>();
let availableFontInventoryPromise: Promise<Map<string, FontName[]>> | null = null;
let vectorSvgsCreated = 0;
let vectorSvgFailures = 0;

figma.ui.onmessage = async (msg: {
  type: string;
  tree?: SerializedHtmlNode;
  images?: ImageMap;
  viewportWidth?: number;
  viewportHeight?: number;
  captureStats?: CaptureStats;
  asComponent?: boolean;
}) => {
  if (msg.type !== 'convert' || !msg.tree) return;

  try {
    // Fresh image hashes per import; fonts can stay cached across runs.
    for (const key of Object.keys(imageHashCache)) delete imageHashCache[key];
    fontSubstitutions.clear();
    vectorSvgsCreated = 0;
    vectorSvgFailures = 0;

    // Decode raster assets once up front.
    if (msg.images) {
      for (const [id, b64] of Object.entries(msg.images)) {
        try {
          const bytes = figma.base64Decode(b64);
          const image = figma.createImage(bytes);
          imageHashCache[id] = image.hash;
        } catch (e) {
          console.warn('Failed to create image', id, e);
        }
      }
    }

    const styleCollector = new Map<string, Rgba>();
    let rootFrame = await buildNode(msg.tree, null, styleCollector);

    let stylesCreated = 0;
    if (rootFrame) {
      stylesCreated = await createLocalColorStyles(styleCollector);

      const viewport = figma.viewport.center;
      rootFrame.name =
        'HTML Import' + viewportLabel(msg.viewportWidth, msg.viewportHeight);
      rootFrame.x = viewport.x - rootFrame.width / 2;
      rootFrame.y = viewport.y - rootFrame.height / 2;
      figma.currentPage.appendChild(rootFrame);
      if (msg.asComponent) {
        rootFrame = figma.createComponentFromNode(rootFrame);
        rootFrame.name =
          'HTML Component' + viewportLabel(msg.viewportWidth, msg.viewportHeight);
      }
      figma.currentPage.selection = [rootFrame];
      figma.viewport.scrollAndZoomIntoView([rootFrame]);

      figma.ui.postMessage({
        type: 'done',
        count: countNodes(rootFrame),
        styles: stylesCreated,
        vectorSvgs: vectorSvgsCreated,
        rasterFallbacks: msg.captureStats?.rasterBackgrounds || 0,
        approximations: vectorSvgFailures,
        fontSubstitutions: Array.from(fontSubstitutions),
      });
    } else {
      figma.ui.postMessage({ type: 'error', message: 'Nothing was created from the HTML tree.' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    figma.ui.postMessage({ type: 'error', message });
  }
};

// ---------------------------------------------------------------------------
// Node building
// ---------------------------------------------------------------------------

async function buildNode(
  data: SerializedHtmlNode,
  parentOrigin: { x: number; y: number } | null,
  styles: Map<string, Rgba>
): Promise<SceneNode | null> {
  const relX = parentOrigin ? data.x - parentOrigin.x : 0;
  const relY = parentOrigin ? data.y - parentOrigin.y : 0;
  const w = Math.max(data.width, 1);
  const h = Math.max(data.height, 1);

  if (data.isSvg && data.svgMarkup) {
    try {
      const svg = figma.createNodeFromSvg(data.svgMarkup);
      svg.name = data.name || 'svg';
      svg.resize(w, h);
      svg.x = relX;
      svg.y = relY;
      applyOpacity(svg, effectiveOpacity(data));
      applyBrightness(svg, data.filterBrightness);
      applyEffects(svg, data);
      vectorSvgsCreated++;
      return svg;
    } catch (error) {
      vectorSvgFailures++;
      console.warn('Failed to create vector SVG', data.name, error);
    }
  }

  // Rasterized SVG / <img>
  if (data.isImage) {
    const rect = figma.createRectangle();
    rect.name = data.name;
    rect.resize(w, h);
    rect.x = relX;
    rect.y = relY;

    if (data.imageRef && imageHashCache[data.imageRef]) {
      rect.fills = [
        {
          type: 'IMAGE',
          scaleMode: 'FILL',
          imageHash: imageHashCache[data.imageRef],
        },
      ];
    } else {
      rect.fills = buildsFills(data, { r: 0.93, g: 0.9, b: 0.82, a: 1 }, styles);
    }

    applyOpacity(rect, effectiveOpacity(data));
    applyCornerRadii(rect, data);
    applyStroke(rect, data, styles);
    applyEffects(rect, data);
    return rect;
  }

  // Unrasterized SVG fallback
  if (data.isSvg) {
    const ellipse = figma.createEllipse();
    ellipse.name = data.name || 'svg';
    ellipse.resize(w, h);
    ellipse.x = relX;
    ellipse.y = relY;
    ellipse.fills = [];
    const stroke = data.strokeColor || { r: 0.76, g: 0.41, b: 0.29, a: 1 };
    trackColor(styles, stroke);
    ellipse.strokes = [
      {
        type: 'SOLID',
        color: { r: stroke.r, g: stroke.g, b: stroke.b },
        opacity: stroke.a,
      },
    ];
    ellipse.strokeWeight = Math.max(data.strokeWidth || 1.5, 1);
    applyOpacity(ellipse, effectiveOpacity(data));
    applyEffects(ellipse, data);
    return ellipse;
  }

  if (data.isText && data.text) {
    return await buildTextNode(data, relX, relY, w, h, styles);
  }

  const frame = figma.createFrame();
  frame.name = data.name;
  frame.resize(w, h);
  frame.x = relX;
  frame.y = relY;
  frame.fills = buildsFills(data, null, styles);
  applyOpacity(frame, effectiveOpacity(data));
  applyCornerRadii(frame, data);
  applyStroke(frame, data, styles);
  applyEffects(frame, data);

  const overflow = (data.overflow || 'visible').toLowerCase();
  frame.clipsContent =
    overflow === 'hidden' ||
    overflow === 'auto' ||
    overflow === 'scroll';

  const origin = { x: data.x, y: data.y };
  for (const child of data.children) {
    const childNode = await buildNode(child, origin, styles);
    if (childNode) frame.appendChild(childNode);
  }

  return frame;
}

async function buildTextNode(
  data: SerializedHtmlNode,
  relX: number,
  relY: number,
  w: number,
  h: number,
  styles: Map<string, Rgba>
): Promise<TextNode> {
  const text = figma.createText();
  text.name = data.name;
  text.x = relX;
  text.y = relY;

  const resolvedFont = await resolveFont(
    data.fontFamily,
    data.fontWeight,
    data.fontStyle,
    data.text
  );
  const font = resolvedFont.fontName;
  const requestedFamily = (data.fontFamily || '').trim();
  const requestedWeight = normalizeFontWeight(data.fontWeight);
  const requestedItalic = isItalicStyle(data.fontStyle);
  if (
    (requestedFamily && requestedFamily.toLowerCase() !== font.family.toLowerCase()) ||
    requestedWeight !== resolvedFont.weight ||
    requestedItalic !== resolvedFont.italic
  ) {
    const requestedFace = `${requestedFamily || 'Inter'} ${requestedWeight}${requestedItalic ? ' italic' : ''}`;
    const actualFace = `${font.family} ${font.style} (${resolvedFont.weight}${resolvedFont.italic ? ' italic' : ''})`;
    fontSubstitutions.add(`${requestedFace} → ${actualFace}`);
  }
  await figma.loadFontAsync(font);
  text.fontName = font;
  text.characters = data.text || '';
  text.fontSize = data.fontSize || 12;

  if (data.lineHeight && data.lineHeight > 0) {
    text.lineHeight = { value: data.lineHeight, unit: 'PIXELS' };
  }
  if (data.letterSpacing && Math.abs(data.letterSpacing) > 0.01) {
    text.letterSpacing = { value: data.letterSpacing, unit: 'PIXELS' };
  }
  const resolvedAlign = mapTextAlign(data.textAlign, data.direction);
  text.textAlignHorizontal = resolvedAlign;

  if (data.textColor) {
    trackColor(styles, data.textColor);
    text.fills = [
      {
        type: 'SOLID',
        color: { r: data.textColor.r, g: data.textColor.g, b: data.textColor.b },
        opacity: data.textColor.a,
      },
    ];
  }

  try {
    // Preserve the browser's measured text box. Figma's font metrics can
    // otherwise reflow the text even when its width is the same.
    if (data.singleLine) {
      text.textAutoResize = 'WIDTH_AND_HEIGHT';
      const measuredWidth = text.width;
      if (resolvedAlign === 'RIGHT') text.x = relX + w - measuredWidth;
      else if (resolvedAlign === 'CENTER') text.x = relX + (w - measuredWidth) / 2;
    } else {
      text.textAutoResize = 'NONE';
      text.resize(Math.max(w, 1), Math.max(h, data.fontSize || 12));
    }
  } catch {
    try {
      text.textAutoResize = 'HEIGHT';
      text.resize(Math.max(w, 1), 0.01);
    } catch {
      // keep default
    }
  }

  applyOpacity(text, effectiveOpacity(data));
  applyEffects(text, data);
  return text;
}

// ---------------------------------------------------------------------------
// Styles / paints / effects
// ---------------------------------------------------------------------------

function trackColor(styles: Map<string, Rgba>, c: Rgba): void {
  if (c.a < 0.05) return;
  const key = [
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
    Math.round(c.a * 100),
  ].join(',');
  if (!styles.has(key)) styles.set(key, c);
}

async function createLocalColorStyles(styles: Map<string, Rgba>): Promise<number> {
  let created = 0;
  // Cap so imports don't flood the file with hundreds of near-duplicate styles.
  const entries = Array.from(styles.entries()).slice(0, 40);
  for (const [, c] of entries) {
    const name =
      'HTML/' +
      rgbToHex(c) +
      (c.a < 0.999 ? ` @${Math.round(c.a * 100)}%` : '');
    try {
      const existing = figma.getLocalPaintStyles().find((s) => s.name === name);
      if (existing) continue;
      const style = figma.createPaintStyle();
      style.name = name;
      style.paints = [
        {
          type: 'SOLID',
          color: { r: c.r, g: c.g, b: c.b },
          opacity: c.a,
        },
      ];
      created++;
    } catch {
      // ignore
    }
  }
  return created;
}

function rgbToHex(c: Rgba): string {
  const h = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
  return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}

function buildsFills(
  data: SerializedHtmlNode,
  fallback: Rgba | null,
  styles: Map<string, Rgba>
): Paint[] {
  if (data.gradient && data.gradient.stops && data.gradient.stops.length >= 2) {
    for (const s of data.gradient.stops) trackColor(styles, s.color);
    return [toLinearGradientPaint(data.gradient)];
  }
  if (data.backgroundColor) {
    trackColor(styles, data.backgroundColor);
    return [
      {
        type: 'SOLID',
        color: {
          r: data.backgroundColor.r,
          g: data.backgroundColor.g,
          b: data.backgroundColor.b,
        },
        opacity: data.backgroundColor.a,
      },
    ];
  }
  if (fallback) {
    trackColor(styles, fallback);
    return [
      {
        type: 'SOLID',
        color: { r: fallback.r, g: fallback.g, b: fallback.b },
        opacity: fallback.a,
      },
    ];
  }
  return [];
}

function toLinearGradientPaint(gradient: LinearGradientPaint): GradientPaint {
  const stops: ColorStop[] = gradient.stops.map((s) => ({
    position: clamp01(s.position),
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
  }));
  const rad = ((gradient.angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const gradientTransform: Transform = [
    [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
    [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
  ];
  return { type: 'GRADIENT_LINEAR', gradientStops: stops, gradientTransform };
}

function applyEffects(node: BlendMixin, data: SerializedHtmlNode): void {
  const shadows = data.boxShadows || [];
  const effects: Effect[] = shadows.map((shadow) => ({
    type: shadow.type,
    color: {
      r: shadow.color.r,
      g: shadow.color.g,
      b: shadow.color.b,
      a: shadow.color.a,
    },
    offset: shadow.offset,
    radius: shadow.radius,
    spread: shadow.spread,
    visible: true,
    blendMode: 'NORMAL' as const,
  }));
  if (data.layerBlur && data.layerBlur > 0) {
    effects.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: data.layerBlur, visible: true });
  }
  if (data.backdropBlur && data.backdropBlur > 0) {
    effects.push({
      type: 'BACKGROUND_BLUR',
      blurType: 'NORMAL',
      radius: data.backdropBlur,
      visible: true,
    });
  }
  if (effects.length > 0) node.effects = effects;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function applyOpacity(node: BlendMixin, opacity: number): void {
  if (opacity < 1 && opacity >= 0) node.opacity = opacity;
}

function effectiveOpacity(data: SerializedHtmlNode): number {
  return clamp01(data.opacity * (data.filterOpacity === undefined ? 1 : data.filterOpacity));
}

function applyBrightness(node: SceneNode, brightness: number | undefined): void {
  if (brightness === undefined || Math.abs(brightness - 1) < 0.001) return;
  if ('fills' in node && Array.isArray(node.fills)) {
    node.fills = adjustPaintBrightness(node.fills, brightness);
  }
  if ('strokes' in node && Array.isArray(node.strokes)) {
    node.strokes = adjustPaintBrightness(node.strokes, brightness);
  }
  if ('children' in node) {
    for (const child of node.children) applyBrightness(child, brightness);
  }
}

function adjustPaintBrightness(paints: readonly Paint[], brightness: number): Paint[] {
  return paints.map((paint) => {
    if (paint.type === 'SOLID') {
      return {
        ...paint,
        color: {
          r: clamp01(paint.color.r * brightness),
          g: clamp01(paint.color.g * brightness),
          b: clamp01(paint.color.b * brightness),
        },
      };
    }
    if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' ||
        paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') {
      return {
        ...paint,
        gradientStops: paint.gradientStops.map((stop) => ({
          ...stop,
          color: {
            ...stop.color,
            r: clamp01(stop.color.r * brightness),
            g: clamp01(stop.color.g * brightness),
            b: clamp01(stop.color.b * brightness),
          },
        })),
      };
    }
    return paint;
  });
}

function applyCornerRadii(
  node: RectangleNode | FrameNode | EllipseNode | ComponentNode | InstanceNode,
  data: SerializedHtmlNode
): void {
  if (!('cornerRadius' in node)) return;
  const target = node as RectangleNode | FrameNode;
  const radii = data.cornerRadii;
  if (!radii) {
    if (data.borderRadius > 0) target.cornerRadius = data.borderRadius;
    return;
  }
  target.topLeftRadius = radii.topLeft;
  target.topRightRadius = radii.topRight;
  target.bottomRightRadius = radii.bottomRight;
  target.bottomLeftRadius = radii.bottomLeft;
}

function applyStroke(
  node: GeometryMixin & MinimalStrokesMixin,
  data: SerializedHtmlNode,
  styles: Map<string, Rgba>
): void {
  if (data.borderWidth > 0 && data.borderColor) {
    trackColor(styles, data.borderColor);
    node.strokes = [
      {
        type: 'SOLID',
        color: {
          r: data.borderColor.r,
          g: data.borderColor.g,
          b: data.borderColor.b,
        },
        opacity: data.borderColor.a,
      },
    ];
    node.strokeWeight = data.borderWidth;
    node.strokeAlign = 'INSIDE';
  }
}

function mapTextAlign(
  align: string | undefined,
  direction: 'ltr' | 'rtl' = 'ltr'
): 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED' {
  switch ((align || 'left').toLowerCase()) {
    case 'center':
      return 'CENTER';
    case 'right':
      return 'RIGHT';
    case 'start':
      return direction === 'rtl' ? 'RIGHT' : 'LEFT';
    case 'end':
      return direction === 'rtl' ? 'LEFT' : 'RIGHT';
    case 'justify':
      return 'JUSTIFIED';
    default:
      return 'LEFT';
  }
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function weightToStyle(weight: string | undefined, fontStyle: string | undefined): string {
  const italic = isItalicStyle(fontStyle);
  const w = normalizeFontWeight(weight);
  let base = 'Regular';
  if (w >= 900) base = 'Black';
  else if (w >= 800) base = 'Extra Bold';
  else if (w >= 700) base = 'Bold';
  else if (w >= 600) base = 'Semi Bold';
  else if (w >= 500) base = 'Medium';
  else if (w >= 400) base = 'Regular';
  else if (w >= 300) base = 'Light';
  else if (w >= 200) base = 'Extra Light';
  else base = 'Thin';
  if (!italic) return base;
  if (base === 'Regular') return 'Italic';
  return base + ' Italic';
}

function normalizeFontWeight(weight: string | undefined): number {
  const normalized = (weight || '400').toLowerCase().trim();
  if (normalized === 'normal') return 400;
  if (normalized === 'bold') return 700;
  const parsed = parseInt(normalized, 10);
  if (isNaN(parsed)) return 400;
  return Math.max(1, Math.min(parsed, 1000));
}

function isItalicStyle(style: string | undefined): boolean {
  return /italic|oblique/.test((style || '').toLowerCase());
}

function fontWeightFromStyle(style: string): number {
  const normalized = style.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(thin|hairline)\b/.test(normalized)) return 100;
  if (/\b(extra|ultra)\s*light\b/.test(normalized)) return 200;
  if (/\blight\b/.test(normalized)) return 300;
  if (/\bmedium\b/.test(normalized)) return 500;
  if (/\b(semi|demi)\s*bold\b/.test(normalized)) return 600;
  if (/\b(extra|ultra)\s*bold\b/.test(normalized)) return 800;
  if (/\b(black|heavy)\b/.test(normalized)) return 900;
  if (/\bbold\b/.test(normalized)) return 700;
  return 400;
}

function cssWeightSortKey(requested: number, candidate: number): [number, number] {
  if (requested >= 400 && requested <= 500) {
    if (candidate >= requested && candidate <= 500) return [0, candidate - requested];
    if (candidate < requested) return [1, requested - candidate];
    return [2, candidate - 500];
  }
  if (requested < 400) {
    if (candidate <= requested) return [0, requested - candidate];
    return [1, candidate - requested];
  }
  if (candidate >= requested) return [0, candidate - requested];
  return [1, requested - candidate];
}

function compareFontFaces(
  requestedWeight: number,
  requestedItalic: boolean,
  a: FontName,
  b: FontName
): number {
  const aItalicMismatch = isItalicStyle(a.style) === requestedItalic ? 0 : 1;
  const bItalicMismatch = isItalicStyle(b.style) === requestedItalic ? 0 : 1;
  if (aItalicMismatch !== bItalicMismatch) return aItalicMismatch - bItalicMismatch;
  const aKey = cssWeightSortKey(requestedWeight, fontWeightFromStyle(a.style));
  const bKey = cssWeightSortKey(requestedWeight, fontWeightFromStyle(b.style));
  if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
  if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
  return a.style.localeCompare(b.style);
}

async function getAvailableFontInventory(): Promise<Map<string, FontName[]>> {
  if (!availableFontInventoryPromise) {
    availableFontInventoryPromise = figma
      .listAvailableFontsAsync()
      .then((fonts) => {
        const inventory = new Map<string, FontName[]>();
        for (const entry of fonts) {
          const font = entry.fontName;
          const key = font.family.toLowerCase();
          const familyFonts = inventory.get(key) || [];
          if (!familyFonts.some((item) => item.style === font.style)) familyFonts.push(font);
          inventory.set(key, familyFonts);
        }
        return inventory;
      })
      .catch(() => new Map<string, FontName[]>());
  }
  return availableFontInventoryPromise;
}

function familyFallbacks(family: string, text?: string): string[] {
  const f = family.trim();
  const lower = f.toLowerCase();
  const serifLike =
    /playfair|serif|georgia|times|garamond|merriweather/.test(lower);
  const list: string[] = [f];
  if (/\p{Script=Arabic}/u.test(text || '')) {
    list.push('Noto Sans Arabic', 'Noto Kufi Arabic', 'Arial');
  } else if (serifLike) {
    list.push('Playfair Display', 'Noto Serif', 'Georgia', 'Times New Roman', 'IBM Plex Serif');
  } else {
    list.push('Figtree', 'Inter', 'Roboto', 'Helvetica');
  }
  list.push('Inter');
  return list;
}

async function tryLoadFont(font: FontName): Promise<boolean> {
  const key = font.family + '::' + font.style;
  const cached = fontAvailability.get(key);
  if (cached !== undefined) return cached;
  try {
    await figma.loadFontAsync(font);
    fontAvailability.set(key, true);
    return true;
  } catch {
    fontAvailability.set(key, false);
    return false;
  }
}

async function resolveFont(
  family: string | undefined,
  weight: string | undefined,
  fontStyle?: string,
  text?: string
): Promise<ResolvedFontFace> {
  const scriptKey = /\p{Script=Arabic}/u.test(text || '') ? 'arabic' : 'other';
  const cacheKey =
    (family || 'Inter') + '|' + (weight || '400') + '|' + (fontStyle || 'normal') + '|' + scriptKey;
  const cached = fontFaceCache.get(cacheKey);
  if (cached) return cached;

  const requestedWeight = normalizeFontWeight(weight);
  const requestedItalic = isItalicStyle(fontStyle);
  const inventory = await getAvailableFontInventory();
  for (const fam of familyFallbacks(family || 'Inter', text)) {
    const candidates = (inventory.get(fam.toLowerCase()) || [])
      .slice()
      .sort((a, b) => compareFontFaces(requestedWeight, requestedItalic, a, b));
    for (const font of candidates) {
      if (await tryLoadFont(font)) {
        const resolved = {
          fontName: font,
          weight: fontWeightFromStyle(font.style),
          italic: isItalicStyle(font.style),
        };
        fontFaceCache.set(cacheKey, resolved);
        return resolved;
      }
    }
  }

  // Retain direct style-name probes for environments whose font inventory is
  // incomplete, such as older Figma hosts or temporarily unavailable fonts.
  const style = weightToStyle(weight, fontStyle);
  // Google Fonts style names are inconsistent about the space in compound
  // weights ("Semi Bold" vs "SemiBold") depending on the family — try both
  // before giving up on the weight and falling back to Regular.
  const noSpace = style.replace(/ /g, '');
  const styleFallbacks =
    style.indexOf('Italic') >= 0
      ? [style, noSpace, 'Italic', style.replace(' Italic', ''), noSpace.replace('Italic', ''), 'Regular']
      : [style, noSpace, 'Regular'];
  const seen = new Set<string>();
  for (const fam of familyFallbacks(family || 'Inter', text)) {
    for (const st of styleFallbacks) {
      const key = fam + '::' + st;
      if (seen.has(key)) continue;
      seen.add(key);
      const font: FontName = { family: fam, style: st };
      if (await tryLoadFont(font)) {
        const resolved = {
          fontName: font,
          weight: fontWeightFromStyle(font.style),
          italic: isItalicStyle(font.style),
        };
        fontFaceCache.set(cacheKey, resolved);
        return resolved;
      }
    }
  }
  const fallback: FontName = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  const resolved = { fontName: fallback, weight: 400, italic: false };
  fontFaceCache.set(cacheKey, resolved);
  return resolved;
}

function countNodes(node: BaseNode): number {
  let n = 1;
  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children) n += countNodes(child);
  }
  return n;
}

function viewportLabel(width?: number, height?: number): string {
  if (!width) return '';
  return ` · ${width}${height ? `×${height}` : ''}px`;
}
