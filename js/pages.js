/* pages.js — multi-page notebook model + thumbnails + indicator */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  function blankPage() {
    const C = window.InkPad.Canvas;
    return { id: window.InkPad.uid('p'), objects: [], background: null, size: { w: C.DOC_W, h: C.DOC_H }, createdAt: Date.now() };
  }

  /** Thumbnails with per-page checkbox for multi-select delete.
   *  sel: Set of selected page ids (optional); onToggle(id, checked). */
  function renderThumbs(container, pages, currentIndex, onJump, sel, onToggle) {
    sel = sel || new Set();
    container.innerHTML = '';
    pages.forEach((pg, i) => {
      const row = document.createElement('div');
      row.className = 'thumb-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(pg.id);
      cb.title = `Select page ${i + 1} for bulk delete`;
      cb.setAttribute('aria-label', `Select page ${i + 1}`);
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onToggle) onToggle(pg.id, cb.checked);
      });
      const b = document.createElement('button');
      b.className = 'thumb';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', i === currentIndex ? 'true' : 'false');
      b.title = `Go to page ${i + 1}`;
      const img = document.createElement('img');
      img.alt = `Page ${i + 1} thumbnail`;
      img.src = pg._thumb || placeholderThumb(i);
      b.appendChild(img);
      const meta = document.createElement('span');
      meta.innerHTML = `<strong>Page ${i + 1}</strong><br><span class="badge">${pg.objects.length} object(s)${pg.background ? ' · has background' : ''}</span>`;
      b.appendChild(meta);
      b.addEventListener('click', () => onJump(i));
      row.appendChild(cb);
      row.appendChild(b);
      container.appendChild(row);
    });
  }

  function placeholderThumb(i) {
    const c = document.createElement('canvas');
    c.width = 52; c.height = 72;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 52, 72);
    g.fillStyle = '#94a3b8'; g.font = '16px sans-serif'; g.textAlign = 'center';
    g.fillText(String(i + 1), 26, 42);
    return c.toDataURL();
  }

  /** Render live thumbnail for a page using the Canvas engine (offscreen). */
  function makeThumb(pg, paperStyle) {
    try {
      const { w: PW, h: PH } = window.InkPad.Canvas.pageSizeOf(pg);
      const c = document.createElement('canvas');
      const W = 104, H = Math.max(8, Math.round(W * PH / PW));
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const s = W / PW;
      g.scale(s, s);
      // paper
      g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
      if (pg.background && pg.background.dataURL) {
        const img = new Image();
        img.src = pg.background.dataURL;
        // sync draw only if cached & complete
        if (img.complete && img.naturalWidth) {
          const k = Math.min(PW / img.naturalWidth, PH / img.naturalHeight);
          g.drawImage(img, (PW - img.naturalWidth * k) / 2, (PH - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
        }
      }
      for (const o of pg.objects.slice(0, 400)) {
        try {
          if (o.type === 'stroke') window.InkPad.Canvas.drawStroke(g, o);
          else if (o.type === 'shape') window.InkPad.Canvas.drawShape(g, o);
        } catch {}
      }
      return c.toDataURL('image/png');
    } catch { return null; }
  }

  window.InkPad.Pages = { blankPage, renderThumbs, makeThumb };
})();
