import { fonts, CATEGORIES, cssFamily, registerPreviews, getFont, addCustomFont } from './fonts.js';
import { layoutBox, hitTest, pullPoint } from './layout.js';
import { fitView, render, handleAt, boxRect, drawArtwork } from './renderer.js';
import { createColorPicker } from './colorpicker.js';
import { PixelLayer } from './pixels.js';
import { exportPNG, exportSVG, exportGIF, exportMP4, canEncodeMP4, maxScale, download } from './export.js';
import { Timeline, createTimelineUI } from './timeline.js';

// Artboard size in pixels; mutable via the Canvas panel.
const artboard = { width: 1600, height: 1000 };

// ---------- Document: text boxes ----------
// Each box has its own text, metrics, styles and warp. `fonts[i]` is the
// font of character i (indexed like the string), so single letters can
// use different fonts.

let nextBoxId = 1;

function makeBox(props = {}) {
  const box = {
    id: nextBoxId++,
    text: 'Text',
    font: 'playfair',
    size: 200,
    tracking: 0,
    lineHeight: 1.1,
    offsetX: 0, // position relative to artboard center
    offsetY: 0,
    bold: false,
    italic: false,
    underline: false,
    outline: false,
    stroke: 0, // 1/1000 em
    warp: 'none',
    warpAmount: 40,
    warpFreq: 50,
    warpPhase: 0, // degrees; animate it to make waves travel
    ...props,
  };
  box.fonts ??= Array(box.text.length).fill(box.font);
  return box;
}

const doc = { boxes: [makeBox({ text: 'Nexus', size: 360 })], activeId: 1 };

const state = {
  fg: '#000000',
  bg: '#ffffff',
  tool: 'text', // 'text' | 'brush'
  eraser: false,
  pixelSize: 24,
  brushSize: 120,
  softness: 0, // percent
  pixelWeight: 70, // percent
  bleed: 0, // percent
  // Pixel layers, bottom to top. Each has its own shape; size, weight,
  // softness and bleed stay global.
  // pixelSize / pixelWeight on a layer override the global values (null =
  // follow global). `editAll` = the "All layers" row is selected.
  layers: [{ id: 1, name: 'Layer 1', shape: 'square', visible: true, pixelSize: null, pixelWeight: null }],
  activeLayer: 1, // the layer the brush paints into
  editAll: true,
  shiftX: 0, // slides every painted area (animatable)
  shiftY: 0,
  boil: 0, // hand-drawn jitter amount (percent)
  boilRate: 8, // boil redraws per second
  clip: true, // new strokes clip to letters vs. free paint
};

const pixels = new PixelLayer();
const timeline = new Timeline();
let transitions = new Map(); // box id → mid-animation font change
let revealOverride = null; // animated stroke count (null = all strokes)

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');

const activeBox = () => doc.boxes.find((b) => b.id === doc.activeId) ?? null;
const entryById = (id) => fonts.find((f) => f.id === id) ?? fonts[0];

let scenes = new Map(); // box id → laid-out scene
let art = null; // whole document: { items, path2d, d }
let view = { scale: 1, x: 0, y: 0 };
let dpr = window.devicePixelRatio || 1;

// ---------- Rendering ----------

const bleedSigma = () => (state.bleed / 100) * state.pixelSize * 0.3;

// A layer's own pixel size / weight, or the global one it follows.
const layerValue = (layer, key) => layer[key] ?? state[key];
const LAYER_KEYS = ['pixelSize', 'pixelWeight'];

function currentPixels() {
  return pixels.compute({
    artboard,
    anchors: anchors(),
    scene: art,
    layers: state.layers.map((l) => ({ ...l, ps: layerValue(l, 'pixelSize'), weight: layerValue(l, 'pixelWeight') })),
    reveal: revealOverride,
    seed: boilSeed(),
  });
}

let frame = 0;
function requestRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const box = activeBox();
    render(ctx, {
      artboard,
      art,
      scene: box ? scenes.get(box.id) : null,
      colors: state,
      editing: editingState(),
      selected: selected && !!box,
      resizeLabel: gesture?.type === 'resize' && box ? `${box.size}px` : null,
      guides: gesture?.type === 'move' ? gesture.guides : null,
      draft: gesture?.type === 'draw' ? gesture : null,
      mesh: state.tool === 'pull' && gesture?.type !== 'pull' ? meshFor(activeBox()) : null,
      hotHandle,
      pixels: currentPixels(),
      bleed: bleedSigma(),
      brush: (state.tool === 'brush' || state.tool === 'pull') && pointer
        ? state.tool === 'pull'
          ? { ...pointer, size: state.brushSize, softness: 0, erase: false, pull: true }
          : { ...pointer, size: state.brushSize, softness: state.softness / 100, erase: erasing() }
        : null,
    }, view, dpr);
  });
}

// Where each box sits: painted strokes are stored relative to these.
// Id 0 is the canvas itself, for strokes painted with no boxes around.
function boxAnchor(b) {
  return {
    cx: artboard.width / 2 + b.offsetX + state.shiftX,
    cy: artboard.height / 2 + b.offsetY + state.shiftY,
    size: b.size,
  };
}

function anchors() {
  const m = new Map([[0, { cx: artboard.width / 2 + state.shiftX, cy: artboard.height / 2 + state.shiftY, size: 100 }]]);
  for (const b of doc.boxes) m.set(b.id, boxAnchor(b));
  return m;
}

let layoutToken = 0;
async function relayout() {
  const token = ++layoutToken;
  const ids = new Set();
  for (const b of doc.boxes) {
    ids.add(b.font);
    for (const f of b.fonts) ids.add(f);
  }
  for (const tr of transitions.values()) {
    for (const side of [tr.a, tr.b]) {
      ids.add(side.font);
      for (const f of side.fonts) ids.add(f);
    }
  }
  try {
    await Promise.all([...ids].map((id) => getFont(entryById(id))));
  } catch (err) {
    showStatus(err.message);
    return;
  }
  if (token !== layoutToken) return; // a newer change superseded this one

  const next = new Map();
  const items = [];
  const path2d = new Path2D();
  const fontFor = (id) => entryById(id).font;
  const fx = { boil: state.boil, seed: boilSeed() };
  for (const b of doc.boxes) {
    const tr = transitions.get(b.id);
    if (tr) {
      // Lay out both sides of a font change and blend them while drawing.
      const sa = layoutBox({ ...b, font: tr.a.font, fonts: fitFonts(tr.a.fonts, b) }, fontFor, artboard, fx);
      const sb = layoutBox({ ...b, font: tr.b.font, fonts: fitFonts(tr.b.fonts, b) }, fontFor, artboard, fx);
      next.set(b.id, tr.u < 0.5 ? sa : sb);
      items.push({ box: b, path2d: sa.path2d, d: tr.u < 0.5 ? sa.d : sb.d, trans: transitionFor(sa, sb, tr.u) });
      path2d.addPath(sa.path2d);
      path2d.addPath(sb.path2d);
      continue;
    }
    const s = layoutBox(b, fontFor, artboard, fx);
    next.set(b.id, s);
    items.push({ box: b, path2d: s.path2d, d: s.d });
    path2d.addPath(s.path2d);
  }
  scenes = next;
  art = { items, path2d, d: items.map((it) => it.d).join(' ') };
  requestRender();
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const { width, height } = stage.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  view = fitView(width, height, artboard);
  requestRender();
}

new ResizeObserver(resize).observe(stage);

// ---------- Sliders ----------
// Box sliders edit the active text box; the rest are global settings.

const sliders = {
  size: { box: true, format: (v) => `${Math.round(v)}px` },
  tracking: { box: true, format: (v) => `${Math.round(v)}` },
  lineHeight: { box: true, format: (v) => Number(v).toFixed(2) },
  stroke: { box: true, format: (v) => (v ? `${Math.round(v)}` : 'Off') },
  warpAmount: { box: true, format: (v) => `${Math.round(v)}%` },
  warpFreq: { box: true, format: (v) => `${Math.round(v)}%` },
  pixelSize: { format: (v) => `${Math.round(v)}px` },
  pixelWeight: { format: (v) => `${Math.round(v)}%` },
  brushSize: { format: (v) => `${v}px` },
  softness: { format: (v) => `${v}%` },
  bleed: { format: (v) => (v ? `${Math.round(v)}%` : 'Off') },
  boil: { format: (v) => (v ? `${Math.round(v)}%` : 'Off'), layout: true },
  boilRate: { format: (v) => `${v} fps`, layout: true },
  shiftX: { format: (v) => `${Math.round(v)}` },
  shiftY: { format: (v) => `${Math.round(v)}` },
};

function showSlider(key, value) {
  $(key).value = value;
  $(`${key}-out`).textContent = sliders[key].format(value);
}

function setSlider(key, value) {
  const input = $(key);
  value = Math.min(Number(input.max), Math.max(Number(input.min), value));
  if (LAYER_KEYS.includes(key) && !state.editAll) {
    activeLayer()[key] = value; // just this layer (not keyframed)
    showSlider(key, value);
    renderLayers();
    requestRender();
    return;
  }
  if (LAYER_KEYS.includes(key)) {
    for (const l of state.layers) l[key] = null; // All layers: everyone follows global again
  }
  if (sliders[key].box) {
    const box = activeBox();
    if (!box) return;
    box[key] = value;
    relayout();
  } else {
    state[key] = value;
    if (sliders[key].layout) relayout();
    requestRender();
  }
  showSlider(key, value);
  if (LAYER_KEYS.includes(key)) renderLayers();
  if (key === 'boil') syncBoil();
  if (key === 'boil' || key === 'boilRate') return syncExport(); // live effect, not keyed
  markEdited();
}

for (const key of Object.keys(sliders)) {
  $(key).addEventListener('input', (e) => setSlider(key, Number(e.target.value)));
  if (!sliders[key].box) showSlider(key, state[key]);
}

// ---------- Canvas size ----------

const PRESETS = [
  { label: 'Landscape', w: 1600, h: 1000, unit: 'px' },
  { label: 'Square', w: 1080, h: 1080, unit: 'px' },
  { label: 'Portrait post', w: 1080, h: 1350, unit: 'px' },
  { label: 'Story', w: 1080, h: 1920, unit: 'px' },
  { label: 'Presentation', w: 1920, h: 1080, unit: 'px' },
  { label: 'US Letter', w: 8.5, h: 11, unit: 'in' },
  { label: 'A4', w: 8.27, h: 11.69, unit: 'in' },
  { label: 'Poster', w: 18, h: 24, unit: 'in' },
];

const MIN_DIM = 16;
const MAX_DIM = 12000;
const canvasUnits = { unit: 'px', dpi: 300 };

const presetSelect = $('art-preset');
const widthInput = $('art-w');
const heightInput = $('art-h');
const dpiInput = $('art-dpi');

presetSelect.innerHTML =
  '<option value="custom">Custom</option>' +
  PRESETS.map((p, i) => `<option value="${i}">${p.label} · ${p.w} × ${p.h} ${p.unit}</option>`).join('');

const toPx = (v, unit) => Math.round(unit === 'in' ? v * canvasUnits.dpi : v);
const fromPx = (px) => (canvasUnits.unit === 'in' ? +(px / canvasUnits.dpi).toFixed(2) : px);

