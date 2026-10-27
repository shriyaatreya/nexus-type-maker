import { caretX, strokeWidthOf } from './layout.js?v=202610271414';

// Draws the artboard into the stage canvas. `view` maps artboard units to
// canvas CSS pixels; later phases use its inverse for brush input.

// Margin around the artboard: roomy on desktop, tight on phones.
const padFor = (cssWidth) => (cssWidth < 600 ? 14 : 48);
const ACCENT = '#eb0028'; // TEDx Red
const BOX_PAD = 10; // screen px between text and selection box
const HANDLE = 8; // screen px

export function fitView(cssWidth, cssHeight, artboard) {
  const scale = Math.min(
    (cssWidth - padFor(cssWidth) * 2) / artboard.width,
    (cssHeight - padFor(cssWidth) * 2) / artboard.height,
  );
  return {
    scale,
    x: (cssWidth - artboard.width * scale) / 2,
    y: (cssHeight - artboard.height * scale) / 2,
  };
}

// Selection box around the text, in canvas CSS pixels.
export function boxRect(bounds, view) {
  const x = view.x + bounds.x0 * view.scale - BOX_PAD;
  const y = view.y + bounds.y0 * view.scale - BOX_PAD;
  return {
    x,
    y,
    w: (bounds.x1 - bounds.x0) * view.scale + BOX_PAD * 2,
    h: (bounds.y1 - bounds.y0) * view.scale + BOX_PAD * 2,
  };
}

function corners(r) {
  return {
    nw: [r.x, r.y],
    ne: [r.x + r.w, r.y],
    sw: [r.x, r.y + r.h],
    se: [r.x + r.w, r.y + r.h],
  };
}

// Which resize handle (if any) is under a canvas CSS-pixel point.
export function handleAt(bounds, view, px, py) {
  const hit = HANDLE / 2 + 4; // a little forgiving
  for (const [name, [cx, cy]] of Object.entries(corners(boxRect(bounds, view)))) {
    if (Math.abs(px - cx) <= hit && Math.abs(py - cy) <= hit) return name;
  }
  return null;
}

// Selection highlight and blinking I-beam caret, slanted to match the
// font's italic angle.
function drawEditing(ctx, scene, { start, end, caretOn }, view, color) {
  const slant = Math.tan((-scene.italicAngle * Math.PI) / 180);
  const quad = (line, x0, x1) => {
    const up = (line.baseline - line.top) * slant;
    const down = (line.bottom - line.baseline) * slant;
    ctx.beginPath();
    ctx.moveTo(x0 + up, line.top);
    ctx.lineTo(x1 + up, line.top);
    ctx.lineTo(x1 - down, line.bottom);
    ctx.lineTo(x0 - down, line.bottom);
    ctx.closePath();
    ctx.fill();
  };

  if (start !== end) {
    ctx.fillStyle = 'rgba(235, 0, 40, 0.18)';
    for (const line of scene.lines) {
      const lineEnd = line.start + line.offsets[line.offsets.length - 1];
      const a = Math.max(start, line.start);
      const b = Math.min(end, lineEnd);
      if (a > b || (a === b && end <= lineEnd)) continue;
      // Include a sliver for the selected line break so empty lines show up.
      const extra = end > lineEnd ? 12 / view.scale : 0;
      quad(line, caretX(line, a), caretX(line, b) + extra);
    }
  } else if (caretOn) {
    // A slim, slightly transparent I-beam about cap height tall.
    const line = scene.lines.findLast((l) => l.start <= start);
    const x = caretX(line, start);
    const y0 = line.caretTop;
    const y1 = line.caretBottom;
    const top = x + (line.baseline - y0) * slant;
    const bottom = x - (y1 - line.baseline) * slant;
    const bar = 3 / view.scale; // half-width of the end bars, in screen px

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25 / view.scale;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(top, y0);
    ctx.lineTo(bottom, y1);
    ctx.moveTo(top - bar, y0);
    ctx.lineTo(top + bar, y0);
    ctx.moveTo(bottom - bar, y1);
    ctx.lineTo(bottom + bar, y1);
    ctx.stroke();
    ctx.restore();
  }
}

// Figma-style bounding box with corner handles, drawn in screen space so
// it stays crisp and visible even when the text overflows the artboard.
function drawSelectionBox(ctx, bounds, view, dpr, label) {
  const r = boxRect(bounds, view);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));

  ctx.fillStyle = '#fff';
  for (const [cx, cy] of Object.values(corners(r))) {
    const x = Math.round(cx - HANDLE / 2) + 0.5;
    const y = Math.round(cy - HANDLE / 2) + 0.5;
    ctx.fillRect(x, y, HANDLE, HANDLE);
    ctx.strokeRect(x, y, HANDLE, HANDLE);
  }

  if (label) {
    ctx.font = '500 11px Helvetica, "Helvetica Neue", Arial, sans-serif';
    const w = ctx.measureText(label).width + 12;
    const x = r.x + r.w / 2 - w / 2;
    const y = r.y + r.h + 10;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + 9.5);
  }
}

