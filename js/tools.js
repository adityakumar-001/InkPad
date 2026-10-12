/* tools.js — pointer interactions: pen / eraser / shapes / select */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const C = () => window.InkPad.Canvas;

  const SHAPE_HINTS = {
    'shape-line': 'Line: drag to draw', 'shape-arrow': 'Arrow: drag to draw',
    'shape-rect': 'Rectangle: drag to draw', 'shape-roundrect': 'Rounded rect: drag',
    'shape-circle': 'Circle: drag (Shift = perfect)', 'shape-ellipse': 'Ellipse: drag',
    'shape-triangle': 'Triangle: drag', 'shape-polygon': 'Polygon: drag',
    'shape-star': 'Star: drag', 'shape-freeform': 'Freeform: click points, double-click to finish',
    'shape-cube': 'Cube (3D-style): drag', 'shape-cuboid': 'Cuboid (3D-style): drag',
    'shape-cylinder': 'Cylinder (3D-style): drag', 'shape-cone': 'Cone (3D-style): drag',
    'shape-sphere': 'Sphere (3D-style): drag', 'shape-pyramid': 'Pyramid (3D-style): drag'
  };

  function hintFor(tool) {
    if (tool === 'pen') return 'Pen: drag to write (pressure supported)';
    if (tool === 'pencil') return 'Pencil: drag to sketch';
    if (tool === 'highlighter') return 'Highlighter: drag to mark';
    if (tool === 'eraser') return 'Eraser: drag over strokes to remove them';
    if (tool === 'select') return 'Select: click object, drag to move, corners to resize';
    return SHAPE_HINTS[tool] || tool;
  }

  function isShapeTool(t) { return typeof t === 'string' && t.startsWith('shape-'); }
  function shapeName(t) { return t.replace('shape-', ''); }

  function initTools(ctx) {
    const paper = document.getElementById('paper');
    let drawing = null;      // active stroke
    let shapeDrag = null;    // {x1,y1,x2,y2,tool}
    let freePts = [];        // freeform in-progress
    let eraseBatch = null;   // area-erase snapshot {before:Map}
    let boxDrag = null;      // box-erase marquee {x1,y1,x2,y2}
    let moveOp = null;       // select move/resize {id, before, mode, handle, dx,dy}
    let selectedId = null;

    const getPage = () => ctx.getPage();
    const opts = () => ctx.getOpts();

    function setHint(t) {
      paper.dataset.tool = t;
      const st = document.getElementById('status-tool');
      if (st) st.textContent = 'Tool: ' + labelFor(t);
    }
    function labelFor(t) {
      const map = { pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter', eraser: 'Eraser', select: 'Select' };
      if (map[t]) return map[t];
      if (isShapeTool(t)) return shapeName(t)[0].toUpperCase() + shapeName(t).slice(1) + ' (shape)';
      return t;
    }

    function getPos(e) { return C().docFromEvent(e, ctx.main); }

    function events() {
      paper.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      paper.addEventListener('dblclick', onDbl);
      document.addEventListener('keydown', onKey);
      ctx.main.addEventListener('pointermove', onCoord);
    }

    function onCoord(e) {
      const p = getPos(e);
      const el = document.getElementById('status-coords');
      if (el) el.textContent = `x: ${Math.round(p.x)} y: ${Math.round(p.y)}`;
    }

    function onKey(e) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ctx.getTool() === 'select' && selectedId) {
        e.preventDefault();
        ctx.deleteObjects([selectedId]);
        selectedId = null; ctx.setSelected(null);
      }
      if (e.key === 'Escape') { freePts = []; shapeDrag = null; ctx.rerender(); }
      if (e.key === 'Enter' && freePts.length > 2 && isShapeTool(ctx.getTool()) && shapeName(ctx.getTool()) === 'freeform') {
        finishFreeform();
      }
    }

    function onDbl(e) {
      if (e.target && e.target.closest && e.target.closest('#float-bar, #tool-popup')) return;
      if (isShapeTool(ctx.getTool()) && shapeName(ctx.getTool()) === 'freeform' && freePts.length > 2) {
        e.preventDefault(); finishFreeform();
      }
    }

    /* ── pointer down ── */
    function onDown(e) {
      // UI lives inside #paper now — ignore clicks on buttons/inputs, draw only on canvas
      if (e.target && e.target.closest && e.target.closest('#float-bar, #tool-popup')) return;
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      const tool = ctx.getTool();
      const page = getPage();
      if (!page) return;
      const p = getPos(e);
      try { paper.setPointerCapture(e.pointerId); } catch {}

      if (tool === 'pencil' || tool === 'highlighter') {
        const o = opts().pen;
        // Har tool ka fixed style: pencil = grainy, mark = highlighter.
        // (Purane saves me style stored ho sakta hai — wahi use hoga.)
        const style = o.style || tool;
        drawing = {
          id: window.InkPad.uid('s'), type: 'stroke',
          points: [{ x: clampX(p.x), y: clampY(p.y), p: p.pressure }],
          color: o.color, width: clampNum(o.width, o.min, o.max),
          opacity: o.opacity, style
        };
        // draw dot immediately for tap
        const mctx = ctx.main.getContext('2d');
        C().drawStroke(mctx, drawing);
        e.preventDefault();
      } else if (tool === 'eraser') {
        if (opts().eraser.mode === 'box') {
          boxDrag = { x1: clampX(p.x), y1: clampY(p.y), x2: clampX(p.x), y2: clampY(p.y) };
        } else {
          const pg0 = getPage();
          eraseBatch = { before: new Map(pg0.objects.map(o => [o.id, window.InkPad.clone(o)])) };
          areaEraseAt(p);
        }
        e.preventDefault();
      } else if (isShapeTool(tool)) {
        if (shapeName(tool) === 'freeform') {
          freePts.push({ x: clampX(p.x), y: clampY(p.y) });
          drawFreePreview();
        } else {
          shapeDrag = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, tool };
        }
        e.preventDefault();
      } else if (tool === 'select') {
        selectDown(p);
        e.preventDefault();
      }
    }

    function onMove(e) {
      const tool = ctx.getTool();
      const page = getPage();
      if (!page) return;
      // eraser cursor preview even without drag
      if (tool === 'eraser' && !eraseBatch && !boxDrag) { drawEraserCursor(e); return; }

      if (drawing) {
        const pts = (e.getCoalescedEvents ? e.getCoalescedEvents() : [e]);
        const mctx = ctx.main.getContext('2d');
        for (const ce of pts) {
          const p = C().docFromEvent(ce, ctx.main);
          const last = drawing.points[drawing.points.length - 1];
          const np = { x: clampX(p.x), y: clampY(p.y), p: p.pressure };
          drawing.points.push(np);
          // incremental segment that matches the final look (WYSIWYG):
          // pencil replicates its grainy two-pass stroke, highlighter uses
          // the same auto band it will finalize with.
          drawLiveSegment(mctx, drawing, last, np);
        }
        if (e.cancelable) e.preventDefault();
      } else if (boxDrag) {
        const p = getPos(e);
        boxDrag.x2 = clampX(p.x); boxDrag.y2 = clampY(p.y);
        drawBoxPreview();
        if (e.cancelable) e.preventDefault();
      } else if (eraseBatch) {
        areaEraseAt(getPos(e));
        if (e.cancelable) e.preventDefault();
      } else if (shapeDrag) {
        const p = getPos(e);
        shapeDrag.x2 = e.shiftKey ? shapeDrag.x1 + Math.max(Math.abs(p.x - shapeDrag.x1), Math.abs(p.y - shapeDrag.y1)) * Math.sign(p.x - shapeDrag.x1 || 1) : p.x;
        shapeDrag.y2 = e.shiftKey ? shapeDrag.y1 + Math.max(Math.abs(p.x - shapeDrag.x1), Math.abs(p.y - shapeDrag.y1)) * Math.sign(p.y - shapeDrag.y1 || 1) : p.y;
        drawShapePreview();
        if (e.cancelable) e.preventDefault();
      } else if (moveOp && moveOp.active) {
        const p = getPos(e);
        applyMove(p);
        if (e.cancelable) e.preventDefault();
      }
    }

    function onUp(e) {
      if (drawing) {
        const page = getPage();
        if (drawing.points.length === 1) {
          // make taps visible: duplicate point slightly
          drawing.points.push({ ...drawing.points[0] });
        }
        // simplify: drop near-duplicate points
        drawing.points = drawing.points.filter((pt, i, a) =>
          i === 0 || i === a.length - 1 || Math.hypot(pt.x - a[i - 1].x, pt.y - a[i - 1].y) > 0.8);
        if (drawing.style === 'highlighter') {
          // Auto-cover: band height spans the stroke's full vertical extent plus
          // line padding, so marked text is covered top-to-bottom (round caps
          // extend coverage past both ends for full width).
          const ys = drawing.points.map(p => p.y);
          const h = Math.max(...ys) - Math.min(...ys);
          drawing.band = Math.max(8, drawing.width * 3, h + 12);
        }
        page.objects.push(drawing);
        ctx.history.push(page.id, { kind: 'add', objects: [window.InkPad.clone(drawing)] });
        drawing = null;
        ctx.afterChange();
      } else if (boxDrag) {
        const bx = Math.min(boxDrag.x1, boxDrag.x2), by = Math.min(boxDrag.y1, boxDrag.y2);
        const bw = Math.abs(boxDrag.x2 - boxDrag.x1), bh = Math.abs(boxDrag.y2 - boxDrag.y1);
        boxDrag = null;
        ctx.rerenderOverlay(null);
        if (bw >= 4 || bh >= 4) finishBoxErase({ x: bx, y: by, w: bw, h: bh });
        else ctx.rerender();
      } else if (eraseBatch) {
        const page = getPage();
        const before = eraseBatch.before;
        const curIds = new Set(page.objects.map(o => o.id));
        const deleted = [];
        for (const [id, cl] of before) if (!curIds.has(id)) deleted.push(cl);
        const added = [];
        for (const o of page.objects) if (!before.has(o.id)) added.push(window.InkPad.clone(o));
        eraseBatch = null;
        ctx.rerenderOverlay(null);
        if (deleted.length || added.length) {
          if (deleted.length) ctx.history.push(page.id, { kind: 'delete', objects: deleted });
          if (added.length) ctx.history.push(page.id, { kind: 'add', objects: added });
          ctx.afterChange();
        } else ctx.rerender();
      } else if (shapeDrag) {
        const { x1, y1, x2, y2, tool } = shapeDrag;
        shapeDrag = null;
        ctx.rerenderOverlay(null);
        if (Math.hypot(x2 - x1, y2 - y1) < 4) return; // accidental click
        const s = opts().shape;
        const obj = {
          id: window.InkPad.uid('h'), type: 'shape', shape: shapeName(tool),
          x1: clampX(x1), y1: clampY(y1), x2: clampX(x2), y2: clampY(y2),
          stroke: s.stroke, fill: s.fill, fillOn: s.fillOn,
          lineWidth: s.lineWidth, opacity: s.opacity
        };
        getPage().objects.push(obj);
        ctx.history.push(getPage().id, { kind: 'add', objects: [window.InkPad.clone(obj)] });
        ctx.afterChange();
      } else if (moveOp && moveOp.active) {
        const page = getPage();
        const cur = page.objects.find(o => o.id === moveOp.id);
        if (cur && moveOp.moved) {
          ctx.history.push(page.id, { kind: 'update', before: [moveOp.before], after: [window.InkPad.clone(cur)] });
          ctx.afterChange();
        } else ctx.rerender();
        moveOp = null;
      }
    }

    /* ── eraser: Area mode = sirf touch hua hissa mitao (stroke split ho jata hai) ── */
    function areaEraseAt(p) {
      const page = getPage();
      const R = Math.max(2, opts().eraser.size / 2);
      let changed = false;
      for (const o of [...page.objects]) {
        if (o.type === 'stroke') {
          let run = [];
          const pieces = [];
          for (const pt of o.points) {
            if (Math.hypot(pt.x - p.x, pt.y - p.y) > R) run.push(pt);
            else if (run.length) { pieces.push(run); run = []; }
          }
          if (run.length) pieces.push(run);
          const kept = pieces.reduce((n, r) => n + r.length, 0);
          if (kept === o.points.length) continue; // touch hi nahi hua
          page.objects = page.objects.filter(x => x.id !== o.id);
          for (const pts of pieces) {
            if (!pts.length) continue;
            page.objects.push({ ...window.InkPad.clone(o), id: window.InkPad.uid('s'), points: pts });
          }
          changed = true;
        } else if (C().objectHit(o, p.x, p.y, R)) {
          // shapes/images split nahi ho sakte — touch par poori remove
          page.objects = page.objects.filter(x => x.id !== o.id);
          changed = true;
        }
      }
      if (selectedId && !page.objects.some(o => o.id === selectedId)) { selectedId = null; ctx.setSelected(null); }
      if (changed) ctx.rerender();
      drawEraserAt(p, opts().eraser.size);
    }
    /* ── eraser: Box mode = drag kiya selected area sab mit jata hai ── */
    function finishBoxErase(b) {
      const page = getPage();
      const hit = page.objects.filter(o => objectInBox(o, b));
      if (!hit.length) { ctx.rerender(); return; }
      const ids = new Set(hit.map(o => o.id));
      page.objects = page.objects.filter(o => !ids.has(o.id));
      if (selectedId && ids.has(selectedId)) { selectedId = null; ctx.setSelected(null); }
      ctx.history.push(page.id, { kind: 'delete', objects: hit.map(window.InkPad.clone) });
      ctx.afterChange();
    }
    function objectInBox(o, b) {
      if (o.type === 'image') return rectsOverlap(o.x, o.y, o.w, o.h, b.x, b.y, b.w, b.h);
      if (o.type === 'shape') {
        if (o.shape === 'freeform' && o.points) return o.points.some(p => inBox(p, b));
        const nb = C().normBox(o);
        return rectsOverlap(nb.x, nb.y, nb.w, nb.h, b.x, b.y, b.w, b.h);
      }
      const pts = o.points;
      for (const p of pts) if (inBox(p, b)) return true;
      for (let i = 1; i < pts.length; i++) if (segIntersectsRect(pts[i - 1], pts[i], b)) return true;
      return false;
    }
    function inBox(p, b) { return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; }
    function rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
      return x1 <= x2 + w2 && x1 + w1 >= x2 && y1 <= y2 + h2 && y1 + h1 >= y2;
    }
    function segIntersectsRect(a, c, b) {
      if (inBox(a, b) || inBox(c, b)) return true;
      const edges = [
        [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }],
        [{ x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }],
        [{ x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }],
        [{ x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }]
      ];
      return edges.some(([e1, e2]) => segsCross(a, c, e1, e2));
    }
    function segsCross(p1, p2, p3, p4) {
      const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
      if (!d) return false;
      const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
      const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
      return t >= 0 && t <= 1 && u >= 0 && u <= 1;
    }
    function drawBoxPreview() {
      if (!boxDrag) return;
      const octx = ctx.overlay.getContext('2d');
      const z = ctx.getZoom(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      octx.save();
      octx.setTransform(z * dpr, 0, 0, z * dpr, 0, 0);
      clearOverlay(octx);
      const x = Math.min(boxDrag.x1, boxDrag.x2), y = Math.min(boxDrag.y1, boxDrag.y2);
      const w = Math.abs(boxDrag.x2 - boxDrag.x1), h = Math.abs(boxDrag.y2 - boxDrag.y1);
      octx.fillStyle = 'rgba(200,30,30,.10)';
      octx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
      octx.strokeStyle = '#c81e1e'; octx.lineWidth = 1.5 / z; octx.setLineDash([6, 4]);
      octx.strokeRect(x, y, Math.max(1, w), Math.max(1, h));
      octx.restore();
    }
    function drawEraserCursor(e) {
      const p = getPos(e);
      drawEraserAt(p, opts().eraser.size);
    }
    function clearOverlay(octx) {
      const W = ctx.overlay._docW || C().DOC_W, H = ctx.overlay._docH || C().DOC_H;
      octx.clearRect(0, 0, W, H);
    }
    function drawEraserAt(p, size) {
      const octx = ctx.overlay.getContext('2d');
      const z = ctx.getZoom();
      octx.save();
      octx.setTransform(z * (window.devicePixelRatio || 1), 0, 0, z * (window.devicePixelRatio || 1), 0, 0);
      clearOverlay(octx);
      octx.beginPath();
      octx.arc(p.x, p.y, Math.max(2, size / 2), 0, Math.PI * 2);
      octx.strokeStyle = '#c81e1e'; octx.lineWidth = 1.5 / z; octx.stroke();
      octx.fillStyle = 'rgba(200,30,30,.12)'; octx.fill();
      octx.restore();
    }

    /* ── shape preview ── */
    function previewObj() {
      const s = opts().shape;
      return {
        id: 'preview', type: 'shape', shape: shapeName(shapeDrag.tool),
        x1: shapeDrag.x1, y1: shapeDrag.y1, x2: shapeDrag.x2, y2: shapeDrag.y2,
        stroke: s.stroke, fill: s.fill, fillOn: s.fillOn, lineWidth: s.lineWidth, opacity: s.opacity
      };
    }
    function drawShapePreview() {
      const octx = ctx.overlay.getContext('2d');
      const z = ctx.getZoom(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      octx.save();
      octx.setTransform(z * dpr, 0, 0, z * dpr, 0, 0);
      clearOverlay(octx);
      octx.globalAlpha = 0.85;
      C().drawShape(octx, previewObj());
      octx.restore();
    }
    function drawFreePreview() {
      const octx = ctx.overlay.getContext('2d');
      const z = ctx.getZoom(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      octx.save();
      octx.setTransform(z * dpr, 0, 0, z * dpr, 0, 0);
      clearOverlay(octx);
      if (freePts.length) {
        octx.strokeStyle = opts().shape.stroke; octx.lineWidth = opts().shape.lineWidth;
        octx.beginPath();
        freePts.forEach((p, i) => i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y));
        octx.stroke();
        octx.fillStyle = opts().shape.stroke;
        for (const p of freePts) { octx.beginPath(); octx.arc(p.x, p.y, 3, 0, 7); octx.fill(); }
      }
      octx.restore();
    }
    function finishFreeform() {
      if (freePts.length < 3) { freePts = []; ctx.rerenderOverlay(null); return; }
      const xs = freePts.map(p => p.x), ys = freePts.map(p => p.y);
      const s = opts().shape;
      const obj = {
        id: window.InkPad.uid('h'), type: 'shape', shape: 'freeform',
        x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys),
        points: freePts.map(p => ({ ...p })),
        stroke: s.stroke, fill: s.fill, fillOn: s.fillOn, lineWidth: s.lineWidth, opacity: s.opacity
      };
      freePts = [];
      getPage().objects.push(obj);
      ctx.history.push(getPage().id, { kind: 'add', objects: [window.InkPad.clone(obj)] });
      ctx.afterChange();
    }

    /* ── select / move / resize ── */
    function boundsOf(o) {
      if (o.type === 'image') return { x: o.x, y: o.y, w: o.w, h: o.h };
      if (o.type === 'shape') { const b = C().normBox(o); return b; }
      const xs = o.points.map(p => p.x), ys = o.points.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    function handleAt(o, p) {
      const b = boundsOf(o);
      const hs = [
        [b.x, b.y, 'nw'], [b.x + b.w, b.y, 'ne'], [b.x, b.y + b.h, 'sw'], [b.x + b.w, b.y + b.h, 'se'],
        [b.x + b.w / 2, b.y, 'n'], [b.x + b.w / 2, b.y + b.h, 's'],
        [b.x, b.y + b.h / 2, 'w'], [b.x + b.w, b.y + b.h / 2, 'e']
      ];
      for (const [hx, hy, name] of hs) {
        if (Math.abs(p.x - hx) < 10 && Math.abs(p.y - hy) < 10) return name;
      }
      return null;
    }
    function selectDown(p) {
      const page = getPage();
      const cur = selectedId && page.objects.find(o => o.id === selectedId);
      if (cur) {
        // Selection-box mini actions: color-plate dots, duplicate, cross (delete).
        // Compact mini-icons, beech me 3px gap.
        const acts = C().selectionActions(C().selectionBounds(cur), cur.type);
        for (const d of acts.dots) {
          if (Math.hypot(p.x - d.x, p.y - d.y) <= d.r + 3) { ctx.recolorObject(cur.id, d.color); return; }
        }
        if (Math.hypot(p.x - acts.dup.x, p.y - acts.dup.y) <= acts.dup.r + 3) { ctx.duplicateObject(cur.id); return; }
        if (Math.hypot(p.x - acts.del.x, p.y - acts.del.y) <= acts.del.r + 3) {
          ctx.deleteObjects([cur.id]);
          selectedId = null; ctx.setSelected(null);
          ctx.rerender();
          return;
        }
        const h = handleAt(cur, p);
        if (h) {
          moveOp = { active: true, id: cur.id, mode: 'resize', handle: h, before: window.InkPad.clone(cur), start: p, moved: false, orig: boundsOf(cur) };
          return;
        }
      }
      // topmost hit
      let found = null;
      for (let i = page.objects.length - 1; i >= 0; i--) {
        if (C().objectHit(page.objects[i], p.x, p.y, 3)) { found = page.objects[i]; break; }
      }
      selectedId = found ? found.id : null;
      ctx.setSelected(selectedId);
      if (found) moveOp = { active: true, id: found.id, mode: 'move', before: window.InkPad.clone(found), start: p, moved: false };
      else ctx.rerender();
    }
    function shiftObj(o, before, dx, dy) {
      if (o.type === 'stroke') for (const pt of o.points) { pt.x += dx; pt.y += dy; }
      else if (o.type === 'image') { o.x += dx; o.y += dy; }
      else if (o.type === 'shape') {
        if (o.shape === 'freeform' && o.points) for (const pt of o.points) { pt.x += dx; pt.y += dy; }
        o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy;
      }
    }
    function applyMove(p) {
      const page = getPage();
      const o = page.objects.find(x => x.id === moveOp.id);
      if (!o) return;
      const dx = p.x - moveOp.start.x, dy = p.y - moveOp.start.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      moveOp.moved = true;
      if (moveOp.mode === 'move') {
        shiftObj(o, moveOp.before, dx, dy);
        moveOp.start = p;
      } else {
        // resize by dragging corner handle (incremental deltas)
        if (o.type === 'image') {
          const h = moveOp.handle;
          let { x, y, w, h: hh } = o;
          if (h.includes('e')) w += dx;
          if (h.includes('s')) hh += dy;
          if (h.includes('w')) { x += dx; w -= dx; }
          if (h.includes('n')) { y += dy; hh -= dy; }
          o.x = x; o.y = y; o.w = Math.max(8, w); o.h = Math.max(8, hh);
          moveOp.start = p;
        } else if (o.type === 'shape') {
          const h = moveOp.handle;
          if (h.includes('e')) o.x2 += dx;
          if (h.includes('s')) o.y2 += dy;
          if (h.includes('w')) o.x1 += dx;
          if (h.includes('n')) o.y1 += dy;
          if (o.shape === 'freeform' && o.points) {
            // scale freeform points proportionally to bbox change
            const b0 = moveOp._b0 || (moveOp._b0 = { ...C().normBox(moveOp.before), pts: moveOp.before.points.map(q => ({ ...q })) });
            const b1 = C().normBox(o);
            const sx = (b1.w || 1) / (b0.w || 1), sy = (b1.h || 1) / (b0.h || 1);
            o.points = b0.pts.map(q => ({ x: b1.x + (q.x - b0.x) * sx, y: b1.y + (q.y - b0.y) * sy }));
          }
          moveOp.start = p;
        } else if (o.type === 'stroke') {
          // scale stroke points around bbox
          const b0 = moveOp._b0 || (moveOp._b0 = bboxOfPts(moveOp.before.points));
          const cur = bboxOfPts(o.points);
          const h = moveOp.handle;
          let nx = cur.x, ny = cur.y, nw = cur.w, nh = cur.h;
          if (h.includes('e')) nw += dx;
          if (h.includes('s')) nh += dy;
          if (h.includes('w')) { nx += dx; nw -= dx; }
          if (h.includes('n')) { ny += dy; nh -= dy; }
          nw = Math.max(4, nw); nh = Math.max(4, nh);
          const sx = nw / (b0.w || 1), sy = nh / (b0.h || 1);
          o.points = moveOp.before.points.map(q => ({ x: nx + (q.x - b0.x) * sx, y: ny + (q.y - b0.y) * sy, p: q.p }));
          moveOp.start = p;
        }
      }
      ctx.rerender();
    };
    function bboxOfPts(pts) {
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x || 1, h: Math.max(...ys) - y || 1 };
    }

    function drawLiveSegment(mctx, drawing, last, np) {
      const op = drawing.opacity / 100;
      const pw = (last.p || 0.5) + (np.p || 0.5);
      mctx.save();
      mctx.globalAlpha = op;
      mctx.lineCap = 'round'; mctx.lineJoin = 'round';
      if (drawing.style === 'highlighter') {
        const ys = drawing.points.map(q => q.y);
        const band = Math.max(8, drawing.width * 3, (Math.max(...ys) - Math.min(...ys)) + 12);
        mctx.globalCompositeOperation = 'multiply';
        mctx.strokeStyle = C().hexToRgba(drawing.color, 0.45);
        mctx.lineWidth = band;
        mctx.beginPath(); mctx.moveTo(last.x, last.y); mctx.lineTo(np.x, np.y); mctx.stroke();
      } else if (drawing.style === 'pencil') {
        mctx.strokeStyle = C().hexToRgba(drawing.color, 0.85 * op);
        mctx.lineWidth = Math.max(0.6, drawing.width);
        mctx.beginPath(); mctx.moveTo(last.x, last.y); mctx.lineTo(np.x, np.y); mctx.stroke();
        mctx.lineWidth = Math.max(0.6, drawing.width * 0.55);
        mctx.setLineDash([1.5, 1.2]);
        mctx.beginPath(); mctx.moveTo(last.x, last.y); mctx.lineTo(np.x, np.y); mctx.stroke();
        mctx.setLineDash([]);
      } else {
        mctx.strokeStyle = drawing.color;
        mctx.lineWidth = drawing.width * (0.55 + 0.7 * pw / 2);
        mctx.beginPath(); mctx.moveTo(last.x, last.y); mctx.lineTo(np.x, np.y); mctx.stroke();
      }
      mctx.restore();
    }
    function pageDims() {
      try { return ctx.getPageSize(); } catch { return { w: C().DOC_W, h: C().DOC_H }; }
    }
    function clampX(v) { return Math.max(0, Math.min(pageDims().w, v)); }    function clampY(v) { return Math.max(0, Math.min(pageDims().h, v)); }
    function clamp(v) { return Math.max(0, Math.min(2000, v)); }
    function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    events();
    setHint(ctx.getTool());

    return {
      setHint, hintFor, isShapeTool,
      getSelected: () => selectedId,
      setSelected: (id) => { selectedId = id; moveOp = null; },
      clearTransient: () => { drawing = null; shapeDrag = null; freePts = []; eraseBatch = null; boxDrag = null; moveOp = null; }
    };
  }

  window.InkPad.Tools = { initTools, hintFor };
})();
