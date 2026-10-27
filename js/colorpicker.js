// Canva-style color picker: Text / Background tabs, a swatch row (custom,
// eyedropper, document colors), an expandable saturation/value + hue panel
// with a hex field, and a default palette.

const DEFAULTS = [
  '#000000', '#545454', '#a6a6a6', '#d9d9d9', '#ffffff', '#9e001b', '#e2366f',
  '#7b4dff', '#2f6bff', '#1f9d8b', '#8cc63f', '#f5c518', '#ff8a00', '#0e2a47',
];

const TARGETS = [
  { id: 'fg', label: 'Text' },
  { id: 'bg', label: 'Background' },
];

const EYEDROPPER_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`;

// Official TEDxUTAustin brand colors.
const BRAND = [
  { color: '#eb0028', name: 'TEDx Red' },
  { color: '#000000', name: 'TEDx Black' },
  { color: '#ffffff', name: 'White' },
];

const ROW = 7; // swatches per row
const hasEyeDropper = 'EyeDropper' in window;

// ---------- Color math ----------

const clamp01 = (n) => Math.min(1, Math.max(0, n));

function normalizeHex(value) {
  let v = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(v)) v = v.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }) {
  const f = (k) => {
    const c = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(c, 4 - c, 1));
  };
  return '#' + [f(5), f(3), f(1)]
    .map((x) => Math.round(x * 255).toString(16).padStart(2, '0'))
    .join('');
}

// ---------- Component ----------

export function createColorPicker(root, { get, set }) {
  let target = 'fg';
  let hsv = { h: 0, s: 0, v: 0 };
  const recents = [];

  root.innerHTML = `
    <div class="cp-tabs" role="tablist">
      ${TARGETS.map((t) => `<button type="button" role="tab" class="cp-tab" data-target="${t.id}">${t.label}</button>`).join('')}
    </div>
    <div class="cp-swatches" data-role="document"></div>
    <div class="cp-panel" hidden>
      <div class="cp-sv" tabindex="0" aria-label="Saturation and brightness"><span class="cp-thumb"></span></div>
      <div class="cp-hue" tabindex="0" aria-label="Hue"><span class="cp-thumb"></span></div>
      <div class="cp-hex-row">
        <label class="cp-hex"><span class="cp-hex-dot"></span><input type="text" spellcheck="false" maxlength="7" aria-label="Hex color"></label>
        ${hasEyeDropper ? `<button type="button" class="cp-icon-btn" data-action="eyedropper" aria-label="Pick color from screen">${EYEDROPPER_ICON}</button>` : ''}
      </div>
    </div>
    <div class="cp-label">Brand colors</div>
    <div class="cp-swatches" data-role="brand"></div>
    <div class="cp-label">Default colors</div>
    <div class="cp-swatches" data-role="defaults"></div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const panel = $('.cp-panel');
  const sv = $('.cp-sv');
  const hue = $('.cp-hue');
  const hexInput = $('.cp-hex input');
  const hexDot = $('.cp-hex-dot');

  const current = () => get(target).toLowerCase();

  function syncHsv() {
    const next = hexToHsv(current());
    // Greys have no hue; keep the last one so the hue slider doesn't jump.
    if (next.s === 0 || next.v === 0) next.h = hsv.h;
    hsv = next;
  }

  function apply(hex, { commit = false, fromPanel = false } = {}) {
    set(target, hex);
    if (!fromPanel) syncHsv();
    if (commit) remember(hex);
    render();
  }

  function remember(hex) {
    const i = recents.indexOf(hex);
    if (i !== -1) recents.splice(i, 1);
    recents.unshift(hex);
    recents.length = Math.min(recents.length, ROW);
  }

  // ---------- Rendering ----------

  function swatch(color, name) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-swatch';
    b.style.setProperty('--swatch', color);
    b.dataset.color = color;
    b.setAttribute('aria-label', name ? `${name} ${color}` : color);
    b.title = name ? `${name} ${color.toUpperCase()}` : color.toUpperCase();
    b.setAttribute('aria-pressed', String(color === current()));
    return b;
  }

  function renderSwatches() {
    const docRow = $('[data-role="document"]');
    docRow.innerHTML = '';

    const custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'cp-swatch cp-custom';
    custom.dataset.action = 'toggle';
    custom.setAttribute('aria-label', 'Custom color');
    custom.setAttribute('aria-expanded', String(!panel.hidden));
    custom.innerHTML = '<span>+</span>';
    docRow.append(custom);

    if (hasEyeDropper) {
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'cp-swatch cp-eyedropper';
      drop.dataset.action = 'eyedropper';
      drop.setAttribute('aria-label', 'Pick color from screen');
      drop.innerHTML = EYEDROPPER_ICON;
      docRow.append(drop);
    }

    // Document colors: what's in use, then recent picks.
    const used = [...new Set([get('fg'), get('bg'), ...recents].map((c) => c.toLowerCase()))];
    const room = ROW - docRow.children.length;
    for (const c of used.slice(0, room)) docRow.append(swatch(c));

    const brand = $('[data-role="brand"]');
    brand.innerHTML = '';
    for (const b of BRAND) brand.append(swatch(b.color, b.name));

    const defaults = $('[data-role="defaults"]');
    defaults.innerHTML = '';
    for (const c of DEFAULTS) defaults.append(swatch(c));
  }

  function renderPanel() {
    const color = current();
    sv.style.setProperty('--hue', `hsl(${hsv.h} 100% 50%)`);
    sv.style.setProperty('--color', color);
    hue.style.setProperty('--hue', `hsl(${hsv.h} 100% 50%)`);
    const svThumb = sv.querySelector('.cp-thumb');
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    hue.querySelector('.cp-thumb').style.left = `${(hsv.h / 360) * 100}%`;
    hexDot.style.background = color;
    if (document.activeElement !== hexInput) hexInput.value = color.toUpperCase();
  }

  function render() {
    for (const tab of root.querySelectorAll('.cp-tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.target === target));
    }
    renderSwatches();
    renderPanel();
  }

  // ---------- Interaction ----------

  root.addEventListener('click', (e) => {
    const tab = e.target.closest('.cp-tab');
    if (tab) {
      target = tab.dataset.target;
      syncHsv();
      render();
      return;
    }
    const btn = e.target.closest('[data-action], [data-color]');
    if (!btn) return;
    if (btn.dataset.color) apply(btn.dataset.color);
    else if (btn.dataset.action === 'toggle') {
      panel.hidden = !panel.hidden;
      render();
    } else if (btn.dataset.action === 'eyedropper') {
      new EyeDropper().open()
        .then((r) => apply(normalizeHex(r.sRGBHex), { commit: true }))
        .catch(() => {});
    }
  });

  function drag(el, update) {
    const move = (e) => {
      const r = el.getBoundingClientRect();
      update(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
      apply(hsvToHex(hsv), { fromPanel: true });
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      move(e);
      const up = () => {
        el.removeEventListener('pointermove', move);
        remember(current());
        render();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
    });
  }

  drag(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; });
  drag(hue, (x) => { hsv.h = x * 360; });

  // Arrow keys nudge the panel controls (Shift for bigger steps).
  function nudge(el, onKey) {
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.01;
      const dx = { ArrowLeft: -step, ArrowRight: step }[e.key] || 0;
      const dy = { ArrowUp: -step, ArrowDown: step }[e.key] || 0;
      if (!dx && !dy) return;
      e.preventDefault();
      onKey(dx, dy);
      apply(hsvToHex(hsv), { fromPanel: true });
    });
  }

  nudge(sv, (dx, dy) => { hsv.s = clamp01(hsv.s + dx); hsv.v = clamp01(hsv.v - dy); });
  nudge(hue, (dx) => { hsv.h = (hsv.h + dx * 360 + 360) % 360; });

  hexInput.addEventListener('input', () => {
    const hex = normalizeHex(hexInput.value);
    if (hex && hexInput.value.replace('#', '').length === 6) apply(hex);
  });
  hexInput.addEventListener('change', () => {
    const hex = normalizeHex(hexInput.value);
    if (hex) apply(hex, { commit: true });
    hexInput.value = current().toUpperCase();
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hexInput.blur();
  });
  hexInput.addEventListener('focus', () => hexInput.select());

  syncHsv();
  render();

  return {
    // Call after colors change outside the picker (e.g. Invert).
    refresh() {
      syncHsv();
      render();
    },
  };
}