function syncCanvasFields() {
  const { unit, dpi } = canvasUnits;
  widthInput.value = fromPx(artboard.width);
  heightInput.value = fromPx(artboard.height);
  for (const el of [widthInput, heightInput]) el.step = unit === 'in' ? '0.01' : '1';
  for (const el of document.querySelectorAll('.art-unit')) el.textContent = unit;
  for (const b of document.querySelectorAll('[data-unit]')) {
    b.setAttribute('aria-checked', String(b.dataset.unit === unit));
  }
  $('art-dpi-field').hidden = unit !== 'in';
  dpiInput.value = dpi;
  $('art-px-note').textContent = unit === 'in' ? `${artboard.width} × ${artboard.height} px` : '';

  const match = PRESETS.findIndex(
    (p) => toPx(p.w, p.unit) === artboard.width && toPx(p.h, p.unit) === artboard.height,
  );
  presetSelect.value = match === -1 ? 'custom' : String(match);
  syncExport();
}

// Resizing the artboard scales the design with it (like Canva's resize),
// so everything keeps its proportions.
function setArtboard(w, h) {
  w = Math.min(MAX_DIM, Math.max(MIN_DIM, Math.round(w)));
  h = Math.min(MAX_DIM, Math.max(MIN_DIM, Math.round(h)));
  if (w !== artboard.width || h !== artboard.height) {
    const kx = w / artboard.width;
    const ky = h / artboard.height;
    const k = Math.min(kx, ky);
    artboard.width = w;
    artboard.height = h;
    // Slider ranges grow with big canvases so posters can have big type and blocks.
    const grow = Math.max(1, Math.max(w, h) / 1600);
    $('size').max = Math.max(900, Math.round(Math.max(w, h) * 0.9));
    $('pixelSize').max = Math.round(160 * grow);
    $('brushSize').max = Math.round(600 * grow);
    for (const b of doc.boxes) {
      b.offsetX *= kx;
      b.offsetY *= ky;
      b.size = Math.max(4, Math.round(b.size * k));
    }
    $('shiftX').min = -Math.round(w / 2);
    $('shiftX').max = Math.round(w / 2);
    $('shiftY').min = -Math.round(h / 2);
    $('shiftY').max = Math.round(h / 2);
    setSlider('shiftX', Math.round(state.shiftX * kx));
    setSlider('shiftY', Math.round(state.shiftY * ky));
    for (const l of state.layers) if (l.pixelSize != null) l.pixelSize = Math.max(4, Math.round(l.pixelSize * k));
    state.pixelSize = Math.round(state.pixelSize * k);
    syncPixelSliders();
    setSlider('brushSize', Math.round(state.brushSize * k));
    syncBoxControls();
    relayout();
    resize();
  }
  syncCanvasFields();
}

presetSelect.addEventListener('change', () => {
  const p = PRESETS[Number(presetSelect.value)];
  if (!p) return;
  canvasUnits.unit = p.unit;
  setArtboard(toPx(p.w, p.unit), toPx(p.h, p.unit));
});

function onDimension() {
  const w = parseFloat(widthInput.value);
  const h = parseFloat(heightInput.value);
  if (w > 0 && h > 0) setArtboard(toPx(w, canvasUnits.unit), toPx(h, canvasUnits.unit));
  else syncCanvasFields();
}
widthInput.addEventListener('change', onDimension);
heightInput.addEventListener('change', onDimension);

$('art-swap').addEventListener('click', () => setArtboard(artboard.height, artboard.width));

for (const b of document.querySelectorAll('[data-unit]')) {
  b.addEventListener('click', () => {
    canvasUnits.unit = b.dataset.unit;
    syncCanvasFields();
  });
}

// Changing DPI keeps the physical size in inches and changes the pixel count.
dpiInput.addEventListener('change', () => {
  const dpi = Math.round(parseFloat(dpiInput.value));
  if (!(dpi >= 18 && dpi <= 1200)) return syncCanvasFields();
  const inW = artboard.width / canvasUnits.dpi;
  const inH = artboard.height / canvasUnits.dpi;
  canvasUnits.dpi = dpi;
  setArtboard(inW * dpi, inH * dpi);
});

// ---------- Text editing ----------
// The sidebar textarea holds the active box's text. Clicking a box on the
// canvas focuses it and sets its selection, so typing, arrows, paste, IME
// and undo come for free; the canvas just draws the caret.

const textInput = $('text');
let typingFont = null; // { id, at } — font picked at a collapsed caret

// Keep per-character fonts aligned with the text: diff old vs. new, and
// give inserted characters the font of their neighbor (or the typing font).
function applyTextEdit(box, next) {
  const prev = box.text;
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let b = 0;
  while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  const inserted = next.length - a - b;
  const font = typingFont?.at === a ? typingFont.id : box.fonts[a - 1] ?? box.fonts[a] ?? box.font;
  box.fonts.splice(a, prev.length - a - b, ...Array(inserted).fill(font));
  box.text = next;
  if (typingFont?.at === a) typingFont.at = a + inserted; // keep typing in that font
}

textInput.addEventListener('input', () => {
  const box = activeBox();
  if (!box) return;
  applyTextEdit(box, textInput.value);
  updatePreviews();
  relayout();
});

function syncBoxControls() {
  const box = activeBox();
  textInput.value = box?.text ?? '';
  textInput.disabled = !box;
  for (const key of Object.keys(sliders)) {
    if (sliders[key].box && box) showSlider(key, box[key]);
  }
  for (const b of document.querySelectorAll('[data-style]')) {
    b.setAttribute('aria-pressed', String(!!box?.[b.dataset.style]));
  }
  for (const b of document.querySelectorAll('[data-warp]')) {
    b.setAttribute('aria-checked', String((box?.warp ?? 'none') === b.dataset.warp));
  }
  const warp = box?.warp ?? 'none';
  $('warp-amount-row').hidden = warp === 'none';
  $('warp-freq-row').hidden = warp !== 'wave' && warp !== 'distort';
  syncFontButton();
  updatePreviews();
}

function setActive(id) {
  if (doc.activeId === id) return;
  doc.activeId = id;
  typingFont = null;
  syncBoxControls();
  requestRender();
}

function addBox(x, y, size) {
  const prev = activeBox();
  const box = makeBox({
    text: 'Text',
    font: prev?.font ?? 'playfair',
    size: size ?? (prev ? Math.round(prev.size * 0.6) : 200),
    offsetX: x - artboard.width / 2,
    offsetY: y - artboard.height / 2,
  });
  doc.boxes.push(box);
  setActive(box.id);
  selected = true;
  relayout();
  // Select the placeholder so typing replaces it.
  focusText();
  textInput.select();
  return box;
}

function deleteActiveBox() {
  const box = activeBox();
  if (!box) return;
  doc.boxes = doc.boxes.filter((b) => b.id !== box.id);
  doc.activeId = doc.boxes[doc.boxes.length - 1]?.id ?? null;
  selected = false;
  textInput.blur();
  syncBoxControls();
  relayout();
  requestRender();
}

$('add-box').addEventListener('click', () => {
  // Stagger new boxes below the active one so they don't stack exactly.
  const prev = activeBox();
  const y = prev ? artboard.height / 2 + prev.offsetY + prev.size * 0.9 : artboard.height / 2;
  addBox(artboard.width / 2, Math.min(artboard.height * 0.9, y));
});

for (const b of document.querySelectorAll('[data-style]')) {
  b.addEventListener('click', () => {
    const box = activeBox();
    if (!box) return;
    box[b.dataset.style] = !box[b.dataset.style];
    syncBoxControls();
    relayout();
  });
}

for (const b of document.querySelectorAll('[data-warp]')) {
  b.addEventListener('click', () => {
    const box = activeBox();
    if (!box) return;
    box.warp = b.dataset.warp;
    syncBoxControls();
    relayout();
  });
}

// ---------- Canvas interaction ----------
// Figma-style selection:
//   click a box           → select it and edit with caret at that point
//   drag a box            → move it (snaps to artboard center)
//   drag box edge         → move it, even while editing
//   drag corner handle    → resize font
//   click empty space     → deselect; double-click empty space → new box
//   Delete / Backspace    → delete the selected box (when not typing)

let caretOn = true;
let blinkTimer = 0;
let selected = false; // box visible even when not editing
let gesture = null; // { type: 'pending' | 'move' | 'select' | 'resize' | 'paint', ... }
let fontTarget = null; // selection to restyle while the font menu has focus

const isEditing = () => document.activeElement === textInput;

function editingState() {
  if (isEditing()) return { start: textInput.selectionStart, end: textInput.selectionEnd, caretOn };
  // Keep the selection visible while choosing a font for it.
  if (fontTarget && !fontMenu.hidden) return { ...fontTarget, caretOn: false };
  return null;
}

function restartBlink() {
  caretOn = true;
  clearInterval(blinkTimer);
  if (isEditing()) {
    blinkTimer = setInterval(() => { caretOn = !caretOn; requestRender(); }, 530);
  }
  if (isEditing()) syncFontButton();
  requestRender();
}

document.addEventListener('selectionchange', restartBlink);
for (const type of ['focus', 'blur', 'keydown', 'select']) {
  textInput.addEventListener(type, () => requestAnimationFrame(restartBlink));
}
textInput.addEventListener('focus', () => { selected = true; });

function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function toArtboard(e) {
  const s = toCanvas(e);
  return { x: (s.x - view.x) / view.scale, y: (s.y - view.y) / view.scale };
}

// Which box (and which part of its selection box) is under the pointer.
// Handles only exist on the active box; later boxes sit on top.
const EDGE = 6; // screen px either side of the box outline
function boxHit(e) {
  const s = toCanvas(e);
  const active = activeBox();
  if (active && (selected || isEditing())) {
    const sc = scenes.get(active.id);
    const handle = sc && handleAt(sc.bounds, view, s.x, s.y);
    if (handle) return { box: active, part: 'handle', handle };
  }
  const order = [...doc.boxes].reverse();
  // Prefer the active box when boxes overlap.
  if (active) order.sort((a, b) => (b.id === active.id) - (a.id === active.id));
  for (const box of order) {
    const sc = scenes.get(box.id);
    if (!sc) continue;
    const r = boxRect(sc.bounds, view);
    const within = (m) => s.x >= r.x - m && s.x <= r.x + r.w + m && s.y >= r.y - m && s.y <= r.y + r.h + m;
    if (within(EDGE)) return { box, part: within(-EDGE) ? 'inside' : 'edge' };
  }
  return null;
}

const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

function cursorFor(hit) {
  if (!hit) return 'default';
  if (hit.part === 'handle') return HANDLE_CURSORS[hit.handle];
  if (hit.part === 'inside' && isEditing() && hit.box.id === doc.activeId) return 'text';
  return 'move';
}

// Boxes are laid out centered on (artboard center + offset), so resizing
// scales about that point: size follows the pointer's distance from it.
function boxCenter(box) {
  return {
    x: view.x + (artboard.width / 2 + box.offsetX) * view.scale,
    y: view.y + (artboard.height / 2 + box.offsetY) * view.scale,
  };
}

const SNAP = 6; // screen px

