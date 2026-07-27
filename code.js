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
figma.ui.onmessage = async (msg) => {
    if (msg.type !== 'convert' || !msg.tree)
        return;
    try {
        // Fresh image hashes per import; fonts can stay cached across runs.
        for (const key of Object.keys(imageHashCache))
            delete imageHashCache[key];
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
                'HTML Import' + (msg.viewportWidth ? ` · ${msg.viewportWidth}px` : '');
            rootFrame.x = viewport.x - rootFrame.width / 2;
            rootFrame.y = viewport.y - rootFrame.height / 2;
            figma.currentPage.appendChild(rootFrame);
            if (msg.asComponent) {
                rootFrame = figma.createComponentFromNode(rootFrame);
                rootFrame.name =
                    'HTML Component' + (msg.viewportWidth ? ` · ${msg.viewportWidth}px` : '');
            }
            figma.currentPage.selection = [rootFrame];
            figma.viewport.scrollAndZoomIntoView([rootFrame]);
            figma.ui.postMessage({
                type: 'done',
                count: countNodes(rootFrame),
                styles: stylesCreated,
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
        applyOpacity(rect, data.opacity);
        applyCornerRadius(rect, data.borderRadius);
        applyStroke(rect, data, styles);
        applyShadows(rect, data.boxShadows);
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
        applyOpacity(ellipse, data.opacity);
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
    applyOpacity(frame, data.opacity);
    applyCornerRadius(frame, data.borderRadius);
    applyStroke(frame, data, styles);
    applyShadows(frame, data.boxShadows);
    const overflow = (data.overflow || 'visible').toLowerCase();
    frame.clipsContent =
        data.borderRadius > 0 ||
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
    const font = await resolveFont(data.fontFamily, data.fontWeight, data.fontStyle);
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
    text.textAlignHorizontal = mapTextAlign(data.textAlign);
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
        text.textAutoResize = 'NONE';
        text.resize(Math.max(w, 1), Math.max(h, data.fontSize || 12));
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
    applyOpacity(text, data.opacity);
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
function applyShadows(node, shadows) {
    if (!shadows || shadows.length === 0)
        return;
    node.effects = shadows.map((shadow) => ({
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
function applyCornerRadius(node, radius) {
    if (radius > 0 && 'cornerRadius' in node) {
        node.cornerRadius = radius;
    }
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
function mapTextAlign(align) {
    switch ((align || 'left').toLowerCase()) {
        case 'center':
            return 'CENTER';
        case 'right':
        case 'end':
            return 'RIGHT';
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
    const italic = (fontStyle || '').toLowerCase() === 'italic';
    const w = parseInt(weight || '400', 10);
    let base = 'Regular';
    if (w >= 800)
        base = 'Black';
    else if (w >= 700)
        base = 'Bold';
    else if (w >= 600)
        base = 'Semi Bold';
    else if (w >= 500)
        base = 'Medium';
    else if (w <= 300)
        base = 'Light';
    if (!italic)
        return base;
    if (base === 'Regular')
        return 'Italic';
    return base + ' Italic';
}
function familyFallbacks(family) {
    const f = family.trim();
    const lower = f.toLowerCase();
    const serifLike = /playfair|serif|georgia|times|garamond|merriweather/.test(lower);
    const list = [f];
    if (serifLike) {
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
async function resolveFont(family, weight, fontStyle) {
    const cacheKey = (family || 'Inter') + '|' + (weight || '400') + '|' + (fontStyle || 'normal');
    const cached = fontFaceCache.get(cacheKey);
    if (cached)
        return cached;
    const style = weightToStyle(weight, fontStyle);
    // Google Fonts style names are inconsistent about the space in compound
    // weights ("Semi Bold" vs "SemiBold") depending on the family — try both
    // before giving up on the weight and falling back to Regular.
    const noSpace = style.replace(/ /g, '');
    const styleFallbacks = style.indexOf('Italic') >= 0
        ? [style, noSpace, 'Italic', style.replace(' Italic', ''), noSpace.replace('Italic', ''), 'Regular']
        : [style, noSpace, 'Regular'];
    const seen = new Set();
    for (const fam of familyFallbacks(family || 'Inter')) {
        for (const st of styleFallbacks) {
            const key = fam + '::' + st;
            if (seen.has(key))
                continue;
            seen.add(key);
            const font = { family: fam, style: st };
            if (await tryLoadFont(font)) {
                fontFaceCache.set(cacheKey, font);
                return font;
            }
        }
    }
    const fallback = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(fallback);
    fontFaceCache.set(cacheKey, fallback);
    return fallback;
}
function countNodes(node) {
    let n = 1;
    if ('children' in node) {
        for (const child of node.children)
            n += countNodes(child);
    }
    return n;
}