// Dashed center guides shown while a move snaps to the artboard center.
function drawGuides(ctx, artboard, view, dpr, guides) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = ACCENT;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (guides.x) {
    const x = Math.round(view.x + (artboard.width / 2) * view.scale) + 0.5;
    ctx.moveTo(x, view.y);
    ctx.lineTo(x, view.y + artboard.height * view.scale);
  }
  if (guides.y) {
    const y = Math.round(view.y + (artboard.height / 2) * view.scale) + 0.5;
    ctx.moveTo(view.x, y);
    ctx.lineTo(view.x + artboard.width * view.scale, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

// Circular brush preview: outer ring = brush edge, dashed inner ring = where
// a soft brush starts to fade. Double-stroked so it reads on any color.
function drawBrushCursor(ctx, view, dpr, { x, y, size, softness, erase, pull }) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = (size / 2) * view.scale;
  const ring = (radius, dash) => {
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = erase ? '#555' : '#000';
    ctx.stroke();
  };
  ring(r, erase ? [4, 3] : []);
  if (softness > 0) ring(r * (1 - 0.6 * softness), [2, 3]);
  ctx.setLineDash([]);

  // Center mark: dot for brush, minus sign for eraser, crosshair for pull.
  ctx.fillStyle = erase ? '#555' : ACCENT;
  if (pull) {
    ctx.fillRect(x - 5, y - 0.75, 10, 1.5);
    ctx.fillRect(x - 0.75, y - 5, 1.5, 10);
  } else if (erase) ctx.fillRect(x - 4, y - 0.75, 8, 1.5);
  else {
    ctx.beginPath();
    ctx.arc(x, y, 1.75, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- Artwork ----------
// `art` is the whole document: { items: [{ box, path2d, d }], path2d, d }.

// Each box's outlines: filled unless outline-only, stroked when it has a
// stroke or synthetic bold. Uses the context's current fill/stroke style.
function inkPath(ctx, box, path2d) {
  let sw = strokeWidthOf(box);
  if (box.outline) sw = Math.max(sw, box.size * 0.012);
  if (!box.outline) ctx.fill(path2d);
  if (sw > 0) {
    ctx.lineWidth = sw;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path2d);
  }
}

// Mid-animation font change: `trans` = { pathB, u, mode, cellsB?, outsideB? }.
// Crossfade blends the two layouts; dissolve shows the new font in a
// growing random set of cells (`cellsB`) and the old one everywhere else.
function inkTransition(ctx, it) {
  const { trans, box } = it;
  ctx.save();
  if (trans.mode === 'dissolve') {
    ctx.save();
    ctx.clip(trans.outsideB, 'evenodd');
    inkPath(ctx, box, it.path2d);
    ctx.restore();
    ctx.clip(trans.cellsB);
    inkPath(ctx, box, trans.pathB);
  } else {
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * (1 - trans.u);
    inkPath(ctx, box, it.path2d);
    ctx.globalAlpha = base * trans.u;
    inkPath(ctx, box, trans.pathB);
  }
  ctx.restore();
}

export function drawInk(ctx, art) {
  for (const it of art.items) {
    if (it.trans) inkTransition(ctx, it);
    else inkPath(ctx, it.box, it.path2d);
  }
}

function drawContent(ctx, artboard, art, pixels, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, artboard.width, artboard.height);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (pixels) {
    // Smooth outlines everywhere except painted cells (even-odd punches
    // the non-overlapping cell runs out of the artboard rect)...
    ctx.save();
    const outside = new Path2D();
    outside.rect(0, 0, artboard.width, artboard.height);
    outside.addPath(pixels.cut);
    ctx.clip(outside, 'evenodd');
    drawInk(ctx, art);
    ctx.restore();
    // ...and pixel shapes inside them.
    ctx.fill(pixels.fill);
  } else {
    drawInk(ctx, art);
  }
  ctx.restore();
}

// Bleed: blur everything, then pull the alpha back to a crisp edge. Blocks
// and strokes melt into each other with rounded, gooey joins.
const BLEED_MAX_SIDE = 8192;
const BLEED_CUT = 90; // alpha (0–255) where the bleed edge lands
let bleedCache = null;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawBleed(ctx, artboard, art, pixels, color, sigma) {
  const m = ctx.getTransform();
  const k = Math.min(Math.hypot(m.a, m.b), BLEED_MAX_SIDE / Math.max(artboard.width, artboard.height));
  const w = Math.max(1, Math.ceil(artboard.width * k));
  const h = Math.max(1, Math.ceil(artboard.height * k));

  const c = bleedCache;
  if (!(c && c.art === art && c.pixels === pixels && c.color === color && c.sigma === sigma && c.w === w && c.h === h)) {
    const sharp = document.createElement('canvas');
    sharp.width = w;
    sharp.height = h;
    const sctx = sharp.getContext('2d');
    sctx.setTransform(k, 0, 0, k, 0, 0);
    drawContent(sctx, artboard, art, pixels, '#000');

    // Blur via an offset shadow (works in every browser, unlike ctx.filter).
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true });
    const off = w + 100;
    octx.shadowColor = '#000';
    octx.shadowBlur = 2 * sigma * k;
    octx.shadowOffsetX = off;
    octx.drawImage(sharp, -off, 0);

    // Threshold with a short ramp so edges stay anti-aliased. The cut sits
    // below 50% so thin strokes survive and neighbors merge.
    const img = octx.getImageData(0, 0, w, h);
    const d = img.data;
    const [r, g, b] = hexToRgb(color);
    for (let i = 0; i < d.length; i += 4) {
      const a = (d[i + 3] - BLEED_CUT) * 6 + 128;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a < 0 ? 0 : a > 255 ? 255 : a;
    }
    octx.putImageData(img, 0, 0);
    bleedCache = { art, pixels, color, sigma, w, h, canvas: out };
  }
  ctx.drawImage(bleedCache.canvas, 0, 0, artboard.width, artboard.height);
}