function updateMove(e) {
  const s = toCanvas(e);
  const box = gesture.box;
  let dx = (s.x - gesture.sx) / view.scale;
  let dy = (s.y - gesture.sy) / view.scale;
  const guides = { x: false, y: false };
  // Snap the box center to the artboard center lines.
  const cx = gesture.center.x + dx;
  const cy = gesture.center.y + dy;
  if (Math.abs(cx - artboard.width / 2) * view.scale < SNAP) {
    dx = artboard.width / 2 - gesture.center.x;
    guides.x = true;
  }
  if (Math.abs(cy - artboard.height / 2) * view.scale < SNAP) {
    dy = artboard.height / 2 - gesture.center.y;
    guides.y = true;
  }
  gesture.guides = guides;
  box.offsetX = gesture.ox + dx;
  box.offsetY = gesture.oy + dy;
  relayout();
}

function placeCaret(e, extend) {
  const sc = scenes.get(doc.activeId);
  if (!sc) return 0;
  const p = toArtboard(e);
  const index = hitTest(sc, p.x, p.y);
  const anchor = extend ? textInput.selectionStart : index;
  focusText();
  selectRange(anchor, index);
  return anchor;
}

canvas.addEventListener('pointerdown', (e) => {
  // Phones: tapping the canvas tucks sheets away (Canva-style), except
  // the Text sheet while you're typing.
  if (isPhone()) {
    if (openSheet && !(openSheet === 'Text' && isEditing())) closeSheet();
    animatePanel.hidden = true;
  }
  if (e.button !== 0) return;
  if (state.tool === 'brush') return brushDown(e);
  if (state.tool === 'pull') return pullDown(e);
  const hit = boxHit(e);
  const s = toCanvas(e);

  if (!hit) {
    selected = false;
    textInput.blur();
    // Text tool: dragging on empty canvas draws a new text box.
    if (state.tool === 'text') {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = toArtboard(e);
      gesture = { type: 'draw', from: p, to: p };
    }
    requestRender();
    return;
  }

  e.preventDefault(); // keep focus where it is; we manage it ourselves
  canvas.setPointerCapture(e.pointerId);
  const wasActive = hit.box.id === doc.activeId;

  if (hit.part === 'handle') {
    const c = boxCenter(hit.box);
    gesture = { type: 'resize', box: hit.box, dist: Math.max(1, Math.hypot(s.x - c.x, s.y - c.y)), size: hit.box.size };
  } else if (hit.part === 'inside' && isEditing() && wasActive) {
    gesture = { type: 'select', anchor: placeCaret(e, e.shiftKey) };
  } else {
    if (!wasActive) textInput.blur();
    setActive(hit.box.id);
    const b = scenes.get(hit.box.id).bounds;
    gesture = {
      type: 'pending',
      box: hit.box,
      sx: s.x,
      sy: s.y,
      ox: hit.box.offsetX,
      oy: hit.box.offsetY,
      center: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 },
      shift: e.shiftKey && wasActive,
    };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (state.tool === 'brush') return brushMove(e);
  if (state.tool === 'pull') return pullMove(e);
  if (!gesture) {
    canvas.style.cursor = cursorFor(boxHit(e));
    return;
  }
  const s = toCanvas(e);
  switch (gesture.type) {
    case 'draw':
      gesture.to = toArtboard(e);
      canvas.style.cursor = 'crosshair';
      requestRender();
      break;
    case 'pending':
      if (Math.hypot(s.x - gesture.sx, s.y - gesture.sy) > 3) {
        gesture.type = 'move';
        selected = true;
        canvas.style.cursor = 'move';
        updateMove(e);
      }
      break;
    case 'move':
      updateMove(e);
      break;
    case 'select': {
      const sc = scenes.get(doc.activeId);
      if (!sc) break;
      const p = toArtboard(e);
      selectRange(gesture.anchor, hitTest(sc, p.x, p.y));
      break;
    }
    case 'resize': {
      const c = boxCenter(gesture.box);
      const ratio = Math.hypot(s.x - c.x, s.y - c.y) / gesture.dist;
      setSlider('size', Math.round(gesture.size * ratio));
      break;
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (gesture?.type === 'paint') {
    pixels.end();
    logAction('px');
    markEdited({ painted: true });
  }
  if (gesture?.type === 'pull') {
    const added = gesture.box.pulls.slice(gesture.before);
    if (added.every((q) => q.du === 0 && q.dv === 0)) gesture.box.pulls.length = gesture.before;
    else logAction({ box: gesture.box, before: gesture.before });
  }
  if (gesture?.type === 'mesh') {
    const { box, pull, before } = gesture;
    const moved = pull.du !== gesture.du0 || pull.dv !== gesture.dv0;
    // A click that didn't move leaves no empty pull behind (but keeps a new point).
    if (!moved && !before.pulls.some((q) => q.mesh === pull.mesh)) box.pulls = box.pulls.filter((q) => q !== pull);
    if (moved || before.points.length !== (box.pullPoints ?? []).length) logAction({ box, swap: before });
    hotHandle = null;
  }
  if (gesture?.type === 'draw') {
    const { from, to } = gesture;
    const w = Math.abs(to.x - from.x);
    const h = Math.abs(to.y - from.y);
    gesture = null;
    // Ignore tiny drags (that was a click). Font size follows the box height.
    if (w * view.scale > 8 && h * view.scale > 8) {
      const input = $('size');
      const size = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(h * 0.8)));
      addBox((from.x + to.x) / 2, (from.y + to.y) / 2, size);
    }
    requestRender();
    return;
  }
  if (gesture?.type === 'move' || gesture?.type === 'resize') markEdited();
  if (gesture?.type === 'pending') {
    // A click, not a drag: the Text tool starts typing there; Select just selects.
    if (state.tool === 'select') {
      selected = true;
      textInput.blur();
    } else {
      placeCaret(e, gesture.shift && isEditing());
    }
  }
  gesture = null;
  requestRender();
});

canvas.addEventListener('dblclick', (e) => {
  if (state.tool === 'pull') return; // points are added with a single press
  if (state.tool !== 'text' && state.tool !== 'select') return;
  const hit = boxHit(e);
  // Select tool: double-click a box to start typing in it (like Illustrator).
  if (state.tool === 'select') {
    if (hit) {
      setActive(hit.box.id);
      placeCaret(e, false);
    }
    return;
  }
  if (!hit) {
    const p = toArtboard(e);
    addBox(p.x, p.y);
    return;
  }
  if (!isEditing() || hit.box.id !== doc.activeId) return;
  const sc = scenes.get(hit.box.id);
  const p = toArtboard(e);
  const index = hitTest(sc, p.x, p.y);
  const text = textInput.value;
  let a = index;
  let b = index;
  while (a > 0 && /\S/.test(text[a - 1])) a--;
  while (b < text.length && /\S/.test(text[b])) b++;
  selectRange(a, b);
});

function selectRange(anchor, focus) {
  textInput.setSelectionRange(
    Math.min(anchor, focus),
    Math.max(anchor, focus),
    focus < anchor ? 'backward' : 'forward',
  );
  restartBlink();
}

// ---------- Pixel brush input ----------

let pointer = null; // brush cursor position in canvas CSS px
let shiftHeld = false;

const erasing = () => state.eraser !== shiftHeld; // Shift flips brush ↔ eraser

// A stroke belongs to the box it starts on (else the nearest box), so
// moving or resizing that box carries its pixels along.
function boxForPoint(p) {
  let best = null;
  let bestDist = Infinity;
  for (const b of [...doc.boxes].reverse()) {
    const sc = scenes.get(b.id);
    if (!sc) continue;
    const { x0, y0, x1, y1 } = sc.bounds;
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return b;
    const d = Math.hypot(p.x - (x0 + x1) / 2, p.y - (y0 + y1) / 2);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return best;
}

function brushDown(e) {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  shiftHeld = e.shiftKey;
  const p = toArtboard(e);
  const box = boxForPoint(p);
  const id = box?.id ?? 0;
  pixels.begin(p, id, anchors().get(id), {
    brushSize: state.brushSize,
    softness: state.softness / 100,
    erase: erasing(),
    clip: state.clip,
    layer: state.activeLayer,
  });
  gesture = { type: 'paint', id };
  requestRender();
}

function brushMove(e) {
  pointer = toCanvas(e);
  if (gesture?.type !== 'paint') shiftHeld = e.shiftKey; // keep the cursor's eraser look in sync
  if (gesture?.type === 'paint') {
    const anchor = anchors().get(gesture.id);
    // Coalesced events give every sample the pointer produced → smoother strokes.
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events.length ? events : [e]) pixels.extend(toArtboard(ev), anchor);
  }
  requestRender();
}

canvas.addEventListener('pointerleave', () => {
  pointer = null;
  requestRender();
});

// ---------- Pull tool ----------
// Drag on any box to push its outlines around (liquify). Each drag lays
// down a trail of small pulls, so long drags smear the shape.

// Control points: a grid over the active box, drawn where the distortion
// has moved them. Dragging one pulls that region; each point owns one pull,
// so grabbing it again keeps adjusting the same spot.
const MESH_COLS = 5;
const MESH_ROWS = 3;
let hotHandle = null; // key of the handle under the pointer / being dragged

function meshFor(box) {
  const sc = box && scenes.get(box.id);
  if (!sc) return null;
  const { x0, x1, y0, y1 } = sc.base;
  const sx = (x1 - x0) / (MESH_COLS - 1);
  const sy = (y1 - y0) / (MESH_ROWS - 1);
  const points = [];
  for (let j = 0; j < MESH_ROWS; j++) {
    for (let i = 0; i < MESH_COLS; i++) {
      const bx = x0 + sx * i;
      const by = y0 + sy * j;
      const [x, y] = pullPoint(box, artboard, bx, by);
      points.push({ key: `${i},${j}`, i, j, bx, by, x, y });
    }
  }
  // Points added by double-clicking, stored in box units so they follow the box.
  const cx = artboard.width / 2 + box.offsetX;
  const cy = artboard.height / 2 + box.offsetY;
  for (const cp of box.pullPoints ?? []) {
    const bx = cx + cp.u * box.size;
    const by = cy + cp.v * box.size;
    const [x, y] = pullPoint(box, artboard, bx, by);
    points.push({ key: `p${cp.id}`, id: cp.id, custom: true, bx, by, x, y });
  }
  return { points, cols: MESH_COLS, rows: MESH_ROWS, sx, sy };
}

let nextPointId = 1;

// Pulls and added points together, so one undo step restores both.
const snapshotPulls = (box) => ({
  pulls: (box.pulls ?? []).map((p) => ({ ...p })),
  points: (box.pullPoints ?? []).map((p) => ({ ...p })),
});

function restorePulls(box, snap) {
  box.pulls = snap.pulls;
  box.pullPoints = snap.points;
}

function removePullPoint(box, handle) {
  const before = snapshotPulls(box);
  box.pullPoints = box.pullPoints.filter((cp) => cp.id !== handle.id);
  box.pulls = (box.pulls ?? []).filter((q) => q.mesh !== handle.key);
  logAction({ box, swap: before });
  hotHandle = null;
  relayout();
}

function meshHandleAt(e) {
  const mesh = meshFor(activeBox());
  if (!mesh) return null;
  const s = toCanvas(e);
  for (const pt of mesh.points) {
    const hx = view.x + pt.x * view.scale;
    const hy = view.y + pt.y * view.scale;
    if (Math.abs(s.x - hx) <= 8 && Math.abs(s.y - hy) <= 8) return { ...pt, mesh };
  }
  return null;
}

