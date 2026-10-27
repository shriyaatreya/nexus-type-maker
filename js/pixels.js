// Pixel brush layer.
//
// Brush strokes are stored as vector polylines in *text space* (relative to
// the text's center, in units of font size), so painted areas stick to the
// same parts of the letters when the text is moved or resized. Strokes are
// rasterized into coverage masks; every frame the masks are sampled on a
// grid of `pixelSize` cells to decide which cells are "pixelated". Changing
// pixel size only re-samples — strokes are untouched.
//
// Each stroke remembers its mode, so clipped and free strokes can be mixed:
// clipped strokes go into one mask, free strokes into another, and erasers
// remove from both.
//
// Per cell (t = stable per-cell random threshold, so soft edges dither):
//   painted = clipped coverage > t  or  free coverage > t
//   filled  = free coverage > t  or  (clipped coverage > t and a letter
//             covers the cell center)
// Painted cells cut the smooth outline away; filled cells draw as squares.

import { drawInk } from './renderer.js';

const MASK_MAX = 1600; // longest side of the coverage masks, in mask px
const SHADOW_OFFSET = 100000; // draws strokes off-canvas, keeps their blurred shadow

// Stable hash → [0, 1) per cell, so dithering doesn't flicker between frames.
function cellNoise(i, j) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const toText = (p, a) => ({ u: (p.x - a.cx) / a.size, v: (p.y - a.cy) / a.size });
const toDoc = (p, a) => ({ x: a.cx + p.u * a.size, y: a.cy + p.v * a.size });

function makeCanvas(w, h, readable) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', readable ? { willReadFrequently: true } : undefined);
  return { canvas: c, ctx };
}

// One stroke = one stroke() call, so a stroke never builds up density over
// itself. Softness shrinks the hard core and blurs the rest via a shadow.
function strokeInto(ctx, stroke, anchor, ms) {
  const pts = stroke.points.map((p) => toDoc(p, anchor));
  const r = stroke.r * anchor.size;
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) path.lineTo(pts[0].x + 0.01, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);

  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2 * r * (1 - 0.6 * stroke.softness);
  const blur = (2 * r * 0.6 * stroke.softness) / ms; // shadowBlur ignores the transform
  if (blur > 0.5) {
    ctx.setTransform(1 / ms, 0, 0, 1 / ms, -SHADOW_OFFSET, 0);
    ctx.shadowColor = '#000';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = SHADOW_OFFSET;
  } else {
    ctx.setTransform(1 / ms, 0, 0, 1 / ms, 0, 0);
  }
  ctx.stroke(path);
  ctx.restore();
}

// Route a stroke to the right mask(s): erasers clear both.
function drawStroke(masks, stroke, anchor, ms) {
  if (stroke.erase || stroke.clip) strokeInto(masks.clip.ctx, stroke, anchor, ms);
  if (stroke.erase || !stroke.clip) strokeInto(masks.free.ctx, stroke, anchor, ms);
}


// Path data for one pixel cell at (x, y) with side s, in the chosen shape.
// Shapes other than squares leave gaps, so they're emitted per cell.
const f2 = (n) => Math.round(n * 100) / 100;

function shapePath(shape, x, y, s) {
  const cx = x + s / 2;
  const cy = y + s / 2;
  const poly = (pts) => 'M' + pts.map(([px, py]) => `${f2(cx + px)} ${f2(cy + py)}`).join('L') + 'Z';
  const cross = (w, l) => [[-w, -l], [w, -l], [w, -w], [l, -w], [l, w], [w, w], [w, l], [-w, l], [-w, w], [-l, w], [-l, -w], [-w, -w]];
  switch (shape) {
    case 'circle': {
      const r = s * 0.48;
      return `M${f2(cx - r)} ${f2(cy)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0Z`;
    }
    case 'ring': {
      const r = s * 0.48;
      const h = s * 0.24; // hole, wound the other way so nonzero leaves it empty
      return `M${f2(cx - r)} ${f2(cy)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0Z` +
        `M${f2(cx - h)} ${f2(cy)}a${f2(h)} ${f2(h)} 0 1 1 ${f2(2 * h)} 0a${f2(h)} ${f2(h)} 0 1 1 ${f2(-2 * h)} 0Z`;
    }
    case 'diamond':
      return poly([[0, -s / 2], [s / 2, 0], [0, s / 2], [-s / 2, 0]]);
    case 'plus':
      return poly(cross(s / 6, s / 2));
    case 'x': {
      const c = Math.SQRT1_2;
      return poly(cross(s * 0.13, s * 0.62).map(([px, py]) => [(px - py) * c, (px + py) * c]));
    }
    default:
      return `M${f2(x)} ${f2(y)}h${f2(s)}v${f2(s)}h${f2(-s)}Z`;
  }
}

