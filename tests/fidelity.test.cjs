const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadPlugin(figmaOverrides = {}) {
  const context = {
    __html__: '',
    console,
    figma: {
      showUI() {},
      ui: {},
      ...figmaOverrides,
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(`${root}/code.js`, 'utf8'), context);
  return context;
}

function createFrameMock() {
  return {
    fills: [],
    strokes: [],
    children: [],
    clipsContent: true,
    opacity: 1,
    resize(width, height) {
      this.width = width;
      this.height = height;
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

function loadUiTextHelpers() {
  const source = fs.readFileSync(`${root}/ui.html`, 'utf8');
  const start = source.indexOf('    function countVisualTextLines');
  const end = source.indexOf('    function applyTextTransform', start);
  const symbolStart = source.indexOf('    function isFallbackDependentSymbolText');
  const symbolEnd = source.indexOf('    async function rasterizeSymbolText', symbolStart);
  const containerStart = source.indexOf('    function needsTextLayoutContainer');
  const containerEnd = source.indexOf('    function buildNodeName', containerStart);
  assert.ok(
    start >= 0 && end > start && symbolStart >= 0 && symbolEnd > symbolStart &&
      containerStart >= 0 && containerEnd > containerStart
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\n${source.slice(symbolStart, symbolEnd)}\n` +
      `${source.slice(containerStart, containerEnd)}\n` +
      'globalThis.helpers = { countVisualTextLines, normalizeTextForWhiteSpace, ' +
      'isFallbackDependentSymbolText, needsTextLayoutContainer };',
    context
  );
  return context.helpers;
}

test('normalizes browser whitespace without preserving source indentation', () => {
  const helpers = loadUiTextHelpers();
  assert.equal(
    helpers.normalizeTextForWhiteSpace(
      'بعد الانتقال إلى السؤال التالي لا يمكنك تعديل إجابتك\n              السابقة',
      'normal'
    ),
    'بعد الانتقال إلى السؤال التالي لا يمكنك تعديل إجابتك السابقة'
  );
  assert.equal(
    helpers.normalizeTextForWhiteSpace('  first   line \n  second line  ', 'pre-line'),
    'first line\nsecond line'
  );
  assert.equal(helpers.normalizeTextForWhiteSpace('  exact\n  spacing', 'pre'), '  exact\n  spacing');
});

test('counts bidi fragments on the same vertical position as one visual line', () => {
  const { countVisualTextLines } = loadUiTextHelpers();
  assert.equal(
    countVisualTextLines([
      { top: 10, height: 16 },
      { top: 10.4, height: 16 },
      { top: 30, height: 16 },
    ]),
    2
  );
});

test('limits browser glyph rasterization to symbol-only runs', () => {
  const { isFallbackDependentSymbolText } = loadUiTextHelpers();
  assert.equal(isFallbackDependentSymbolText('▮▮▮'), true);
  assert.equal(isFallbackDependentSymbolText('≋'), true);
  assert.equal(isFallbackDependentSymbolText('الوقت ١٠'), false);
  assert.equal(isFallbackDependentSymbolText('ordinary text'), false);
});

test('keeps text-only layout boxes as containers', () => {
  const { needsTextLayoutContainer } = loadUiTextHelpers();
  const plainStyle = {
    display: 'inline',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
  };
  const plainVisual = { solid: null, gradient: null, borderWidth: 0, shadows: null };

  assert.equal(needsTextLayoutContainer({ ...plainStyle, display: 'flex' }, plainVisual), true);
  assert.equal(needsTextLayoutContainer({ ...plainStyle, paddingTop: '8px' }, plainVisual), true);
  assert.equal(needsTextLayoutContainer(plainStyle, { ...plainVisual, borderWidth: 1 }), true);
  assert.equal(needsTextLayoutContainer(plainStyle, plainVisual), false);
});

test('uses CSS weight fallback order within the requested family', async () => {
  const available = [
    ['Tajawal', 'Regular'],
    ['Tajawal', 'Medium'],
    ['Tajawal', 'Bold'],
    ['Noto Sans Arabic', 'Regular'],
    ['Inter', 'Regular'],
  ].map(([family, style]) => ({ fontName: { family, style } }));
  const context = loadPlugin({
    async listAvailableFontsAsync() {
      return available;
    },
    async loadFontAsync() {},
  });
  vm.runInContext('globalThis.resolveForTest = resolveFont;', context);

  const semi = await context.resolveForTest('Tajawal', '600', 'normal', 'سلسلة');
  const medium = await context.resolveForTest('Tajawal', '500', 'normal', 'اقرأ');
  const missingArabic = await context.resolveForTest('Missing', '500', 'normal', 'العربية');

  assert.deepEqual({ ...semi.fontName }, { family: 'Tajawal', style: 'Bold' });
  assert.equal(semi.weight, 700);
  assert.deepEqual({ ...medium.fontName }, { family: 'Tajawal', style: 'Medium' });
  assert.equal(missingArabic.fontName.family, 'Noto Sans Arabic');
});

test('separates SVG artwork clipping from its CSS viewport', async () => {
  const context = loadPlugin({
    createNodeFromSvg() {
      return createFrameMock();
    },
    createFrame() {
      return createFrameMock();
    },
  });
  vm.runInContext('globalThis.buildForTest = buildNode;', context);
  const wrapper = await context.buildForTest(
    {
      tag: 'svg',
      name: 'corner',
      x: -65,
      y: -90,
      width: 140,
      height: 140,
      opacity: 1,
      filterOpacity: 1,
      filterBrightness: 0.85,
      backgroundColor: null,
      borderWidth: 0,
      borderColor: null,
      overflow: 'hidden',
      isText: false,
      isImage: false,
      isSvg: true,
      svgMarkup: '<svg/>',
      children: [],
    },
    { x: 0, y: 0 },
    new Map()
  );

  assert.equal(wrapper.clipsContent, true);
  assert.equal(wrapper.children[0].clipsContent, false);
  assert.equal(wrapper.x, -65);
  assert.equal(wrapper.y, -90);
});

test('names imports from the HTML filename and viewport', () => {
  const context = loadPlugin();
  vm.runInContext(
    'globalThis.importNameForTest = (file, width, height) => sourceName(file) + viewportLabel(width, height);',
    context
  );

  assert.equal(
    context.importNameForTest('01-intro-rules.html', 390, 844),
    '01-intro-rules · 390×844px'
  );
  assert.equal(context.importNameForTest('landing.xhtml', 1440, 900), 'landing · 1440×900px');
  assert.equal(context.importNameForTest('', 390, 844), 'HTML Import · 390×844px');
});

test('aligns Figma text to browser content bounds and line leading', () => {
  const context = loadPlugin();
  vm.runInContext('globalThis.browserAlignedTextYForTest = browserAlignedTextY;', context);

  assert.equal(
    context.browserAlignedTextYForTest(
      { fontSize: 14.5, lineHeight: 17.4, browserTextTopOffset: 0 },
      110.5
    ),
    109.05
  );
  assert.equal(
    context.browserAlignedTextYForTest(
      { fontSize: 13.5, lineHeight: 22.275, browserTextTopOffset: 0 },
      74
    ),
    69.6125
  );
  assert.equal(context.browserAlignedTextYForTest({}, 42), 42);
});

test('adds bidi hints only when Figma cannot infer browser direction', () => {
  const context = loadPlugin();
  vm.runInContext('globalThis.bidiHintsForTest = applyBidiDirectionHints;', context);

  assert.equal(context.bidiHintsForTest('١٠٠٪', 'rtl'), '\u200F١٠٠٪');
  assert.equal(context.bidiHintsForTest('نتيجتك: ١٠٠٪', 'rtl'), 'نتيجتك: ١٠٠٪');
  assert.equal(context.bidiHintsForTest('100%', 'rtl'), '\u200F100%');
  assert.equal(context.bidiHintsForTest('العربية', 'ltr'), '\u200Eالعربية');
  assert.equal(context.bidiHintsForTest('plain', 'ltr'), 'plain');
  assert.equal(context.bidiHintsForTest('\u200F١٠٠٪', 'rtl'), '\u200F١٠٠٪');
});
