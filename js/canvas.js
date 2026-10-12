/* canvas.js — document-space rendering engine (zoom-safe, high-DPI) */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const DOC_W = 794;   // default page size: A4 portrait
  const DOC_H = 1123;
  const MIN_SIDE = 200, MAX_SIDE = 2000;

  /** Normalize any stored size → {w,h} ints clamped to sane limits. */
  function normSize(size) {
    let w = Math.round(Number(size && size.w)) || DOC_W;
    let h = Math.round(Number(size && size.h)) || DOC_H;
    w = Math.max(MIN_SIDE, Math.min(MAX_SIDE, w));
    h = Math.max(MIN_SIDE, Math.min(MAX_SIDE, h));
    return { w, h };
  }
  function pageSizeOf(pg) { return normSize(pg && pg.size); }

  const imgCache = new Map(); // dataURL -> HTMLImageElement (or 'error')

  function loadImage(src) {
    if (!src) return Promise.reject(new Error('empty image'));
    const hit = imgCache.get(src);
    if (hit && hit instanceof HTMLImageElement && hit.complete && hit.naturalWidth) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { imgCache.set(src, img); resolve(img); };
      img.onerror = () => reject(new Error('Image failed to decode'));
      img.src = src;
    });
  }
  function cachedImage(src) {
    const hit = imgCache.get(src);
    if (hit instanceof HTMLImageElement && hit.complete && hit.naturalWidth) return hit;
    // kick off async load; caller re-renders on arrival
    loadImage(src).then(() => document.dispatchEvent(new CustomEvent('inkpad:imgready')))
      .catch(() => {});
    return null;
  }

  function sizeCanvases(main, overlay, zoom, W = DOC_W, H = DOC_H) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const scale = zoom * dpr;
    for (const c of [main, overlay]) {
      c.width = Math.round(W * scale);
      c.height = Math.round(H * scale);
      c._docW = W; c._docH = H; // document size for coordinate mapping
    }
    const paper = document.getElementById('paper');
    if (paper) {
      paper.style.width = Math.round(W * zoom) + 'px';
      paper.style.height = Math.round(H * zoom) + 'px';
      paper.style.aspectRatio = 'auto';
    }
    // keep the wrapper exactly paper-wide so the stuck button bar follows zoom
    const wrap = document.getElementById('paper-wrap');
    if (wrap) wrap.style.width = Math.round(W * zoom) + 'px';
    const mctx = main.getContext('2d');
    mctx.setTransform(scale, 0, 0, scale, 0, 0);
    const octx = overlay.getContext('2d');
    octx.setTransform(scale, 0, 0, scale, 0, 0);
    return { mctx, octx };
  }

  function docFromEvent(e, canvas) {
    const r = canvas.getBoundingClientRect();
    const W = canvas._docW || DOC_W, H = canvas._docH || DOC_H;
    return {
      x: (e.clientX - r.left) * (W / r.width),
      y: (e.clientY - r.top) * (H / r.height),
      pressure: (e.pressure && e.pressure > 0) ? e.pressure : 0.5
    };
  }

  function hexToRgba(hex, alpha) {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function drawPaperBase(ctx, paperStyle, W = DOC_W, H = DOC_H, bgColor = '#ffffff') {
    ctx.save();
    ctx.fillStyle = bgColor || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(100,116,139,.28)';
    ctx.fillStyle = 'rgba(100,116,139,.35)';
    ctx.lineWidth = 1;
    if (paperStyle === 'ruled') {
      for (let y = 80; y < H; y += 32) {
        ctx.beginPath(); ctx.moveTo(56, y + .5); ctx.lineTo(W - 40, y + .5); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(200,80,80,.4)';
      ctx.beginPath(); ctx.moveTo(56.5, 0); ctx.lineTo(56.5, H); ctx.stroke();
    } else if (paperStyle === 'grid') {
      ctx.strokeStyle = 'rgba(100,116,139,.18)';
      for (let x = 0; x <= W; x += 24) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
      for (let y = 0; y <= H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke(); }
    } else if (paperStyle === 'dots') {
      for (let y = 16; y < H; y += 24)
        for (let x = 16; x < W; x += 24) { ctx.beginPath(); ctx.arc(x, y, 1.3, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }

  /* ── smooth freehand stroke ── */
  function strokePath(ctx, pts) {
    if (!pts.length) return;
    ctx.beginPath();
    if (pts.length === 1) { ctx.arc(pts[0].x, pts[0].y, 0.6, 0, 7); ctx.fill(); return; }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  function drawStroke(ctx, s) {
    const op = (s.opacity == null ? 100 : s.opacity) / 100;
    ctx.save();
    ctx.globalAlpha = op;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (s.style === 'highlighter') ctx.globalCompositeOperation = 'multiply';
    if (s.style === 'pencil') {
      // grainy pencil: two passes, slightly offset, lighter
      ctx.strokeStyle = hexToRgba(s.color, 0.85 * op);
      ctx.globalAlpha = op;
      for (const pass of [0, 1]) {
        ctx.lineWidth = Math.max(0.6, s.width * (pass ? 0.55 : 1));
        ctx.setLineDash(pass ? [1.5, 1.2] : []);
        strokePath(ctx, s.points);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    } else if (s.style === 'highlighter') {
      // Marker band: auto-covers the full text-line height along the drawn path.
      // `band` is computed at stroke end (bbox height + padding); older saves
      // without it fall back to width*3.
      ctx.strokeStyle = hexToRgba(s.color, 0.45);
      ctx.lineWidth = s.band || Math.max(6, s.width * 3);
      strokePath(ctx, s.points);
      ctx.stroke();
    } else {
      // pen: pressure-modulated width via segments for natural feel
      const pts = s.points;
      if (pts.length < 3) {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
        strokePath(ctx, pts); ctx.stroke();
      } else {
        ctx.strokeStyle = s.color;
        for (let i = 1; i < pts.length; i++) {
          const p0 = pts[i - 1], p1 = pts[i];
          const w = s.width * (0.55 + 0.7 * ((p0.p || 0.5) + (p1.p || 0.5)) / 2);
          ctx.lineWidth = w;
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
        // round joints overlay
        ctx.lineWidth = s.width;
        ctx.globalAlpha = op * 0.35;
        strokePath(ctx, pts); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ── shapes ── */
  function normBox(o) {
    return {
      x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
      w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1)
    };
  }

  function polyPoints(cx, cy, r, n, rot = -Math.PI / 2) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }
  function starPoints(cx, cy, rO, rI, n = 5, rot = -Math.PI / 2) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? rO : rI;
      const a = rot + (i / (n * 2)) * Math.PI * 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function shade(hex, amt) { // amt -100..100
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    let n = parseInt(h, 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  function traceShapePath(ctx, o) {
    const { x, y, w, h } = normBox(o);
    const cx = x + w / 2, cy = y + h / 2;
    ctx.beginPath();
    switch (o.shape) {
      case 'line': ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); break;
      case 'arrow': break; // handled in draw (needs head)
      case 'rect': ctx.rect(x, y, w || 1, h || 1); break;
      case 'roundrect':
        if (ctx.roundRect) ctx.roundRect(x, y, w || 1, h || 1, Math.min(18, w / 4, h / 4));
        else ctx.rect(x, y, w || 1, h || 1);
        break;
      case 'circle': {
        const r = Math.max(1, Math.min(w, h) / 2);
        ctx.arc(cx, cy, r, 0, Math.PI * 2); break;
      }
      case 'ellipse': ctx.ellipse(cx, cy, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); break;
      case 'triangle':
        ctx.moveTo(cx, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); break;
      case 'polygon':
        polyPoints(cx, cy, Math.max(1, Math.min(w, h) / 2), 6).forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
        ctx.closePath(); break;
      case 'star':
        starPoints(cx, cy, Math.max(1, Math.min(w, h) / 2), Math.max(1, Math.min(w, h) / 4)).forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
        ctx.closePath(); break;
      case 'freeform':
        (o.points || []).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath(); break;
      default: ctx.rect(x, y, w || 1, h || 1);
    }
  }

  function drawArrow(ctx, o) {
    const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
    const len = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const head = Math.min(22, Math.max(8, len * 0.18));
    ctx.beginPath();
    ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2);
    ctx.moveTo(o.x2, o.y2);
    ctx.lineTo(o.x2 - head * Math.cos(ang - 0.42), o.y2 - head * Math.sin(ang - 0.42));
    ctx.moveTo(o.x2, o.y2);
    ctx.lineTo(o.x2 - head * Math.cos(ang + 0.42), o.y2 - head * Math.sin(ang + 0.42));
  }

  function drawShape(ctx, o) {
    const op = (o.opacity == null ? 100 : o.opacity) / 100;
    ctx.save();
    ctx.globalAlpha = op;
    ctx.lineWidth = o.lineWidth || 3;
    ctx.strokeStyle = o.stroke || '#1a56db';
    ctx.fillStyle = o.fill || '#bfdbfe';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    const is3d = ['cube', 'cuboid', 'cylinder', 'cone', 'sphere', 'pyramid'].includes(o.shape);
    if (is3d) { drawShape3D(ctx, o); ctx.restore(); return; }

    if (o.shape === 'line' || o.shape === 'arrow') {
      if (o.shape === 'line') { ctx.beginPath(); ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); }
      else drawArrow(ctx, o);
      ctx.stroke();
      ctx.restore();
      return;
    }
    traceShapePath(ctx, o);
    if (o.fillOn) ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** 3D-style shapes via shaded canvas paths + gradients (not a 3D engine). */
  function drawShape3D(ctx, o) {
    const { x, y, w, h } = normBox(o);
    const W = Math.max(4, w), H = Math.max(4, h);
    const base = o.fill || '#9ec1ff';
    const edge = o.stroke || '#1a3a8f';
    ctx.lineWidth = o.lineWidth || 2;
    ctx.strokeStyle = edge;
    const depth = Math.min(W, H) * 0.28;

    const face = (pts, color) => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
      ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
      if (o.fillOn === false) { /* outline only */ }
      ctx.stroke();
    };

    if (o.shape === 'cube' || o.shape === 'cuboid') {
      // consistent oblique projection, depth vector v=(dx,-dy): every shared
      // edge matches, so the box reads as one solid (cube vs cuboid comes
      // from the dragged W/H proportions).
      const dx = depth, dy = depth;
      face([[x, y + dy], [x + W - dx, y + dy], [x + W - dx, y + H], [x, y + H]], shade(base, -8));
      face([[x, y + dy], [x + W - dx, y + dy], [x + W, y], [x + dx, y]], shade(base, 28));
      face([[x + W - dx, y + dy], [x + W - dx, y + H], [x + W, y + H - dy], [x + W, y]], shade(base, -28));
    } else if (o.shape === 'cylinder') {
      const rx = W / 2, ry = Math.min(H * 0.18, 34);
      const cx = x + W / 2;
      const g = ctx.createLinearGradient(x, 0, x + W, 0);
      g.addColorStop(0, shade(base, -32)); g.addColorStop(0.45, shade(base, 22)); g.addColorStop(1, shade(base, -28));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, y + ry); ctx.lineTo(x, y + H - ry);
      ctx.ellipse(cx, y + H - ry, rx, ry, 0, 0, Math.PI);
      ctx.lineTo(x + W, y + ry);
      ctx.ellipse(cx, y + ry, rx, ry, 0, Math.PI, 0, true);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, y + ry, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(base, 40); ctx.fill(); ctx.stroke();
    } else if (o.shape === 'cone') {
      const cx = x + W / 2;
      const g = ctx.createLinearGradient(x, 0, x + W, 0);
      g.addColorStop(0, shade(base, -30)); g.addColorStop(0.5, shade(base, 25)); g.addColorStop(1, shade(base, -25));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(x, y + H * 0.86); ctx.lineTo(x + W, y + H * 0.86); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, y + H * 0.86, W / 2, Math.min(H * 0.12, 22), 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(base, -12); ctx.fill(); ctx.stroke();
    } else if (o.shape === 'sphere') {
      const cx = x + W / 2, cy = y + H / 2, r = Math.min(W, H) / 2;
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
      g.addColorStop(0, shade(base, 60)); g.addColorStop(0.55, base); g.addColorStop(1, shade(base, -55));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, r), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.beginPath(); ctx.ellipse(cx - r * 0.32, cy - r * 0.38, r * 0.22, r * 0.12, -0.5, 0, Math.PI * 2); ctx.fill();
    } else if (o.shape === 'pyramid') {
      const cx = x + W / 2;
      face([[cx, y], [x, y + H], [cx, y + H]], shade(base, 22));
      face([[cx, y], [cx, y + H], [x + W, y + H]], shade(base, -22));
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(x + W, y + H); ctx.stroke();
    }
  }

  function render(main, overlay, page, opts = {}) {
    const { zoom = 1, paperStyle = 'blank', paperBg = '#ffffff' } = opts;
    const { w: PW, h: PH } = pageSizeOf(page);
    const { mctx, octx } = sizeCanvases(main, overlay, zoom, PW, PH);
    drawPaperBase(mctx, paperStyle, PW, PH, paperBg);
    // background (imported PDF page / image fitted to page)
    if (page && page.background && page.background.dataURL) {
      const img = cachedImage(page.background.dataURL);
      if (img) {
        // preserve proportions: contain within page
        const s = Math.min(PW / img.naturalWidth, PH / img.naturalHeight);
        const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
        mctx.save();
        mctx.drawImage(img, (PW - dw) / 2, (PH - dh) / 2, dw, dh);
        mctx.restore();
      }
    }
    if (!page) return { mctx, octx };
    for (const o of page.objects) {
      try {
        if (o.type === 'stroke') drawStroke(mctx, o);
        else if (o.type === 'shape') drawShape(mctx, o);
        else if (o.type === 'image') {
          const img = cachedImage(o.src);
          if (img) mctx.drawImage(img, o.x, o.y, o.w, o.h);
          else { mctx.save(); mctx.fillStyle = '#e5e7eb'; mctx.fillRect(o.x, o.y, o.w, o.h); mctx.restore(); }
        }
      } catch (err) { console.warn('render object failed', err); }
    }
    octx.clearRect(0, 0, PW, PH);
    return { mctx, octx, pageW: PW, pageH: PH };
  }

  /* ── hit testing (document coords) ── */
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / L;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function strokeHit(s, x, y, pad) {
    const pts = s.points;
    const tol = Math.max(3, s.width / 2) + pad;
    for (let i = 1; i < pts.length; i++) {
      if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) return true;
    }
    if (pts.length === 1 && Math.hypot(x - pts[0].x, y - pts[0].y) <= tol) return true;
    return false;
  }
  function shapeHit(o, x, y, pad) {
    if (o.shape === 'freeform' && o.points && o.points.length) {
      return strokeHit({ points: o.points, width: o.lineWidth || 3 }, x, y, pad);
    }
    if (o.shape === 'line' || o.shape === 'arrow')
      return distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= (o.lineWidth || 3) / 2 + pad + 3;
    const b = normBox(o);
    if (o.fillOn !== false) {
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return true;
    }
    // outline proximity
    const edges = [
      [b.x, b.y, b.x + b.w, b.y], [b.x + b.w, b.y, b.x + b.w, b.y + b.h],
      [b.x + b.w, b.y + b.h, b.x, b.y + b.h], [b.x, b.y + b.h, b.x, b.y]
    ];
    return edges.some(([a, bb, c, d]) => distToSeg(x, y, a, bb, c, d) <= (o.lineWidth || 3) / 2 + pad + 3);
  }
  function objectHit(o, x, y, pad = 2) {
    if (o.type === 'stroke') return strokeHit(o, x, y, pad);
    if (o.type === 'shape') return shapeHit(o, x, y, pad);
    if (o.type === 'image') return x >= o.x - pad && x <= o.x + o.w + pad && y >= o.y - pad && y <= o.y + o.h + pad;
    return false;
  }

  // Selection box ka bounds (draw + hit-test dono yahi use karte hain).
  function selectionBounds(o) {
    if (o.type === 'image') return { x: o.x, y: o.y, w: o.w, h: o.h };
    if (o.type === 'shape') return normBox(o);
    const xs = o.points.map(p => p.x), ys = o.points.map(p => p.y);
    return { x: Math.min(...xs) - 6, y: Math.min(...ys) - 6, w: Math.max(...xs) - Math.min(...xs) + 12, h: Math.max(...ys) - Math.min(...ys) + 12 };
  }

  // Mini action colors (color-plate dots).
  const SEL_COLORS = ['#1a1a1a', '#c81e1e', '#1a56db', '#047857', '#facc15', '#ffffff'];

  // Selection box ke upar mini action cluster: duplicate + cross + color-plate.
  // Compact mini-icons, beech me 3px gap. Images par palette nahi (recolor nahi hota).
  // tools.js hit-test ke liye bhi yahi geometry use karta hai.
  function selectionActions(b, type) {
    const y = b.y - 16, R = 9, DOT_R = 7, GAP = 3;
    const del = { x: b.x + b.w - R, y, r: R };
    const dup = { x: del.x - R - GAP - R, y, r: R };
    const dots = [];
    if (type !== 'image') {
      let right = dup.x - R - GAP;
      for (const color of SEL_COLORS) {
        dots.push({ x: right - DOT_R, y, r: DOT_R, color });
        right -= DOT_R * 2 + GAP;
      }
    }
    return { del, dup, dots };
  }

  function drawSelection(octx, o) {
    if (!o) return;
    octx.save();
    octx.strokeStyle = '#1a56db'; octx.lineWidth = 1.5; octx.setLineDash([6, 4]);
    const b = selectionBounds(o);
    octx.strokeRect(b.x, b.y, Math.max(2, b.w), Math.max(2, b.h));
    octx.setLineDash([]);
    octx.fillStyle = '#1a56db';
    // corners + edges (all-direction resize handles)
    for (const [hx, hy] of [
      [b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
      [b.x + b.w / 2, b.y], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2]
    ]) {
      octx.fillRect(hx - 5, hy - 5, 10, 10);
    }
    // mini action cluster: duplicate + cross + color-plate dots
    const acts = selectionActions(b, o.type);
    // duplicate: white circle + blue double-square
    octx.beginPath();
    octx.arc(acts.dup.x, acts.dup.y, acts.dup.r, 0, Math.PI * 2);
    octx.fillStyle = '#ffffff'; octx.fill();
    octx.strokeStyle = '#1a56db'; octx.lineWidth = 2; octx.stroke();
    octx.strokeStyle = '#1a56db'; octx.lineWidth = 2;
    octx.strokeRect(acts.dup.x - 5, acts.dup.y - 2, 7, 7);
    octx.strokeRect(acts.dup.x - 2, acts.dup.y - 5, 7, 7);
    // cross (delete): red circle + white cross
    octx.beginPath();
    octx.arc(acts.del.x, acts.del.y, acts.del.r, 0, Math.PI * 2);
    octx.fillStyle = '#c81e1e'; octx.fill();
    octx.strokeStyle = '#ffffff'; octx.lineWidth = 2.5;
    octx.beginPath();
    octx.moveTo(acts.del.x - 5, acts.del.y - 5); octx.lineTo(acts.del.x + 5, acts.del.y + 5);
    octx.moveTo(acts.del.x + 5, acts.del.y - 5); octx.lineTo(acts.del.x - 5, acts.del.y + 5);
    octx.stroke();
    // color-plate dots
    for (const d of acts.dots) {
      octx.beginPath();
      octx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      octx.fillStyle = d.color; octx.fill();
      octx.strokeStyle = '#17202b'; octx.lineWidth = 1.5; octx.stroke();
    }
    octx.restore();
    return b;
  }

  // Selected image box ke top-right bahar cross-button ka geometry (doc coords).
  // tools.js hit-test ke liye bhi yahi use karta hai taaki draw/click ek jaise rahen.
  function deleteBtnFor(b) {
    return { x: b.x + b.w + 14, y: b.y - 14, r: 11 };
  }

  window.InkPad.Canvas = {
    DOC_W, DOC_H, render, sizeCanvases, docFromEvent,
    drawStroke, drawShape, objectHit, strokeHit, shapeHit, normBox, drawSelection, deleteBtnFor,
    selectionBounds, selectionActions,
    loadImage, hexToRgba, shade, normSize, pageSizeOf
  };
})();
