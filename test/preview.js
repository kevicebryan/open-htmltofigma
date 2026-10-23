// Redraws a captured tree with plain HTML/SVG, following code.ts's rules (fills bottom → top,
// INSIDE strokes, Figma gradient transforms), so test/figma-e2e.mjs can diff a capture against the
// browser render without spending Figma calls. It checks the capture, not Figma itself: fonts and
// text wrapping are the browser's. Usage in a blank page: renderTree(tree, images) → root element.
// ponytail: an approximation of the builder, add cases when a diff shows the preview itself is wrong.
function renderTree(tree, images) {
  const css = (c) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
  const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  let gid = 0;

  // Figma's gradientTransform maps the node's unit square into gradient space, where a linear
  // gradient runs (0, .5) → (1, .5) and a radial one is the circle at (.5, .5) with radius .5.
  const unit = (m, x, y) => {
    const [[a, c, e], [b, d, f]] = m, det = a * d - b * c;
    return [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det];
  };
  function paintSvg(p, w, h) {
    if (p.type === 'SOLID') return `<rect width="${w}" height="${h}" fill="${css(p.color)}"/>`;
    if (p.type === 'IMAGE') {
      // A url paint is fetched by Figma itself, which may fail: leave it out rather than guess.
      if (!p.imageRef) return '';
      const src = 'data:image/png;base64,' + images[p.imageRef];
      return `<image href="${esc(src)}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${p.scaleMode === 'FIT' ? 'meet' : 'slice'}"/>`;
    }
    const id = 'g' + gid++;
    const stops = p.gradientStops.map((s) => `<stop offset="${s.position}" stop-color="${css(s.color)}"/>`).join('');
    const pt = (x, y) => { const [u, v] = unit(p.gradientTransform, x, y); return [u * w, v * h]; };
    let def;
    if (p.type === 'GRADIENT_LINEAR') {
      const [x1, y1] = pt(0, 0.5), [x2, y2] = pt(1, 0.5);
      def = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
    } else {
      const [cx, cy] = pt(0.5, 0.5), [ax, ay] = pt(1, 0.5), [bx, by] = pt(0.5, 1);
      def = `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" ` +
        `gradientTransform="matrix(${ax - cx},${ay - cy},${bx - cx},${by - cy},${cx},${cy})">${stops}</radialGradient>`;
    }
    return `<defs>${def}</defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`;
  }

  // Drop shadows go on the box; inner shadows on a layer above the fills and below the children.
  function effectsCss(effects, el) {
    const drop = [], inner = [];
    for (const fx of effects || []) {
      const sh = () => `${fx.offset.x}px ${fx.offset.y}px ${fx.radius}px ${fx.spread || 0}px ${css(fx.color)}`;
      if (fx.type === 'DROP_SHADOW') drop.push(sh());
      else if (fx.type === 'INNER_SHADOW') inner.push('inset ' + sh());
      else if (fx.type === 'LAYER_BLUR') el.style.filter = `blur(${fx.radius / 2}px)`;
      else if (fx.type === 'BACKGROUND_BLUR') el.style.backdropFilter = `blur(${fx.radius / 2}px)`;
    }
    if (drop.length) el.style.boxShadow = drop.join(',');
    if (inner.length) {
      const layer = document.createElement('div');
      layer.style.cssText = 'position:absolute;inset:0;border-radius:inherit;box-shadow:' + inner.join(',');
      el.appendChild(layer);
    }
  }

  function build(n, parent) {
    const el = document.createElement('div');
    const s = el.style;
    s.position = 'absolute';
    s.left = n.x - (parent ? parent.x : 0) + 'px';
    s.top = n.y - (parent ? parent.y : 0) + 'px';
    s.boxSizing = 'border-box';
    if (n.name) el.dataset.name = n.name;
    if (n.opacity !== undefined) s.opacity = n.opacity;
    if (n.blend) s.mixBlendMode = n.blend.toLowerCase().replace('_', '-').replace('linear-burn', 'color-burn').replace('pass-through', 'normal');
    if (n.transform) {
      s.transformOrigin = `${n.transform.ox}px ${n.transform.oy}px`;
      s.transform = `matrix(${n.transform.m.join(',')})`;
    }
    if (n.type === 'text') {
      const r0 = (n.runs || [])[0] || {};
      if (!n.autoWidth) s.width = n.w + 'px';
      s.minHeight = n.h + 'px';
      s.whiteSpace = n.autoWidth ? 'pre' : 'pre-wrap';
      s.textAlign = (n.align || 'LEFT').toLowerCase().replace('justified', 'justify');
      // The block's own font sets the line strut; a default 16px one would push big text down.
      s.lineHeight = r0.lineHeight + 'px';
      s.fontSize = r0.size + 'px';
      s.fontFamily = (r0.families || []).map((f) => `"${f}"`).join(',');
      if (n.maxLines) Object.assign(s, { display: '-webkit-box', webkitLineClamp: n.maxLines, webkitBoxOrient: 'vertical', overflow: 'hidden', height: n.h + 'px' });
      for (const r of n.runs || []) {
        const span = document.createElement('span');
        span.textContent = r.text.replace(/\u2028/g, '\n');
        Object.assign(span.style, {
          fontFamily: r.families.map((f) => (/^[\w-]+$/.test(f) ? f : `"${f}"`)).join(','),
          fontWeight: r.weight, fontStyle: r.italic ? 'italic' : 'normal', fontSize: r.size + 'px',
          lineHeight: r.lineHeight + 'px', letterSpacing: (r.letterSpacing || 0) + 'px', color: css(r.color),
          textDecoration: r.decoration ? r.decoration.toLowerCase().replace('strikethrough', 'line-through') : 'none',
          textTransform: { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[r.textCase] || 'none',
        });
        el.appendChild(span);
      }
      return el;
    }
    s.width = n.w + 'px';
    s.height = n.h + 'px';
    if (n.type === 'svg') {
      el.innerHTML = n.svg || '';
      const svg = el.firstElementChild;
      if (svg) { svg.setAttribute('width', n.w); svg.setAttribute('height', n.h); svg.style.display = 'block'; }
      if (n.clip) s.overflow = 'hidden';
      return el;
    }
    const r = n.radius;
    if (r) s.borderRadius = r.map((v) => v + 'px').join(' ');
    if (n.fills && n.fills.length) {
      const bg = document.createElement('div');
      bg.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit';
      bg.innerHTML = `<svg width="${n.w}" height="${n.h}" style="display:block">${n.fills.map((p) => paintSvg(p, n.w, n.h)).join('')}</svg>`;
      el.appendChild(bg);
    }
    if (n.stroke) {
      const b = document.createElement('div'), st = n.stroke;
      b.style.cssText = `position:absolute;inset:0;border-radius:inherit;border-style:${st.dash ? 'dashed' : 'solid'};border-color:${css(st.color)};` +
        `border-width:${st.t}px ${st.r}px ${st.b}px ${st.l}px;box-sizing:border-box;pointer-events:none;z-index:1`;
      el.appendChild(b);
    }
    effectsCss(n.effects, el);
    // Figma makes childless boxes Rectangles, which never clip.
    if (n.clip && n.children && n.children.length) s.overflow = 'hidden';
    for (const c of n.children || []) el.appendChild(build(c, n));
    return el;
  }
  return build(tree, null);
}