// Pull tool press:
//   on a point        → drag it (Alt-click removes a point you added)
//   anywhere else     → drop a new point under the circle and drag it
//   Shift + drag      → freeform smudge
function pullDown(e) {
  const handle = meshHandleAt(e);
  if (handle) {
    e.preventDefault();
    if (e.altKey && handle.custom) return removePullPoint(activeBox(), handle);
    return dragHandle(e, activeBox(), handle, snapshotPulls(activeBox()));
  }
  const p = toArtboard(e);
  const box = boxForPoint(p);
  if (!box) return;
  e.preventDefault();
  setActive(box.id);
  if (!e.shiftKey) {
    const before = snapshotPulls(box);
    const cx = artboard.width / 2 + box.offsetX;
    const cy = artboard.height / 2 + box.offsetY;
    const id = nextPointId++;
    box.pullPoints ??= [];
    box.pullPoints.push({ id, u: (p.x - cx) / box.size, v: (p.y - cy) / box.size });
    const mesh = meshFor(box);
    const point = mesh.points.find((q) => q.key === `p${id}`);
    return dragHandle(e, box, { ...point, mesh }, before);
  }
  canvas.setPointerCapture(e.pointerId);
  box.pulls ??= [];
  gesture = { type: 'pull', box, before: box.pulls.length, last: p, pull: null };
  startPull(p);
}

// Each point owns one pull; grabbing it again keeps adjusting the same spot.
function dragHandle(e, box, handle, before) {
  canvas.setPointerCapture(e.pointerId);
  box.pulls ??= [];
  let pull = box.pulls.find((q) => q.mesh === handle.key);
  if (!pull) {
    const cx = artboard.width / 2 + box.offsetX;
    const cy = artboard.height / 2 + box.offsetY;
    pull = {
      mesh: handle.key,
      u: (handle.bx - cx) / box.size,
      v: (handle.by - cy) / box.size,
      du: 0,
      dv: 0,
      // Added points reach as far as the circle; grid points reach their cell.
      r: handle.custom
        ? state.brushSize / 2 / box.size
        : (Math.max(handle.mesh.sx, handle.mesh.sy) * 1.1) / box.size,
    };
    box.pulls.push(pull);
  }
  hotHandle = handle.key;
  gesture = { type: 'mesh', box, pull, du0: pull.du, dv0: pull.dv, from: toArtboard(e), before };
  pointer = null;
  requestRender();
}

function startPull(p) {
  const box = gesture.box;
  const c = { x: artboard.width / 2 + box.offsetX, y: artboard.height / 2 + box.offsetY };
  gesture.pull = {
    u: (p.x - c.x) / box.size,
    v: (p.y - c.y) / box.size,
    du: 0,
    dv: 0,
    r: state.brushSize / 2 / box.size,
  };
  gesture.from = p;
  box.pulls.push(gesture.pull);
}

function pullMove(e) {
  if (gesture?.type === 'mesh') {
    const p = toArtboard(e);
    gesture.pull.du = gesture.du0 + (p.x - gesture.from.x) / gesture.box.size;
    gesture.pull.dv = gesture.dv0 + (p.y - gesture.from.y) / gesture.box.size;
    relayout();
    return;
  }
  // Over a control point: show a move cursor instead of the pull ring.
  const handle = !gesture && meshHandleAt(e);
  hotHandle = handle ? handle.key : null;
  canvas.style.cursor = handle ? 'move' : 'none';
  pointer = handle ? null : toCanvas(e);
  if (gesture?.type === 'pull') {
    const p = toArtboard(e);
    const box = gesture.box;
    gesture.pull.du = (p.x - gesture.from.x) / box.size;
    gesture.pull.dv = (p.y - gesture.from.y) / box.size;
    // Start a fresh dab every ~third of the radius so the push follows the drag.
    if (Math.hypot(p.x - gesture.from.x, p.y - gesture.from.y) > state.brushSize / 6) startPull(p);
    relayout();
  }
  requestRender();
}

$('reset-pulls').addEventListener('click', () => {
  const box = activeBox();
  if (!box?.pulls?.length && !box?.pullPoints?.length) return;
  logAction({ box, before: 0, reset: box.pulls.slice() }); // undo brings them back
  box.pulls = [];
  box.pullPoints = [];
  relayout();
});

// ---------- Tools, history and shortcuts ----------

// Tools: 'select' (arrow), 'text', 'pull' (liquify), 'brush' (+ eraser).
function setTool(tool, { eraser = false } = {}) {
  state.tool = tool;
  state.eraser = tool === 'brush' && eraser;
  if (tool === 'brush' || tool === 'pull') {
    selected = false;
    textInput.blur();
  }
  if (tool === 'select') textInput.blur();
  canvas.style.cursor = tool === 'brush' || tool === 'pull' ? 'none' : 'default';
  const active = tool === 'brush' && state.eraser ? 'eraser' : tool;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === active));
  }
  syncHint();
  requestRender();
}

for (const b of document.querySelectorAll('[data-tool]')) {
  b.addEventListener('click', () => {
    const t = b.dataset.tool;
    setTool(t === 'eraser' ? 'brush' : t, { eraser: t === 'eraser' });
  });
}

// One undo stack across pixel edits ('px') and pulls ({ box, before }).
// Pixel edits not in the log (e.g. auto-painted by presets) still undo.
const actionLog = [];
let redoLog = [];

function logAction(action) {
  actionLog.push(action);
  redoLog = [];
  syncHistory();
}

function syncHistory() {
  $('undo').disabled = !(pixels.canUndo || actionLog.some((a) => a !== 'px'));
  $('redo').disabled = !(pixels.canRedo || redoLog.length);
  $('clear-pixels').disabled = !pixels.hasPaint;
}

function undo() {
  const last = actionLog.pop();
  if (last?.swap) {
    redoLog.push({ box: last.box, swap: snapshotPulls(last.box) });
    restorePulls(last.box, last.swap);
    relayout();
  } else if (last?.reset) {
    last.box.pulls = last.reset.slice(); // undo a Reset
    redoLog.push({ box: last.box, reset: last.reset });
    relayout();
  } else if (last && last !== 'px') {
    redoLog.push({ box: last.box, before: last.before, removed: last.box.pulls.slice(last.before) });
    last.box.pulls.length = last.before;
    relayout();
  } else {
    pixels.undo();
    if (last) redoLog.push('px');
    markEdited({ painted: true });
  }
  syncHistory();
  requestRender();
}

function redo() {
  const next = redoLog.pop();
  if (next?.swap) {
    actionLog.push({ box: next.box, swap: snapshotPulls(next.box) });
    restorePulls(next.box, next.swap);
    relayout();
  } else if (next?.reset) {
    next.box.pulls = [];
    actionLog.push({ box: next.box, before: 0, reset: next.reset });
    relayout();
  } else if (next && next !== 'px') {
    next.box.pulls.push(...next.removed);
    actionLog.push({ box: next.box, before: next.before });
    relayout();
  } else {
    pixels.redo();
    if (next) actionLog.push('px');
    markEdited({ painted: true });
  }
  syncHistory();
  requestRender();
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('clear-pixels').addEventListener('click', () => {
  pixels.clear();
  logAction('px');
  markEdited({ painted: true });
  requestRender();
});

for (const b of document.querySelectorAll('[data-clip]')) {
  b.addEventListener('click', () => {
    state.clip = b.dataset.clip === 'letters'; // applies to new strokes
    syncPixelControls();
  });
}

// ---------- Pixel layers ----------
// The shape picker edits the selected layer; the brush paints into it.

const activeLayer = () => state.layers.find((l) => l.id === state.activeLayer) ?? state.layers[0];
let nextLayerId = 2;

// Picking a pixel shape or layer means you're about to paint: switch to
// the Pixel brush (also out of the eraser).
function useBrush() {
  if (state.tool !== 'brush' || state.eraser) setTool('brush');
}

for (const b of document.querySelectorAll('[data-shape]')) {
  b.addEventListener('click', () => {
    for (const l of state.editAll ? state.layers : [activeLayer()]) l.shape = b.dataset.shape;
    useBrush();
    syncPixelControls();
    requestRender();
  });
}

const SHAPE_ICONS = Object.fromEntries(
  [...document.querySelectorAll('[data-shape]')].map((b) => [b.dataset.shape, b.querySelector('svg').outerHTML]),
);

function renderLayers() {
  const list = $('layer-list');
  list.innerHTML = '';

  const all = document.createElement('li');
  all.className = 'layer-row layer-row-all';
  all.setAttribute('aria-selected', String(state.editAll));
  all.innerHTML = `<button type="button" class="layer-select" title="Edit pixel size, weight and shape for every layer">
      <span class="layer-shape layer-shape-all"><svg viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6"/><circle cx="12" cy="4" r="3"/><path d="M1 9l6 6M7 9l-6 6" stroke="currentColor" stroke-width="1.6"/><path d="M12 9v6M9 12h6" stroke="currentColor" stroke-width="1.6"/></svg></span>
      <span class="layer-name">All layers</span>
      <span class="layer-meta">${Math.round(state.pixelSize)}px · ${Math.round(state.pixelWeight)}%</span>
    </button>`;
  all.querySelector('.layer-select').addEventListener('click', () => {
    state.editAll = true;
    useBrush();
    syncPixelControls();
  });
  list.append(all);
  // Top layer first, like every design tool.
  for (const layer of [...state.layers].reverse()) {
    const row = document.createElement('li');
    row.className = 'layer-row';
    row.setAttribute('aria-selected', String(!state.editAll && layer.id === state.activeLayer));
    row.classList.toggle('is-target', layer.id === state.activeLayer);
    row.innerHTML = `
      <button type="button" class="layer-select" title="Paint into this layer · double-click to rename">
        <span class="layer-shape">${SHAPE_ICONS[layer.shape]}</span>
        <span class="layer-name"></span>
        <span class="layer-meta">${Math.round(layerValue(layer, 'pixelSize'))}px · ${Math.round(layerValue(layer, 'pixelWeight'))}%</span>
      </button>
      <button type="button" class="layer-icon" data-act="visible" aria-pressed="${!layer.visible}" title="${layer.visible ? 'Hide' : 'Show'} layer" aria-label="${layer.visible ? 'Hide' : 'Show'} layer">
        ${layer.visible
          ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
          : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>'}
      </button>
      <button type="button" class="layer-icon" data-act="delete" title="Delete layer" aria-label="Delete layer" ${state.layers.length < 2 ? 'disabled' : ''}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>`;
    row.querySelector('.layer-name').textContent = layer.name;
    row.querySelector('.layer-select').addEventListener('click', () => {
      state.activeLayer = layer.id;
      state.editAll = false;
      useBrush();
      syncPixelControls();
    });
    row.querySelector('.layer-select').addEventListener('dblclick', () => renameLayer(row, layer));
    row.querySelector('[data-act=visible]').addEventListener('click', () => {
      layer.visible = !layer.visible;
      syncPixelControls();
      requestRender();
    });
    row.querySelector('[data-act=delete]').addEventListener('click', () => {
      if (state.layers.length < 2) return;
      state.layers = state.layers.filter((l) => l.id !== layer.id);
      if (state.activeLayer === layer.id) state.activeLayer = state.layers[state.layers.length - 1].id;
      syncPixelControls();
      requestRender();
    });
    list.append(row);
  }
}

// Swap the layer's name for a text field; Enter or clicking away saves,
// Esc cancels.
function renameLayer(row, layer) {
  const button = row.querySelector('.layer-select');
  const input = document.createElement('input');
  input.className = 'layer-rename';
  input.value = layer.name;
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Layer name');
  // A field can't live inside a <button>, so swap the label for a plain row.
  const editor = document.createElement('div');
  editor.className = 'layer-select';
  editor.append(button.querySelector('.layer-shape').cloneNode(true), input);
  button.replaceWith(editor);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value) layer.name = value;
    renderLayers();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep tool shortcuts (T, B, E…) out of the field
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

$('add-layer').addEventListener('click', () => {
  if (state.layers.length >= 6) return showStatus('Up to 6 pixel layers');
  // New layers default to a shape the stack isn't using yet.
  const used = new Set(state.layers.map((l) => l.shape));
  const shape = ['circle', 'x', 'plus', 'diamond', 'ring', 'square'].find((s) => !used.has(s)) ?? 'circle';
  const id = nextLayerId++;
  state.layers.push({ id, name: `Layer ${id}`, shape, visible: true, pixelSize: null, pixelWeight: null });
  state.activeLayer = id;
  state.editAll = false;
  syncPixelControls();
  if (state.tool !== 'brush') setTool('brush');
});

// Pixel size / weight sliders show the selected layer, or the global value.
function syncPixelSliders() {
  for (const key of LAYER_KEYS) showSlider(key, state.editAll ? state[key] : layerValue(activeLayer(), key));
  $('pixel-scope').textContent = state.editAll ? 'All layers' : activeLayer().name;
}

function syncPixelControls() {
  for (const b of document.querySelectorAll('[data-clip]')) {
    b.setAttribute('aria-checked', String((b.dataset.clip === 'letters') === state.clip));
  }
  // Mixed shapes under "All layers" highlight nothing.
  const shapes = new Set((state.editAll ? state.layers : [activeLayer()]).map((l) => l.shape));
  const shape = shapes.size === 1 ? [...shapes][0] : null;
  for (const b of document.querySelectorAll('[data-shape]')) {
    b.setAttribute('aria-checked', String(b.dataset.shape === shape));
  }
  syncPixelSliders();
  renderLayers();
}

const typingInField = (e) => e.target.closest?.('input, textarea, select, [contenteditable]');

document.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && !shiftHeld) {
    shiftHeld = true;
    requestRender();
  }
  if (typingInField(e)) return; // let fields keep their own keys (incl. text undo)

  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod || e.altKey) return;

  if ((e.key === 'Delete' || e.key === 'Backspace') && selected && (state.tool === 'text' || state.tool === 'select')) {
    e.preventDefault();
    deleteActiveBox();
    return;
  }

  const key = e.key.toLowerCase();
  if (key === 'v') setTool('select');
  else if (key === 't') setTool('text');
  else if (key === 'w') setTool('pull');
  else if (key === 'b') setTool('brush');
  else if (key === 'e') setTool('brush', { eraser: !(state.tool === 'brush' && state.eraser) });
  else if ((state.tool === 'brush' || state.tool === 'pull') && (e.key === '[' || e.key === ']')) {
    const step = Math.max(2, Math.round(state.brushSize * 0.1));
    setSlider('brushSize', state.brushSize + (e.key === ']' ? step : -step));
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') {
    shiftHeld = false;
    requestRender();
  }
});

