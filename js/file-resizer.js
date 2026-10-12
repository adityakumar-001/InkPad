/* file-resizer.js — page size switcher inside Settings: Portrait (A4) / Landscape (16:9) */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const PORTRAIT = { w: 794, h: 1123 };   // A4
  const LANDSCAPE = { w: 1123, h: 632 };  // 16:9

  function initResizer(ctx) {
    const cur = document.getElementById('pg-cur-size');
    const btnP = document.getElementById('pg-portrait');
    const btnL = document.getElementById('pg-landscape');

    function refresh() {
      const s = ctx.getPageSize();
      if (cur) cur.textContent = `${s.w}×${s.h}`;
      if (btnP) btnP.setAttribute('aria-pressed', (s.w === PORTRAIT.w && s.h === PORTRAIT.h) ? 'true' : 'false');
      if (btnL) btnL.setAttribute('aria-pressed', (s.w === LANDSCAPE.w && s.h === LANDSCAPE.h) ? 'true' : 'false');
    }
    function applySize(which) {
      const s = which === 'portrait' ? PORTRAIT : LANDSCAPE;
      ctx.setPageSize(s.w, s.h);
      refresh();
    }
    if (btnP) btnP.addEventListener('click', () => applySize('portrait'));
    if (btnL) btnL.addEventListener('click', () => applySize('landscape'));

    return { refresh };
  }

  window.InkPad.Resizer = { initResizer, PORTRAIT, LANDSCAPE };
})();