// Route a stroke to its layer's masks; erasers clear every layer.
function drawStrokeLayers(layerMasks, stroke, anchor, ms) {
  if (stroke.erase) {
    for (const masks of layerMasks.values()) drawStroke(masks, stroke, anchor, ms);
  } else {
    const masks = layerMasks.get(stroke.layer);
    if (masks) drawStroke(masks, stroke, anchor, ms);
  }
}

// Strokes belong to a text box (`boxId`) and are stored relative to it.
// `anchors` maps box id → { cx, cy, size }; id 0 is the canvas itself.
//
// Strokes also belong to a pixel layer (`layer`). Each layer has its own
// shape; where layers overlap, the top (last) visible layer wins the cell.
export class PixelLayer {
  constructor() {
    this.entries = []; // strokes and 'clear' markers, oldest first
    this.redoStack = [];
    this.active = null;
    this.version = 0;
    this.baseKey = '';
    this.baseDirty = true;
    this.cache = null;
    this.reveal = null; // animation: how many strokes are shown (null = all)
  }

  // Strokes since the last Clear.
  strokes() {
    const start = this.entries.findLastIndex((e) => e.type === 'clear') + 1;
    return this.entries.slice(start);
  }

  // Strokes shown right now: the first floor(reveal) strokes plus the
  // leading part of the next one, so animated strokes grow along their path.
  visibleStrokes() {
    const all = this.strokes();
    if (this.reveal == null) return all;
    const full = Math.max(0, Math.floor(this.reveal));
    const shown = all.slice(0, full);
    const frac = this.reveal - full;
    const next = all[full];
    if (frac > 0 && next) {
      shown.push({ ...next, points: next.points.slice(0, Math.max(1, Math.ceil(frac * next.points.length))) });
    }
    return shown;
  }

