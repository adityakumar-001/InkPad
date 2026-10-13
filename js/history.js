/* history.js — per-page action-based undo/redo (no full-canvas wipe hacks) */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  // Action: {kind:'add'|'delete'|'update'|'clear', pageId, objects:[...], before?:[...], after?:[...]}
  // For simplicity & robustness each action stores affected objects; undo/redo
  // mutates only the target page's object list then re-renders that page.
  class PageHistory {
    constructor(limit = 80) {
      this.limit = limit;
      this.stacks = new Map(); // pageId -> {undo:[], redo:[]}
    }
    _s(pageId) {
      if (!this.stacks.has(pageId)) this.stacks.set(pageId, { undo: [], redo: [] });
      return this.stacks.get(pageId);
    }
    push(pageId, action) {
      const s = this._s(pageId);
      s.undo.push(action);
      if (s.undo.length > this.limit) s.undo.shift();
      s.redo.length = 0; // new action invalidates redo
      this._emit();
    }
    canUndo(pageId) { return this._s(pageId).undo.length > 0; }
    canRedo(pageId) { return this._s(pageId).redo.length > 0; }
    dropPage(pageId) { this.stacks.delete(pageId); }

    /** Apply undo to the live pages array. Returns true if something changed. */
    undo(pages, pageId) {
      const s = this._s(pageId);
      const a = s.undo.pop();
      if (!a) return false;
      const page = pages.find(p => p.id === pageId);
      if (!page) return false;
      this._applyInverse(page, a);
      s.redo.push(a);
      this._emit();
      return true;
    }
    redo(pages, pageId) {
      const s = this._s(pageId);
      const a = s.redo.pop();
      if (!a) return false;
      const page = pages.find(p => p.id === pageId);
      if (!page) return false;
      this._applyForward(page, a);
      s.undo.push(a);
      this._emit();
      return true;
    }
    _applyInverse(page, a) {
      if (a.kind === 'add') {
        const ids = new Set(a.objects.map(o => o.id));
        page.objects = page.objects.filter(o => !ids.has(o.id));
      } else if (a.kind === 'delete') {
        page.objects.push(...a.objects.map(clone));
      } else if (a.kind === 'update') {
        for (const b of a.before) {
          const i = page.objects.findIndex(o => o.id === b.id);
          if (i >= 0) page.objects[i] = clone(b);
        }
      } else if (a.kind === 'clear') {
        page.objects = a.before.map(clone);
        if ('bg' in a) page.background = clone(a.bg);
        if (a.prevSize) page.size = clone(a.prevSize);
      }
    }
    _applyForward(page, a) {
      if (a.kind === 'add') {
        page.objects.push(...a.objects.map(clone));
      } else if (a.kind === 'delete') {
        const ids = new Set(a.objects.map(o => o.id));
        page.objects = page.objects.filter(o => !ids.has(o.id));
      } else if (a.kind === 'update') {
        for (const af of a.after) {
          const i = page.objects.findIndex(o => o.id === af.id);
          if (i >= 0) page.objects[i] = clone(af);
        }
      } else if (a.kind === 'clear') {
        page.objects = [];
        if ('bg' in a) page.background = null;
        if (a.nextSize) page.size = clone(a.nextSize);
      }
    }
    _emit() { document.dispatchEvent(new CustomEvent('inkpad:history')); }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(prefix = 'o') {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  window.InkPad.History = PageHistory;
  window.InkPad.clone = clone;
  window.InkPad.uid = uid;
})();