window.addEventListener('blur', () => { shiftHeld = false; });

// Arrow keys nudge the selected box when not typing (Shift = 10×).
document.addEventListener('keydown', (e) => {
  const box = activeBox();
  if (!box || !selected || isEditing() || typingInField(e)) return;
  const step = (e.shiftKey ? 10 : 1) / view.scale;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!d) return;
  e.preventDefault();
  box.offsetX += d[0];
  box.offsetY += d[1];
  relayout();
});

// ---------- Font menu ----------
// Grouped by category with a search box. With letters selected on the
// canvas, the chosen font applies to just those letters; with a caret it
// becomes the font for what you type next; otherwise the whole box.

const fontButton = $('font-current');
const fontName = $('font-current-name');
const fontMenu = $('font-menu');
const fontSearch = $('font-search');
const fontList = $('font-list');

function previewText() {
  const text = activeBox()?.text ?? '';
  const first = text.split('\n').find((l) => l.trim()) || '';
  return first.trim().slice(0, 24) || 'Aa';
}

function buildMenu() {
  fontList.innerHTML = '';
  for (const cat of CATEGORIES) {
    const group = fonts.filter((f) => f.cat === cat);
    if (!group.length) continue;
    const header = document.createElement('li');
    header.className = 'font-group';
    header.textContent = cat;
    header.dataset.group = cat;
    fontList.append(header);

    for (const entry of group) {
      const li = document.createElement('li');
      li.className = 'font-option';
      li.role = 'option';
      li.dataset.id = entry.id;
      li.dataset.group = cat;

      const sample = document.createElement('span');
      sample.className = 'font-option-sample';
      sample.style.fontFamily = `"${cssFamily(entry)}", serif`;
      sample.textContent = previewText();

      const name = document.createElement('span');
      name.className = 'font-option-name';
      name.textContent = entry.name;

      li.append(sample, name);
      li.addEventListener('click', () => applyFont(entry.id));
      fontList.append(li);
    }
  }
  filterMenu();
  syncFontButton();
}

function filterMenu() {
  const q = fontSearch.value.trim().toLowerCase();
  const visible = new Set();
  for (const li of fontList.querySelectorAll('.font-option')) {
    const show = !q || entryById(li.dataset.id).name.toLowerCase().includes(q) || li.dataset.group.toLowerCase().includes(q);
    li.hidden = !show;
    if (show) visible.add(li.dataset.group);
  }
  for (const h of fontList.querySelectorAll('.font-group')) h.hidden = !visible.has(h.dataset.group);
}

fontSearch.addEventListener('input', filterMenu);
fontSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = fontList.querySelector('.font-option:not([hidden])');
    if (first) applyFont(first.dataset.id);
  }
});

function updatePreviews() {
  const t = previewText();
  for (const el of fontList.querySelectorAll('.font-option-sample')) el.textContent = t;
}

// The fonts that a font change would affect right now.
function targetFonts() {
  const box = activeBox();
  if (!box) return [];
  const sel = fontTarget ?? (isEditing() ? { start: textInput.selectionStart, end: textInput.selectionEnd } : null);
  if (sel && sel.start !== sel.end) return box.fonts.slice(sel.start, sel.end);
  if (sel) return [typingFont?.at === sel.start ? typingFont.id : box.fonts[sel.start - 1] ?? box.fonts[sel.start] ?? box.font];
  return box.fonts.length ? box.fonts : [box.font];
}

function syncFontButton() {
  const ids = [...new Set(targetFonts())];
  fontName.textContent = ids.length === 1 ? entryById(ids[0]).name : ids.length ? 'Mixed fonts' : '—';
  for (const li of fontList.querySelectorAll('.font-option')) {
    li.setAttribute('aria-selected', String(ids.length === 1 && li.dataset.id === ids[0]));
  }
}

function applyFont(id) {
  const box = activeBox();
  if (!box) return;
  const sel = fontTarget;
  if (sel && sel.start !== sel.end) {
    box.fonts.fill(id, sel.start, sel.end);
  } else if (sel) {
    typingFont = { id, at: sel.start };
  } else {
    box.font = id;
    box.fonts.fill(id);
  }
  closeMenu();
  relayout();
  syncFontButton();
  markEdited();
}

function openMenu() {
  const box = activeBox();
  if (!box) return;
  // Remember the text selection before focus moves into the menu.
  fontTarget = isEditing() ? { start: textInput.selectionStart, end: textInput.selectionEnd } : null;
  fontMenu.hidden = false;
  fontButton.setAttribute('aria-expanded', 'true');
  fontSearch.value = '';
  filterMenu();
  syncFontButton();
  fontList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  fontSearch.focus({ preventScroll: true });
  requestRender();
}

function closeMenu() {
  if (fontMenu.hidden) return;
  fontMenu.hidden = true;
  fontButton.setAttribute('aria-expanded', 'false');
  // Go back to editing the same selection.
  const sel = fontTarget;
  fontTarget = null;
  if (sel) {
    focusText();
    textInput.setSelectionRange(sel.start, sel.end);
  }
  requestRender();
}

// Open on pointerdown, before the click moves focus away from the text.
fontButton.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  fontMenu.hidden ? openMenu() : closeMenu();
});
fontButton.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fontMenu.hidden ? openMenu() : closeMenu();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!$('font-select').contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!fontMenu.hidden) closeMenu();
  else if (isEditing()) textInput.blur(); // stay selected, stop typing
  else if (selected) selected = false;
  requestRender();
});

$('font-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const entry = await addCustomFont(file);
    buildMenu();
    applyFont(entry.id);
    showStatus(`Added ${entry.name}`);
  } catch (err) {
    showStatus(err.message);
  }
});

// ---------- Colors ----------

const colorPicker = createColorPicker($('color-picker'), {
  get: (target) => state[target],
  set: (target, value) => {
    state[target] = value;
    requestRender();
  },
});

$('invert').addEventListener('click', () => {
  [state.fg, state.bg] = [state.bg, state.fg];
  colorPicker.refresh();
  requestRender();
});

// ---------- Animation ----------
// A keyframe snapshots everything animatable. Between keys, numbers are
// eased; font changes become crossfades or pixel dissolves; painted
// strokes are revealed in the order they were painted.
//
// Once there's at least one keyframe, editing anything at the playhead
// updates the key there (or creates one) — auto-keying, like After Effects.

const BOX_KEYS = ['offsetX', 'offsetY', 'size', 'tracking', 'lineHeight', 'stroke', 'warpAmount', 'warpFreq', 'warpPhase'];
const PX_KEYS = ['pixelSize', 'pixelWeight', 'bleed', 'shiftX', 'shiftY'];
let applying = false; // true while writing animated values (not a user edit)

function snapshot() {
  return {
    boxes: doc.boxes.map((b) => ({
      id: b.id,
      ...Object.fromEntries(BOX_KEYS.map((k) => [k, b[k]])),
      font: b.font,
      fonts: [...b.fonts],
    })),
    px: {
      ...Object.fromEntries(PX_KEYS.map((k) => [k, state[k]])),
      reveal: revealOverride ?? pixels.strokes().length,
    },
  };
}

// Per-character fonts saved in a key may predate text edits: fit to length.
function fitFonts(list, box) {
  const out = list.slice(0, box.text.length);
  while (out.length < box.text.length) out.push(out[out.length - 1] ?? box.font);
  return out;
}

const sameFonts = (a, b) => a.font === b.font && a.fonts.join() === b.fonts.join();

function interpolate(t) {
  const seg = timeline.segment(t);
  if (!seg) return null;
  const { k0, k1, u } = seg;
  const lerp = (a, b) => a + (b - a) * u;
  const boxes = new Map();
  const trans = new Map();
  for (const box of doc.boxes) {
    let a = k0.snap.boxes.find((s) => s.id === box.id);
    let b = k1.snap.boxes.find((s) => s.id === box.id);
    if (!a && !b) continue; // added after these keys: leave it alone
    a ??= b;
    b ??= a;
    const v = Object.fromEntries(BOX_KEYS.map((k) => [k, lerp(a[k] ?? box[k], b[k] ?? box[k])]));
    const cut = timeline.transition === 'cut';
    const side = (cut ? u < 1 : u < 0.5) ? a : b;
    v.font = side.font;
    v.fonts = side.fonts;
    if (!cut && u > 0 && u < 1 && !sameFonts(a, b)) {
      trans.set(box.id, { a: { font: a.font, fonts: a.fonts }, b: { font: b.font, fonts: b.fonts }, u });
    }
    boxes.set(box.id, v);
  }
  const px = Object.fromEntries(PX_KEYS.map((k) => [k, lerp(k0.snap.px[k], k1.snap.px[k])]));
  px.reveal = lerp(k0.snap.px.reveal, k1.snap.px.reveal);
  return { boxes, trans, px };
}