  get canUndo() { return this.entries.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get hasPaint() { return this.strokes().length > 0 || !!this.active; }

  begin(p, boxId, anchor, { brushSize, softness, erase, clip, layer }) {
    this.active = {
      type: 'stroke',
      boxId,
      layer,
      points: [toText(p, anchor)],
      r: brushSize / 2 / anchor.size,
      softness,
      erase,
      clip,
    };
    this.version++;
  }

  extend(p, anchor) {
    if (!this.active) return;
    const q = toText(p, anchor);
    const last = this.active.points[this.active.points.length - 1];
    if (Math.hypot(q.u - last.u, q.v - last.v) < this.active.r * 0.05) return;
    this.active.points.push(q);
    this.version++;
  }

  end() {
    if (!this.active) return;
    const stroke = this.active;
    this.entries.push(stroke);
    this.redoStack.length = 0;
    this.active = null;
    // Bake straight into the base masks instead of replaying everything.
    const anchor = this.baseAnchors?.get(stroke.boxId);
    const canBake = this.base && !this.baseDirty && anchor && this.reveal == null &&
      (stroke.erase || this.base.has(stroke.layer));
    if (canBake) drawStrokeLayers(this.base, stroke, anchor, this.ms);
    else this.baseDirty = true;
    this.version++;
  }

  clear() {
    if (!this.hasPaint) return;
    this.entries.push({ type: 'clear' });
    this.redoStack.length = 0;
    this.touch();
  }

  undo() {
    if (!this.canUndo) return;
    this.redoStack.push(this.entries.pop());
    this.touch();
  }

  redo() {
    if (!this.canRedo) return;
    this.entries.push(this.redoStack.pop());
    this.touch();
  }

  touch() {
    this.baseDirty = true;
    this.version++;
  }

  // Re-rasterize committed strokes when any box moves/resizes, the layers
  // change, or the canvas changes. One clip + one free mask per layer.
  ensureBase(artboard, anchors, layerIds) {
    const key = `${artboard.width}x${artboard.height}|${layerIds.join(',')}|${JSON.stringify([...anchors])}`;
    if (key === this.baseKey && !this.baseDirty) return;

    const ms = Math.max(1, Math.max(artboard.width, artboard.height) / MASK_MAX);
    const w = Math.ceil(artboard.width / ms);
    const h = Math.ceil(artboard.height / ms);
    if (!this.letters || this.letters.canvas.width !== w || this.letters.canvas.height !== h) {
      this.letters = makeCanvas(w, h, true);
      this.lettersScene = null;
      this.base = new Map();
      this.mask = new Map();
    }
    // Keep canvases for surviving layers, add new ones, drop deleted ones.
    for (const id of [...this.base.keys()]) {
      if (!layerIds.includes(id)) {
        this.base.delete(id);
        this.mask.delete(id);
      }
    }
    for (const id of layerIds) {
      if (!this.base.has(id)) {
        this.base.set(id, { clip: makeCanvas(w, h, false), free: makeCanvas(w, h, false) });
        this.mask.set(id, { clip: makeCanvas(w, h, true), free: makeCanvas(w, h, true) });
      }
    }
    this.ms = ms;
    for (const masks of this.base.values()) {
      masks.clip.ctx.clearRect(0, 0, w, h);
      masks.free.ctx.clearRect(0, 0, w, h);
    }
    for (const s of this.visibleStrokes()) {
      const anchor = anchors.get(s.boxId);
      if (anchor) drawStrokeLayers(this.base, s, anchor, ms); // strokes of deleted boxes drop out
    }
    this.baseKey = key;
    this.baseAnchors = anchors;
    this.baseDirty = false;
  }

  // Doc-space bounds of everything painted (erasers only remove).
  paintBounds(anchors) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const all = this.active ? [...this.visibleStrokes(), this.active] : this.visibleStrokes();
    for (const s of all) {
      const anchor = anchors.get(s.boxId);
      if (s.erase || !anchor) continue;
      const r = s.r * anchor.size * (1 + s.softness);
      for (const p of s.points) {
        const d = toDoc(p, anchor);
        x0 = Math.min(x0, d.x - r);
        y0 = Math.min(y0, d.y - r);
        x1 = Math.max(x1, d.x + r);
        y1 = Math.max(y1, d.y + r);
      }
    }
    return x0 < x1 ? { x0, y0, x1, y1 } : null;
  }

  // `layers`: [{ id, shape, visible, ps, weight }], bottom to top. Each layer
  // has its own pixel size (grid) and weight.
  // Returns { cut, cutD, fill, fillD, squaresD, shapesD } for the renderer
  // and exporters, or null when nothing is painted.
  compute({ artboard, anchors, scene, layers, reveal = null, seed = 0 }) {
    if (reveal !== this.reveal) {
      this.reveal = reveal;
      this.touch();
    }
    if (!this.hasPaint || !scene) return null;
    const layerIds = layers.map((l) => l.id);
    this.ensureBase(artboard, anchors, layerIds);

    const layerKey = layers.map((l) => `${l.id}:${l.shape}:${l.visible ? 1 : 0}:${l.ps}:${l.weight}`).join(',');
    const c = this.cache;
    if (c && c.version === this.version && c.baseKey === this.baseKey &&
        c.scene === scene && c.layerKey === layerKey && c.seed === seed) {
      return c.result;
    }

    const { ms } = this;
    for (const id of layerIds) {
      for (const k of ['clip', 'free']) {
        const { canvas, ctx } = this.mask.get(id)[k];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this.base.get(id)[k].canvas, 0, 0);
      }
    }
    const activeAnchor = this.active && anchors.get(this.active.boxId);
    if (activeAnchor) drawStrokeLayers(this.mask, this.active, activeAnchor, ms);