// The artwork itself — background, outlines, pixel shapes, bleed — drawn
// in artboard units with whatever transform is current. Shared by the
// screen and PNG export, so exports match exactly what's on the canvas.
export function drawArtwork(ctx, { artboard, art, colors, pixels, bleed = 0, background = true }) {
  if (background) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, artboard.width, artboard.height);
  }
  if (!art) return;
  if (bleed > 0) drawBleed(ctx, artboard, art, pixels, colors.fg, bleed);
  else drawContent(ctx, artboard, art, pixels, colors.fg);
}

// Pull tool control points: a light grid joining the handles (like an
// envelope mesh), with the hovered / dragged handle filled.
function drawMesh(ctx, view, dpr, { points, cols, rows }, hot) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const at = (i, j) => {
    const p = points[j * cols + i];
    return [view.x + p.x * view.scale, view.y + p.y * view.scale];
  };
  ctx.strokeStyle = 'rgba(235, 0, 40, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const [x, y] = at(i, j);
      if (i < cols - 1) { ctx.moveTo(x, y); ctx.lineTo(...at(i + 1, j)); }
      if (j < rows - 1) { ctx.moveTo(x, y); ctx.lineTo(...at(i, j + 1)); }
    }
  }
  ctx.stroke();
  const size = 7;
  for (const p of points) {
    const cx = view.x + p.x * view.scale;
    const cy = view.y + p.y * view.scale;
    ctx.fillStyle = p.key === hot ? ACCENT : '#fff';
    ctx.strokeStyle = ACCENT;
    if (p.custom) {
      // Points you added are round; grid points are square.
      ctx.beginPath();
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }
    const x = Math.round(cx - size / 2) + 0.5;
    const y = Math.round(cy - size / 2) + 0.5;
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x, y, size, size);
  }
}

// Dashed rectangle while dragging out a new text box.
function drawDraft(ctx, view, dpr, { from, to }) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = view.x + Math.min(from.x, to.x) * view.scale;
  const y = view.y + Math.min(from.y, to.y) * view.scale;
  const w = Math.abs(to.x - from.x) * view.scale;
  const h = Math.abs(to.y - from.y) * view.scale;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.setLineDash([]);
}

export function render(ctx, state, view, dpr) {
  const { artboard, art, scene, colors, editing, selected, resizeLabel, guides, pixels, bleed, brush, draft, mesh, hotHandle } = state;
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

  // Artboard with a soft shadow so a white board reads against the stage.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.08)';
  ctx.shadowBlur = 24 * dpr;
  ctx.shadowOffsetY = 4 * dpr;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, artboard.width, artboard.height);
  ctx.restore();

  drawArtwork(ctx, { artboard, art, colors, pixels, bleed, background: false });

  // Caret positions follow unwarped text, so hide them on warped boxes.
  if (scene && editing && !scene.warped) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, artboard.width, artboard.height);
    ctx.clip();
    drawEditing(ctx, scene, editing, view, colors.fg);
    ctx.restore();
  }

  if (guides) drawGuides(ctx, artboard, view, dpr, guides);
  if (draft) drawDraft(ctx, view, dpr, draft);
  if (mesh) drawMesh(ctx, view, dpr, mesh, hotHandle);
  if (scene && (editing || selected)) drawSelectionBox(ctx, scene.bounds, view, dpr, resizeLabel);
  if (brush) drawBrushCursor(ctx, view, dpr, brush);
}