// Write the animated state at time t into the live document. Returns the
// relayout promise so GIF export can wait for each frame.
function applyAnimated(t) {
  const s = interpolate(t);
  if (!s) return relayout();
  applying = true;
  for (const box of doc.boxes) {
    const v = s.boxes.get(box.id);
    if (!v) continue;
    for (const k of BOX_KEYS) box[k] = v[k];
    box.font = v.font;
    box.fonts = fitFonts(v.fonts, box);
  }
  for (const k of PX_KEYS) state[k] = s.px[k];
  transitions = s.trans;
  const total = pixels.strokes().length;
  revealOverride = s.px.reveal >= total - 1e-6 ? null : Math.max(0, s.px.reveal);
  syncBoxControls();
  for (const k of PX_KEYS) if (!LAYER_KEYS.includes(k)) showSlider(k, state[k]);
  syncPixelSliders();
  applying = false;
  return relayout();
}

function markEdited({ painted = false } = {}) {
  if (applying || !timeline.keys.length) return;
  if (painted) revealOverride = null; // just painted: show every stroke here
  transitions = new Map();
  const snap = snapshot();
  let key = timeline.keyAt(timeline.time);
  if (key) key.snap = snap;
  else key = timeline.add(timeline.time, snap);
  timeline.selectedId = key.id;
  syncTimeline();
}

// Pixel-dissolve mask for a font change: cells flip to the new font in a
// stable random order as u goes 0 → 1.
function transitionFor(sa, sb, u) {
  const mode = timeline.transition;
  if (mode !== 'dissolve') return { mode, u, pathB: sb.path2d };
  const ps = Math.max(4, state.pixelSize);
  const x0 = Math.min(sa.bounds.x0, sb.bounds.x0);
  const y0 = Math.min(sa.bounds.y0, sb.bounds.y0);
  const x1 = Math.max(sa.bounds.x1, sb.bounds.x1);
  const y1 = Math.max(sa.bounds.y1, sb.bounds.y1);
  const cellsB = new Path2D();
  for (let j = Math.floor(y0 / ps); j * ps < y1; j++) {
    for (let i = Math.floor(x0 / ps); i * ps < x1; i++) {
      let h = Math.imul(i, 2654435761) ^ Math.imul(j, 1597334677);
      h = Math.imul(h ^ (h >>> 15), 2246822519);
      if (((h ^ (h >>> 13)) >>> 0) / 4294967296 < u) cellsB.rect(i * ps, j * ps, ps, ps);
    }
  }
  const outsideB = new Path2D();
  outsideB.rect(x0 - ps, y0 - ps, x1 - x0 + 2 * ps, y1 - y0 + 2 * ps);
  outsideB.addPath(cellsB);
  return { mode, u, pathB: sb.path2d, cellsB, outsideB };
}

// ---------- Timeline controls ----------

const tlUI = createTimelineUI(
  {
    track: $('tl-track'),
    ruler: $('tl-ruler'),
    lane: $('tl-lane'),
    playhead: $('tl-playhead'),
    empty: $('tl-empty'),
  },
  timeline,
  {
    onScrub: (t) => { pause(); setTime(t); },
    onSelectKey: (key) => {
      pause();
      timeline.selectedId = key.id;
      setTime(key.time);
    },
    onMoveKey: (key) => {
      timeline.time = key.time;
      applyAnimated(key.time);
      syncTimeline();
    },
  },
);

function syncTimeline() {
  $('tl-time').textContent = `${timeline.time.toFixed(2)} / ${timeline.duration.toFixed(2)}s`;
  $('tl-play').setAttribute('aria-pressed', String(timeline.playing));
  $('tl-play').title = timeline.playing ? 'Pause (Space)' : 'Play (Space)';
  $('tl-play-icon').setAttribute('d', timeline.playing ? 'M7 5h3v14H7zM14 5h3v14h-3z' : 'M8 5v14l11-7z');
  $('tl-loop').setAttribute('aria-pressed', String(timeline.loop));
  $('tl-delete').disabled = !timeline.selected;
  $('tl-add').textContent = timeline.keyAt(timeline.time) ? '◆ Update keyframe' : '◆ Add keyframe';
  tlUI.draw();
  syncExport();
  syncAnimateCards();
}

function setTime(t) {
  timeline.time = t;
  const onKey = timeline.keyAt(t);
  if (onKey) timeline.selectedId = onKey.id;
  applyAnimated(t);
  syncTimeline();
}

let lastTick = 0;
function tick(now) {
  if (!timeline.playing) return;
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  let t = timeline.time + dt * timeline.speed;
  if (t >= timeline.duration) {
    if (timeline.loop) t %= timeline.duration;
    else {
      t = timeline.duration;
      timeline.playing = false;
    }
  }
  setTime(t);
  if (timeline.playing) requestAnimationFrame(tick);
}

function play() {
  if (timeline.playing) return;
  if (!timeline.loop && timeline.time >= timeline.duration) timeline.time = 0;
  timeline.playing = true;
  selected = false;
  textInput.blur();
  lastTick = performance.now();
  requestAnimationFrame(tick);
  syncTimeline();
}

function pause() {
  if (!timeline.playing) return;
  timeline.playing = false;
  syncTimeline();
}

$('tl-play').addEventListener('click', () => (timeline.playing ? pause() : play()));
$('tl-loop').addEventListener('click', () => {
  timeline.loop = !timeline.loop;
  syncTimeline();
});

function addOrUpdateKey() {
  transitions = new Map();
  let key = timeline.keyAt(timeline.time);
  if (key) key.snap = snapshot();
  else key = timeline.add(timeline.time, snapshot());
  timeline.selectedId = key.id;
  syncTimeline();
}

$('tl-add').addEventListener('click', addOrUpdateKey);
$('tl-delete').addEventListener('click', () => {
  if (!timeline.selected) return;
  timeline.remove(timeline.selectedId);
  if (!timeline.keys.length) {
    transitions = new Map();
    revealOverride = null;
    relayout();
  } else {
    applyAnimated(timeline.time);
  }
  syncTimeline();
});

$('tl-duration').addEventListener('change', (e) => {
  const d = Math.min(30, Math.max(0.5, parseFloat(e.target.value) || timeline.duration));
  // Keep keys at the same relative positions.
  const k = d / timeline.duration;
  for (const key of timeline.keys) key.time = Math.round(key.time * k * 100) / 100;
  timeline.time = Math.min(d, timeline.time * k);
  timeline.duration = d;
  e.target.value = d;
  syncTimeline();
});

$('tl-speed').addEventListener('input', (e) => {
  timeline.speed = Number(e.target.value);
  $('tl-speed-out').textContent = `${timeline.speed}×`;
});

$('tl-easing').addEventListener('change', (e) => {
  timeline.easing = e.target.value;
  applyAnimated(timeline.time);
});

$('tl-transition').addEventListener('change', (e) => {
  timeline.transition = e.target.value;
  applyAnimated(timeline.time);
});

document.addEventListener('keydown', (e) => {
  if (typingInField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    timeline.playing ? pause() : play();
  } else if (e.key.toLowerCase() === 'k') {
    addOrUpdateKey();
  }
});

// ---------- Auto-animate presets ----------
// One click builds a whole looping animation from keyframes. If nothing is
// painted yet, the word is auto-painted first so there are pixels to move.

const boilSeed = () => (state.boil > 0 ? Math.floor(timeline.time * state.boilRate) : 0);

function presetBox() {
  return activeBox() ?? doc.boxes[0] ?? null;
}

// Paint a straight stroke on a box programmatically (clipped to letters).
function autoStroke(box, from, to, brushSize) {
  const anchor = anchors().get(box.id);
  pixels.begin(from, box.id, anchor, { brushSize, softness: 0, erase: false, clip: true, layer: state.activeLayer });
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    pixels.extend({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, anchor);
  }
  pixels.end();
  syncHistory();
}

// A horizontal sweep covering the whole word.
function paintSweep(box) {
  const b = scenes.get(box.id).bounds;
  const cy = (b.y0 + b.y1) / 2;
  const h = b.y1 - b.y0;
  autoStroke(box, { x: b.x0, y: cy }, { x: b.x1, y: cy }, h * 1.2);
}

// A vertical band through the middle of the word.
function paintBand(box) {
  const b = scenes.get(box.id).bounds;
  const cx = (b.x0 + b.x1) / 2;
  const h = b.y1 - b.y0;
  const w = Math.max(box.size * 0.6, (b.x1 - b.x0) * 0.18);
  autoStroke(box, { x: cx, y: b.y0 - h * 0.1 }, { x: cx, y: b.y1 + h * 0.1 }, w);
  return w;
}

let presetRestore = null; // { box, values } to put back when the preset goes away

function resetAnimation() {
  pause();
  // Go back to the first frame so removing or swapping an animation leaves
  // the design as it started (not mid-flash or mid-move).
  if (timeline.keys.length) applyAnimated(0);
  // Undo settings a preset switched on directly (e.g. Wave's warp).
  if (presetRestore) {
    Object.assign(presetRestore.box, presetRestore.values);
    presetRestore = null;
    syncBoxControls();
    relayout();
  }
  timeline.keys = [];
  timeline.selectedId = null;
  timeline.time = 0;
  transitions = new Map();
  revealOverride = null;
}

// Add a key at `frac` of the duration from the current state, tweaked.
function keyAt(frac, tweak) {
  const snap = snapshot();
  tweak?.(snap);
  return timeline.add(frac * timeline.duration, snap);
}

const boxSnap = (snap, box) => snap.boxes.find((s) => s.id === box.id);