    if (this.lettersScene !== scene) {
      const { canvas, ctx } = this.letters;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(1 / ms, 0, 0, 1 / ms, 0, 0);
      ctx.fillStyle = ctx.strokeStyle = '#000';
      drawInk(ctx, scene); // includes strokes / synthetic bold
      this.lettersScene = scene;
    }

    let result = null;
    const b = this.paintBounds(anchors);
    const visible = layers.filter((l) => l.visible);
    if (b && visible.length) result = this.sample(b, artboard, visible, seed);

    this.cache = { version: this.version, baseKey: this.baseKey, scene, layerKey, seed, result };
    return result;
  }

  // Each layer is sampled on its own grid (its pixel size), top layer first.
  // A cell is painted when the layer's coverage beats a stable per-cell
  // random threshold (soft edges dither; `seed` reshuffles it for boil).
  // Where a higher layer has paint, lower layers step aside — top wins.
  // Pixel weight: a clipped cell fills when the letters cover at least
  // `threshold` of it. Heavy = any touch fills (chunky, connected blocks).
  sample(b, artboard, layers, seed = 0) {
    const { ms } = this;
    const W = this.letters.canvas.width;
    const H = this.letters.canvas.height;
    const maxPs = Math.max(...layers.map((l) => l.ps));
    // Mask region covering the painted bounds plus one cell of slack.
    const bx = Math.max(0, Math.floor((b.x0 - maxPs) / ms));
    const by = Math.max(0, Math.floor((b.y0 - maxPs) / ms));
    const bw = Math.min(W, Math.ceil((b.x1 + maxPs) / ms)) - bx;
    const bh = Math.min(H, Math.ceil((b.y1 + maxPs) / ms)) - by;
    if (bw <= 0 || bh <= 0) return null;

    const read = (canvasCtx) => canvasCtx.getImageData(bx, by, bw, bh).data;
    const letters = read(this.letters.ctx);
    const stack = [...layers].reverse().map((l) => ({
      ...l,
      clipped: read(this.mask.get(l.id).clip.ctx),
      free: read(this.mask.get(l.id).free.ctx),
    }));
    const at = (data, x, y) => {
      const mx = Math.floor(x / ms) - bx;
      const my = Math.floor(y / ms) - by;
      return mx >= 0 && my >= 0 && mx < bw && my < bh ? data[(my * bw + mx) * 4 + 3] : 0;
    };

    const r3 = (n) => Math.round(n * 1000) / 1000;
    const cutRects = [];
    const squareRects = [];
    let shapesD = '';

    stack.forEach((L, li) => {
      const ps = L.ps;
      const threshold = Math.max(0.02, 1 - L.weight / 100);
      const n = Math.max(1, Math.min(6, Math.round(ps / ms / 3))); // coverage samples per axis
      const coverage = (i, j) => {
        let hit = 0;
        for (let sy = 0; sy < n; sy++) {
          for (let sx = 0; sx < n; sx++) {
            if (at(letters, (i + (sx + 0.5) / n) * ps, (j + (sy + 0.5) / n) * ps) > 127) hit++;
          }
        }
        return hit / (n * n);
      };
      const higher = stack.slice(0, li);
      const i0 = Math.max(0, Math.floor(b.x0 / ps));
      const j0 = Math.max(0, Math.floor(b.y0 / ps));
      const i1 = Math.min(Math.ceil(artboard.width / ps) - 1, Math.floor(b.x1 / ps));
      const j1 = Math.min(Math.ceil(artboard.height / ps) - 1, Math.floor(b.y1 / ps));

      for (let j = j0; j <= j1; j++) {
        let cutStart = -1;
        let runStart = -1;
        for (let i = i0; i <= i1 + 1; i++) {
          let painted = false;
          let filled = false;
          if (i <= i1) {
            const cx = (i + 0.5) * ps;
            const cy = (j + 0.5) * ps;
            const t = cellNoise(i + seed * 7919 + li * 131, j + seed * 104729) * 255;
            const inFree = at(L.free, cx, cy) > t;
            const inClip = at(L.clipped, cx, cy) > t;
            painted = (inFree || inClip) && !higher.some((h) => at(h.free, cx, cy) > 127 || at(h.clipped, cx, cy) > 127);
            filled = painted && (inFree || coverage(i, j) >= threshold);
          }
          if (painted && cutStart < 0) cutStart = i;
          if (!painted && cutStart >= 0) {
            cutRects.push([r3(cutStart * ps), r3(j * ps), r3(i * ps), r3((j + 1) * ps)]);
            cutStart = -1;
          }
          const square = filled && L.shape === 'square';
          if (filled && !square) shapesD += shapePath(L.shape, i * ps, j * ps, ps);
          if (square && runStart < 0) runStart = i;
          if (!square && runStart >= 0) {
            squareRects.push([r3(runStart * ps), r3(j * ps), r3(i * ps), r3((j + 1) * ps)]);
            runStart = -1;
          }
        }
      }
    });

    if (!cutRects.length) return null;
    const cutD = traceRectUnion(cutRects);
    const squaresD = traceRectUnion(squareRects);
    const fillD = squaresD + shapesD;
    return { cut: new Path2D(cutD), cutD, fill: new Path2D(fillD), fillD, squaresD, shapesD };
  }
}

