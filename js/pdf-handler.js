/* pdf-handler.js — PDF import (PDF.js render → page backgrounds) */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const MAX_PDF_PAGES = 100;
  const RENDER_SCALE = 1.6;

  async function importPdfFile(ctx, file) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      ctx.toast('Not a PDF file.', 'err');
      return;
    }
    const buf = await file.arrayBuffer();
    await importPdfBytes(ctx, buf, file.name);
  }

  async function importPdfBlob(ctx, blob) {
    const buf = await blob.arrayBuffer();
    await importPdfBytes(ctx, buf, 'linked-document.pdf');
  }

  /** Page size matching the PDF page aspect (long side 1123):
   *  A4 portrait → 794×1123, A4 landscape → 1123×794, 16:9 → 1123×632. */
  function sizeForPdf(imgW, imgH) {
    const C = window.InkPad.Canvas;
    const LONG = 1123;
    const aspect = (imgW > 0 && imgH > 0) ? imgW / imgH : 794 / 1123;
    let w, h;
    if (aspect >= 1) { w = LONG; h = Math.round(LONG / aspect); }
    else { h = LONG; w = Math.round(LONG * aspect); }
    return C.normSize({ w, h });
  }

  async function importPdfBytes(ctx, arrayBuffer, name) {
    if (!window.pdfjsLib) {
      ctx.toast('PDF engine (PDF.js) failed to load. Check your connection and reload.', 'err');
      return;
    }
    let pdf;
    try {
      pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    } catch (e) {
      ctx.toast('Could not open PDF (corrupted or unsupported): ' + (e.message || e), 'err');
      return;
    }
    const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
    if (pdf.numPages > MAX_PDF_PAGES) {
      const ok = await ctx.confirm(`This PDF has ${pdf.numPages} pages. Only the first ${MAX_PDF_PAGES} will be imported (memory safety). Continue?`);
      if (!ok) return;
    }
    ctx.toast(`Rendering ${n} PDF page(s)…`);
    // Collect all backgrounds first, then insert as ONE block starting at
    // notebook page 1 (PDF p.1 → notebook page 1), in A-Z order.
    const bgs = [];
    for (let i = 1; i <= n; i++) {
      try {
        const { dataURL, w, h } = await renderPdfPageToDataURL(pdf, i);
        // canvas auto-matches the PDF page shape (A4 → A4, landscape/16:9 → same)
        bgs.push({ dataURL, kind: 'pdf', label: `${name} p.${i}`, size: sizeForPdf(w, h) });
      } catch (e) {
        console.warn('pdf page render failed', e);
        ctx.toast(`PDF page ${i} failed to render — skipped.`, 'err');
      }
      // yield to keep UI responsive during large imports
      await new Promise(r => setTimeout(r, 0));
    }
    if (!bgs.length) {
      ctx.toast('No PDF pages could be rendered.', 'err');
      return;
    }
    ctx.insertPdfPages(bgs);
    // keep thumbnails fresh (backgrounds need async img decode)
    setTimeout(() => ctx.afterChange(true), 400);
    ctx.toast(`PDF imported: ${bgs.length} page(s) starting at page 1. Draw on top — annotations stay aligned on export.`);
  }

  async function renderPdfPageToDataURL(pdf, pageNum) {
    const page = await pdf.getPage(pageNum);
    const vp = page.getViewport({ scale: RENDER_SCALE });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    page.cleanup();
    return { dataURL: c.toDataURL('image/png'), w: c.width, h: c.height };
  }

  window.InkPad.PdfHandler = { importPdfFile, importPdfBlob, importPdfBytes, sizeForPdf };
})();
