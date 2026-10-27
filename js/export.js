// PNG and SVG export.
//
// PNG redraws the artwork off-screen at 1×/2×/4× (no UI overlays) and, for
// canvases set up in inches, writes a pHYs chunk so print apps open it at
// the right physical size.
//
// SVG produces one merged path: pixel cells are traced into orthogonal
// polygons, then paper.js computes (outlines − pixelated cells) ∪ filled
// cells, keeping the glyphs' real Bézier curves.

import { drawArtwork } from './renderer.js?v=202610271417';
import { strokeWidthOf } from './layout.js?v=202610271417';

// ---------- PNG ----------

// Stay inside browser canvas limits (Chrome: 16384 px per side, ~268 MP).
const MAX_SIDE = 16384;
const MAX_AREA = 268_000_000;

export function maxScale(artboard) {
  const { width: w, height: h } = artboard;
  return Math.min(MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
}

export async function exportPNG({ artboard, art, pixels, colors, scale, transparent, dpi, bleed }) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(artboard.width * scale);
  canvas.height = Math.round(artboard.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawArtwork(ctx, { artboard, art, colors, pixels, bleed, background: !transparent });

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed — try a smaller scale.'))), 'image/png'),
  );
  return dpi ? withDpi(blob, dpi * scale) : blob;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Insert a pHYs chunk right after IHDR (8-byte signature + 25-byte IHDR).
async function withDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254); // pixels per meter
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: meter
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  const at = 33;
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: 'image/png' });
}

// ---------- SVG ----------

let paperLoading = null;

function loadPaper() {
  paperLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/paper-core.min.js';
    s.onload = () => {
      window.paper.setup(new window.paper.Size(1, 1));
      resolve(window.paper);
    };
    s.onerror = () => reject(new Error('Couldn’t load the vector engine (paper.js).'));
    document.head.append(s);
  });
  return paperLoading;
}

const fmt = (n) => +n.toFixed(3);

function svgDocument({ artboard, units, colors, transparent, body }) {
  const { width: w, height: h } = artboard;
  const size = units.unit === 'in'
    ? `width="${fmt(w / units.dpi)}in" height="${fmt(h / units.dpi)}in"`
    : `width="${w}" height="${h}"`;
  const bg = transparent ? '' : `\n  <rect width="${w}" height="${h}" fill="${colors.bg}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${w} ${h}">${bg}
  ${body}
</svg>
`;
}

// Plain boxes (no stroke/outline/bold) are merged into one clean path:
// (outlines − pixelated cells) ∪ filled cells. Stroked boxes keep their
// stroke as an SVG stroke, clipped away from pixelated cells. Bleed is
// written as an SVG blur + alpha-threshold filter.
export async function exportSVG({ artboard, art, pixels, colors, transparent, units, bleed }) {
  const { width: w, height: h } = artboard;
  const fg = colors.fg;
  const plain = art.items.filter((it) => !it.box.outline && strokeWidthOf(it.box) === 0);
  const styled = art.items.filter((it) => !plain.includes(it));
  // The pixel layer already merges cells into clean outlines.
  const squareRuns = pixels?.squaresD ?? '';
  const cutD = pixels?.cutD ?? '';
  const parts = [];
  let merged = true;

  // Merged plain outlines.
  const plainD = plain.map((it) => it.d).join(' ');
  let mergedD = plainD;
  try {
    const paper = await loadPaper();
    const opts = { insert: false };
    const board = new paper.Path.Rectangle({ point: [0, 0], size: [w, h], ...opts });
    let shape = new paper.CompoundPath({ pathData: plainD, ...opts });
    if (pixels) {
      shape = shape.subtract(new paper.CompoundPath({ pathData: cutD, ...opts }), opts);
      if (squareRuns) shape = shape.unite(new paper.CompoundPath({ pathData: squareRuns, ...opts }), opts);
    }
    mergedD = shape.intersect(board, opts).getPathData(null, 2);
  } catch (err) {
    console.warn('Boolean merge failed; falling back to clip paths.', err);
    merged = false;
  }

  const defs = [];
  const clip = pixels ? ' clip-path="url(#outside-cells)"' : '';
  if (pixels) {
    defs.push(`<clipPath id="outside-cells"><path clip-rule="evenodd" d="M0 0H${w}V${h}H0Z${cutD}"/></clipPath>`);
  }

  if (merged) {
    if (mergedD) parts.push(`<path d="${mergedD}" fill="${fg}"/>`);
  } else if (plainD) {
    parts.push(`<path d="${plainD}" fill="${fg}"${clip}/>`);
  }

  for (const it of styled) {
    const box = it.box;
    const sw = box.outline ? Math.max(strokeWidthOf(box), box.size * 0.012) : strokeWidthOf(box);
    const fill = box.outline ? 'none' : fg;
    parts.push(`<path d="${it.d}" fill="${fill}" stroke="${fg}" stroke-width="${fmt(sw)}" stroke-linejoin="round" stroke-linecap="round"${clip}/>`);
  }

  // Pixel cells: square runs are merged above; other shapes leave gaps,
  // so they're their own path (they never overlap the outlines).
  if (pixels) {
    const d = (merged ? '' : squareRuns) + pixels.shapesD;
    if (d) parts.push(`<path d="${d}" fill="${fg}"/>`);
  }

  let body = parts.join('\n  ');
  if (bleed > 0) {
    defs.push(
      '<filter id="bleed" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">' +
      `<feGaussianBlur stdDeviation="${fmt(bleed)}"/>` +
      '<feComponentTransfer><feFuncA type="linear" slope="6" intercept="-1.62"/></feComponentTransfer></filter>',
    );
    body = `<g filter="url(#bleed)">\n  ${body}\n  </g>`;
  }
  if (defs.length) body = `<defs>${defs.join('')}</defs>\n  ${body}`;

  const svg = svgDocument({ artboard, units, colors, transparent, body });
  return { blob: new Blob([svg], { type: 'image/svg+xml' }), merged };
}