const ANIM_PRESETS = {
  breathe(box) {
    if (!pixels.hasPaint) paintSweep(box);
    const small = Math.max(4, Math.round(box.size * 0.02));
    const big = Math.round(box.size * 0.09);
    timeline.duration = 2.4;
    timeline.easing = 'inOut';
    keyAt(0, (s) => { s.px.pixelSize = small; });
    keyAt(0.5, (s) => { s.px.pixelSize = big; });
    keyAt(1, (s) => { s.px.pixelSize = small; });
  },

  scan(box) {
    let band = box.size * 0.6;
    if (!pixels.hasPaint) band = paintBand(box);
    const b = scenes.get(box.id).bounds;
    const reach = (b.x1 - b.x0) / 2 + band;
    timeline.duration = 2.5;
    timeline.easing = 'linear';
    keyAt(0, (s) => { s.px.shiftX = -reach; });
    keyAt(1, (s) => { s.px.shiftX = reach; });
  },

  pixelate(box) {
    if (!pixels.hasPaint) paintSweep(box);
    const n = pixels.strokes().length;
    timeline.duration = 3;
    timeline.easing = 'inOut';
    keyAt(0, (s) => { s.px.reveal = 0; });
    keyAt(0.42, (s) => { s.px.reveal = n; });
    keyAt(0.58, (s) => { s.px.reveal = n; });
    keyAt(1, (s) => { s.px.reveal = 0; });
  },

  wave(box) {
    presetRestore = { box, values: { warp: box.warp, warpAmount: box.warpAmount, warpFreq: box.warpFreq, warpPhase: box.warpPhase } };
    if (box.warp !== 'wave') {
      box.warp = 'wave';
      box.warpAmount = 30;
      box.warpFreq = 45;
      syncBoxControls();
    }
    timeline.duration = 2;
    timeline.easing = 'linear';
    keyAt(0, (s) => { boxSnap(s, box).warpPhase = 0; });
    keyAt(1, (s) => { boxSnap(s, box).warpPhase = -360; });
  },

  flash(box) {
    const start = box.font;
    const pool = ['greatvibes', 'bodoni', 'archivoblack', 'pinyon', 'bebas', 'imfell', 'dmserif', 'italianno'];
    const cycle = [start, ...pool.filter((f) => f !== start).slice(0, 7)];
    timeline.duration = 2;
    timeline.easing = 'linear';
    timeline.transition = 'cut';
    $('tl-transition').value = 'cut';
    cycle.forEach((font, i) => {
      keyAt(i / cycle.length, (s) => {
        const bs = boxSnap(s, box);
        bs.font = font;
        bs.fonts = bs.fonts.map(() => font);
      });
    });
    // Land back on the starting font so the loop is seamless.
    keyAt(1, (s) => {
      const bs = boxSnap(s, box);
      bs.font = start;
      bs.fonts = bs.fonts.map(() => start);
    });
  },

  shuffle(box) {
    const start = box.font;
    const cycle = [start, ...['greatvibes', 'bodoni', 'pinyon', 'dmserif'].filter((f) => f !== start).slice(0, 3), start];
    timeline.duration = 4;
    timeline.easing = 'inOut';
    timeline.transition = 'dissolve';
    $('tl-transition').value = 'dissolve';
    const step = 1 / (cycle.length - 1);
    cycle.forEach((font, i) => {
      const setFont = (s) => {
        const bs = boxSnap(s, box);
        bs.font = font;
        bs.fonts = bs.fonts.map(() => font);
      };
      keyAt(i * step, setFont);
      // Hold each font a moment before dissolving to the next.
      if (i < cycle.length - 1) keyAt(i * step + step * 0.45, setFont);
    });
  },
};

function runPreset(name) {
  const box = presetBox();
  if (!box || !scenes.get(box.id)) return showStatus('Add some text first');
  resetAnimation();
  state.shiftX = 0;
  state.shiftY = 0;
  ANIM_PRESETS[name](box);
  timeline.loop = true;
  $('tl-easing').value = timeline.easing;
  $('tl-duration').value = timeline.duration;
  setTime(0);
  play();
  showStatus('Animation created — edit any keyframe to tweak it');
}

// ---------- Animate panel ----------
// Canva-style bar on the right: preset cards with little previews that
// play on hover (and keep playing while that animation is on).

const RED = '#eb0028';
const VIEW = 'viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"';
const pvText = (attrs = '', family = 'HT-playfair, Georgia, serif', size = 44) =>
  `<text x="60" y="56" text-anchor="middle" font-family="${family}" font-style="italic" font-size="${size}"${attrs}>Abc</text>`;

// A grid of little squares; clipped to the text it reads as pixel type.
function pvCells(fill, filter = () => true, extra = () => '') {
  let s = '';
  for (let y = 14; y < 66; y += 7) {
    for (let x = 12; x < 108; x += 7) {
      if (filter(x, y)) s += `<rect class="pv-cell" x="${x}" y="${y}" width="6.4" height="6.4" fill="${fill}"${extra(x, y)}/>`;
    }
  }
  return s;
}

const PREVIEWS = {
  none: () => `<svg ${VIEW}>${pvText(' fill="#111"')}</svg>`,
  breathe: () => `<svg ${VIEW} class="pv-breathe"><defs><clipPath id="pv-c1">${pvText()}</clipPath></defs>
    <g clip-path="url(#pv-c1)">${pvCells('#111')}</g></svg>`,
  scan: () => `<svg ${VIEW} class="pv-scan"><defs><clipPath id="pv-c2">${pvText()}</clipPath></defs>
    ${pvText(' fill="#111"')}<g clip-path="url(#pv-c2)"><g class="pv-band">${pvCells(RED, (x) => x >= 53 && x <= 67)}</g></g></svg>`,
  pixelate: () => `<svg ${VIEW} class="pv-pixelate"><defs><clipPath id="pv-c3">${pvText()}</clipPath></defs>
    ${pvText(' fill="#111"')}<g clip-path="url(#pv-c3)">${pvCells(RED, () => true, (x) => ` style="animation-delay:${(((x - 12) / 96) * 0.7).toFixed(2)}s"`)}</g></svg>`,
  boil: () => `<svg ${VIEW} class="pv-boil"><g class="pv-text">${pvText(' fill="#111"')}</g></svg>`,
  wave: () => `<svg ${VIEW} class="pv-wave">${['A', 'b', 'c']
    .map((ch, i) => `<text class="pv-letter" style="animation-delay:${i * 0.18}s" x="${36 + i * 25}" y="56" text-anchor="middle" font-family="HT-playfair, Georgia, serif" font-style="italic" font-size="44" fill="#111">${ch}</text>`)
    .join('')}</svg>`,
  flash: () => `<svg ${VIEW} class="pv-flash">
    <g class="pv-f1">${pvText(' fill="#111"')}</g>
    <g class="pv-f2">${pvText(' fill="#111"', 'HT-greatvibes, cursive', 48)}</g>
    <g class="pv-f3">${pvText(' fill="#111"', 'HT-archivoblack, Arial Black, sans-serif', 34)}</g></svg>`,
  shuffle: () => `<svg ${VIEW} class="pv-shuffle">
    <g class="pv-a">${pvText(' fill="#111"')}</g>
    <g class="pv-b">${pvText(' fill="#111"', 'HT-greatvibes, cursive', 48)}</g>
    <g class="pv-flicker">${pvCells(RED, (x, y) => (x * 7 + y * 13) % 5 === 0 && y > 20 && y < 60)}</g></svg>`,
};

const ANIM_CARDS = [
  { title: 'Pixel effects', items: [['none', 'None'], ['breathe', 'Breathe'], ['scan', 'Scan'], ['pixelate', 'Pixelate'], ['boil', 'Boil']] },
  { title: 'Text motion', items: [['wave', 'Wave'], ['shuffle', 'Font shuffle'], ['flash', 'Font flash']] },
];

const animatePanel = $('animate-panel');
let activePreset = null;

function buildAnimatePanel() {
  const body = $('animate-body');
  body.innerHTML = '';
  for (const { title, items } of ANIM_CARDS) {
    const section = document.createElement('section');
    section.className = 'animate-section';
    section.innerHTML = `<h3>${title}</h3><div class="animate-grid"></div>`;
    const grid = section.querySelector('.animate-grid');
    for (const [id, label] of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'anim-card';
      card.dataset.anim = id;
      card.innerHTML = `<span class="anim-thumb">${PREVIEWS[id]()}</span><span>${label}</span>`;
      card.addEventListener('click', () => chooseAnimation(id));
      grid.append(card);
    }
    body.append(section);
  }
}

function chooseAnimation(id) {
  // Phones: tuck the presets sheet away so the result is visible.
  if (isPhone()) animatePanel.hidden = true;
  // Clicking the active preset again turns it off.
  if (id === activePreset && timeline.keys.length) id = 'none';
  if (id === 'none') {
    resetAnimation();
    activePreset = null;
    setSlider('boil', 0);
    relayout();
    syncTimeline();
  } else if (id === 'boil') {
    setSlider('boil', state.boil > 0 ? 0 : 50);
    if (state.boil > 0) play();
  } else {
    runPreset(id);
    activePreset = id;
  }
  syncAnimateCards();
}

function syncAnimateCards() {
  if (!timeline.keys.length) activePreset = null;
  for (const card of animatePanel.querySelectorAll('.anim-card')) {
    const id = card.dataset.anim;
    const on =
      id === 'boil' ? state.boil > 0
      : id === 'none' ? !timeline.keys.length && state.boil === 0
      : id === activePreset;
    card.setAttribute('aria-pressed', String(on));
  }
}

// The toolbar's Animate button opens the panel and the timeline together;
// both stay out of the way otherwise.
function setAnimatePanel(open) {
  animatePanel.hidden = !open;
  $('timeline').hidden = !open;
  document.querySelector('[data-resize=animate]').hidden = !open;
  $('toolbar-animate').setAttribute('aria-expanded', String(open));
  if (open) {
    closeSheet(); // phones: one sheet at a time
    syncAnimateCards();
    syncTimeline();
  } else {
    pause();
  }
}

// Toggle on the timeline: on phones the presets sheet may already be tucked away.
$('toolbar-animate').addEventListener('click', () => setAnimatePanel($('timeline').hidden));
// Phones: the × only tucks the presets sheet away; the timeline stays.
$('animate-close').addEventListener('click', () => (isPhone() ? (animatePanel.hidden = true) : setAnimatePanel(false)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !animatePanel.hidden && fontMenu.hidden && !isEditing()) setAnimatePanel(false);
});

buildAnimatePanel();

function syncBoil() {
  syncAnimateCards();
}

$('tl-clear').addEventListener('click', () => chooseAnimation('none'));

// Settings popover (duration, speed, easing, font change, boil).
const tlSettings = $('tl-settings');
$('tl-settings-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  tlSettings.hidden = !tlSettings.hidden;
  $('tl-settings-toggle').setAttribute('aria-expanded', String(!tlSettings.hidden));
});
document.addEventListener('pointerdown', (e) => {
  if (!tlSettings.hidden && !tlSettings.contains(e.target) && e.target !== $('tl-settings-toggle')) {
    tlSettings.hidden = true;
    $('tl-settings-toggle').setAttribute('aria-expanded', 'false');
  }
});

// ---------- Export ----------

// Frame rate and width are remembered separately for GIF and MP4.
const exportOptions = { format: 'png', scale: 2, transparent: false, fps: { gif: 15, mp4: 30 }, width: { gif: 800, mp4: 1080 } };
const isMotion = (format) => format === 'gif' || format === 'mp4';
// H.264 needs even dimensions.
const motionSize = (format) => {
  const w = exportOptions.width[format];
  const h = Math.round((w * artboard.height) / artboard.width);
  return format === 'mp4' ? [w - (w % 2), h - (h % 2)] : [w, h];
};
const exportButton = $('export-button');

function fileBase() {
  const slug = (activeBox() ?? doc.boxes[0])?.text
    .split('\n')
    .find((l) => l.trim())
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug ? `${slug}-nexus` : 'nexus-type';
}

