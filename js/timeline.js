// Keyframe timeline: the model (keys, playhead, playback settings) and the
// track UI along the bottom of the stage. What a keyframe's snapshot holds
// and how it's interpolated lives in app.js, which knows the document.

export const EASINGS = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) ** 2,
};

let nextKeyId = 1;

export class Timeline {
  constructor() {
    this.keys = []; // { id, time, snap }, sorted by time
    this.duration = 3; // seconds
    this.time = 0;
    this.playing = false;
    this.loop = true;
    this.speed = 1;
    this.easing = 'inOut';
    this.transition = 'crossfade'; // font change: 'crossfade' | 'dissolve'
    this.selectedId = null;
  }

  sort() {
    this.keys.sort((a, b) => a.time - b.time);
  }

  keyAt(time, eps = 0.02) {
    return this.keys.find((k) => Math.abs(k.time - time) <= eps) ?? null;
  }

  get selected() {
    return this.keys.find((k) => k.id === this.selectedId) ?? null;
  }

  add(time, snap) {
    const key = { id: nextKeyId++, time: Math.min(this.duration, Math.max(0, time)), snap };
    this.keys.push(key);
    this.sort();
    return key;
  }

  remove(id) {
    this.keys = this.keys.filter((k) => k.id !== id);
    if (this.selectedId === id) this.selectedId = null;
  }

  // The two keys around time t and the eased progress between them.
  segment(t) {
    const keys = this.keys;
    if (!keys.length) return null;
    if (t <= keys[0].time) return { k0: keys[0], k1: keys[0], u: 0 };
    const last = keys[keys.length - 1];
    if (t >= last.time) return { k0: last, k1: last, u: 0 };
    let i = 0;
    while (keys[i + 1].time < t) i++;
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const raw = (t - k0.time) / Math.max(1e-6, k1.time - k0.time);
    return { k0, k1, u: EASINGS[this.easing](raw) };
  }
}

// ---------- Track UI ----------

const PAD = 16; // px inset at both ends of the track

export function createTimelineUI({ track, ruler, lane, playhead, empty }, timeline, { onScrub, onSelectKey, onMoveKey }) {
  const width = () => track.clientWidth - PAD * 2;
  const timeToX = (t) => PAD + (t / timeline.duration) * width();
  const xToTime = (x) => Math.min(timeline.duration, Math.max(0, ((x - PAD) / width()) * timeline.duration));
  const snap = (t) => Math.round(t * 20) / 20; // 0.05s

  function localX(e) {
    return e.clientX - track.getBoundingClientRect().left;
  }

  function drawRuler() {
    const d = timeline.duration;
    const step = d <= 2 ? 0.25 : d <= 6 ? 0.5 : d <= 15 ? 1 : 2;
    ruler.innerHTML = '';
    for (let t = 0; t <= d + 1e-6; t += step) {
      const tick = document.createElement('span');
      const major = Math.abs(t - Math.round(t)) < 1e-6;
      tick.className = major ? 'tl-tick tl-tick-major' : 'tl-tick';
      tick.style.left = `${timeToX(t)}px`;
      if (major) tick.dataset.label = `${Math.round(t)}s`;
      ruler.append(tick);
    }
  }

  function draw() {
    drawRuler();
    for (const el of lane.querySelectorAll('.tl-key')) el.remove();
    for (const key of timeline.keys) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tl-key';
      el.style.left = `${timeToX(key.time)}px`;
      el.title = `Keyframe at ${key.time.toFixed(2)}s`;
      el.setAttribute('aria-pressed', String(key.id === timeline.selectedId));
      el.dataset.id = key.id;
      lane.append(el);
    }
    empty.hidden = timeline.keys.length > 0;
    playhead.style.left = `${timeToX(timeline.time)}px`;
  }

  // Scrub by dragging anywhere on the track; drag diamonds to retime keys.
  let drag = null;

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    track.setPointerCapture(e.pointerId);
    const keyEl = e.target.closest('.tl-key');
    if (keyEl) {
      const key = timeline.keys.find((k) => k.id === Number(keyEl.dataset.id));
      drag = { type: 'key', key, startX: localX(e), startTime: key.time, moved: false };
      onSelectKey(key);
    } else {
      drag = { type: 'scrub' };
      onScrub(snap(xToTime(localX(e))));
    }
  });

  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.type === 'scrub') {
      onScrub(snap(xToTime(localX(e))));
    } else {
      const dx = localX(e) - drag.startX;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      drag.key.time = snap(Math.min(timeline.duration, Math.max(0, drag.startTime + (dx / width()) * timeline.duration)));
      timeline.sort();
      onMoveKey(drag.key);
    }
  });

  const end = () => { drag = null; };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);

  new ResizeObserver(draw).observe(track);
  return { draw };
}
