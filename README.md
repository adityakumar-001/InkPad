# InkPad — Digital Notepad

> Cache note: CSS/JS load with `?v=2`. After any edit, bump to `?v=3`
> (or hard-refresh Ctrl+Shift+R) or the browser may run old cached files.

A professional multi-page digital notepad: freehand handwriting (pen / pencil /
highlighter with pressure support), 2D + 3D-style shapes, area + box eraser,
undo/redo, zoom, image & PDF import with annotation, a standalone image
resizer, and local autosave with PDF / PNG / JSON export. No backend required.

## Project structure

```text
index.html
css/style.css
js/storage.js       IndexedDB persistence + settings + quota handling
js/history.js       per-page action-based undo/redo
js/canvas.js        document-space renderer (zoom-safe, high-DPI), shapes, hit-testing
js/tools.js         pointer interactions (draw / erase / shape drag / select-move-resize)
js/pages.js         page model + thumbnails
js/file-import.js   image / URL / JSON-backup import
js/pdf-handler.js   PDF import via PDF.js (pages become annotated backgrounds)
js/file-resizer.js  dedicated image resizer (independent from notebook zoom)
js/app.js           state, wiring, autosave, export (PDF-lib / PNG / JSON)
```

## Run on Windows 11 + VS Code

No build step, no npm packages. External libraries (PDF.js for rendering,
PDF-Lib for export) load from CDN, so the first load needs internet.

**Option A — VS Code Live Server (easiest)**

1. Open this folder in VS Code.
2. Install the *Live Server* extension (Ritwick Dey).
3. Right-click `index.html` → **Open with Live Server**.
4. Use the app at `http://127.0.0.1:5500/...`.

**Option B — Python (built into most systems)**

```powershell
cd "E:\Game\Note Pad"
python -m http.server 8000
# open http://localhost:8000/index.html
```

> `file://` also works for drawing, but ES module–free scripts + CDN still
> prefer `http://localhost`. IndexedDB works on `localhost`.

## External dependencies (CDN)

| Library | Version | Used for |
|---|---|---|
| `pdf.min.js` + worker (cdnjs) | PDF.js 3.11.174 | rendering imported PDF pages to page backgrounds |
| `pdf-lib.min.js` (cdnjs) | PDF-Lib 1.17.1 | exporting the annotated notebook as multi-page PDF |

If the CDN is unreachable you will get a clear error toast when using the
corresponding PDF feature; all drawing tools keep working offline.

## Feature checklist (all functional)

- Left toolbar holds 5 tools (pen / pencil / highlighter / eraser / select) plus
  one **Shapes** button showing the current shape. Selecting any tool opens a
  floating options popup (colors, thickness, opacity, shape grid…); clicking the
  canvas closes it. Right panel is pages-only.
- Canvas floats (base 28px): drawing tools, [‹] [+] [›] [☰ + live count], ⚙
  Settings, and the tool-options popup all live **inside the white page**
  (10px margins) and **scale with zoom** — 200% zoom = double-size buttons,
  fixed to the page. No side panels.
- One floating **⚙ Settings** button (white page, right-bottom, 10px margin)
  holds everything: Import (image / PDF / link / backup), Export (PDF / PNG /
  JSON), Page size (Portrait A4 794×1123, Landscape 16:9 1123×632), and
  local-storage settings.
- Bottom-left cluster **[‹] [+] [›] [☰ + live count]**: prev/next navigation, +
  adds a new page, hamburger opens the thumbnails popup upward.
- Pages popup keeps only 3 features: **☑ All** (select all), **🗑 Sel** (delete
  ticked — single, several, or all), and **per-page checkboxes** for custom
  selection. Deleting all pages auto-creates a fresh blank page (confirmed).
- Size button opens a 2-option dialog: **Portrait = A4 (794×1123)**,
  **Landscape = 16:9 (1123×632)**, applied to the current page.
- Pen tool merged into pencil (same features): pencil button + style dropdown
  covers normal pen, grainy pencil and highlighter strokes.
- Page size per page (default A4 794×1123): imported PDFs auto-match their page
  shape (up to 100 pages); Settings dialog switches Portrait A4 / Landscape 16:9.

- Pen / pencil / highlighter: thickness slider + min/max (max 15), presets + custom
  color, opacity, live stroke preview, pressure-sensitive width, smoothing.