function syncExport() {
  const { format, transparent } = exportOptions;
  const limit = maxScale(artboard);
  // Fall back to the largest scale the browser can render for huge canvases.
  if (exportOptions.scale > limit) exportOptions.scale = [4, 2, 1].find((s) => s <= limit) ?? 1;

  for (const b of document.querySelectorAll('[data-format]')) {
    b.setAttribute('aria-checked', String(b.dataset.format === format));
  }
  for (const b of document.querySelectorAll('[data-scale]')) {
    const s = Number(b.dataset.scale);
    b.disabled = s > limit && s !== 1;
    b.title = b.disabled ? 'Too large for the browser to render at this canvas size' : '';
    b.setAttribute('aria-checked', String(s === exportOptions.scale));
  }
  $('export-scale-row').hidden = format !== 'png';
  $('export-gif-options').hidden = !isMotion(format);
  $('export-transparent-row').hidden = isMotion(format);
  $('export-transparent').checked = transparent;
  if (isMotion(format)) {
    $('gif-fps').max = format === 'mp4' ? 60 : 30;
    $('gif-fps').value = exportOptions.fps[format];
    $('gif-fps-out').textContent = `${exportOptions.fps[format]} fps`;
    $('gif-width').value = String(exportOptions.width[format]);
  }

  const inches = canvasUnits.unit === 'in';
  if (format === 'png') {
    const w = Math.round(artboard.width * exportOptions.scale);
    const h = Math.round(artboard.height * exportOptions.scale);
    $('export-note').textContent = `${w} × ${h} px` + (inches ? ` · ${canvasUnits.dpi * exportOptions.scale} DPI` : '');
  } else if (isMotion(format)) {
    const [w, h] = motionSize(format);
    const fps = exportOptions.fps[format];
    const animated = timeline.keys.length || state.boil > 0;
    let note = animated
      ? `${w} × ${h} px · ${timeline.duration.toFixed(1)}s · ${Math.round(timeline.duration * fps)} frames`
      : format === 'gif' ? `${w} × ${h} px · still image (add keyframes to animate)` : `${w} × ${h} px · ${timeline.duration.toFixed(1)}s still (add keyframes to animate)`;
    if (format === 'mp4') note += canEncodeMP4() ? ' · H.264' : ' · needs Chrome, Edge or Safari 17+';
    $('export-note').textContent = note;
  } else {
    $('export-note').textContent = inches
      ? `Vector · ${fromPx(artboard.width)} × ${fromPx(artboard.height)} in`
      : `Vector · ${artboard.width} × ${artboard.height}`;
  }
  exportButton.textContent = `Download ${format.toUpperCase()}`;
}

for (const b of document.querySelectorAll('[data-format]')) {
  b.addEventListener('click', () => { exportOptions.format = b.dataset.format; syncExport(); });
}
for (const b of document.querySelectorAll('[data-scale]')) {
  b.addEventListener('click', () => { exportOptions.scale = Number(b.dataset.scale); syncExport(); });
}
$('export-transparent').addEventListener('change', (e) => {
  exportOptions.transparent = e.target.checked;
});
$('gif-fps').addEventListener('input', (e) => {
  exportOptions.fps[exportOptions.format] = Number(e.target.value);
  syncExport();
});
$('gif-width').addEventListener('change', (e) => {
  exportOptions.width[exportOptions.format] = Number(e.target.value);
  syncExport();
});

// Render the animation frame by frame (same drawing as the canvas), then
// put the playhead back where it was.
async function exportAnimation(format) {
  const fps = exportOptions.fps[format];
  const [w, h] = motionSize(format);
  const encode = format === 'mp4' ? exportMP4 : exportGIF;
  // A still MP4 still needs some length; a still GIF is one frame.
  const animated = timeline.keys.length || state.boil > 0;
  const startTime = timeline.time;
  pause();
  selected = false;
  textInput.blur();
  try {
    return await encode({
      width: w,
      height: h,
      fps,
      duration: animated || format === 'mp4' ? timeline.duration : 1 / fps,
      loop: timeline.loop,
      renderFrame: async (t) => {
        await applyAnimated(t);
        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = w;
        frameCanvas.height = h;
        const fctx = frameCanvas.getContext('2d');
        fctx.setTransform(w / artboard.width, 0, 0, h / artboard.height, 0, 0);
        drawArtwork(fctx, { artboard, art, colors: state, pixels: currentPixels(), bleed: bleedSigma(), background: true });
        return frameCanvas;
      },
      onProgress: (p) => { exportButton.textContent = `Rendering ${Math.round(p * 100)}%`; },
    });
  } finally {
    setTime(startTime);
  }
}

exportButton.addEventListener('click', async () => {
  if (!art) return;
  const { format, scale, transparent } = exportOptions;
  exportButton.disabled = true;
  exportButton.textContent = 'Exporting…';
  try {
    const common = { artboard, art, pixels: currentPixels(), colors: state, transparent, bleed: bleedSigma() };
    if (isMotion(format)) {
      const blob = await exportAnimation(format);
      download(blob, `${fileBase()}.${format}`);
      showStatus(`${format.toUpperCase()} downloaded`);
    } else if (format === 'png') {
      const dpi = canvasUnits.unit === 'in' ? canvasUnits.dpi : null;
      const blob = await exportPNG({ ...common, scale, dpi });
      download(blob, `${fileBase()}@${scale}x.png`);
      showStatus('PNG downloaded');
    } else {
      const { blob, merged } = await exportSVG({ ...common, units: canvasUnits });
      download(blob, `${fileBase()}.svg`);
      showStatus(merged ? 'SVG downloaded' : 'SVG downloaded (some outlines kept separate)');
    }
  } catch (err) {
    showStatus(err.message);
  } finally {
    exportButton.disabled = false;
    syncExport();
  }
});

// ---------- Sidebar: collapsible sections ----------
// Click a section title to fold it away; remembered per browser.

const COLLAPSE_KEY = 'hybrid-type:collapsed';
let collapsedPanels = new Set();
try {
  collapsedPanels = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
} catch {
  // Storage blocked (private mode etc.): sections just start open.
}

for (const panel of document.querySelectorAll('.sidebar .panel')) {
  const title = panel.querySelector('h2');
  const name = title.textContent.trim();
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  const apply = (folded) => {
    panel.classList.toggle('is-collapsed', folded);
    title.setAttribute('aria-expanded', String(!folded));
  };
  apply(collapsedPanels.has(name));
  const toggle = () => {
    const folded = !panel.classList.contains('is-collapsed');
    apply(folded);
    folded ? collapsedPanels.add(name) : collapsedPanels.delete(name);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedPanels]));
    } catch {
      // Not saved; fine for this visit.
    }
  };
  title.addEventListener('click', toggle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

// ---------- Resizable side panels ----------
// Drag the inner edge of the sidebar or the Animate panel; double-click to
// reset. Widths are remembered per browser.

const PANEL_SIZES = {
  sidebar: { prop: '--sidebar-w', min: 240, max: 520, initial: 300 },
  animate: { prop: '--animate-w', min: 240, max: 560, initial: 300 },
};
const PANEL_KEY = 'hybrid-type:panel-widths';

function setPanelWidth(name, width, save = true) {
  const p = PANEL_SIZES[name];
  const w = Math.round(Math.min(p.max, Math.max(p.min, width)));
  document.documentElement.style.setProperty(p.prop, `${w}px`);
  if (!save) return;
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
    saved[name] = w;
    localStorage.setItem(PANEL_KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable: width just isn't remembered.
  }
}

try {
  const saved = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
  for (const [name, w] of Object.entries(saved)) if (PANEL_SIZES[name]) setPanelWidth(name, w, false);
} catch {
  // Ignore unreadable saved widths.
}

for (const handle of document.querySelectorAll('[data-resize]')) {
  const name = handle.dataset.resize;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    const move = (ev) => {
      // Sidebar grows to the right; the Animate panel grows to the left.
      setPanelWidth(name, name === 'sidebar' ? ev.clientX : window.innerWidth - ev.clientX, false);
    };
    const up = (ev) => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      move(ev);
      setPanelWidth(name, name === 'sidebar' ? ev.clientX : window.innerWidth - ev.clientX);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  handle.addEventListener('dblclick', () => setPanelWidth(name, PANEL_SIZES[name].initial));
}

// ---------- Canvas hint ----------

const HINTS = {
  select: 'Click to select · Drag to move · Corners resize · Double-click to type · V: select',
  pull: 'Press to add a point and drag it · Drag points to bend · Alt-click removes · Shift-drag to smudge · [ ] size',
  text: 'Click text to edit · Drag to move · Double-click empty space for a new box · B: brush',
  brush: 'Drag to paint pixels · Hold Shift or press E to erase · [ ] brush size · T: text',
  eraser: 'Drag to erase pixels · E: back to brush · T: text',
};

function syncHint() {
  $('canvas-hint').textContent = HINTS[state.tool === 'brush' ? (state.eraser ? 'eraser' : 'brush') : state.tool];
}

// ---------- Phone layout ----------
// Under 760px wide the sidebar becomes bottom sheets opened from a tab bar,
// one section at a time (see the phone block in styles.css).

const phoneQuery = matchMedia('(max-width: 760px)');
const isPhone = () => phoneQuery.matches;
const sidebarEl = $('sidebar');
let openSheet = null;

function showSheet(name) {
  openSheet = name;
  for (const panel of sidebarEl.querySelectorAll('.panel')) {
    const match = panel.querySelector('h2').textContent.trim() === name;
    panel.classList.toggle('is-sheet', match);
    if (match) panel.classList.remove('is-collapsed'); // folding is a desktop thing
  }
  sidebarEl.classList.toggle('is-open', !!name);
  for (const b of document.querySelectorAll('[data-sheet]')) {
    b.setAttribute('aria-pressed', String(b.dataset.sheet === name));
  }
  if (name) {
    animatePanel.hidden = true;
    sidebarEl.scrollTop = 0;
  }
}

function closeSheet() {
  if (openSheet) showSheet(null);
}

for (const b of document.querySelectorAll('[data-sheet]')) {
  b.addEventListener('click', () => (openSheet === b.dataset.sheet ? closeSheet() : showSheet(b.dataset.sheet)));
}
$('sheet-close').addEventListener('click', closeSheet);

// Make room above whichever sheet is up so the design stays visible.
function syncSheetSpace() {
  document.body.classList.toggle('sheet-open', isPhone() && (!!openSheet || !animatePanel.hidden));
}
new MutationObserver(syncSheetSpace).observe(animatePanel, { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(syncSheetSpace).observe(sidebarEl, { attributes: true, attributeFilter: ['class'] });
phoneQuery.addEventListener('change', syncSheetSpace);

// Start typing: on phones the field lives in the Text sheet, and a hidden
// field can't take focus, so open that sheet first.
function focusText() {
  if (isPhone() && openSheet !== 'Text') showSheet('Text');
  textInput.focus({ preventScroll: true });
}

// Typing on the canvas shows the Text sheet so you can see the field.
textInput.addEventListener('focus', () => {
  if (isPhone() && openSheet !== 'Text') showSheet('Text');
});

$('tl-presets').addEventListener('click', () => {
  closeSheet();
  animatePanel.hidden = false;
  syncAnimateCards();
});

// Leaving phone size: drop the sheet state and restore folded sections.
phoneQuery.addEventListener('change', () => {
  if (isPhone()) return;
  closeSheet();
  for (const panel of sidebarEl.querySelectorAll('.panel')) {
    panel.classList.remove('is-sheet');
    panel.classList.toggle('is-collapsed', collapsedPanels.has(panel.querySelector('h2').textContent.trim()));
  }
});

// ---------- Status toast ----------

let statusTimer = 0;
function showStatus(message) {
  const el = $('status');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

// ---------- Boot ----------

registerPreviews();
buildMenu();
syncBoxControls();
syncCanvasFields();
syncPixelControls();
syncHistory();
setTool('text');
syncTimeline();
syncBoil();
resize();
relayout();
