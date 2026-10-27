// Lays out one text box as real glyph outlines, centered on the artboard
// and then shifted by the box's (offsetX, offsetY).
// All coordinates are in artboard (document) units.
//
// Every character can have its own font (`box.fonts[i]`, indexed like the
// string). Glyphs map 1:1 to characters (no ligature substitution) so every
// character has a caret position — needed for typing on the canvas.
//
// Synthetic styles: italic slants the outlines about each baseline,
// underline adds a bar per line. (Bold is a stroke, applied when drawing.)

const ITALIC_DEG = 12;

// `fx.boil` (0–100) adds a hand-drawn jitter that changes with `fx.seed`.
export function layoutBox(box, fontFor, artboard, fx = {}) {
  const { text, size, tracking, lineHeight, offsetX = 0, offsetY = 0 } = box;
  const spacing = (tracking / 1000) * size; // tracking is in 1/1000 em
  const leading = size * lineHeight;
  const baseFont = fontFor(box.font);
  const skew = box.italic ? Math.tan((ITALIC_DEG * Math.PI) / 180) : 0;

  // Split into lines of { char, font, index } so each character knows its font.
  const lineItems = [];
  let index = 0;
  for (const lineText of text.split('\n')) {
    const items = [];
    let u = index;
    for (const ch of Array.from(lineText)) {
      items.push({ ch, font: fontFor(box.fonts[u] ?? box.font) });
      u += ch.length;
    }
    lineItems.push({ start: index, text: lineText, items });
    index += lineText.length + 1;
  }

  // Vertical metrics: the tallest/deepest of every font used, so mixed
  // lines don't collide. Centered on metrics (not ink) so the block doesn't
  // jump around as descenders/swashes come and go while typing.
  const used = new Set([baseFont, ...lineItems.flatMap((l) => l.items.map((it) => it.font))]);
  let ascender = 0;
  let descender = 0;
  let capHeight = 0;
  for (const f of used) {
    const k = size / f.unitsPerEm;
    ascender = Math.max(ascender, f.ascender * k);
    descender = Math.min(descender, f.descender * k);
    capHeight = Math.max(capHeight, (f.tables.os2?.sCapHeight || f.ascender * 0.7) * k);
  }

  const blockHeight = (lineItems.length - 1) * leading + (ascender - descender);
  let baseline = (artboard.height - blockHeight) / 2 + ascender + offsetY;

  const glyphs = [];
  const lines = [];
  const extras = []; // underline bars

  for (const { start, text: lineText, items } of lineItems) {
    const advances = items.map((it, i) => {
      const k = size / it.font.unitsPerEm;
      const g = it.font.charToGlyph(it.ch);
      it.glyph = g;
      let a = (g.advanceWidth || 0) * k;
      if (i < items.length - 1) {
        const next = items[i + 1];
        if (next.font === it.font) a += it.font.getKerningValue(g, next.font.charToGlyph(next.ch)) * k;
        a += spacing;
      }
      return a;
    });
    const width = advances.reduce((s, a) => s + a, 0);

    // carets[i] is the x position before character i; carets[n] is the line end.
    let x = (artboard.width - width) / 2 + offsetX;
    const carets = [x];
    items.forEach((it, i) => {
      const path = it.glyph.getPath(x, baseline, size);
      if (skew) slantPath(path, baseline, skew);
      if (path.commands.length) glyphs.push({ path });
      x += advances[i];
      carets.push(x);
    });

    if (box.underline && items.length) {
      const post = baseFont.tables.post;
      const k = size / baseFont.unitsPerEm;
      const thick = (post?.underlineThickness || 50) * k;
      const y = baseline - (post?.underlinePosition || -100) * k;
      const bar = new opentype.Path();
      bar.moveTo(carets[0], y);
      bar.lineTo(x, y);
      bar.lineTo(x, y + thick);
      bar.lineTo(carets[0], y + thick);
      bar.close();
      extras.push({ path: bar });
    }

    // Offsets are in UTF-16 units to match textarea selection indices.
    const offsets = [0];
    for (const it of items) offsets.push(offsets[offsets.length - 1] + it.ch.length);

    lines.push({
      start, offsets, carets, baseline,
      top: baseline - ascender,
      bottom: baseline - descender,
      caretTop: baseline - capHeight * 1.1,
      caretBottom: baseline + size * 0.08,
    });
    baseline += leading;
  }

  const shapes = [...glyphs, ...extras];
  const warped = (box.warp && box.warp !== 'none' && box.warpAmount !== 0) || box.pulls?.length > 0;
  if (box.warp && box.warp !== 'none' && box.warpAmount !== 0) warpShapes(shapes, box, lines);
  if (box.pulls?.length) pullShapes(shapes, box, artboard);
  if (fx.boil > 0) boilShapes(shapes, box.size, fx.boil, fx.seed || 0);
  for (const s of shapes) s.d = s.path.toPathData(2);

  // Selection box: union of the ink and the line boxes, so it hugs swashes
  // but still has a sensible size for empty or space-only text. Warped text
  // uses ink only, since its lines no longer sit on straight baselines.
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const extend = (bx, by) => {
    bounds.x0 = Math.min(bounds.x0, bx);
    bounds.y0 = Math.min(bounds.y0, by);
    bounds.x1 = Math.max(bounds.x1, bx);
    bounds.y1 = Math.max(bounds.y1, by);
  };
  for (const s of shapes) {
    const b = s.path.getBoundingBox();
    if (!isFinite(b.x1)) continue;
    extend(b.x1, b.y1);
    extend(b.x2, b.y2);
  }
  if (!warped || !isFinite(bounds.x0)) {
    for (const line of lines) {
      extend(line.carets[0], line.top);
      extend(line.carets[line.carets.length - 1], line.bottom);
    }
  }
  // Leave room for strokes / faux bold.
  const pad = strokeWidthOf(box) / 2;
  bounds.x0 -= pad; bounds.y0 -= pad; bounds.x1 += pad; bounds.y1 += pad;

  const italicAngle = (baseFont.tables.post?.italicAngle || 0) - (skew ? ITALIC_DEG : 0);
  const d = shapes.map((s) => s.d).join(' ');
  const base = {
    x0: Math.min(...lines.map((ln) => ln.carets[0])),
    x1: Math.max(...lines.map((ln) => ln.carets[ln.carets.length - 1])),
    y0: lines[0].caretTop,
    y1: lines[lines.length - 1].caretBottom,
  };
  return { box, lines, bounds, base, italicAngle, warped, d, path2d: new Path2D(d) };
}