// Outline of the union of axis-aligned rects [x0, y0, x1, y1] (any sizes,
// overlapping or not): compress coordinates into a grid, mark covered
// cells, then walk the boundary edges clockwise around filled area. Holes
// come out counter-clockwise, so the result fills correctly with nonzero
// and with even-odd.
export function traceRectUnion(rects) {
  if (!rects.length) return '';
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, i) => [y, i]));
  const K = xs.length + 2;
  const cells = new Set();
  for (const [x0, y0, x1, y1] of rects) {
    for (let j = yi.get(y0); j < yi.get(y1); j++) {
      for (let i = xi.get(x0); i < xi.get(x1); i++) cells.add(j * K + i);
    }
  }

  const next = new Map(); // vertex key → outgoing vertex keys
  const edge = (i0, j0, i1, j1) => {
    const a = j0 * K + i0;
    if (!next.has(a)) next.set(a, []);
    next.get(a).push(j1 * K + i1);
  };
  for (const key of cells) {
    const i = key % K;
    const j = (key - i) / K;
    if (!cells.has(key - K)) edge(i, j, i + 1, j); // top
    if (!cells.has(key + 1)) edge(i + 1, j, i + 1, j + 1); // right
    if (!cells.has(key + K)) edge(i + 1, j + 1, i, j + 1); // bottom
    if (!cells.has(key - 1)) edge(i, j + 1, i, j); // left
  }

  let d = '';
  for (const start of next.keys()) {
    while (next.get(start)?.length) {
      const loop = [start];
      let v = start;
      do {
        const out = next.get(v);
        const u = out.pop();
        if (!out.length) next.delete(v);
        v = u;
        loop.push(v);
      } while (v !== start && next.has(v));

      // Drop points in the middle of straight runs.
      const pts = loop.slice(0, -1).map((k) => [k % K, Math.floor(k / K)]);
      const corners = pts.filter((p, idx) => {
        const a = pts[(idx - 1 + pts.length) % pts.length];
        const c = pts[(idx + 1) % pts.length];
        return !((a[0] === p[0] && p[0] === c[0]) || (a[1] === p[1] && p[1] === c[1]));
      });
      if (corners.length < 3) continue;
      d += 'M' + corners.map(([i, j]) => `${xs[i]} ${ys[j]}`).join('L') + 'Z';
    }
  }
  return d;
}
