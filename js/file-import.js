/* file-import.js — image / URL / JSON imports */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const ACCEPT_IMG = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_IMG_DIM = 4096; // guard: downscale on import to keep storage sane

  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Could not read file'));
      r.readAsDataURL(file);
    });
  }

  function downscaleIfNeeded(dataURL, contentType) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = img;
        if (Math.max(w, h) <= MAX_IMG_DIM) return resolve({ dataURL, w, h });
        const k = MAX_IMG_DIM / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ dataURL: c.toDataURL(contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92), w: c.width, h: c.height });
      };
      img.onerror = () => resolve({ dataURL, w: 0, h: 0 });
      img.src = dataURL;
    });
  }

  function fitIntoPage(nw, nh, maxW = 700, maxH = 900) {
    const k = Math.min(1, maxW / nw, maxH / nh);
    return { w: Math.max(20, Math.round(nw * k)), h: Math.max(20, Math.round(nh * k)) };
  }

  function initFileImport(ctx) {
    const fileImage = document.getElementById('file-image');
    const fileJson = document.getElementById('file-json');
    const modal = document.getElementById('modal-image');
    const preview = document.getElementById('mi-preview');
    const info = document.getElementById('mi-info');
    let pending = null; // {dataURL,w,h}

    fileImage.addEventListener('change', async () => {
      const f = fileImage.files[0];
      fileImage.value = '';
      if (!f) return;
      if (!ACCEPT_IMG.includes(f.type) && !/\.(jpe?g|png|webp)$/i.test(f.name)) {
        ctx.toast('Unsupported image type. Use JPG, PNG or WebP.', 'err');
        return;
      }
      if (f.size > 25 * 1024 * 1024) {
        ctx.toast('Image is very large (>25 MB). It will be downscaled on import.', null);
      }
      try {
        const raw = await readAsDataURL(f);
        const done = await downscaleIfNeeded(raw, f.type);
        pending = done;
        preview.src = done.dataURL;
        info.textContent = `${f.name} — ${done.w}×${done.h}px`;
        ctx.openModal(modal);
      } catch (e) {
        ctx.toast('Could not import image: ' + e.message, 'err');
      }
    });

    document.getElementById('mi-insert').addEventListener('click', () => {
      if (!pending) return;
      insertImageObject(ctx, pending.dataURL, pending.w, pending.h);
      pending = null;
      ctx.closeModals();
    });

    fileJson.addEventListener('change', async () => {
      const f = fileJson.files[0];
      fileJson.value = '';
      if (!f) return;
      try {
        const text = await f.text();
        const doc = JSON.parse(text);
        ctx.restoreBackup(doc);
      } catch (e) {
        ctx.toast('Invalid backup file: ' + e.message, 'err');
      }
    });

    // ── URL import ──
    const urlModal = document.getElementById('modal-url');
    const urlInput = document.getElementById('url-input');
    const urlErr = document.getElementById('url-error');
    document.getElementById('url-fetch').addEventListener('click', async () => {
      urlErr.hidden = true;
      const url = urlInput.value.trim();
      if (!/^https?:\/\/.+/i.test(url)) {
        showUrlErr('Enter a full http(s) URL, e.g. https://example.com/photo.png');
        return;
      }
      const prog = document.getElementById('url-progress');
      prog.hidden = false;
      try {
        const resp = await fetch(url, { mode: 'cors' });
        if (!resp.ok) throw new Error(`Server responded with ${resp.status} ${resp.statusText}`);
        const blob = await resp.blob();
        if (blob.type.startsWith('image/')) {
          if (!ACCEPT_IMG.includes(blob.type)) throw new Error(`Unsupported image type "${blob.type}". Use JPG, PNG or WebP.`);
          const raw = await blobToDataURL(blob);
          const done = await downscaleIfNeeded(raw, blob.type);
          insertImageObject(ctx, done.dataURL, done.w, done.h);
          ctx.closeModals();
        } else if (blob.type === 'application/pdf' || /\.pdf(\?|#|$)/i.test(url)) {
          await window.InkPad.PdfHandler.importPdfBlob(ctx, blob);
          ctx.closeModals();
        } else {
          throw new Error(`Unsupported content type "${blob.type || 'unknown'}". Link must point directly to an image or PDF file.`);
        }
      } catch (e) {
        let msg = e.message;
        if (e instanceof TypeError || /fetch|network|CORS|opaque/i.test(msg)) {
          msg = 'Could not fetch this URL. The server may block cross-origin (CORS) access, require login, or be unreachable. Try downloading the file and importing it directly. (Browser security cannot be bypassed.)';
        }
        showUrlErr(msg);
      } finally { prog.hidden = true; }
    });
    function showUrlErr(m) { urlErr.textContent = m; urlErr.hidden = false; }
    function blobToDataURL(blob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('Could not decode download'));
        r.readAsDataURL(blob);
      });
    }

    return {
      pickImage: () => fileImage.click(),
      pickJson: () => fileJson.click(),
      openUrlModal: () => { urlErr.hidden = true; urlInput.value = ''; ctx.openModal(urlModal); setTimeout(() => urlInput.focus(), 50); }
    };
  }

  function insertImageObject(ctx, dataURL, nw, nh) {
    const page = ctx.getPage();
    if (!page) return;
    const { w: DOC_W, h: DOC_H } = window.InkPad.Canvas.pageSizeOf(page);
    const { w, h } = fitIntoPage(nw || 600, nh || 400);
    const obj = {
      id: window.InkPad.uid('i'), type: 'image', src: dataURL,
      x: Math.round((DOC_W - w) / 2), y: Math.round((DOC_H - h) / 2), w, h
    };
    // warn before covering existing content? Only if page already has a background
    page.objects.push(obj);
    ctx.history.push(page.id, { kind: 'add', objects: [window.InkPad.clone(obj)] });
    ctx.toast(`Image inserted (${w}×${h}). Use Select tool to move/resize.`);
    // switch to select so user can reposition immediately
    ctx.setTool('select');
    ctx.setSelected(obj.id);
    ctx.afterChange();
  }

  window.InkPad.FileImport = { initFileImport, insertImageObject };
})();