// ---------- Warps ----------
// Point warps applied to every outline point. Curves are subdivided first
// (exactly, via derivatives) so straight edges bend and curves stay smooth.
// The result is re-centered so the box stays where it was.

function warpShapes(shapes, box, lines) {
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of shapes) {
    const b = s.path.getBoundingBox();
    if (!isFinite(b.x1)) continue;
    bb.x0 = Math.min(bb.x0, b.x1); bb.y0 = Math.min(bb.y0, b.y1);
    bb.x1 = Math.max(bb.x1, b.x2); bb.y1 = Math.max(bb.y1, b.y2);
  }
  if (!isFinite(bb.x0)) return;
  const cx = (bb.x0 + bb.x1) / 2;
  const cy = (bb.y0 + bb.y1) / 2;
  const w = Math.max(1, bb.x1 - bb.x0);
  const h = Math.max(1, bb.y1 - bb.y0);
  const amt = box.warpAmount / 100; // -1..1
  const freq = (box.warpFreq ?? 50) / 100; // 0..1
  const size = box.size;

  let fn;
  switch (box.warp) {
    case 'arc': {
      // Bend along a circle; ±100% wraps the text all the way around.
      const sweep = amt * 2 * Math.PI;
      const R = w / sweep;
      const b0 = lines[0].baseline;
      fn = (x, y) => {
        const th = (x - cx) / R;
        const rho = R - (y - b0);
        return [cx + rho * Math.sin(th), b0 + R - rho * Math.cos(th)];
      };
      break;
    }
    case 'wave': {
      const A = amt * size * 0.35;
      const lambda = size * (6 - 5.2 * freq);
      const phase = ((box.warpPhase || 0) * Math.PI) / 180;
      fn = (x, y) => [x, y + A * Math.sin((2 * Math.PI * (x - bb.x0)) / lambda + phase)];
      break;
    }
    case 'bulge': {
      // Positive inflates the middle, negative pinches it.
      const rx = w / 2;
      const ry = h / 2;
      fn = (x, y) => {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const r2 = Math.min(1, nx * nx + ny * ny);
        const k = 1 + amt * 0.6 * (1 - r2);
        return [cx + (x - cx) * k, cy + (y - cy) * k];
      };
      break;
    }
    case 'distort': {
      // Smooth value noise displacement: wobbly, hand-warped outlines.
      const A = amt * size * 0.18;
      const scale = size * (1.6 - 1.45 * freq);
      fn = (x, y) => [
        x + A * smoothNoise(x / scale, y / scale),
        y + A * smoothNoise(x / scale + 37.1, y / scale + 91.7),
      ];
      break;
    }
    default:
      return;
  }

  const n = box.warp === 'distort' ? 8 : 6;
  for (const s of shapes) {
    s.path.commands = subdivide(s.path.commands, n);
    for (const c of s.path.commands) {
      if ('x' in c) [c.x, c.y] = fn(c.x, c.y);
      if ('x1' in c) [c.x1, c.y1] = fn(c.x1, c.y1);
      if ('x2' in c) [c.x2, c.y2] = fn(c.x2, c.y2);
    }
  }

  // Re-center on the original box center.
  const nb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of shapes) {
    const b = s.path.getBoundingBox();
    if (!isFinite(b.x1)) continue;
    nb.x0 = Math.min(nb.x0, b.x1); nb.y0 = Math.min(nb.y0, b.y1);
    nb.x1 = Math.max(nb.x1, b.x2); nb.y1 = Math.max(nb.y1, b.y2);
  }
  const dx = cx - (nb.x0 + nb.x1) / 2;
  const dy = cy - (nb.y0 + nb.y1) / 2;
  for (const s of shapes) {
    for (const c of s.path.commands) {
      if ('x' in c) { c.x += dx; c.y += dy; }
      if ('x1' in c) { c.x1 += dx; c.y1 += dy; }
      if ('x2' in c) { c.x2 += dx; c.y2 += dy; }
    }
  }
}