// ---------- GIF ----------
// Frames are rendered one at a time by the caller (`renderFrame(t)` returns
// a canvas), then gif.js encodes them in web workers.

let gifLoading = null;

function loadGif() {
  gifLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/gif.js';
    s.onload = () => resolve(window.GIF);
    s.onerror = () => reject(new Error('Couldn’t load the GIF encoder (gif.js).'));
    document.head.append(s);
  });
  return gifLoading;
}

export async function exportGIF({ width, height, fps, duration, loop, renderFrame, onProgress }) {
  const GIF = await loadGif();
  const gif = new GIF({
    workers: 2,
    quality: 10,
    width,
    height,
    repeat: loop ? 0 : -1, // 0 = loop forever, -1 = play once
    workerScript: 'vendor/gif.worker.js',
  });
  const frames = Math.max(1, Math.round(duration * fps));
  for (let i = 0; i < frames; i++) {
    const canvas = await renderFrame(i / fps);
    gif.addFrame(canvas, { delay: Math.round(1000 / fps), copy: true });
    onProgress?.(((i + 1) / frames) * 0.5);
  }
  return new Promise((resolve, reject) => {
    gif.on('progress', (p) => onProgress?.(0.5 + p / 2));
    gif.on('finished', resolve);
    gif.on('abort', () => reject(new Error('GIF export was cancelled.')));
    gif.render();
  });
}

// ---------- MP4 ----------
// Frame-by-frame H.264 via WebCodecs (exact timing, faster than real time),
// packaged into an .mp4 by mp4-muxer.

let muxerLoading = null;

function loadMuxer() {
  muxerLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mp4-muxer.js';
    s.onload = () => resolve(window.Mp4Muxer);
    s.onerror = () => reject(new Error('Couldn’t load the MP4 muxer.'));
    document.head.append(s);
  });
  return muxerLoading;
}

export const canEncodeMP4 = () => 'VideoEncoder' in window && 'VideoFrame' in window;

// High → Main → Baseline profiles, highest level first so tall/large frames fit.
const AVC_CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e01f'];

export async function exportMP4({ width, height, fps, duration, renderFrame, onProgress }) {
  if (!canEncodeMP4()) {
    throw new Error('MP4 export needs Chrome, Edge or Safari 17+. Try GIF instead.');
  }
  const bitrate = Math.round(width * height * fps * 0.2);
  let config = null;
  for (const codec of AVC_CODECS) {
    const candidate = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(candidate)).supported) {
      config = candidate;
      break;
    }
  }
  if (!config) throw new Error(`This browser can’t encode H.264 at ${width} × ${height}. Try a smaller width.`);

  const { Muxer, ArrayBufferTarget } = await loadMuxer();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  const frames = Math.max(1, Math.round(duration * fps));
  const step = 1e6 / fps; // microseconds
  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    const canvas = await renderFrame(i / fps);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    // Don't let the encoder queue run away from the renderer.
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    onProgress?.(((i + 1) / frames) * 0.95);
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  onProgress?.(1);
  return new Blob([target.buffer], { type: 'video/mp4' });
}

// ---------- Download ----------

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
