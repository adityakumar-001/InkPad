/* app.js — InkPad state, wiring, persistence, export */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const { Canvas, Pages, Storage } = window.InkPad;
  const $ = (id) => document.getElementById(id);

  const MIN_ZOOM = 0.25, MAX_ZOOM = 3;
  // Window version (installed Electron app) me mouse-wheel zoom blocked hai.
  const IS_ELECTRON = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent || '');
  const PRESETS = ['#ffffff', '#1a1a1a', '#c81e1e', '#1a56db', '#047857', '#b7791f', '#7c3aed', '#db2777', '#0e7490'];
  const PAGE_BG_PRESETS = ['#ffffff', '#fefce8', '#fef3c7', '#eff6ff', '#f0fdf4', '#fdf2f8', '#f3f4f6', '#1f2937', '#000000'];

  const state = {
    title: 'My Notebook',
    pages: [], currentIndex: 0, selectedPages: new Set(),
    tool: 'pencil', lastShape: 'shape-rect', zoom: 1,
    pencil: { color: '#1a1a1a', width: 4, min: 1, max: 15, opacity: 100 },
    highlighter: { color: '#facc15', width: 10, min: 1, max: 15, opacity: 100 },
    shape: { stroke: '#1a56db', fill: '#bfdbfe', fillOn: true, lineWidth: 3, opacity: 100 },
    eraser: { size: 40, mode: 'area' },
    paper: 'blank', paperBg: '#ffffff', autosave: true, theme: 'light'
  };
  // Pencil aur Mark (highlighter) ke settings ab alag-alag hain —
  // jo tool active hai, pen popup wahi dikhata/badalta hai.
  function activePen() { return state.tool === 'highlighter' ? state.highlighter : state.pencil; }
  let history = new window.InkPad.History();
  let toolsApi = null, fileImportApi = null, resizerApi = null;
  let saveTimer = null, thumbTimer = null;
  let confirmResolve = null;
  // File-save tracking: koi bhi badlav → true; kamyab export (PDF/PNG) → false.
  // Exit gate isi par chalta hai (bina-save exit block).
  let needFileSave = false, exitAfterSave = false, allowExit = false;

  const main = $('main-canvas'), overlay = $('overlay-canvas');

  /* ═════════ helpers ═════════ */
  function toast(msg, kind) {
    const w = $('toast-wrap');
    const d = document.createElement('div');
    d.className = 'toast' + (kind === 'err' ? ' err' : '');
    d.textContent = msg;
    w.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 300); }, kind === 'err' ? 5200 : 3200);
  }
  function openModal(m) {
    closeModals(true);
    $('modal-backdrop').hidden = false;
    m.hidden = false;
  }
  function closeModals(keepBackdrop) {
    document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
    if (!keepBackdrop) $('modal-backdrop').hidden = true;
  }
  function confirmDlg(title, text, okLabel = 'Delete') {
    $('mc-title').textContent = title;
    $('mc-text').textContent = text;
    $('mc-ok').textContent = okLabel;
    openModal($('modal-confirm'));
    return new Promise((res) => { confirmResolve = res; });
  }

  const getPage = () => state.pages[state.currentIndex] || null;
  const getTool = () => state.tool;
  const getZoom = () => state.zoom;

  function markDirty() {
    needFileSave = true; // file ab saved nahi rahi (export par false hoga)
    $('save-state').textContent = '○ unsaved…';
    $('save-state').classList.add('dirty');
    if (!state.autosave) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 800);
  }
  async function saveNow() {
    if (!state.autosave) { $('save-state').textContent = '○ autosave off'; return; }
    const doc = {
      app: 'inkpad', version: 1, title: state.title,
      paper: state.paper, paperBg: state.paperBg, updatedAt: Date.now(),
      pages: state.pages.map(({ _thumb, ...p }) => p)
    };
    const r = await Storage.saveNotebook(doc);
    if (r.ok) { $('save-state').textContent = '● saved'; $('save-state').classList.remove('dirty'); }
    else { $('save-state').textContent = '○ save failed'; toast(r.error, 'err'); }
  }

  /* ═════════ render ═════════ */
  function applyThemeUI() {
    const dark = state.theme === 'dark';
    document.documentElement.dataset.theme = state.theme;
    const chk = $('set-theme');
    if (chk) chk.checked = dark;
  }
  function applyPaperBgVar() {
    document.documentElement.style.setProperty('--paper', state.paperBg || '#ffffff');
  }
  function rerender() {
    const pg = getPage();
    applyPaperBgVar();
    Canvas.render(main, overlay, pg || { objects: [] }, { zoom: state.zoom, paperStyle: state.paper, paperBg: state.paperBg });
    // FIX-1: UI ko canvas zoom se alag rakho — hamesha 1x taaki inputs clickable rahen.
    // Pehle fb.style.zoom / tp.style.zoom se popup tiny + hit-area kharab ho jati thi.
    const fb = $('float-bar'), tp = $('tool-popup');
    if (fb) fb.style.zoom = '1';
    if (tp) tp.style.zoom = '1';
    drawSelectionOverlay();
    updateHistoryButtons();
    updateIndicator();
    scheduleThumbs();
  }
  function rerenderOverlay() { drawSelectionOverlay(); }
  function drawSelectionOverlay() {
    const z = state.zoom, dpr = Math.min(window.devicePixelRatio || 1, 3);
    const octx = overlay.getContext('2d');
    octx.save();
    octx.setTransform(z * dpr, 0, 0, z * dpr, 0, 0);
    const { w: PW, h: PH } = getPageSize();
    octx.clearRect(0, 0, PW, PH);
    const sel = toolsApi && toolsApi.getSelected();
    if (sel && state.tool === 'select') {
      const pg = getPage();
      const o = pg && pg.objects.find(x => x.id === sel);
      if (o) Canvas.drawSelection(octx, o);
    }
    octx.restore();
  }
  function updateIndicator() {
    $('pages-count').textContent = (state.pages.length ? state.currentIndex + 1 : 0) + '/' + state.pages.length;
    document.querySelectorAll('[data-nav="prev"]').forEach(b => { b.disabled = state.currentIndex <= 0; });
    document.querySelectorAll('[data-nav="next"]').forEach(b => { b.disabled = state.currentIndex >= state.pages.length - 1; });
    const zl = $('btn-zoom-label'), sz = $('status-zoom');
    const pct = Math.round(state.zoom * 100) + '%';
    if (zl) zl.textContent = pct;
    if (sz) sz.textContent = 'Zoom ' + pct;
    const n = [...state.selectedPages].filter(id => state.pages.some(p => p.id === id)).length;
    const ds = $('btn-del-selected');
    if (ds) { ds.textContent = n ? `🗑 Sel (${n})` : '🗑 Sel'; ds.disabled = !n; }
  }
  function updateHistoryButtons() {
    const pg = getPage();
    const id = pg && pg.id;
    $('btn-undo').disabled = !(id && history.canUndo(id));
    $('btn-redo').disabled = !(id && history.canRedo(id));
  }
  function paintThumbs() {
    Pages.renderThumbs($('thumbs'), state.pages, state.currentIndex,
      (i) => gotoPage(i), state.selectedPages, onTogglePageSel);
    updateIndicator();
  }
  function onTogglePageSel(id, checked) {
    if (checked) state.selectedPages.add(id);
    else state.selectedPages.delete(id);
    updateIndicator();
  }
  function scheduleThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      // snapshot current page from live canvas (includes images + pdf bg)
      try {
        const pg = getPage();
        if (pg) {
          const { w: PW, h: PH } = Canvas.pageSizeOf(pg);
          const t = document.createElement('canvas');
          if (PW >= PH) { t.width = 74; t.height = Math.max(8, Math.round(74 * PH / PW)); }
          else { t.height = 74; t.width = Math.max(8, Math.round(74 * PW / PH)); }
          t.getContext('2d').drawImage(main, 0, 0, t.width, t.height);
          pg._thumb = t.toDataURL();
        }
      } catch {}
      paintThumbs();
    }, 250);
  }
  function afterChange(skipThumb) {
    drawSelectionOverlaySafe();
    updateHistoryButtons();
    updateIndicator();
    markDirty();
    // re-render fully (objects changed) unless caller already did
    rerender();
    void skipThumb;
  }
  function drawSelectionOverlaySafe() { try { drawSelectionOverlay(); } catch {} }

  function gotoPage(i) {
    if (i < 0 || i >= state.pages.length) return;
    toolsApi.clearTransient();
    toolsApi.setSelected(null);
    state.currentIndex = i;
    $('pages-popup').hidden = true;
    rerender();
  }

  /* ═════════ tools / popup ═════════ */
  const SHAPE_GLYPHS = {
    'shape-line': '╱', 'shape-arrow': '→', 'shape-rect': '▭', 'shape-roundrect': '▢',
    'shape-circle': '○', 'shape-ellipse': '⬭', 'shape-triangle': '△', 'shape-polygon': '⬡',
    'shape-star': '★', 'shape-freeform': '〰', 'shape-cube': '⬢', 'shape-cuboid': '▤',
    'shape-cylinder': '🛢', 'shape-cone': '🔻', 'shape-sphere': '●', 'shape-pyramid': '▲'
  };
  const isShapeTool = (t) => typeof t === 'string' && t.startsWith('shape-');
  function openToolPopup() { $('tool-popup').hidden = false; }
  function closeToolPopup() { $('tool-popup').hidden = true; }
  function toggleToolPopup() {
    // Eraser/Select ka koi options popup nahi — actions selection-box par hain.
    if (state.tool === 'eraser' || state.tool === 'select') { $('tool-popup').hidden = true; return; }
    $('tool-popup').hidden = !$('tool-popup').hidden;
  }
  function popupTitleFor(t) {
    if (t === 'pencil') return 'Pencil options';
    if (t === 'highlighter') return 'Mark options';
    if (isShapeTool(t)) return 'Shapes';
    if (t === 'eraser') return 'Eraser options';
    return 'Select options';
  }
  function setTool(t, opts = {}) {
    state.tool = t;
    if (isShapeTool(t)) state.lastShape = t;
    toolsApi.clearTransient();
    document.querySelectorAll('#float-toolbar .tool[data-tool]').forEach(b => {
      const on = b.dataset.tool === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const shapeOn = isShapeTool(t);
    $('btn-shapes').classList.toggle('active', shapeOn);
    $('btn-shapes').setAttribute('aria-pressed', shapeOn ? 'true' : 'false');
    if (shapeOn) $('shapes-glyph').textContent = SHAPE_GLYPHS[t] || '▭';
    document.querySelectorAll('#tool-popup .shape-btn[data-tool]').forEach(b => {
      const on = b.dataset.tool === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    toolsApi.setHint(t);
    $('popup-title').textContent = popupTitleFor(t);
    // Popup me sirf active tool ke features — pehle sab hide, phir sirf apna show.
    // (Kisi tool me dusre tool ka option kabhi nahi dikhega.)
    ['popup-shapes', 'props-pen', 'props-shape'].forEach(id => { $(id).hidden = true; });
    if (shapeOn) { $('popup-shapes').hidden = false; $('props-shape').hidden = false; }
    else if (t === 'pencil' || t === 'highlighter') $('props-pen').hidden = false;
    // Select/Eraser ka koi popup block nahi — actions selection-box / tool par hain.
    // Eraser ka koi popup block nahi — sirf eraser tool (koi option nahi).
    // Pencil/Mark alag-alag settings rakhte hain — tool badalne par
    // popup active tool ki values se sync hota hai (koi force-default nahi).
    if (t === 'pencil' || t === 'highlighter') syncPenUI();
    drawStrokePreview();
    drawSelectionOverlay();
    // Eraser me koi option nahi — popup khulta hi nahi, sirf eraser milta hai (fixed 40px Area).
    // Eraser/Select me koi popup nahi — actions tool / selection-box par hain.
    if (t === 'eraser' || t === 'select') closeToolPopup();
    else if (opts.popup !== false) openToolPopup();
  }
  function setSelected(id) {
    toolsApi.setSelected(id);
    drawSelectionOverlay();
  }
  function deleteObjects(ids) {
    const pg = getPage();
    if (!pg) return;
    const set = new Set(ids);
    const removed = pg.objects.filter(o => set.has(o.id)).map(window.InkPad.clone);
    if (!removed.length) return;
    pg.objects = pg.objects.filter(o => !set.has(o.id));
    history.push(pg.id, { kind: 'delete', objects: removed });
    afterChange();
    toast(`Deleted ${removed.length} object(s). Undo (Ctrl+Z) to restore.`);
  }
  // Selected object ka color badlo (canvas selection-box palette se bhi yahi chalta hai).
  // Returns true agar recolor hua (undo supported).
  function recolorObject(id, col) {
    const pg = getPage();
    const o = pg && id && pg.objects.find(x => x.id === id);
    if (!o) { toast('Nothing selected.'); return false; }
    if (o.type !== 'stroke' && o.type !== 'shape') { toast('Images cannot be recolored.'); return false; }
    const before = window.InkPad.clone(o);
    if (o.type === 'stroke') o.color = col;
    else o.stroke = col;
    history.push(pg.id, { kind: 'update', before: [before], after: [window.InkPad.clone(o)] });
    afterChange();
    return true;
  }
  // Selected object ka duplicate (canvas box icon se bhi yahi chalta hai).
  function duplicateObject(id) {
    const pg = getPage();
    const o = pg && pg.objects.find(x => x.id === id);
    if (!o) { toast('Nothing selected.'); return false; }
    const copy = window.InkPad.clone(o);
    copy.id = window.InkPad.uid(o.type[0]);
    if (copy.type === 'stroke') copy.points = copy.points.map(p => ({ x: p.x + 18, y: p.y + 18, p: p.p }));
    else if (copy.type === 'image') { copy.x += 18; copy.y += 18; }
    else { copy.x1 += 18; copy.x2 += 18; copy.y1 += 18; copy.y2 += 18; if (copy.points) copy.points = copy.points.map(p => ({ x: p.x + 18, y: p.y + 18 })); }
    pg.objects.push(copy);
    history.push(pg.id, { kind: 'add', objects: [window.InkPad.clone(copy)] });
    toolsApi.setSelected(copy.id);
    afterChange();
    return true;
  }

  // Pen popup ke inputs ko active tool (pencil/highlighter) ki values se bharta hai.
  function syncPenUI() {
    const p = activePen();
    $('prop-color').value = p.color;
    $('prop-width').value = p.width;
    $('prop-width-val').textContent = p.width + ' px';
    $('prop-min').value = p.min;
    $('prop-max').value = p.max;
    $('prop-opacity').value = p.opacity;
    $('prop-opacity-val').textContent = p.opacity + '%';
    $('color-presets').querySelectorAll('.swatch').forEach(x => {
      x.setAttribute('aria-pressed', x.title.toLowerCase() === p.color.toLowerCase() ? 'true' : 'false');
    });
  }

  function drawStrokePreview() {
    const c = $('stroke-preview');
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const ap = activePen();
    const demo = {
      id: 'demo', type: 'stroke', color: ap.color,
      width: Math.max(ap.min, Math.min(ap.max, ap.width)),
      opacity: ap.opacity, style: state.tool === 'highlighter' ? 'highlighter' : 'pencil',
      points: Array.from({ length: 24 }, (_, i) => ({
        x: 12 + i * 8, y: 26 + Math.sin(i / 3) * 9, p: 0.5 + 0.4 * Math.sin(i / 4)
      }))
    };
    g.save(); g.translate(0, 0);
    Canvas.drawStroke(g, demo);
    g.restore();
  }

  function bindProps() {
    const cp = $('color-presets');
    cp.innerHTML = '';
    for (const col of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch'; b.style.background = col;
      b.title = col; b.setAttribute('aria-label', 'Color ' + col);
      b.setAttribute('aria-pressed', activePen().color === col ? 'true' : 'false');
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        activePen().color = col; $('prop-color').value = col;
        cp.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        drawStrokePreview(); markDirty();
      });
      cp.appendChild(b);
    }
    const onColor = (e) => {
      e.stopPropagation();
      activePen().color = e.target.value; drawStrokePreview();
      cp.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', 'false'));
    };
    $('prop-color').addEventListener('input', onColor);
    $('prop-color').addEventListener('change', onColor);
    const onWidth = (e) => {
      e.stopPropagation();
      activePen().width = Number(e.target.value);
      $('prop-width-val').textContent = activePen().width + ' px';
      drawStrokePreview();
    };
    $('prop-width').addEventListener('input', onWidth);
    $('prop-width').addEventListener('change', onWidth);
    $('prop-min').addEventListener('change', (e) => {
      const ap = activePen();
      ap.min = Math.max(1, Math.min(15, Number(e.target.value) || 1));
      if (ap.min > ap.max) ap.max = ap.min;
      ap.width = Math.max(ap.min, Math.min(ap.max, ap.width));
      $('prop-width').value = ap.width;
      $('prop-width-val').textContent = ap.width + ' px';
    });
    $('prop-max').addEventListener('change', (e) => {
      const ap = activePen();
      ap.max = Math.max(1, Math.min(15, Number(e.target.value) || 15));
      if (ap.min > ap.max) ap.min = ap.max;
      ap.width = Math.max(ap.min, Math.min(ap.max, ap.width));
      $('prop-width').value = ap.width;
      $('prop-width-val').textContent = ap.width + ' px';
    });
    const onOpacity = (e) => {
      e.stopPropagation();
      activePen().opacity = Number(e.target.value);
      $('prop-opacity-val').textContent = activePen().opacity + '%';
      drawStrokePreview();
    };
    $('prop-opacity').addEventListener('input', onOpacity);
    $('prop-opacity').addEventListener('change', onOpacity);

    $('shape-stroke').addEventListener('input', (e) => { state.shape.stroke = e.target.value; });
    $('shape-fill').addEventListener('input', (e) => { state.shape.fill = e.target.value; });
    $('shape-fill-on').addEventListener('change', (e) => { state.shape.fillOn = e.target.checked; });
    $('shape-width').addEventListener('input', (e) => {
      state.shape.lineWidth = Number(e.target.value);
      $('shape-width-val').textContent = state.shape.lineWidth + ' px';
    });
    $('shape-opacity').addEventListener('input', (e) => {
      state.shape.opacity = Number(e.target.value);
      $('shape-opacity-val').textContent = state.shape.opacity + '%';
    });
  }

  /* ═════════ pages ops ═════════ */
  function addBlankPage(select = true) {
    const pg = Pages.blankPage();
    const cur = getPage();
    if (cur) pg.size = { ...Canvas.pageSizeOf(cur) }; // naya page current jaisa (full-screen barkarar)
    state.pages.splice(state.currentIndex + 1, 0, pg);
    if (select) state.currentIndex++;
    afterChange();
    toast(`Page ${state.currentIndex + 1} added.`);
  }
  function addPageWithBackground(bg, select = true) {
    const pg = Pages.blankPage();
    pg.background = bg;
    state.pages.splice(state.currentIndex + 1, 0, pg);
    if (select) state.currentIndex = state.pages.indexOf(pg);
    afterChange();
  }
  /** Fresh page bilkul screen-size ka (100vh height + full width, bina stretch) —
   *  taaki height kabhi viewport se bahar na jaye. Purane saved pages ko haath nahi lagata. */
  function viewportPageSize() {
    const sc = $('canvas-scroll');
    const w = (sc && sc.clientWidth) || window.innerWidth || 794;
    const h = (sc && sc.clientHeight) || window.innerHeight || 1123;
    return Canvas.normSize({ w, h });
  }
  // Height hamesha 100vh: har plain page (bina PDF/image background) screen-size
  // ka rakhta hai — resize/fullscreen par bhi. Content delete nahi hota, sirf bounds.
  function fitAllToViewport() {
    const vs = viewportPageSize();
    state.pages.forEach((pg) => { if (!pg.background) pg.size = { ...vs }; });
  }
  function getPageSize() { return Canvas.pageSizeOf(getPage()); }
  /** Resize the current page only (content is kept, may fall outside view). */
  function setPageSize(w, h) {
    const pg = getPage();
    if (!pg) return;
    pg.size = Canvas.normSize({ w, h });
    toolsApi.setSelected(null);
    afterChange();
    markDirty();
    toast(`Page ${state.currentIndex + 1} size → ${pg.size.w}×${pg.size.h}. Content kept.`);
  }
  /** Page background color — white area (paper) ka color, canvas + export me bhi lagta hai. */
  function setPaperBg(color, opts = {}) {
    state.paperBg = color || '#ffffff';
    const inp = $('set-pagebg');
    if (inp) inp.value = state.paperBg;
    const wrap = $('pagebg-presets');
    if (wrap) wrap.querySelectorAll('.swatch').forEach(x => {
      const c = (x.dataset.color || '').toLowerCase();
      x.setAttribute('aria-pressed', c === state.paperBg.toLowerCase() ? 'true' : 'false');
    });
    Storage.saveSettings({ ...Storage.loadSettings(), paperBg: state.paperBg });
    if (!opts.silent) { rerender(); markDirty(); saveNow(); }
    else applyPaperBgVar();
  }
  /** Insert imported PDF pages as a block starting at notebook page 1.
   *  Fresh single-blank-page notebook → reuse it for PDF p.1 (with its size).
   *  Otherwise insert at index 0 and shift existing pages after (nothing deleted). */
  function insertPdfPages(list) {
    if (!list.length) return;
    const fresh = state.pages.length === 1 &&
      state.pages[0].objects.length === 0 && !state.pages[0].background;
    const mk = (bg) => ({ ...Pages.blankPage(), background: bg, size: Canvas.normSize(bg.size) });
    if (fresh) {
      state.pages[0].background = list[0];
      state.pages[0].size = Canvas.normSize(list[0].size);
      state.pages.splice(1, 0, ...list.slice(1).map(mk));
    } else {
      state.pages.splice(0, 0, ...list.map(mk));
    }
    state.currentIndex = 0;
    toolsApi.setSelected(null);
    afterChange();
  }
  async function deleteSelectedPages() {
    const ids = [...state.selectedPages].filter(id => state.pages.some(p => p.id === id));
    if (!ids.length) return toast('No pages ticked. Tick checkboxes in the page list.');
    const wipeAll = ids.length >= state.pages.length;
    const ok = await confirmDlg('Delete pages?',
      wipeAll ? `Delete all ${ids.length} page(s)? A new blank page will be created automatically.`
              : `Delete ${ids.length} selected page(s)? This cannot be undone.`);
    if (!ok) return;
    if (wipeAll) {
      state.pages.forEach(p => history.dropPage(p.id));
      state.pages = [Pages.blankPage()];
      state.currentIndex = 0;
      state.selectedPages.clear();
      toolsApi.setSelected(null);
      afterChange();
      toast('All pages deleted. New blank page created.');
      return;
    }
    const curId = getPage() && getPage().id;
    state.pages = state.pages.filter(p => !ids.includes(p.id));
    ids.forEach(id => { history.dropPage(id); state.selectedPages.delete(id); });
    state.currentIndex = state.pages.some(p => p.id === curId)
      ? state.pages.findIndex(p => p.id === curId)
      : Math.min(state.currentIndex, state.pages.length - 1);
    toolsApi.setSelected(null);
    afterChange();
    toast(`${ids.length} page(s) deleted.`);
  }
  async function clearCurrentPage() {
    const pg = getPage();
    if (!pg || (!pg.objects.length && !pg.background)) return toast('Page is already empty.');
    const ok = await confirmDlg('Clear page?', 'Remove all content from the current page? (Undo can restore it.)', 'Clear page');
    if (!ok) return;
    const before = pg.objects.map(window.InkPad.clone);
    const hadBg = pg.background;
    pg.objects = [];
    pg.background = null;
    history.push(pg.id, { kind: 'clear', before, bg: window.InkPad.clone(hadBg) });
    void hadBg;
    toolsApi.setSelected(null);
    afterChange();
    toast('Page cleared. Undo (Ctrl+Z) to restore.');
  }

  /* ═════════ zoom ═════════ */
  let autoFit = true; // FIX-2: hamesha device ke hisab se fit raho
  // Select tool me koi image selected ho to use center se scale karta hai (undo supported).
  // Image selected nahi hai to false (caller phir page zoom karta hai).
  function scaleSelectedImage(factor) {
    if (!toolsApi || state.tool !== 'select') return false;
    const pg = getPage();
    const id = toolsApi.getSelected();
    const o = pg && id && pg.objects.find(x => x.id === id && x.type === 'image');
    if (!o) return false;
    const before = window.InkPad.clone(o);
    const nw = Math.max(8, Math.round(o.w * factor));
    const nh = Math.max(8, Math.round(o.h * factor));
    o.x = Math.round(o.x - (nw - o.w) / 2);
    o.y = Math.round(o.y - (nh - o.h) / 2);
    o.w = nw; o.h = nh;
    history.push(pg.id, { kind: 'update', before: [before], after: [window.InkPad.clone(o)] });
    afterChange();
    return true;
  }
  function setZoom(z, opts = {}) {
    state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
    if (opts.autoFit !== undefined) autoFit = opts.autoFit;
    else if (!opts.fromFit) autoFit = false; // manual zoom => auto-fit off
    rerender();
  }
  function fitZoom() {
    const sc = $('canvas-scroll');
    const { w: PW, h: PH } = getPageSize();
    if (!sc || !PW || !PH) return;
    // working area 100% hai (padding 0) — cover-fit: left+right+top+bottom
    // poora screen use ho, koi axis khali na rahe (bina stretch, aspect same).
    const availW = Math.max(50, sc.clientWidth);
    const availH = Math.max(50, sc.clientHeight);
    const z = Math.max(availW / PW, availH / PH);
    autoFit = true;
    setZoom(z, { fromFit: true, autoFit: true });
  }

  /* ═════════ export (path picker + last-file auto-save) ═════════ */
  function download(url, name) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  // Pehli save par path chuna jata hai, uske baad usi file me auto-save (session).
  // Window + HTML dono me same API (Chromium File System Access), fallback: normal download.
  const lastHandle = { pdf: null, png: null };
  async function writeToHandle(handle, blob) {
    try {
      if (handle.queryPermission) {
        const q = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
        if (q !== 'granted') {
          const r = await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
          if (r !== 'granted') return false;
        }
      }
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch { return false; }
  }
  // Blob ko file me save karta hai: pehle last-file (auto), warna path picker.
  // Returns { ok, } — picker cancel par ok:false (koi error nahi).
  async function saveBlobAs(blob, suggestedName, mime, ext, format) {
    if (lastHandle[format]) {
      if (await writeToHandle(lastHandle[format], blob)) return { ok: true };
      lastHandle[format] = null; // permission gaya — dobara path poochho
    }
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: format.toUpperCase() + ' file', accept: { [mime]: [ext] } }]
        });
        if (await writeToHandle(handle, blob)) {
          lastHandle[format] = handle;
          return { ok: true };
        }
        return { ok: false };
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false }; // user ne cancel kiya
      }
    }
    const url = URL.createObjectURL(blob);
    download(url, suggestedName);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true };
  }
  function exportPNG(fileName) {
    const pg = getPage();
    if (!pg) return Promise.resolve(false);
    const base = safeName(fileName || state.title);
    return new Promise((resolve) => {
      main.toBlob(async (blob) => {
        if (!blob) { toast('PNG export failed.', 'err'); resolve(false); return; }
        const res = await saveBlobAs(blob, `${base}-p${state.currentIndex + 1}.png`, 'image/png', '.png', 'png');
        if (res.ok) toast('Current page exported as PNG.');
        resolve(res.ok);
      }, 'image/png');
    });
  }
  async function exportPageCanvas(pg, scale = 2) {
    // render page offscreen at higher resolution (keeps pdf/bg/annotations aligned)
    const { w: PW, h: PH } = Canvas.pageSizeOf(pg);
    const c = document.createElement('canvas');
    c.width = Math.round(PW * scale);
    c.height = Math.round(PH * scale);
    const g = c.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = state.paperBg || '#ffffff'; g.fillRect(0, 0, PW, PH);
    if (pg.background && pg.background.dataURL) {
      try {
        const img = await Canvas.loadImage(pg.background.dataURL);
        const k = Math.min(PW / img.naturalWidth, PH / img.naturalHeight);
        g.drawImage(img, (PW - img.naturalWidth * k) / 2, (PH - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
      } catch {}
    }
    for (const o of pg.objects) {
      if (o.type === 'stroke') Canvas.drawStroke(g, o);
      else if (o.type === 'shape') Canvas.drawShape(g, o);
      else if (o.type === 'image') {
        try { const img = await Canvas.loadImage(o.src); g.drawImage(img, o.x, o.y, o.w, o.h); }
        catch { g.fillStyle = '#e5e7eb'; g.fillRect(o.x, o.y, o.w, o.h); }
      }
    }
    return c;
  }
  async function renderPDFBytes() {
    if (!window.PDFLib) return null;
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle(state.title);
    for (const pg of state.pages) {
      const c = await exportPageCanvas(pg, 2);
      const bytes = await new Promise((res) => c.toBlob((b) => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result));
        r.readAsArrayBuffer(b);
      }, 'image/png'));
      const img = await doc.embedPng(bytes);
      const { w: PW, h: PH } = Canvas.pageSizeOf(pg);
      const H = 842, W = Math.round(H * PW / PH * 100) / 100; // keep page aspect (portrait/landscape/16:9)
      const page = doc.addPage([W, H]);
      page.drawImage(img, { x: 0, y: 0, width: W, height: H });
    }
    return doc.save();
  }
  async function exportPDF(fileName) {
    if (!window.PDFLib) { toast('PDF export engine (pdf-lib) failed to load. Check connection and reload.', 'err'); return false; }
    const base = safeName(fileName || state.title);
    toast('Building PDF…');
    try {
      const out = await renderPDFBytes();
      const blob = new Blob([out], { type: 'application/pdf' });
      const res = await saveBlobAs(blob, base + '.pdf', 'application/pdf', '.pdf', 'pdf');
      if (!res.ok) return false;
      toast(`Exported ${state.pages.length} page(s) as PDF.`);
      return true;
    } catch (e) {
      console.error(e);
      toast('PDF export failed: ' + (e.message || e), 'err');
      return false;
    }
  }
  // Bina dialog: last PDF file me seedha auto-save (Save button / exit flow).
  async function quickSavePDF() {
    if (!lastHandle.pdf) return false;
    try {
      const out = await renderPDFBytes();
      if (!out) return false;
      const ok = await writeToHandle(lastHandle.pdf, new Blob([out], { type: 'application/pdf' }));
      if (ok) toast(`Saved to ${lastHandle.pdf.name}.`);
      else lastHandle.pdf = null;
      return ok;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  function exportJSON() {
    const doc = {
      app: 'inkpad', version: 1, title: state.title, paper: state.paper, paperBg: state.paperBg,
      exportedAt: new Date().toISOString(),
      pages: state.pages.map(({ _thumb, ...p }) => p)
    };
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    download(url, safeName(state.title) + '-backup.json');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('JSON backup downloaded. Keep it safe — browser storage is not cloud backup.');
  }
  function restoreBackup(doc) {
    if (!doc || doc.app !== 'inkpad' || !Array.isArray(doc.pages) || !doc.pages.length) {
      toast('Backup invalid: expected an InkPad JSON file.', 'err');
      return;
    }
    confirmDlg('Restore backup?', `Replace the current notebook (${state.pages.length} page(s)) with the backup "${doc.title || 'untitled'}" (${doc.pages.length} page(s))?`)
      .then((ok) => {
        if (!ok) return;
        state.title = String(doc.title || 'Restored notebook').slice(0, 80);
        state.paper = doc.paper || state.paper;
        $('set-paper').value = state.paper;
        if (doc.paperBg) setPaperBg(doc.paperBg, { silent: true });
        state.pages = doc.pages.map((p) => ({ id: p.id || window.InkPad.uid('p'), objects: p.objects || [], background: p.background || null, size: Canvas.normSize(p.size) }));
        state.selectedPages.clear();
        state.currentIndex = 0;
        history = new window.InkPad.History();
        toolsApi.setSelected(null);
        rerender(); markDirty(); saveNow();
        toast('Backup restored.');
      });
  }
  function safeName(s) { return (s || 'notebook').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'notebook'; }

  /* ═════════ save with file name (default: date & time) ═════════ */
  let pendingSaveFormat = 'png';
  function defaultFileName() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  }
  function openSaveModal(format) {
    pendingSaveFormat = format === 'pdf' ? 'pdf' : 'png';
    $('save-filename').value = defaultFileName();
    $('save-confirm').textContent = pendingSaveFormat === 'pdf' ? '📕 Save PDF' : '🖼 Save PNG';
    openModal($('modal-save'));
    setTimeout(() => { $('save-filename').focus(); $('save-filename').select(); }, 50);
  }
  async function doSaveConfirm() {
    const raw = $('save-filename').value.trim();
    const name = safeName(raw || defaultFileName());
    state.title = name.slice(0, 80);
    markDirty(); saveNow();
    closeModals();
    const ok = pendingSaveFormat === 'pdf' ? await exportPDF(name) : await exportPNG(name);
    if (ok) {
      needFileSave = false;
      if (exitAfterSave) { exitAfterSave = false; doExit(); }
    } else exitAfterSave = false; // fail hua to ruko, exit mat karo
  }

  // Notebook bilkul khaali hai (koi drawing/image/background nahi)?
  function isBlankNotebook() {
    return state.pages.every((pg) => (!pg.objects || !pg.objects.length) && !pg.background);
  }
  // Exit gate: unsaved kaam ho to Save / Don't Save ka option, Cancel = ruko.
  function requestExit() {
    if (!needFileSave || isBlankNotebook()) { doExit(); return; }
    openModal($('modal-exit'));
  }
  function doExit() {
    exitAfterSave = false;
    if (IS_ELECTRON && typeof window.close === 'function') { allowExit = true; window.close(); }
  }

  /* ═════════ boot / events ═════════ */
  // Fullscreen hamesha-On (pre-On): jab bhi windowed ho, agli interaction/
  // visibility par turant wapas fullscreen. Fail silent (gesture rule).
  // Single-guarded entry: same press par double request se false
  // "Permissions check failed" error aata tha — fsBusy wahi rokta hai.
  let fsBusy = false;
  async function enterFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement || fsBusy) return true;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return false;
    fsBusy = true;
    try { await req.call(el); return true; }
    catch { return false; }
    finally { fsBusy = false; }
  }
  async function tryFullscreenAuto() {
    return enterFullscreen();
  }
  function autoFsTry() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    tryFullscreenAuto();
  }
  // Poller: gesture milte hi (pehli interaction ke 2s andar) fullscreen pakad leta hai,
  // chahe koi event-listener miss ho jaye. Success/exit par stop/start hota hai. Fail silent.
  let fsPoll = null;
  function startFsPoll() {
    if (fsPoll) return;
    fsPoll = setInterval(() => {
      if (document.fullscreenElement || document.webkitFullscreenElement) { stopFsPoll(); return; }
      tryFullscreenAuto();
    }, 2000);
  }
  function stopFsPoll() { if (fsPoll) { clearInterval(fsPoll); fsPoll = null; } }
  function bindTopbar() {
    $('btn-undo').addEventListener('click', doUndo);
    $('btn-redo').addEventListener('click', doRedo);
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    // Zoom buttons (bottom bar se hataye gaye — bache to guarded binding kaam karegi):
    // agar Select tool me koi image selected hai to image zoom hoti hai,
    // warna poore page ka zoom (image add hone ke baad bhi page zoom chalta hai).
    on('btn-zoom-in', () => {
      if (!scaleSelectedImage(1.15)) setZoom(state.zoom + 0.1);
    });
    on('btn-zoom-out', () => {
      if (!scaleSelectedImage(1 / 1.15)) setZoom(state.zoom - 0.1);
    });
    on('btn-zoom-label', () => setZoom(1));
    on('btn-zoom-fit', fitZoom);
    // Fullscreen button: browser me fullscreen toggle; window version (Electron,
    // jahan fullscreen automatic hai) me yehi EXIT button hai.
    if (IS_ELECTRON) {
      const xb = $('btn-fullscreen');
      if (xb) {
        xb.textContent = '⏻';
        xb.title = 'Exit app';
        xb.setAttribute('aria-label', 'Exit app');
        xb.setAttribute('aria-pressed', 'false');
        xb.addEventListener('click', requestExit);
      }
    } else {
      $('btn-fullscreen').addEventListener('click', async () => {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          try { await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen()); }
          catch (e) { toast('Fullscreen exit failed: ' + (e && e.message ? e.message : e), 'err'); }
          return;
        }
        if (fsBusy) return; // auto attempt chal rahi hai — double request par false error aata tha
        const ok = await enterFullscreen();
        if (!ok) toast('Fullscreen blocked: browser ne allow nahi kiya — Open-Fullscreen.bat se kholo.', 'err');
      });
    }
    // Fullscreen pre-On: har interaction + tab visible/load par try (hamesha-On).
    // Exit (Esc/button) ke baad bhi agli interaction par wapas fullscreen lag jata hai.
    ['pointerdown', 'pointerup', 'keydown', 'touchend', 'dblclick'].forEach(ev => window.addEventListener(ev, autoFsTry));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoFsTry(); });
    window.addEventListener('focus', autoFsTry);
    window.addEventListener('pageshow', autoFsTry);
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      if (!IS_ELECTRON) {
        const b = $('btn-fullscreen');
        if (b) { b.textContent = on ? '🗗' : '⛶'; b.setAttribute('aria-pressed', String(on)); }
      }
      if (on) stopFsPoll(); else startFsPoll();
      if (autoFit) { fitAllToViewport(); fitZoom(); } else rerender();
    });
    $('canvas-scroll').addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (IS_ELECTRON) return; // window version: mouse-wheel se zoom in/out blocked
      setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    // Import — ab center toolbar (📥) me hai, Settings me nahi.
    // Page list popup me Save / Save As hai (Export ka naya naam).
    on('imp-image', () => { $('import-popup').hidden = true; fileImportApi.pickImage(); });
    on('imp-pdf', () => { $('import-popup').hidden = true; $('file-pdf').click(); });
    on('imp-url', () => { $('import-popup').hidden = true; fileImportApi.openUrlModal(); });
    on('imp-json', () => { $('import-popup').hidden = true; $('file-json').click(); });
    on('btn-save', async () => {
      $('pages-popup').hidden = true;
      // Save = last file me seedha auto-save; pehli baar path+naam poochho (PDF default).
      if (lastHandle.pdf) {
        if (await quickSavePDF()) { needFileSave = false; return; }
      }
      openSaveModal('pdf');
    });
    on('btn-save-as', () => {
      const box = $('saveas-options');
      const open = box.hidden;
      box.hidden = !open;
      $('btn-save-as').setAttribute('aria-expanded', String(open));
    });
    on('saveas-png', () => { $('pages-popup').hidden = true; openSaveModal('png'); });
    on('saveas-pdf', () => { $('pages-popup').hidden = true; openSaveModal('pdf'); });
    $('save-confirm').addEventListener('click', doSaveConfirm);
    // Exit dialog: Save (last file ho to seedha, warna naam/path modal) / Don't save / Cancel
    on('exit-save', async () => {
      if (lastHandle.pdf && await quickSavePDF()) { needFileSave = false; closeModals(); doExit(); return; }
      exitAfterSave = true;
      openSaveModal('pdf');
    });
    on('exit-discard', () => { closeModals(); doExit(); });
    // Save modal Cancel = exit bhi cancel (bina-save exit block barkarar)
    document.querySelector('#modal-save [data-close]').addEventListener('click', () => { exitAfterSave = false; });
    $('file-pdf').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) await window.InkPad.PdfHandler.importPdfFile(api(), f);
    });

    $('btn-settings').addEventListener('click', async () => {
      openModal($('modal-settings'));
      resizerApi.refresh();
      const est = await Storage.usageEstimate();
      $('storage-info').textContent = est && est.quota
        ? `Local usage: ${(est.usage / 1048576).toFixed(1)} MB of ${(est.quota / 1048576).toFixed(0)} MB.`
        : 'Storage estimate unavailable in this browser.';
    });
  }

  function bindToolbar() {
    // main tools: select + open popup; clicking the active one toggles popup
    document.querySelectorAll('#float-toolbar .tool[data-tool]').forEach(b => {
      b.addEventListener('click', () => {
        const t = b.dataset.tool;
        if ($('import-popup')) $('import-popup').hidden = true;
        if (state.tool === t) toggleToolPopup();
        else setTool(t);
      });
    });
    // single shapes button: open grid popup (toggle if a shape is already active)
    $('btn-shapes').addEventListener('click', () => {
      if ($('import-popup')) $('import-popup').hidden = true;
      if (isShapeTool(state.tool)) toggleToolPopup();
      else setTool(state.lastShape || 'shape-rect');
    });
    // shape grid inside popup: switch shape, keep popup open for tweaking
    document.querySelectorAll('#tool-popup .shape-btn[data-tool]').forEach(b => {
      b.addEventListener('click', () => setTool(b.dataset.tool));
    });
    $('popup-close').addEventListener('click', (e) => { e.stopPropagation(); closeToolPopup(); });
    // FIX-1: popup ke andar koi bhi pointerdown canvas tak na pahuche —
    // warna slider drag / color click par popup close ya draw shuru ho jata tha.
    $('tool-popup').addEventListener('pointerdown', (e) => e.stopPropagation());
    $('tool-popup').addEventListener('click', (e) => e.stopPropagation());
    $('float-bar').addEventListener('pointerdown', (e) => e.stopPropagation());
    // clicking blank canvas closes the popup (clicks inside bar/popup are ignored)
    $('paper').addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#float-bar, #tool-popup')) return;
      closeToolPopup();
    });
    // pages button toggles the thumbnails popup
    $('btn-pages').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('pages-popup');
      pop.hidden = !pop.hidden;
      $('btn-pages').setAttribute('aria-expanded', String(!pop.hidden));
    });
    // import button toggles import popup (center toolbar)
    $('btn-import').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('import-popup');
      pop.hidden = !pop.hidden;
      $('btn-import').setAttribute('aria-expanded', String(!pop.hidden));
    });
    $('import-popup').addEventListener('click', (e) => e.stopPropagation());
    $('import-popup').addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      const pop = $('pages-popup');
      if (!pop.hidden && !e.target.closest('#float-pages')) pop.hidden = true;
      const ip = $('import-popup');
      if (ip && !ip.hidden && !e.target.closest('#float-toolbar, #import-popup')) ip.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('tool-popup').hidden) closeToolPopup();
    });
    $('btn-clear-page').addEventListener('click', clearCurrentPage);
    document.querySelectorAll('[data-nav]').forEach(b => {
      b.addEventListener('click', () => gotoPage(state.currentIndex + (b.dataset.nav === 'next' ? 1 : -1)));
    });
    $('btn-add-page').addEventListener('click', () => addBlankPage(true));
    $('btn-del-selected').addEventListener('click', deleteSelectedPages);
    $('btn-del-selected').addEventListener('click', deleteSelectedPages);
    $('btn-sel-all').addEventListener('click', () => {
      if (state.selectedPages.size >= state.pages.length) state.selectedPages.clear();
      else state.pages.forEach(p => state.selectedPages.add(p.id));
      paintThumbs();
    });
  }

  function bindModals() {
    $('modal-backdrop').addEventListener('click', () => {
      closeModals();
      if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
    });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModals()));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('modal-backdrop').hidden) {
        closeModals();
        if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
      }
    });
    $('mc-ok').addEventListener('click', () => { closeModals(); confirmResolve && confirmResolve(true); confirmResolve = null; });
    $('modal-confirm').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) { confirmResolve && confirmResolve(false); confirmResolve = null; }
    });
    $('set-autosave').addEventListener('change', (e) => {
      state.autosave = e.target.checked;
      Storage.saveSettings({ ...Storage.loadSettings(), autosave: state.autosave });
      if (state.autosave) saveNow();
    });
    $('set-theme').addEventListener('change', (e) => {
      state.theme = e.target.checked ? 'dark' : 'light';
      document.documentElement.dataset.theme = state.theme;
      Storage.saveSettings({ ...Storage.loadSettings(), theme: state.theme });
    });
    $('set-paper').addEventListener('change', (e) => { state.paper = e.target.value; rerender(); markDirty(); saveNow(); });
    // Page background color swatches (Settings me multiple options)
    buildPageBgSwatches();
    $('set-pagebg').addEventListener('input', (e) => { e.stopPropagation(); setPaperBg(e.target.value); });
    $('set-pagebg').addEventListener('change', (e) => { e.stopPropagation(); setPaperBg(e.target.value); });
    $('btn-wipe').addEventListener('click', async () => {
      const ok = await confirmDlg('Erase saved data?', 'Delete the locally saved notebook from this browser? Save a copy via Page list → Save / Save as first if you need it.', 'Erase');
      if (!ok) return;
      await Storage.clearNotebook();
      toast('Local saved data erased. Current session untouched until reload.');
    });
  }

  function buildPageBgSwatches() {
    const wrap = $('pagebg-presets');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const col of PAGE_BG_PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch'; b.style.background = col;
      b.dataset.color = col;
      b.title = col; b.setAttribute('aria-label', 'Page background ' + col);
      b.setAttribute('aria-pressed', state.paperBg.toLowerCase() === col.toLowerCase() ? 'true' : 'false');
      b.addEventListener('click', (e) => { e.stopPropagation(); setPaperBg(col); });
      wrap.appendChild(b);
    }
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); toast('Notebook saved locally.'); }
      else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(state.zoom + 0.1); }
      else if (mod && e.key === '-') { e.preventDefault(); setZoom(state.zoom - 0.1); }
      else if (mod && e.key === '0') { e.preventDefault(); setZoom(1); }
      else if (e.key === 'ArrowLeft' && state.tool === 'select') { e.preventDefault(); gotoPage(state.currentIndex - 1); }
      else if (e.key === 'ArrowRight' && state.tool === 'select') { e.preventDefault(); gotoPage(state.currentIndex + 1); }
      else if (!mod && e.key.toLowerCase() === 'p') setTool('pencil');
      else if (!mod && e.key.toLowerCase() === 'n') setTool('pencil');
      else if (!mod && e.key.toLowerCase() === 'e') setTool('eraser');
      else if (!mod && e.key.toLowerCase() === 'v') setTool('select');
    });
  }

  function doUndo() {
    const pg = getPage();
    if (pg && history.undo(state.pages, pg.id)) {
      toolsApi.setSelected(null);
      afterChange();
    }
  }
  function doRedo() {
    const pg = getPage();
    if (pg && history.redo(state.pages, pg.id)) {
      toolsApi.setSelected(null);
      afterChange();
    }
  }

  function api() {
    return {
      getPage, getTool, getZoom, getOpts: () => ({ pen: activePen(), shape: state.shape, eraser: state.eraser }),
      getPageSize, setPageSize,
      get history() { return history; }, // live reference: survives backup-restore replacement
      main, overlay,
      rerender, rerenderOverlay, afterChange, markDirty,
      setTool, setSelected, deleteObjects, recolorObject, duplicateObject,
      toast, openModal, closeModals, confirm: confirmDlg,
      addPageWithBackground, insertPdfPages, isCurrentPageBlank: () => {
        const pg = getPage();
        return pg && pg.objects.length === 0 && !pg.background;
      },
      restoreBackup
    };
  }

  async function boot() {
    // settings
    const s = Storage.loadSettings();
    state.theme = s.theme || 'light';
    state.autosave = s.autosave !== false;
    state.paper = s.paper || 'blank';
    state.paperBg = s.paperBg || '#ffffff';
    document.documentElement.dataset.theme = state.theme;
    applyThemeUI();
    $('set-autosave').checked = state.autosave;
    $('set-paper').value = state.paper;
    if ($('set-pagebg')) $('set-pagebg').value = state.paperBg;

    // tools + modules
    toolsApi = window.InkPad.Tools.initTools(api());
    fileImportApi = window.InkPad.FileImport.initFileImport(api());
    resizerApi = window.InkPad.Resizer.initResizer(api());

    bindTopbar(); bindToolbar(); bindModals(); bindProps(); bindKeys();
    document.addEventListener('inkpad:history', updateHistoryButtons);
    document.addEventListener('inkpad:imgready', () => rerender());

    // restore or fresh
    const saved = await Storage.loadNotebook();
    if (saved && Array.isArray(saved.pages) && saved.pages.length) {
      state.title = saved.title || 'My Notebook';
      state.paper = saved.paper || state.paper;
      $('set-paper').value = state.paper;
      if (saved.paperBg) state.paperBg = saved.paperBg;
      // normalize old saves (may lack page size)
      state.pages = saved.pages.map((p) => ({ ...p, size: Canvas.normSize(p.size) }));
      state.currentIndex = 0;
      toast(`Restored "${state.title}" (${state.pages.length} page(s)) from local storage.`);
    } else {
      state.pages = [Pages.blankPage()];
    }
    // har plain page (bina PDF/image background) screen-size ka —
    // height 100vh + width full, bina stretch. Background wale pages untouched.
    fitAllToViewport();
    // sync page-bg UI (swatches + custom input) after restore
    setPaperBg(state.paperBg, { silent: true });
    setTool('pencil', { popup: false });
    // FIX-2: hamesha device ke hisab se auto-fit (desktop + mobile dono).
    // Pehle innerWidth>860 par setZoom(1) fit ko cancel kar deta tha.
    fitZoom();
    rerender();
    tryFullscreenAuto(); // run par turant try (gesture na ho to silent fail)
    startFsPoll(); // poller: pehli gesture milte hi auto fullscreen (button ki zaroorat nahi)
    window.addEventListener('load', () => { autoFsTry(); }); // load-complete par dobara try
    // uske baad pehli interaction (draw/click/key — fullscreen button nahi) par auto fullscreen
    let resizeTimer = null;
    const refitOnResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (autoFit) { fitAllToViewport(); fitZoom(); } // height 100vh barkarar
        else rerender(); // DPR change ke liye re-render
      }, 120);
    };
    window.addEventListener('resize', refitOnResize);
    window.addEventListener('orientationchange', refitOnResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', refitOnResize);
    window.addEventListener('beforeunload', (e) => {
      if (allowExit) return; // khud exit kar rahe hain (Save/Don't save ho gaya)
      if (state.autosave) saveNow();
      // X / Alt+F4 par bhi bina-save exit block (browser generic confirm dikhata hai)
      if (needFileSave && !isBlankNotebook()) e.preventDefault();
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot)
    : boot();
})();