// Split every segment into n pieces. Sub-curve control points come from the
// derivative at each end, which is exact for quadratic and cubic Béziers.
function subdivide(commands, n) {
  const out = [];
  let px = 0, py = 0, sx = 0, sy = 0;
  const line = (x, y) => {
    for (let i = 1; i <= n; i++) out.push({ type: 'L', x: px + ((x - px) * i) / n, y: py + ((y - py) * i) / n });
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        out.push({ type: 'M', x: c.x, y: c.y });
        sx = c.x; sy = c.y;
        break;
      case 'L':
        line(c.x, c.y);
        break;
      case 'Q': {
        const B = (t) => [(1 - t) ** 2 * px + 2 * (1 - t) * t * c.x1 + t * t * c.x, (1 - t) ** 2 * py + 2 * (1 - t) * t * c.y1 + t * t * c.y];
        const D = (t) => [2 * (1 - t) * (c.x1 - px) + 2 * t * (c.x - c.x1), 2 * (1 - t) * (c.y1 - py) + 2 * t * (c.y - c.y1)];
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = (i + 1) / n, dt = t1 - t0;
          const p0 = B(t0), p1 = B(t1), d0 = D(t0);
          out.push({ type: 'Q', x1: p0[0] + (dt / 2) * d0[0], y1: p0[1] + (dt / 2) * d0[1], x: p1[0], y: p1[1] });
        }
        break;
      }
      case 'C': {
        const B = (t) => {
          const u = 1 - t;
          return [
            u ** 3 * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x,
            u ** 3 * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y,
          ];
        };
        const D = (t) => {
          const u = 1 - t;
          return [
            3 * u * u * (c.x1 - px) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (c.x - c.x2),
            3 * u * u * (c.y1 - py) + 6 * u * t * (c.y2 - c.y1) + 3 * t * t * (c.y - c.y2),
          ];
        };
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = (i + 1) / n, dt = t1 - t0;
          const p0 = B(t0), p1 = B(t1), d0 = D(t0), d1 = D(t1);
          out.push({
            type: 'C',
            x1: p0[0] + (dt / 3) * d0[0], y1: p0[1] + (dt / 3) * d0[1],
            x2: p1[0] - (dt / 3) * d1[0], y2: p1[1] - (dt / 3) * d1[1],
            x: p1[0], y: p1[1],
          });
        }
        break;
      }
      case 'Z':
        if (px !== sx || py !== sy) line(sx, sy);
        out.push({ type: 'Z' });
        px = sx; py = sy;
        continue;
    }
    if ('x' in c) { px = c.x; py = c.y; }
  }
  return out;
}

