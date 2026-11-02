// Persistencia automática de la sesión en IndexedDB.
// Guarda el archivo ya limpio, el esquema de columnas, la salud de los datos y el estado del dashboard
// (filtros, gráficas, explorador, insights de IA) para que nada se pierda si el celular recarga la pestaña.
// IndexedDB (no localStorage): sin límite de 5 MB, asíncrono, y guarda fechas (Date) de forma nativa.
(function () {
  'use strict';
  const A = window.DashApp;
  const D = window.DataKit;
  const $ = (q) => document.querySelector(q);
  const MAX_RECENT = 3;

  // ---------- Envoltorio ligero de IndexedDB ----------

  class SessionStorageManager {
    constructor(name = 'DashboardAppDB', store = 'sessions') {
      this.name = name;
      this.store = store;
      this.db = null;
    }
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open(this.name, 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.store)) {
            const os = db.createObjectStore(this.store, { keyPath: 'id' });
            os.createIndex('updatedAt', 'updatedAt');
          }
        };
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB bloqueada por otra pestaña.'));
      });
    }
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(this.store, mode);
        const os = t.objectStore(this.store);
        let result;
        Promise.resolve(fn(os)).then((r) => { result = r; }, reject);
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
      });
    }
    put(record) { return this.tx('readwrite', (os) => os.put(record)); }
    get(id) { return this.tx('readonly', (os) => os.get(id)); }
    delete(id) { return this.tx('readwrite', (os) => os.delete(id)); }
    clear() { return this.tx('readwrite', (os) => os.clear()); }
    // Lista ligera (sin los datos) ordenada de la más reciente a la más antigua.
    async list() {
      const all = await this.tx('readonly', (os) => os.getAll());
      return (all || []).map((r) => ({ id: r.id, fileName: r.fileName, updatedAt: r.updatedAt, sheet: r.sheet, rowCount: r.rowCount, size: r.size }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
  }

  const store = new SessionStorageManager();
  let available = typeof indexedDB !== 'undefined';
  let warned = false;
  let initError = available ? null : new Error('IndexedDB no existe en este navegador');

  function warn(err) {
    console.warn('Sesión no guardada:', err);
    if (warned) return;
    warned = true;
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
    A.toast(quota
      ? 'No hay espacio en este dispositivo para guardar la sesión. El dashboard sigue funcionando.'
      : 'Este navegador no permite guardar la sesión (¿modo incógnito?). El dashboard sigue funcionando.');
  }

  // ---------- Auto-guardado con debounce ----------

  let timer = null, saving = false, again = false;
  function schedule() {
    if (!available) { if (initError) warn(initError); return; }
    clearTimeout(timer);
    timer = setTimeout(saveNow, 500);
  }
  async function saveNow() {
    clearTimeout(timer);
    if (!available) return;
    if (saving) { again = true; return; }
    const rec = A.serialize();
    if (!rec) return;
    saving = true;
    try {
      await store.put(rec);
      // Conserva solo los últimos 3 archivos.
      const list = await store.list();
      for (const old of list.slice(MAX_RECENT)) await store.delete(old.id);
      renderRecent(list.slice(0, MAX_RECENT));
    } catch (err) {
      if (err && err.name === 'QuotaExceededError') {
        // Sin espacio: libera los archivos viejos y reintenta una vez con solo el actual.
        try {
          const list = await store.list();
          for (const old of list) if (old.id !== rec.id) await store.delete(old.id);
          await store.put(rec);
        } catch (e2) { warn(e2); }
      } else warn(err);
    } finally {
      saving = false;
      if (again) { again = false; schedule(); }
    }
  }

  // ---------- Restauración y banner ----------

  function ago(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `hace ${hrs} h`;
    return `hace ${Math.round(hrs / 24)} día(s)`;
  }

  function showBanner(rec) {
    const b = $('#sessionBanner');
    b.hidden = false;
    const mk = (tag, attrs, text) => { const n = document.createElement(tag); Object.assign(n, attrs); if (text) n.textContent = text; return n; };
    b.replaceChildren(
      mk('span', { className: 'grow' }, `Sesión restaurada: ${rec.fileName}${rec.sheet && rec.book.order.length > 1 ? ` · ${rec.sheet}` : ''} (guardado ${ago(rec.updatedAt)})`),
      (() => {
        const box = mk('div', { className: 'btns' });
        box.append(
          mk('button', { className: 'btn sm', onclick: newSession, title: 'Cierra esta sesión y vuelve a la pantalla para subir un archivo' }, '🔄 Nueva sesión'),
          mk('button', { className: 'btn sm ghost', onclick: wipeAll, title: 'Borra todos los datos guardados en este navegador' }, '🗑️ Borrar datos locales'),
          mk('button', { className: 'icon-btn', onclick: () => { b.hidden = true; }, title: 'Ocultar aviso', ariaLabel: 'Ocultar aviso' }, '×'));
        return box;
      })());
  }

  async function restore(id) {
    let rec;
    try { rec = await store.get(id); } catch (err) { warn(err); return false; }
    if (!rec || !rec.book) return false;
    try {
      A.restore(rec);
      showBanner(rec);
      return true;
    } catch (err) {
      console.error('No se pudo restaurar la sesión', err);
      A.toast('La sesión guardada estaba dañada y se descartó.');
      try { await store.delete(id); } catch { /* nada */ }
      return false;
    }
  }

  async function newSession() {
    clearTimeout(timer);
    const id = A.state.sessionId;
    A.resetToUpload();
    try { if (id) await store.delete(id); } catch (err) { warn(err); }
    refreshRecent();
  }

  async function wipeAll() {
    if (!confirm('¿Borrar todos los archivos y sesiones guardados en este navegador?')) return;
    clearTimeout(timer);
    A.resetToUpload();
    try { await store.clear(); } catch (err) { warn(err); }
    renderRecent([]);
    A.toast('Datos locales borrados.');
  }

  // ---------- Archivos recientes ----------

  function renderRecent(list) {
    const box = $('#recentFiles');
    const sel = $('#recentSelect');
    const others = list.filter((r) => r.id !== A.state.sessionId);
    // Pantalla de carga: lista de tarjetas.
    box.hidden = !list.length;
    box.replaceChildren();
    if (list.length) {
      const h2 = document.createElement('h2');
      h2.textContent = 'Archivos recientes';
      const wrap = document.createElement('div');
      wrap.className = 'recent-list';
      list.forEach((r) => {
        const b = document.createElement('button');
        b.className = 'recent-item';
        b.type = 'button';
        const name = document.createElement('b');
        name.textContent = r.fileName;
        const meta = document.createElement('small');
        meta.textContent = `${r.rowCount ? D.fmtNum(r.rowCount) + ' filas · ' : ''}${ago(r.updatedAt)}`;
        b.append(name, meta);
        b.addEventListener('click', () => restore(r.id));
        wrap.append(b);
      });
      box.append(h2, wrap);
    }
    // Barra superior: selector para cambiar de archivo en un toque.
    sel.hidden = !others.length || !A.state.book;
    sel.replaceChildren();
    if (others.length) {
      const o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = 'Recientes…';
      sel.append(o0, ...others.map((r) => { const o = document.createElement('option'); o.value = r.id; o.textContent = `${r.fileName} (${ago(r.updatedAt)})`; return o; }));
    }
  }
  $('#recentSelect').addEventListener('change', async (e) => {
    const id = e.target.value;
    e.target.value = '';
    if (!id) return;
    await saveNow();
    restore(id);
  });

  async function refreshRecent() {
    if (!available) return;
    try { renderRecent((await store.list()).slice(0, MAX_RECENT)); } catch (err) { available = false; }
  }

  // Guarda también al ocultar la pestaña (el celular puede descartarla en segundo plano).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer) saveNow(); });

  // ---------- Al abrir la página: restaurar en silencio ----------

  async function init() {
    if (!available) return;
    try {
      const list = await store.list();
      renderRecent(list.slice(0, MAX_RECENT));
      if (list.length && !A.state.book) await restore(list[0].id);
    } catch (err) {
      available = false; // modo incógnito estricto o sin permiso: se trabaja solo en memoria
      initError = err;
    }
  }

  window.DashSession = { schedule, saveNow, restore, newSession, wipeAll, store, list: () => store.list() };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
