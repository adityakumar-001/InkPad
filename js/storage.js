/* storage.js — IndexedDB notebook persistence + settings */
'use strict';
window.InkPad = window.InkPad || {};

(() => {
  const DB_NAME = 'inkpad-db';
  const DB_VER = 1;
  const STORE = 'notebooks';
  const KEY = 'default-notebook';
  const SETTINGS_KEY = 'inkpad-settings-v1';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(KEY);
      rq.onsuccess = () => { db.close(); resolve(rq.result || null); };
      rq.onerror = () => reject(rq.error);
    });
  }

  async function idbClear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  }

  const Storage = {
    loadSettings() {
      try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
      catch { return {}; }
    },
    saveSettings(s) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
    },
    async saveNotebook(doc) {
      // doc: {title, pages, updatedAt}
      try {
        await idbSet(doc);
        return { ok: true };
      } catch (e) {
        const msg = (e && e.name === 'QuotaExceededError')
          ? 'Browser storage is full. Save a copy via Page list → Save / Save as, then delete unused pages/images.'
          : 'Could not save locally: ' + (e && e.message ? e.message : e);
        return { ok: false, error: msg };
      }
    },
    async loadNotebook() {
      try { return await idbGet(); }
      catch (e) { console.warn('loadNotebook failed', e); return null; }
    },
    async clearNotebook() { await idbClear(); },
    async usageEstimate() {
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const { usage, quota } = await navigator.storage.estimate();
          return { usage, quota };
        }
      } catch {}
      return null;
    }
  };

  window.InkPad.Storage = Storage;
})();