// Pull tool (liquify-style forward warp). Each pull is { u, v, du, dv, r }
// in box units (relative to the box center, in multiples of font size), so
// pulls move and scale with the text. Points inside radius r move by
// (du, dv) with a smooth falloff; pulls apply in order, like brush dabs.
// Where a document point ends up after a box's pulls (also used to place
// the Pull tool's control points on the distorted text).
export function pullPoint(box, artboard, x, y) {
  const cx = artboard.width / 2 + (box.offsetX || 0);
  const cy = artboard.height / 2 + (box.offsetY || 0);
  const s = box.size;
  let u = (x - cx) / s;
  let v = (y - cy) / s;
  for (const p of box.pulls ?? []) {
    const du = u - p.u;
    const dv = v - p.v;
    const d2 = (du * du + dv * dv) / (p.r * p.r);
    if (d2 >= 1) continue;
    const w = (1 - d2) ** 2;
    u += p.du * w;
    v += p.dv * w;
  }
  return [cx + u * s, cy + v * s];
}

function pullShapes(shapes, box, artboard) {
  const fn = (x, y) => pullPoint(box, artboard, x, y);
  for (const sh of shapes) {
    sh.path.commands = subdivide(sh.path.commands, 4);
    for (const c of sh.path.commands) {
      if ('x' in c) [c.x, c.y] = fn(c.x, c.y);
      if ('x1' in c) [c.x1, c.y1] = fn(c.x1, c.y1);
      if ('x2' in c) [c.x2, c.y2] = fn(c.x2, c.y2);
    }
  }
}

// Line boil: a small, smooth wobble whose pattern jumps to a new seed a few
// times a second, like redrawn animation frames.
function boilShapes(shapes, size, amount, seed) {
  const A = (amount / 100) * size * 0.035;
  const scale = size * 0.22;
  const ox = seed * 17.3;
  const oy = seed * 29.1;
  const fn = (x, y) => [
    x + A * smoothNoise(x / scale + ox, y / scale + oy),
    y + A * smoothNoise(x / scale + oy + 50, y / scale + ox + 50),
  ];
  for (const s of shapes) {
    s.path.commands = subdivide(s.path.commands, 3);
    for (const c of s.path.commands) {
      if ('x' in c) [c.x, c.y] = fn(c.x, c.y);
      if ('x1' in c) [c.x1, c.y1] = fn(c.x1, c.y1);
      if ('x2' in c) [c.x2, c.y2] = fn(c.x2, c.y2);
    }
  }
}

// 2D value noise in roughly [-1, 1], smooth (cosine-interpolated).
function smoothNoise(x, y) {
  const hash = (i, j) => {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
  };
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = (1 - Math.cos(fx * Math.PI)) / 2;
  const sy = (1 - Math.cos(fy * Math.PI)) / 2;
  const a = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * sx;
  const b = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * sx;
  return a + (b - a) * sy;
}

// Total stroke width drawn around a box's outlines: the user's stroke plus
// the synthetic-bold thickening.
export function strokeWidthOf(box) {
  return ((box.stroke || 0) / 1000) * box.size + (box.bold ? box.size * 0.035 : 0);
}

// Slant an opentype.js path in place about the given baseline.
function slantPath(path, baseline, k) {
  for (const c of path.commands) {
    if ('x' in c) c.x += (baseline - c.y) * k;
    if ('x1' in c) c.x1 += (baseline - c.y1) * k;
    if ('x2' in c) c.x2 += (baseline - c.y2) * k;
  }
}

// Text index of the caret slot nearest to an artboard point.
export function hitTest(scene, x, y) {
  const dist = (l) => Math.abs((l.top + l.bottom) / 2 - y);
  const line = scene.lines.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  const slant = Math.tan((-scene.italicAngle * Math.PI) / 180);
  const xu = x - (line.baseline - y) * slant; // undo the italic lean
  let best = 0;
  line.carets.forEach((cx, i) => {
    if (Math.abs(cx - xu) < Math.abs(line.carets[best] - xu)) best = i;
  });
  return line.start + line.offsets[best];
}

// Caret slot on a given line for a text index, clamped to that line.
export function caretX(line, index) {
  const local = index - line.start;
  let i = line.offsets.findIndex((o) => o >= local);
  if (i === -1) i = line.offsets.length - 1;
  return line.carets[i];
}
