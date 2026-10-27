# Nexus Type

A browser tool for hybrid letterforms: elegant italic and script fonts with
parts of the strokes swapped for stair-stepped pixel blocks. Paint pixels onto
letters, animate them, and export PNG, SVG or GIF.

## Run it

```bash
sh start.sh
```

This serves the app at http://localhost:5173 and opens it in your browser.
It uses the Ruby that ships with macOS, so there's nothing to install.
(Set `PORT=8080 sh start.sh` to use another port.)

## How it's built

Plain HTML, CSS and JavaScript modules — no build step.

| File | What it does |
| --- | --- |
| `js/app.js` | App state, text boxes, sidebar, canvas interaction, animation, export wiring |
| `js/layout.js` | Lays out text as real glyph outlines (per-letter fonts, italic, underline, warps, boil) |
| `js/pixels.js` | Pixel brush: strokes → coverage masks → pixel cells (weight, shapes, reveal) |
| `js/renderer.js` | Draws the canvas: artwork, bleed, caret, selection, brush cursor |
| `js/timeline.js` | Keyframe model and the timeline track |
| `js/export.js` | PNG (with DPI), merged-path SVG (paper.js), GIF (gif.js) |
| `js/fonts.js` | Font registry (47 Google Fonts in `fonts/`, plus uploads) |
| `js/colorpicker.js` | Canva-style color picker with TEDxUTAustin brand colors |
| `vendor/` | opentype.js, paper.js, gif.js |
| `server.rb` | Tiny no-cache static server |

## Shortcuts

| Key | Action |
| --- | --- |
| T / B / E | Text tool / pixel brush / eraser |
| Shift (hold) | Erase while brushing |
| [ / ] | Brush smaller / larger |
| ⌘Z / ⇧⌘Z | Undo / redo pixels |
| Space | Play / pause |
| K | Add or update keyframe |
| Delete | Delete selected text box |
| Arrows | Nudge selected text box (Shift = 10×) |
| Esc | Stop typing / deselect |

Fonts are from Google Fonts under the SIL Open Font License / Apache 2.0.