- Shapes: line, arrow, rect, rounded rect, circle, ellipse, triangle, polygon,
  star, freeform (click points, double-click/Enter to finish) + 3D-style cube,
  cuboid, cylinder, cone, sphere, pyramid (shaded canvas paths — stylised 3D,
  not a 3D engine). Outline/fill/width/opacity configurable, drag-preview.
- Highlighter auto-covers text: band height = stroke extent + padding, so marked
  lines are covered top-to-bottom with round-cap overhang at both ends.
- Import/Export menus stay closed until clicked (CSS `[hidden]` fix).
- Select tool: click to select, drag to move, corner + edge handles to resize.
  Selection box par mini actions: duplicate icon, cross (delete), color-plate
  dots (strokes/shapes recolor, undo supported). No popup — sab box par hai.
  Delete key bhi chalta hai.
- Eraser (unique red button, fixed 35px size erase by default): drag mitata hai
  touched part (strokes split, shapes/images on touch); ▭ Selected-area toggle
  se dragged box ka area erase. Per-page only + confirmed clear-page.
- Pages: add / prev-next / thumbnail jump / delete (confirmed, never deletes
  the last page) / duplicate; content preserved across navigation; autosaved.
- Undo/redo: action-based per page (add / delete / update / clear), toolbar +
  `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`, buttons disable correctly.
- Height locked to viewport (100vh): page display height always equals the
  screen height on load, resize, fullscreen change, page switch and size
  change. Mouse-wheel zoom removed (`Ctrl+wheel` is blocked, no zoom).
  Keyboard `Ctrl + / - / 0` zoom still works (manual zoom turns auto-fit off
  until next resize). Drawing coordinates are document-space, so zoom never
  changes artwork size.
- Import: JPG/PNG/WebP with preview + centered insert + aspect fit; PDF
  (first 30 pages, each becomes an annotatable page background); URL import
  with CORS-safe error messages; JSON backup restore. Large files show
  progress/toasts and never freeze the UI (async + yields).
- Resizer modal: width/height px, aspect lock, 25/50/75/100% presets,
  Portrait/Landscape orientation buttons (auto-swap W/H), inline URL loading
  (no popups), PNG (transparency-safe) / JPEG + quality / WebP, before-after preview,
  8000px + 32MP guards, prominent **Save to computer** / Insert-into-page buttons.
  Fully separate from zoom.
- Pages import in A-Z order; imported PDFs always start at notebook page 1
  (fresh blank page is reused, otherwise the block is inserted at the front and
  existing pages shift after — nothing deleted); a **⇅ Order** button reverses
  page order anytime (fixes previously reversed imports too). Import/Export menus close on selection.
- Resizer Portrait/Landscape buttons also auto-set the notebook page size to the
  image's aspect (A4 → A4, 16:9 → 1123×632).
- Save/export: IndexedDB autosave (+ `Ctrl+S`), title persisted, reload
  restores; multi-page PDF export (backgrounds + annotations aligned);
  current-page PNG; JSON backup/restore; quota errors explained; wipe asks
  first and warns storage is local-only, not cloud.
- Shortcuts: `Ctrl+Z/Y/S`, `Ctrl + - = 0`, `←/→` page nav (in Select tool),
  `P/N/H/E/V` tools, `Del` removes selection, `Esc` closes dialogs / cancels
  freeform. Shortcuts ignored while typing.
- Accessibility: tooltips + aria-labels on all controls, `aria-pressed`
  tool state (not color-only), focus rings, live regions, keyboard-operable
  menus/dialogs, contrast-checked themes.

## Manual test pass (do before calling it done)

1. Change pen color/width → draw → visible change. Pencil grainy, highlighter
   translucent wide.
2. Draw every shape incl. all six 3D styles → fill/outline correct.
3. Eraser Area mode erases only the touched part (stroke splits); Box mode erases
   the dragged selected area; other pages intact.
4. Add 3 pages, draw differently, navigate + thumbnails jump preserves art.
5. Delete middle page (confirm) → sensible page selected; last page undeletable.
6. Undo/redo stroke, shape, erase, move — buttons enable/disable correctly.
7. Zoom 25%→300% → strokes stay aligned with cursor; % label + fit + reset ok.
8. Import JPG/PNG/WebP → preview → insert → Select to move/resize.
9. Import PDF → pages appear → annotate → export PDF contains annotations.
10. URL import of bad/CORS-blocked link → clear error, no hang.
11. Reload browser → notebook restored. Export PNG/JSON contain content.
12. Resizer: 50% preset → apply → before/after differ → download works.
13. Resize window / mobile width → panels collapse, canvas usable.
14. DevTools console → no errors during the above.
