"use strict";
/**
 * HTML → Figma — main thread
 *
 * Local HTML is measured in the UI iframe (browser does flex/grid/CSS layout).
 * We rebuild those boxes as nested Frames/Text with parent-relative positions
 * so the canvas matches what the HTML looked like.
 */
// ---------------------------------------------------------------------------
// Plugin bootstrap
// ---------------------------------------------------------------------------
figma.showUI(__html__, { width: 360, height: 520, themeColors: true });
const imageHashCache = {};
const fontFaceCache = new Map();
const fontAvailability = new Map();
const fontSubstitutions = new Set();
let availableFontInventoryPromise = null;
let vectorSvgsCreated = 0;
let vectorSvgFailures = 0;
figma.ui.onmessage = async (msg) => {
    var _a, _b;
    if (msg.type !== 'convert' || !msg.tree)
        return;
    try {
        // Fresh image hashes per import; fonts can stay cached across runs.
        for (const key of Object.keys(imageHashCache))
            delete imageHashCache[key];
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
                }
                catch (e) {
                    console.warn('Failed to create image', id, e);
                }
            }
        }
        const styleCollector = new Map();
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
                rasterFallbacks: (((_a = msg.captureStats) === null || _a === void 0 ? void 0 : _a.rasterBackgrounds) || 0) +
                    (((_b = msg.captureStats) === null || _b === void 0 ? void 0 : _b.rasterGlyphs) || 0),
                approximations: vectorSvgFailures,
                fontSubstitutions: Array.from(fontSubstitutions),
            });
        }
        else {
            figma.ui.postMessage({ type: 'error', message: 'Nothing was created from the HTML tree.' });
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        figma.ui.postMessage({ type: 'error', message });
    }
};
// ---------------------------------------------------------------------------
// Node building
// ---------------------------------------------------------------------------
async function buildNode(data, parentOrigin, styles) {
    const relX = parentOrigin ? data.x - parentOrigin.x : 0;
    const relY = parentOrigin ? data.y - parentOrigin.y : 0;
    const w = Math.max(data.width, 1);
    const h = Math.max(data.height, 1);
    if (data.isSvg && data.svgMarkup) {
        try {
            const svgArtwork = figma.createNodeFromSvg(data.svgMarkup);
            svgArtwork.name = 'SVG artwork';
            svgArtwork.resize(w, h);
            svgArtwork.x = 0;
            svgArtwork.y = 0;
            // Figma's generated SVG frame can clip vector geometry to its inferred
            // path bounds, which is narrower than the browser's viewport for some
            // large or negatively translated ornaments. A separate wrapper owns the
            // CSS overflow boundary while the generated artwork remains unclipped.
            svgArtwork.clipsContent = false;
            const wrapper = figma.createFrame();
            wrapper.name = data.name || 'svg';
            wrapper.resize(w, h);
            wrapper.x = relX;
            wrapper.y = relY;
            wrapper.fills = [];
            const overflow = (data.overflow || 'hidden').toLowerCase();
            wrapper.clipsContent =
                overflow === 'hidden' || overflow === 'auto' || overflow === 'scroll';
            wrapper.appendChild(svgArtwork);
            // Apply each CSS filter at exactly one level: color filters affect the
            // imported paints, while compositing opacity/effects belong to the
            // viewport wrapper.
            applyBrightness(svgArtwork, data.filterBrightness);
            applyOpacity(wrapper, effectiveOpacity(data));
            applyEffects(wrapper, data);
            vectorSvgsCreated++;
            return wrapper;
        }
        catch (error) {
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
        }
        else {
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
        if (childNode)
            frame.appendChild(childNode);
    }
    return frame;
}
async function buildTextNode(data, relX, relY, w, h, styles) {
    const text = figma.createText();
    text.name = data.name;
    text.x = relX;
    text.y = relY;
    const resolvedFont = await resolveFont(data.fontFamily, data.fontWeight, data.fontStyle, data.text);
    const font = resolvedFont.fontName;
    const requestedFamily = (data.fontFamily || '').trim();
    const requestedWeight = normalizeFontWeight(data.fontWeight);
    const requestedItalic = isItalicStyle(data.fontStyle);
    if ((requestedFamily && requestedFamily.toLowerCase() !== font.family.toLowerCase()) ||
        requestedWeight !== resolvedFont.weight ||
        requestedItalic !== resolvedFont.italic) {
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
            if (resolvedAlign === 'RIGHT')
                text.x = relX + w - measuredWidth;
            else if (resolvedAlign === 'CENTER')
                text.x = relX + (w - measuredWidth) / 2;
        }
        else {
            text.textAutoResize = 'NONE';
            text.resize(Math.max(w, 1), Math.max(h, data.fontSize || 12));
        }
    }
    catch (_a) {
        try {
            text.textAutoResize = 'HEIGHT';
            text.resize(Math.max(w, 1), 0.01);
        }
        catch (_b) {
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
function trackColor(styles, c) {
    if (c.a < 0.05)
        return;
    const key = [
        Math.round(c.r * 255),
        Math.round(c.g * 255),
        Math.round(c.b * 255),
        Math.round(c.a * 100),
    ].join(',');
    if (!styles.has(key))
        styles.set(key, c);
}
async function createLocalColorStyles(styles) {
    let created = 0;
    // Cap so imports don't flood the file with hundreds of near-duplicate styles.
    const entries = Array.from(styles.entries()).slice(0, 40);
    for (const [, c] of entries) {
        const name = 'HTML/' +
            rgbToHex(c) +
            (c.a < 0.999 ? ` @${Math.round(c.a * 100)}%` : '');
        try {
            const existing = figma.getLocalPaintStyles().find((s) => s.name === name);
            if (existing)
                continue;
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
        }
        catch (_a) {
            // ignore
        }
    }
    return created;
}
function rgbToHex(c) {
    const h = (n) => Math.round(n * 255)
        .toString(16)
        .padStart(2, '0');
    return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}
function buildsFills(data, fallback, styles) {
    if (data.gradient && data.gradient.stops && data.gradient.stops.length >= 2) {
        for (const s of data.gradient.stops)
            trackColor(styles, s.color);
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
function toLinearGradientPaint(gradient) {
    const stops = gradient.stops.map((s) => ({
        position: clamp01(s.position),
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    }));
    const rad = ((gradient.angleDeg - 90) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const gradientTransform = [
        [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
        [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
    ];
    return { type: 'GRADIENT_LINEAR', gradientStops: stops, gradientTransform };
}
function applyEffects(node, data) {
    const shadows = data.boxShadows || [];
    const effects = shadows.map((shadow) => ({
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
        blendMode: 'NORMAL',
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
    if (effects.length > 0)
        node.effects = effects;
}
function clamp01(n) {
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
function applyOpacity(node, opacity) {
    if (opacity < 1 && opacity >= 0)
        node.opacity = opacity;
}
function effectiveOpacity(data) {
    return clamp01(data.opacity * (data.filterOpacity === undefined ? 1 : data.filterOpacity));
}
function applyBrightness(node, brightness) {
    if (brightness === undefined || Math.abs(brightness - 1) < 0.001)
        return;
    if ('fills' in node && Array.isArray(node.fills)) {
        node.fills = adjustPaintBrightness(node.fills, brightness);
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
        node.strokes = adjustPaintBrightness(node.strokes, brightness);
    }
    if ('children' in node) {
        for (const child of node.children)
            applyBrightness(child, brightness);
    }
}
function adjustPaintBrightness(paints, brightness) {
    return paints.map((paint) => {
        if (paint.type === 'SOLID') {
            return Object.assign(Object.assign({}, paint), { color: {
                    r: clamp01(paint.color.r * brightness),
                    g: clamp01(paint.color.g * brightness),
                    b: clamp01(paint.color.b * brightness),
                } });
        }
        if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' ||
            paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') {
            return Object.assign(Object.assign({}, paint), { gradientStops: paint.gradientStops.map((stop) => (Object.assign(Object.assign({}, stop), { color: Object.assign(Object.assign({}, stop.color), { r: clamp01(stop.color.r * brightness), g: clamp01(stop.color.g * brightness), b: clamp01(stop.color.b * brightness) }) }))) });
        }
        return paint;
    });
}
function applyCornerRadii(node, data) {
    if (!('cornerRadius' in node))
        return;
    const target = node;
    const radii = data.cornerRadii;
    if (!radii) {
        if (data.borderRadius > 0)
            target.cornerRadius = data.borderRadius;
        return;
    }
    target.topLeftRadius = radii.topLeft;
    target.topRightRadius = radii.topRight;
    target.bottomRightRadius = radii.bottomRight;
    target.bottomLeftRadius = radii.bottomLeft;
}
function applyStroke(node, data, styles) {
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
function mapTextAlign(align, direction = 'ltr') {
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
function weightToStyle(weight, fontStyle) {
    const italic = isItalicStyle(fontStyle);
    const w = normalizeFontWeight(weight);
    let base = 'Regular';
    if (w >= 900)
        base = 'Black';
    else if (w >= 800)
        base = 'Extra Bold';
    else if (w >= 700)
        base = 'Bold';
    else if (w >= 600)
        base = 'Semi Bold';
    else if (w >= 500)
        base = 'Medium';
    else if (w >= 400)
        base = 'Regular';
    else if (w >= 300)
        base = 'Light';
    else if (w >= 200)
        base = 'Extra Light';
    else
        base = 'Thin';
    if (!italic)
        return base;
    if (base === 'Regular')
        return 'Italic';
    return base + ' Italic';
}
function normalizeFontWeight(weight) {
    const normalized = (weight || '400').toLowerCase().trim();
    if (normalized === 'normal')
        return 400;
    if (normalized === 'bold')
        return 700;
    const parsed = parseInt(normalized, 10);
    if (isNaN(parsed))
        return 400;
    return Math.max(1, Math.min(parsed, 1000));
}
function isItalicStyle(style) {
    return /italic|oblique/.test((style || '').toLowerCase());
}
function fontWeightFromStyle(style) {
    const normalized = style.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\b(thin|hairline)\b/.test(normalized))
        return 100;
    if (/\b(extra|ultra)\s*light\b/.test(normalized))
        return 200;
    if (/\blight\b/.test(normalized))
        return 300;
    if (/\bmedium\b/.test(normalized))
        return 500;
    if (/\b(semi|demi)\s*bold\b/.test(normalized))
        return 600;
    if (/\b(extra|ultra)\s*bold\b/.test(normalized))
        return 800;
    if (/\b(black|heavy)\b/.test(normalized))
        return 900;
    if (/\bbold\b/.test(normalized))
        return 700;
    return 400;
}
function cssWeightSortKey(requested, candidate) {
    if (requested >= 400 && requested <= 500) {
        if (candidate >= requested && candidate <= 500)
            return [0, candidate - requested];
        if (candidate < requested)
            return [1, requested - candidate];
        return [2, candidate - 500];
    }
    if (requested < 400) {
        if (candidate <= requested)
            return [0, requested - candidate];
        return [1, candidate - requested];
    }
    if (candidate >= requested)
        return [0, candidate - requested];
    return [1, requested - candidate];
}
function compareFontFaces(requestedWeight, requestedItalic, a, b) {
    const aItalicMismatch = isItalicStyle(a.style) === requestedItalic ? 0 : 1;
    const bItalicMismatch = isItalicStyle(b.style) === requestedItalic ? 0 : 1;
    if (aItalicMismatch !== bItalicMismatch)
        return aItalicMismatch - bItalicMismatch;
    const aKey = cssWeightSortKey(requestedWeight, fontWeightFromStyle(a.style));
    const bKey = cssWeightSortKey(requestedWeight, fontWeightFromStyle(b.style));
    if (aKey[0] !== bKey[0])
        return aKey[0] - bKey[0];
    if (aKey[1] !== bKey[1])
        return aKey[1] - bKey[1];
    return a.style.localeCompare(b.style);
}
async function getAvailableFontInventory() {
    if (!availableFontInventoryPromise) {
        availableFontInventoryPromise = figma
            .listAvailableFontsAsync()
            .then((fonts) => {
            const inventory = new Map();
            for (const entry of fonts) {
                const font = entry.fontName;
                const key = font.family.toLowerCase();
                const familyFonts = inventory.get(key) || [];
                if (!familyFonts.some((item) => item.style === font.style))
                    familyFonts.push(font);
                inventory.set(key, familyFonts);
            }
            return inventory;
        })
            .catch(() => new Map());
    }
    return availableFontInventoryPromise;
}
function familyFallbacks(family, text) {
    const f = family.trim();
    const lower = f.toLowerCase();
    const serifLike = /playfair|serif|georgia|times|garamond|merriweather/.test(lower);
    const list = [f];
    if (/\p{Script=Arabic}/u.test(text || '')) {
        list.push('Noto Sans Arabic', 'Noto Kufi Arabic', 'Arial');
    }
    else if (serifLike) {
        list.push('Playfair Display', 'Noto Serif', 'Georgia', 'Times New Roman', 'IBM Plex Serif');
    }
    else {
        list.push('Figtree', 'Inter', 'Roboto', 'Helvetica');
    }
    list.push('Inter');
    return list;
}
async function tryLoadFont(font) {
    const key = font.family + '::' + font.style;
    const cached = fontAvailability.get(key);
    if (cached !== undefined)
        return cached;
    try {
        await figma.loadFontAsync(font);
        fontAvailability.set(key, true);
        return true;
    }
    catch (_a) {
        fontAvailability.set(key, false);
        return false;
    }
}
async function resolveFont(family, weight, fontStyle, text) {
    const scriptKey = /\p{Script=Arabic}/u.test(text || '') ? 'arabic' : 'other';
    const cacheKey = (family || 'Inter') + '|' + (weight || '400') + '|' + (fontStyle || 'normal') + '|' + scriptKey;
    const cached = fontFaceCache.get(cacheKey);
    if (cached)
        return cached;
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
    const styleFallbacks = style.indexOf('Italic') >= 0
        ? [style, noSpace, 'Italic', style.replace(' Italic', ''), noSpace.replace('Italic', ''), 'Regular']
        : [style, noSpace, 'Regular'];
    const seen = new Set();
    for (const fam of familyFallbacks(family || 'Inter', text)) {
        for (const st of styleFallbacks) {
            const key = fam + '::' + st;
            if (seen.has(key))
                continue;
            seen.add(key);
            const font = { family: fam, style: st };
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
    const fallback = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(fallback);
    const resolved = { fontName: fallback, weight: 400, italic: false };
    fontFaceCache.set(cacheKey, resolved);
    return resolved;
}
function countNodes(node) {
    let n = 1;
    if ('children' in node) {
        for (const child of node.children)
            n += countNodes(child);
    }
    return n;
}
function viewportLabel(width, height) {
    if (!width)
        return '';
    return ` · ${width}${height ? `×${height}` : ''}px`;
}
