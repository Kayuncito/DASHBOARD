// Interfaz del dashboard.
(function () {
  'use strict';
  const D = window.DataKit;
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => c !== null && c !== undefined && n.append(c));
    return n;
  };

  const CHART_TYPES = [
    { id: 'bar', label: 'Barras', icon: 'M4 20h3V10H4zm6.5 0h3V4h-3zM17 20h3v-7h-3z' },
    { id: 'hbar', label: 'Barras horiz.', icon: 'M4 4v3h10V4zm0 6.5v3h16v-3zM4 17v3h7v-3z' },
    { id: 'line', label: 'Línea', icon: 'M3 17l5-6 4 3 7-9 1.5 1.2-8.2 10.6-4-3L4.5 18.3z' },
    { id: 'area', label: 'Área', icon: 'M3 20V16l5-6 4 3 8-9v16z' },
    { id: 'pie', label: 'Dona', icon: 'M11 2v4a6 6 0 1 0 7 7h4A10 10 0 1 1 11 2zm2 0a10 10 0 0 1 9 9h-4a6 6 0 0 0-5-5z' },
    { id: 'scatter', label: 'Dispersión', icon: 'M5 17a2 2 0 1 0 0 .1zm5-5a2 2 0 1 0 0 .1zm4 4a2 2 0 1 0 0 .1zm2-9a2 2 0 1 0 0 .1zm3 5a2 2 0 1 0 0 .1z' },
  ];
  const AGG_LABEL = { count: 'Conteo', sum: 'Suma', avg: 'Promedio', min: 'Mínimo', max: 'Máximo', distinct: 'Únicos' };
  // Prioridad para elegir las métricas principales (la primera coincidencia gana).
  const METRIC_TIERS = [
    /(venta|monto|total|importe|ingreso|factura|revenue|sales|amount)/i,
    /(utilidad|profit|ganancia|margen)/i,
    /(costo|cost|gasto|expense)/i,
    /(cantidad|unidades|qty|quantity|piezas|volumen)/i,
    /(valor|value|saldo|balance)/i,
  ];
  const metricRank = (c) => { if (c.percent) return 99; const i = METRIC_TIERS.findIndex((re) => re.test(c.name)); return i < 0 ? (/(precio|price|tarifa|rate|%)/i.test(c.name) ? 99 : 50) : i; };

  const state = {
    fileName: '',
    book: null,
    sheet: '',
    columns: [],
    rows: [],
    filters: {},       // { col: Set(valores) }
    dateFilter: null,  // { col, from: Date|null, to: Date|null }
    charts: [],
    instances: new Map(),
    table: { page: 0, sort: null, dir: 1, search: '', size: 50 },
    editing: null,
    nextId: 1,
    excludeOutliers: false,             // excluir atípicos de gráficas y KPIs (sin borrarlos de la tabla)
    outliers: { rows: new Set(), detail: [] },
    explorer: { x: '', y: '', agg: '' }, // tabla dinámica
    aiInsights: null,                    // { text, at } generados por IA (se guardan en la sesión)
    sessionId: null,
  };
  const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

  // ---------- Tema ----------

  function storedTheme() { try { return localStorage.getItem('dash-theme'); } catch { return null; } }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(storedTheme());
  $('#btnTheme').addEventListener('click', () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    const t = dark ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('dash-theme', t); } catch { /* sin almacenamiento */ }
    renderCharts();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderCharts());

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
      other: v('--series-other'),
      surface: v('--surface-1'),
      grid: v('--grid'),
      text: v('--text-secondary'),
      muted: v('--text-muted'),
      primary: v('--text-primary'),
      border: v('--border'),
    };
  }
  function alpha(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ---------- Carga de archivos ----------

  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  ['dragenter', 'dragover'].forEach((e) => dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.remove('over'); }));
  dropZone.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (f) loadFile(f); });
  dropZone.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) loadFile(f); fileInput.value = ''; });
  // Permitir soltar un archivo también sobre el dashboard.
  document.addEventListener('dragover', (ev) => ev.preventDefault());
  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    if (!$('#dashView').hidden && ev.dataTransfer.files[0]) loadFile(ev.dataTransfer.files[0]);
  });

  $('#btnSample').addEventListener('click', () => {
    const csv = window.buildSampleCSV();
    const table = D.parseDelimited(csv);
    openBook({ sheets: { Ventas: table }, order: ['Ventas'] }, 'ventas_ejemplo.csv', { size: csv.length });
  });
  $('#btnNewFile').addEventListener('click', () => fileInput.click());

  function showError(msg) {
    const e = $('#uploadError');
    e.textContent = msg;
    e.hidden = !msg;
    if (msg && !$('#dashView').hidden) alert(msg);
  }

  async function loadFile(file) {
    showError('');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['csv', 'txt', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(ext)) {
      showError('Formato no soportado. Usa archivos .csv, .xlsx, .xls o .txt.');
      return;
    }
    dropZone.querySelector('.dz-title').textContent = 'Procesando…';
    try {
      const book = await D.readFile(file);
      openBook(book, file.name, { size: file.size });
    } catch (err) {
      console.error(err);
      showError('No se pudo leer el archivo: ' + (err.message || err));
    } finally {
      dropZone.querySelector('.dz-title').textContent = 'Arrastra tu archivo aquí';
    }
  }

  function openBook(book, name, opts = {}) {
    state.book = book;
    state.fileName = name;
    state.sessionId = opts.sessionId || `s${Date.now()}`;
    state.loadedAt = opts.loadedAt || Date.now();
    state.fileSize = opts.size || 0;
    state.aiInsights = null;
    state.excludeOutliers = false;
    state.explorer = { x: '', y: '', agg: '' };
    const sel = $('#sheetSelect');
    sel.replaceChildren(...book.order.map((s) => el('option', { value: s }, s)));
    $('#sheetPicker').hidden = book.order.length < 2;
    $('#btnBook').hidden = book.order.length < 2;
    analyzeBook();
    openSheet(opts.sheet && book.sheets[opts.sheet] ? opts.sheet : state.bookInfo.recommended || book.order[0]);
    if (book.order.length > 1 && !opts.silent) openBookDialog();
    if (window.DashSession && !opts.silent) window.DashSession.saveNow();
  }

  $('#sheetSelect').addEventListener('change', (e) => openSheet(e.target.value));

  function openSheet(name) {
    const t = state.book.sheets[name];
    if (!t.rows.length) { showError('La hoja no tiene filas de datos.'); return; }
    if (!t.original) {
      t.original = { columns: window.Cleaner.cloneCols(t.columns), rows: t.rows };
      t.history = [];
      t.log = [];
      t.ignored = new Set();
    }
    state.sheet = name;
    $('#sheetSelect').value = name;
    state.tbl = t;
    state.columns = t.columns;
    state.rows = t.rows;
    state.filters = {};
    state.table = { page: 0, sort: null, dir: 1, search: '', size: 50 };
    $('#tableSearch').value = '';
    const dateCol = t.columns.find((c) => c.type === 'date' && c.unique > 1);
    state.dateFilter = dateCol ? { col: dateCol.name, from: null, to: null } : null;
    state.filters = defaultFilters();
    state.charts = suggestCharts();
    state.bannerClosed = false;

    $('#uploadView').hidden = true;
    $('#dashView').hidden = false;
    $('#btnNewFile').hidden = false;
    $('#btnAgent').hidden = false;
    updateInfo();
    buildFilters();
    analyzeData();
    refresh();
  }

  function updateInfo() {
    const info = $('#fileInfo');
    info.hidden = false;
    info.textContent = `${state.fileName}${state.book.order.length > 1 ? ' · ' + state.sheet : ''} · ${D.fmtNum(state.rows.length)} filas · ${state.columns.length} columnas`;
    info.title = info.textContent;
  }

  // Sustituye los datos de la hoja actual (después de limpiar, deshacer o restaurar).
  function setData(columns, rows) {
    const t = state.tbl;
    t.columns = columns;
    t.rows = rows;
    D.restat(columns, rows);
    state.columns = columns;
    state.rows = rows;
    const names = new Set(columns.map((c) => c.name));
    for (const c of Object.keys(state.filters)) if (!names.has(c)) delete state.filters[c];
    for (const [c, set] of Object.entries(state.filters)) {
      const valid = new Set(col(c).values || []);
      [...set].forEach((v) => { if (!valid.has(v)) set.delete(v); });
      if (!set.size) delete state.filters[c];
    }
    if (state.dateFilter && !names.has(state.dateFilter.col)) state.dateFilter = null;
    state.charts = state.charts.filter((c) => names.has(c.x) && (!c.y || names.has(c.y)));
    state.charts.forEach((c) => { if (c.series && !names.has(c.series)) c.series = ''; if (c.ys) c.ys = c.ys.filter((n) => names.has(n)); });
    if (!state.charts.length) state.charts = suggestCharts();
    updateInfo();
    buildFilters();
    analyzeData();
    refresh();
  }

  // ---------- Columnas útiles ----------

  const col = (name) => state.columns.find((c) => c.name === name);
  function metrics() {
    const nums = state.columns.filter((c) => c.type === 'number' && !c.idLike && !c.ordinalLike && c.unique > 1);
    // Columnas casi vacías (p. ej. un total que solo viene en algunas filas) van al final.
    return nums.map((c, i) => [c, metricRank(c) + (c.filled < state.rows.length * 0.6 ? 100 : 0), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([c]) => c);
  }
  function categories() {
    return state.columns.filter((c) => c.type === 'text' && c.categorical && c.unique >= 2);
  }

  // ¿Los datos son una serie de tiempo? (una fila por fecha, o fechas de inicio de mes/trimestre).
  function timeInfo() {
    const date = state.columns.find((c) => c.type === 'date');
    if (!date || date.unique < 3) return { date: null, periodic: false, onePer: false };
    const onePer = date.unique >= date.filled * 0.95 && date.filled >= 3;
    const periodic = onePer || !!date.monthStart;
    let grain = D.autoGrain(date);
    if (date.monthStart) {
      const months = new Set(state.rows.map((r) => r[date.name]).filter(Boolean).map((d) => d.getMonth()));
      const quarterly = [...months].every((m) => m % 3 === 0);
      if (quarterly) grain = 'quarter';
      else if (date.unique <= 150) grain = 'month';
    }
    return { date, periodic, onePer, grain };
  }
  // En series de tiempo y tasas no tiene sentido sumar: se promedia.
  const defaultAgg = (m, t) => (!m ? 'count' : m.percent || (t && t.periodic) ? 'avg' : 'sum');

  // Agrupa columnas de magnitud parecida para poder graficarlas juntas en un mismo eje.
  function clusterByScale(cols, ratio = 2.5) {
    const groups = [];
    cols.forEach((c) => {
      const mag = Math.max(Math.abs(c.max || 0), Math.abs(c.min || 0)) || 1;
      const g = groups.find((x) => x.length < 4 && mag / x.mag <= ratio && x.mag / mag <= ratio);
      if (g) g.push(c); else { const n = [c]; n.mag = mag; groups.push(n); }
    });
    return groups;
  }

  // En formato largo con varias dimensiones (p. ej. Sexo y Tipo_cifra), fija las dimensiones extra
  // en su valor más común para no promediar cosas distintas (cifras originales con desestacionalizadas).
  function defaultFilters() {
    const t = timeInfo();
    if (!t.periodic || t.onePer) return {};
    const seriesCols = categories().filter((c) => c.unique >= 2 && c.unique <= 8).sort((a, b) => b.unique - a.unique);
    const out = {};
    seriesCols.slice(1).forEach((c) => { out[c.name] = new Set([c.values[0]]); });
    return out;
  }

  // Par de columnas numéricas con la correlación más fuerte (evita pares triviales r≈1).
  function scatterPair(m) {
    let best = null;
    const nums = m.filter((c) => !c.percent).slice(0, 6);
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) {
      const xs = [], ys = [];
      state.rows.forEach((r) => { const a = r[nums[i].name], b = r[nums[j].name]; if (typeof a === 'number' && typeof b === 'number') { xs.push(a); ys.push(b); } });
      const r = window.Insights.pearson(xs, ys);
      if (r !== null && Math.abs(r) < 0.995 && (!best || Math.abs(r) > Math.abs(best.r))) best = { a: nums[i], b: nums[j], r };
    }
    return best && Math.abs(best.r) >= 0.3 ? [best.a, best.b] : null;
  }

  function suggestCharts() {
    const m = metrics();
    const cats = categories();
    const t = timeInfo();
    const date = t.date;
    const m1 = m[0];
    const out = [];
    const add = (c) => out.push({ id: state.nextId++, limit: 10, sort: null, title: '', ...c });
    const seriesCols = cats.filter((c) => c.unique >= 2 && c.unique <= 8).sort((a, b) => b.unique - a.unique);

    if (t.periodic && m1) {
      if (t.onePer || !seriesCols.length) {
        // Serie de tiempo: una gráfica por grupo de columnas comparables.
        const groups = [...clusterByScale(m.filter((x) => !x.percent)), ...clusterByScale(m.filter((x) => x.percent))];
        groups.slice(0, 5).forEach((g, i) => add({
          type: i === 0 && g.length === 1 ? 'area' : 'line', x: date.name, y: g[0].name, ys: g.slice(1).map((c) => c.name),
          agg: 'avg', grain: t.grain, wide: i === 0, trend: g.length === 1,
          title: g.length > 1 ? `${g.map((c) => c.name).join(', ')} por ${date.name}` : '',
        }));
      } else {
        // Formato largo (Fecha, Categoría, Valor): una línea por categoría.
        add({ type: 'line', x: date.name, y: m1.name, agg: 'avg', grain: t.grain, series: seriesCols[0].name, wide: true });
        add({ type: 'bar', x: seriesCols[0].name, y: m1.name, agg: 'avg' });
        if (m[1]) add({ type: 'line', x: date.name, y: m[1].name, agg: 'avg', grain: t.grain, series: seriesCols[0].name });
      }
      return out;
    }

    const agg = defaultAgg(m1, t);
    const y = m1 ? m1.name : null;
    // Fecha + número: línea/área con agrupación automática y línea de tendencia.
    if (date) add({ type: 'area', x: date.name, y, agg, grain: t.grain || D.autoGrain(date), wide: true, trend: true });
    // Columna de nombres (una fila por elemento: estados, productos, clientes…).
    const label = labelColumn();
    if (label && m1) add({ type: 'hbar', x: label.name, y, agg, limit: 15, other: false, wide: !date, title: `${y} por ${label.name} (top 15)` });
    const pct = m.find((x) => x.percent && x !== m1);
    if (label && pct) add({ type: 'hbar', x: label.name, y: pct.name, agg: 'avg', limit: 15, other: false, title: `${pct.name} por ${label.name} (top 15)` });
    const small = [...cats].filter((c) => c.unique <= 6).sort((a, b) => a.unique - b.unique)[0];
    const main = cats.find((c) => c !== small) || null;
    // Categoría + número: ≤ 6 categorías → dona; más → barras horizontales Top 10 + "Otros".
    const catChart = (c, yName, a) => {
      const yC = yName ? col(yName) : null;
      add({ type: autoChartType(c, yC, a), x: c.name, y: yName, agg: a, limit: 10 });
    };
    if (main) catChart(main, y, agg);
    if (small) catChart(small, y, agg);
    const restCats = cats.filter((c) => c !== main && c !== small);
    if (restCats[0]) catChart(restCats[0], y, agg);
    if (restCats[1] && m[1]) catChart(restCats[1], m[1].name, defaultAgg(m[1], t));
    // Dos números: dispersión con coeficiente de correlación de Pearson.
    if (m.length >= 2 && out.length < 6) {
      const pair = scatterPair(m);
      if (pair) add({ type: 'scatter', x: pair[0].name, y: pair[1].name, agg: 'none' });
    }

    if (!out.length) {
      const first = state.columns.find((c) => c.type === 'text') || state.columns[0];
      if (first) add({ type: 'bar', x: first.name, y: null, agg: 'count' });
    }
    return out.slice(0, 6);
  }

  // ---------- Filtros ----------

  function buildFilters() {
    const box = $('#filters');
    box.replaceChildren();
    const cats = categories().filter((c) => c.unique <= 200).sort((a, b) => a.unique - b.unique).slice(0, 5);
    cats.forEach((c) => {
      const sel = el('select', { 'data-col': c.name, 'aria-label': `Filtrar por ${c.name}` },
        el('option', { value: '' }, 'Todos'),
        c.values.slice().sort((a, b) => a.localeCompare(b, 'es', { numeric: true })).map((v) => el('option', { value: v }, v)));
      sel.addEventListener('change', () => {
        if (sel.value) state.filters[c.name] = new Set([sel.value]);
        else delete state.filters[c.name];
        refresh();
      });
      box.append(el('label', { class: 'field' }, el('span', {}, c.name), sel));
    });
    if (state.dateFilter) {
      const dc = col(state.dateFilter.col);
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const mk = (key, label) => {
        const inp = el('input', { type: 'date', min: iso(dc.min), max: iso(dc.max), 'aria-label': `${label} (${dc.name})` });
        inp.addEventListener('change', () => {
          if (inp.value) {
            const [y, m, d] = inp.value.split('-').map(Number);
            state.dateFilter[key] = key === 'to' ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
          } else state.dateFilter[key] = null;
          refresh();
        });
        return el('label', { class: 'field' }, el('span', {}, `${dc.name} · ${label}`), inp);
      };
      box.append(mk('from', 'desde'), mk('to', 'hasta'));
    }
  }

  function syncFilterControls() {
    document.querySelectorAll('#filters select[data-col]').forEach((sel) => {
      const set = state.filters[sel.dataset.col];
      let extra = sel.querySelector('option[data-multi]');
      if (extra) extra.remove();
      if (!set) sel.value = '';
      else if (set.size === 1) sel.value = [...set][0];
      else {
        extra = el('option', { value: '__multi__', 'data-multi': true }, `${set.size} seleccionados`);
        sel.append(extra);
        sel.value = '__multi__';
      }
    });
    if (state.dateFilter) {
      const inputs = document.querySelectorAll('#filters input[type="date"]');
      const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '');
      if (inputs[0]) inputs[0].value = iso(state.dateFilter.from);
      if (inputs[1]) inputs[1].value = iso(state.dateFilter.to);
    }
  }

  function renderChips() {
    const box = $('#activeFilters');
    box.replaceChildren();
    for (const [c, set] of Object.entries(state.filters)) {
      const vals = [...set];
      box.append(el('span', { class: 'chip' }, `${c}: `, el('b', {}, vals.length > 3 ? `${vals.slice(0, 3).join(', ')} +${vals.length - 3}` : vals.join(', ')),
        el('button', { 'aria-label': `Quitar filtro ${c}`, title: 'Quitar filtro', onclick: () => { delete state.filters[c]; refresh(); } }, '×')));
    }
    const df = state.dateFilter;
    if (df && (df.from || df.to)) {
      box.append(el('span', { class: 'chip' }, `${df.col}: `, el('b', {}, `${df.from ? D.fmtDate(df.from) : '…'} – ${df.to ? D.fmtDate(df.to) : '…'}`),
        el('button', { 'aria-label': 'Quitar filtro de fechas', title: 'Quitar filtro', onclick: () => { df.from = df.to = null; refresh(); } }, '×')));
    }
  }

  $('#btnReset').addEventListener('click', () => {
    state.filters = {};
    if (state.dateFilter) state.dateFilter.from = state.dateFilter.to = null;
    refresh();
  });

  // Filas filtradas; `except` omite el filtro de una columna (para resaltar en lugar de ocultar).
  function filteredRows(except, opts = {}) {
    const fs = Object.entries(state.filters).filter(([c]) => c !== except);
    const df = state.dateFilter && (state.dateFilter.from || state.dateFilter.to) && state.dateFilter.col !== except ? state.dateFilter : null;
    const out = state.excludeOutliers && !opts.table && state.outliers.rows.size ? state.outliers.rows : null;
    if (!fs.length && !df && !out) return state.rows;
    return state.rows.filter((r) => {
      if (out && out.has(r)) return false;
      for (const [c, set] of fs) if (!set.has(r[c])) return false;
      if (df) {
        const v = r[df.col];
        if (!v) return false;
        if (df.from && v < df.from) return false;
        if (df.to && v > df.to) return false;
      }
      return true;
    });
  }

  function toggleFilter(colName, value) {
    const set = state.filters[colName] || new Set();
    if (set.has(value)) set.delete(value); else set.add(value);
    if (set.size) state.filters[colName] = set; else delete state.filters[colName];
    refresh();
  }

  function refresh() {
    syncFilterControls();
    renderChips();
    renderOutlierToggle();
    renderKpis();
    renderInsights();
    renderExplorer();
    renderCharts();
    state.table.page = 0;
    renderTable();
    notifyChange();
  }

  // Avisa al módulo de sesión (IndexedDB) que hay cambios que guardar.
  function notifyChange() { if (window.DashSession && state.book) window.DashSession.schedule(); }

  // ---------- Valores atípicos (excluir temporalmente) ----------

  function renderOutlierToggle() {
    const box = $('#outlierToggle');
    const n = state.outliers.rows.size;
    box.hidden = !n;
    if (!n) return;
    const det = state.outliers.detail.map((d) => `${d.col}: ${d.n}`).join(', ');
    box.replaceChildren(el('label', { class: 'check', title: `Valores extremos (IQR × 3) — ${det}` },
      el('input', { type: 'checkbox', checked: state.excludeOutliers, onchange: (e) => { state.excludeOutliers = e.target.checked; refresh(); } }),
      ` Excluir ${D.fmtNum(n)} atípico(s) de las gráficas`));
  }

  // ---------- KPIs ----------

  // Tarjetas de KPI: valor abreviado + cifra exacta (visible siempre, también en exportaciones).
  function kpiTiles() {
    const rows = filteredRows();
    const tiles = [];
    const total = state.rows.length;
    tiles.push({ label: 'Registros', value: D.fmtNum(rows.length), sub: rows.length === total ? 'Total del archivo' : `de ${D.fmtNum(total)} (${D.fmtNum((rows.length / total) * 100)}%)` });
    const t = timeInfo();
    const val = (m, v) => ({ value: D.fmtValue(v, m, true), exact: D.isCompacted(v, m) ? D.fmtValue(v, m, false) : '' });
    if (t.onePer) {
      // Serie de tiempo: último valor y cambio contra el periodo anterior.
      const dc = t.date.name;
      const sorted = rows.filter((r) => r[dc]).sort((a, b) => a[dc] - b[dc]);
      const kpiCols = [...clusterByScale(metrics().filter((x) => !x.percent)), ...clusterByScale(metrics().filter((x) => x.percent))].map((g) => g[0]).slice(0, 4);
      tiles.length = 0;
      kpiCols.forEach((m) => {
        const withVal = sorted.filter((r) => typeof r[m.name] === 'number');
        const last = withVal[withVal.length - 1], prev = withVal[withVal.length - 2];
        if (!last) return;
        let sub = D.dateKey(last[dc], t.grain === 'quarter' ? 'quarter' : 'month').label;
        let trend = '';
        if (prev) {
          const dv = last[m.name] - prev[m.name];
          trend = dv > 0 ? 'up' : dv < 0 ? 'down' : '';
          const arrow = dv > 0 ? '▲' : dv < 0 ? '▼' : '=';
          sub += m.percent
            ? ` · ${arrow} ${D.fmtNum(Math.abs(dv * 100))} pp vs anterior`
            : prev[m.name] ? ` · ${arrow} ${D.fmtNum(Math.abs((dv / prev[m.name]) * 100))}% vs anterior` : '';
        }
        tiles.push({ label: `${m.name} · último`, ...val(m, last[m.name]), sub, trend });
      });
    } else metrics().slice(0, 3).forEach((m) => {
      if (m.percent || t.periodic) {
        const avg = D.summarize(rows, m.name, 'avg');
        tiles.push({ label: `${m.name} · promedio`, ...val(m, avg), sub: `Mín. ${D.fmtValue(D.summarize(rows, m.name, 'min'), m, true)} · Máx. ${D.fmtValue(D.summarize(rows, m.name, 'max'), m, true)}` });
        return;
      }
      tiles.push({ label: `${m.name} · total`, ...val(m, D.summarize(rows, m.name, 'sum')), sub: `Promedio: ${D.fmtValue(D.summarize(rows, m.name, 'avg'), m, true)}` });
    });
    if (state.dateFilter) {
      const dc = state.dateFilter.col;
      let min = null, max = null;
      rows.forEach((r) => { const v = r[dc]; if (v) { if (!min || v < min) min = v; if (!max || v > max) max = v; } });
      const periods = t.periodic ? new Set(rows.map((r) => r[dc] && D.dateKey(r[dc], t.grain).key).filter(Boolean)).size : 0;
      const unit = { month: 'meses', quarter: 'trimestres', year: 'años', week: 'semanas', day: 'días' }[t.grain] || 'periodos';
      tiles.push({ label: `Periodo (${dc})`, value: min ? (t.periodic ? `${periods} ${unit}` : `${Math.round((max - min) / 86400000) + 1} días`) : '—', sub: min ? `${D.fmtDate(min)} – ${D.fmtDate(max)}` : 'Sin fechas' });
    } else {
      const cats = categories();
      if (cats[0]) tiles.push({ label: `${cats[0].name} · únicos`, value: D.fmtNum(D.summarize(rows, cats[0].name, 'distinct')), sub: `de ${D.fmtNum(cats[0].unique)} en total` });
    }
    return tiles;
  }
  function kpiEl(t) {
    return el('div', { class: 'kpi', title: t.exact || t.value },
      el('div', { class: 'label' }, t.label),
      el('div', { class: `value${t.trend ? ' ' + t.trend : ''}` }, t.value),
      t.exact ? el('div', { class: 'exact' }, t.exact) : null,
      el('div', { class: 'sub' }, t.sub));
  }
  function renderKpis() { $('#kpis').replaceChildren(...kpiTiles().map(kpiEl)); }

  // ---------- Smart Insights (motor local + IA opcional) ----------

  function labelColumn() {
    return state.columns.find((c) => c.type === 'text' && !c.categorical && !c.idLike && c.unique >= 3 && c.unique <= 500 && c.unique >= c.filled * 0.9 && !(c.values || []).every((v) => /^[\d\W_]+$/.test(v)));
  }
  function insights() {
    const t = timeInfo();
    return window.Insights.generate({ rows: filteredRows(), columns: state.columns, metrics: metrics(), categories: categories(), time: t.date ? t : null, label: labelColumn(), log: state.tbl ? state.tbl.log : [], agg: (m) => defaultAgg(m, t) });
  }
  function renderInsights() {
    const box = $('#insights');
    const list = insights();
    const ai = state.aiInsights;
    if (!list.length && !ai) { box.hidden = true; return; }
    box.hidden = false;
    const expanded = box.dataset.expanded === '1';
    const shown = expanded ? list : list.slice(0, 4);
    box.replaceChildren(
      el('div', { class: 'card-head' },
        el('div', {}, el('h2', {}, '✨ Smart Insights'), el('div', { class: 'card-sub' }, 'Hallazgos calculados automáticamente sobre los datos filtrados')),
        el('div', { class: 'card-actions' },
          window.DashAI && window.DashAI.available() ? el('button', { class: 'btn sm agent-btn', onclick: () => window.DashAI.insights() }, ai ? 'Actualizar con IA' : 'Mejorar con IA') : null,
          list.length > 4 ? el('button', { class: 'btn sm ghost', onclick: () => { box.dataset.expanded = expanded ? '0' : '1'; renderInsights(); } }, expanded ? 'Ver menos' : `Ver ${list.length - 4} más`) : null)),
      el('ul', { class: 'insight-list' }, shown.map((i) => el('li', { class: `insight ${i.kind}` }, el('span', { class: 'ico', 'aria-hidden': 'true' }, i.icon), el('span', {}, i.text)))),
      ...(ai ? [el('div', { class: 'ai-insights' }, el('b', {}, '🤖 Análisis de la IA'), el('div', {}, ai.text))] : []));
  }

  // ---------- Explorador (tabla dinámica) ----------

  function renderExplorer() {
    const box = $('#explorer');
    const nums = metrics();
    const groupable = state.columns.filter((c) => (c.type === 'text' && !c.idLike && c.unique >= 2 && c.unique <= 500) || (c.type === 'date' && c.unique > 1));
    if (!groupable.length) { box.hidden = true; return; }
    box.hidden = false;
    const ex = state.explorer;
    if (!groupable.some((c) => c.name === ex.x)) ex.x = (categories()[0] || groupable[0]).name;
    if (ex.y && !nums.some((c) => c.name === ex.y)) ex.y = '';
    if (!ex.y && nums[0]) ex.y = nums[0].name;
    if (!ex.agg) ex.agg = nums[0] ? defaultAgg(col(ex.y), timeInfo()) : 'count';
    const sel = (options, value, onchange, label) => {
      const s2 = el('select', { 'aria-label': label, onchange }, options.map(([v, t]) => el('option', { value: v }, t)));
      s2.value = value;
      return el('label', { class: 'field' }, el('span', {}, label), s2);
    };
    const xc = col(ex.x), yc = ex.agg === 'count' ? null : col(ex.y);
    const rows = filteredRows();
    const t = timeInfo();
    const data = D.aggregate(rows, xc, yc ? yc.name : null, ex.agg, { grain: t.grain || (xc.type === 'date' ? D.autoGrain(xc) : undefined), limit: xc.type === 'text' ? 10 : 0 });
    const total = data.reduce((a, d) => a + (d.value || 0), 0);
    const additive = ex.agg === 'sum' || ex.agg === 'count';
    const fmt = (v) => (yc ? D.fmtValue(v, yc, false) : D.fmtNum(v));
    const auto = autoChartType(xc, yc, ex.agg);
    box.replaceChildren(
      el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, 'Explorador'), el('div', { class: 'card-sub' }, 'Cruza cualquier columna con una métrica; se actualiza con los filtros'))),
      el('div', { class: 'explorer-controls' },
        sel(groupable.map((c) => [c.name, c.name]), ex.x, (e) => { ex.x = e.target.value; renderExplorer(); notifyChange(); }, 'Eje X / Categoría'),
        sel([['', '(conteo de registros)'], ...nums.map((c) => [c.name, c.name])], ex.agg === 'count' ? '' : ex.y, (e) => { ex.y = e.target.value; if (!ex.y) ex.agg = 'count'; else if (ex.agg === 'count') ex.agg = defaultAgg(col(ex.y), timeInfo()); renderExplorer(); notifyChange(); }, 'Métrica Y'),
        sel([['sum', 'Suma'], ['avg', 'Promedio'], ['count', 'Conteo'], ['max', 'Máximo'], ['min', 'Mínimo']], ex.agg, (e) => { ex.agg = e.target.value; if (ex.agg !== 'count' && !ex.y && nums[0]) ex.y = nums[0].name; renderExplorer(); notifyChange(); }, 'Operación'),
        el('button', { class: 'btn primary', disabled: !data.length, onclick: () => {
          state.charts.unshift({ id: state.nextId++, type: auto, x: xc.name, y: yc ? yc.name : null, agg: ex.agg, grain: t.grain || 'month', limit: 10, sort: null, title: '', wide: xc.type === 'date', trend: xc.type === 'date' });
          renderCharts(); notifyChange(); toast('Gráfica agregada al dashboard.');
        } }, '+ Agregar como gráfica')),
      data.length
        ? el('div', { class: 'table-wrap pivot' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, xc.name), el('th', { class: 'num' }, yc ? `${AGG_LABEL[ex.agg]} de ${yc.name}` : 'Registros'), additive ? el('th', { class: 'num' }, '% del total') : null)),
          el('tbody', {}, data.map((d) => el('tr', {}, el('td', {}, d.label), el('td', { class: 'num', title: fmt(d.value) }, fmt(d.value)), additive ? el('td', { class: 'num' }, total ? `${D.fmtNum((d.value / total) * 100)}%` : '—') : null)))))
        : el('div', { class: 'chart-empty', style: 'height:80px' }, 'Sin datos para los filtros actuales'));
  }

  // Regla de selección automática: fecha → línea; ≤6 categorías → dona; más → barras horizontales (Top 10 + Otros).
  function autoChartType(xc, yc, agg) {
    if (xc.type === 'date') return 'line';
    if (xc.type === 'number') return yc ? 'scatter' : 'bar';
    if (xc.unique <= 6 && (agg === 'sum' || agg === 'count')) return 'pie';
    return 'hbar';
  }

  // ---------- Gráficas ----------

  function chartTitle(c) {
    if (c.title) return c.title;
    if (c.type === 'scatter') return `${c.y} vs ${c.x}`;
    const by = c.series ? `${c.x} y ${c.series}` : c.x;
    if (c.agg === 'count') return `Registros por ${by}`;
    if (c.ys && c.ys.length) return `${[c.y, ...c.ys].join(', ')} por ${c.x}`;
    return `${AGG_LABEL[c.agg]} de ${c.y} por ${by}`;
  }

  function renderCharts() {
    const box = $('#charts');
    state.instances.forEach((ch) => ch.destroy());
    state.instances.clear();
    box.replaceChildren();
    if (!state.charts.length) {
      box.append(el('div', { class: 'card chart-card wide' }, el('div', { class: 'chart-empty', style: 'height:160px' }, 'No hay gráficas. Usa “+ Agregar gráfica” para crear una.')));
      return;
    }
    state.charts.forEach((c) => box.append(renderChartCard(c)));
    notifyChange();
  }
  // Al cruzar el punto de corte de celular, volver a dibujar (leyendas abajo, etiquetas rotadas).
  window.matchMedia('(max-width: 767px)').addEventListener('change', () => { if (state.book) renderCharts(); });

  const ICONS = {
    edit: 'M3 17.2V21h3.8l11-11-3.8-3.8zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8z',
    expand: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
    download: 'M5 20h14v-2H5zM12 16l5-5-1.4-1.4-2.6 2.6V4h-2v8.2l-2.6-2.6L7 11z',
    close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z',
  };
  const iconBtn = (name, label, onclick) => el('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick },
    el('span', { html: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${ICONS[name]}"/></svg>` }));

  function renderChartCard(c) {
    const canvas = el('canvas', { role: 'img', 'aria-label': chartTitle(c) });
    const xc = col(c.x);
    const crossFilter = xc && xc.type === 'text' && c.type !== 'scatter';
    const sub = crossFilter ? 'Haz clic en un elemento para filtrar' : c.type === 'scatter' ? 'Cada punto es un registro' : '';
    const card = el('article', { class: `card chart-card${c.wide ? ' wide' : ''}` },
      el('div', { class: 'card-head' },
        el('div', { style: 'min-width:0' }, el('h3', { title: chartTitle(c) }, chartTitle(c)), sub ? el('div', { class: 'card-sub' }, sub) : null),
        el('div', { class: 'card-actions' },
          iconBtn('edit', 'Editar', () => openDialog(c)),
          iconBtn('expand', c.wide ? 'Reducir' : 'Ampliar', () => { c.wide = !c.wide; renderCharts(); }),
          iconBtn('download', 'Descargar PNG', () => downloadChart(c)),
          iconBtn('close', 'Eliminar', () => { state.charts = state.charts.filter((x) => x !== c); renderCharts(); }))),
      el('div', { class: 'chart-box' }, canvas));

    const cfg = buildConfig(c);
    if (!cfg) {
      card.querySelector('.chart-box').replaceChildren(el('div', { class: 'chart-empty' }, 'Sin datos para los filtros actuales'));
      return card;
    }
    requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      state.instances.set(c.id, new Chart(canvas, cfg));
    });
    return card;
  }

  // opts.export: render fijo para exportar (sin animación, alta densidad, sin interacción).
  function buildConfig(c, opts = {}) {
    const p = palette();
    const xc = col(c.x);
    if (!xc) return null;
    const exp = !!opts.export;
    const mobile = exp ? !!opts.mobile : isMobile();
    const base0 = exp ? { responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 2, events: [] } : { responsive: true, maintainAspectRatio: false, animation: { duration: 300 } };
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = p.text;

    const tooltip = {
      backgroundColor: p.surface, titleColor: p.primary, bodyColor: p.text, borderColor: p.border, borderWidth: 1,
      padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
    };
    const axis = (title) => ({
      grid: { color: p.grid, drawTicks: false }, border: { display: false },
      ticks: { color: p.text, padding: 6, maxRotation: mobile ? 45 : 0, autoSkip: true, font: exp ? { size: 13 } : undefined, callback(v) { const l = this.getLabelForValue ? this.getLabelForValue(v) : v; return typeof l === 'number' ? D.fmtCompact(l) : truncate(String(l), mobile ? 12 : 18); } },
      title: title ? { display: true, text: title, color: p.muted } : undefined,
    });
    const yc = c.y ? col(c.y) : null;
    const yPct = !!(yc && yc.percent && ['sum', 'avg', 'min', 'max'].includes(c.agg));
    const yFmtCol = yc && ['sum', 'avg', 'min', 'max'].includes(c.agg) ? yc : null;
    const fmtV = (v) => D.fmtValue(v, yFmtCol, false);
    const valueAxis = (title, fc = yFmtCol) => ({
      grid: { color: p.grid, drawTicks: false }, border: { display: false }, beginAtZero: true,
      ticks: { color: p.text, padding: 6, font: exp ? { size: 13 } : undefined, callback: (v) => D.fmtValue(v, fc, true) },
      title: title ? { display: true, text: title, color: p.muted } : undefined,
    });

    if (c.type === 'scatter') {
      const rows = filteredRows();
      const pts = [];
      for (const r of rows) {
        const x = r[c.x], y = r[c.y];
        if (typeof x === 'number' && typeof y === 'number') pts.push({ x, y });
        if (pts.length >= 3000) break;
      }
      if (!pts.length) return null;
      const r = window.Insights.pearson(pts.map((q) => q.x), pts.map((q) => q.y));
      const xcol = col(c.x), ycol = col(c.y);
      // Recta de ajuste (mínimos cuadrados) para visualizar la correlación.
      let fit = null;
      if (r !== null) {
        const n = pts.length, mx = pts.reduce((a, q) => a + q.x, 0) / n, my = pts.reduce((a, q) => a + q.y, 0) / n;
        const sxx = pts.reduce((a, q) => a + (q.x - mx) ** 2, 0), sxy = pts.reduce((a, q) => a + (q.x - mx) * (q.y - my), 0);
        if (sxx) {
          const b = sxy / sxx, a0 = my - b * mx;
          const xmin = Math.min(...pts.map((q) => q.x)), xmax = Math.max(...pts.map((q) => q.x));
          fit = [{ x: xmin, y: a0 + b * xmin }, { x: xmax, y: a0 + b * xmax }];
        }
      }
      return {
        type: 'scatter',
        data: { datasets: [
          { label: chartTitle(c), data: pts, backgroundColor: alpha(p.series[0], 0.55), borderColor: p.surface, borderWidth: 1, pointRadius: exp ? 5 : 4, pointHoverRadius: 6 },
          ...(fit ? [{ type: 'line', label: 'Ajuste', data: fit, borderColor: p.muted, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, fill: false }] : []),
        ] },
        options: {
          ...base0,
          plugins: {
            legend: { display: false },
            subtitle: r !== null ? { display: true, text: `r = ${r.toFixed(2)} · ${window.Insights.describeR(r)}`, color: p.muted, align: 'start', font: { size: exp ? 14 : 12 }, padding: { bottom: 8 } } : { display: false },
            tooltip: { ...tooltip, callbacks: { label: (ctx) => `${c.x}: ${D.fmtValue(ctx.parsed.x, xcol)} · ${c.y}: ${D.fmtValue(ctx.parsed.y, ycol)}` } },
          },
          scales: {
            x: { ...valueAxis(c.x, xcol), beginAtZero: false, type: 'linear' },
            y: { ...valueAxis(c.y, ycol), beginAtZero: false },
          },
        },
      };
    }

    // Excluir el filtro de la propia columna X para poder resaltar la selección.
    const own = xc.type === 'text' ? state.filters[c.x] : null;
    const rows = filteredRows(own ? c.x : undefined);
    const isPie = c.type === 'pie';
    const limit = xc.type === 'text' ? (isPie ? Math.min(c.limit || 6, 7) : c.limit) : 0;
    const data = D.aggregate(rows, xc, c.y, c.agg, { grain: c.grain, limit, sort: c.sort || undefined, noOther: c.other === false });
    if (!data.length) return null;

    const labels = data.map((d) => d.label);
    const values = data.map((d) => d.value);
    const selected = (d) => !own || own.has(d.raw);
    const valueName = c.agg === 'count' ? 'Registros' : `${AGG_LABEL[c.agg]} de ${c.y}`;
    const onClick = xc.type === 'text' && !exp ? (evt, els) => {
      if (!els.length) return;
      const d = data[els[0].index];
      // Diferir: Chart.js sigue procesando el evento y no debe destruirse dentro de él.
      if (d && !d.other) setTimeout(() => toggleFilter(c.x, d.raw), 0);
    } : undefined;
    const onHover = exp ? undefined : (evt, els) => { evt.native.target.style.cursor = els.length && onClick ? 'pointer' : 'default'; };
    const tooltipCb = {
      ...tooltip,
      callbacks: {
        label: (ctx) => {
          const v = isPie ? ctx.parsed : (c.type === 'hbar' ? ctx.parsed.x : ctx.parsed.y);
          let s = ` ${valueName}: ${fmtV(v)}`;
          if (isPie || c.agg === 'count' || c.agg === 'sum') {
            const tot = values.reduce((a, b) => a + (b || 0), 0);
            if (tot) s += ` (${D.fmtNum((v / tot) * 100)}%)`;
          }
          return s;
        },
      },
    };

    if (isPie) {
      const colors = data.map((d, i) => (d.other ? p.other : p.series[i % 8]));
      return {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors.map((col, i) => (selected(data[i]) ? col : alpha(col, 0.25))), borderColor: p.surface, borderWidth: 2, hoverOffset: 6 }] },
        options: {
          ...base0, cutout: '58%', onClick, onHover,
          plugins: {
            legend: { position: mobile ? 'bottom' : 'right', labels: { color: p.text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 12, font: exp ? { size: 13 } : undefined, generateLabels: (ch) => Chart.overrides.doughnut.plugins.legend.labels.generateLabels(ch).map((l) => ({ ...l, text: truncate(l.text, 22) })) } },
            tooltip: tooltipCb,
          },
        },
      };
    }

    const base = p.series[0];
    const bg = data.map((d) => (d.other ? p.other : selected(d) ? base : alpha(base, 0.25)));
    // Varias series: desglose por una columna de categorías, o varias columnas numéricas.
    let sets = [{ label: valueName, values, color: base, bg }];
    let note = '';
    const align = (sub, yName) => {
      const map = new Map(D.aggregate(sub, xc, yName, c.agg, { grain: c.grain }).map((d) => [d.key, d.value]));
      return data.map((d) => (d.other ? null : map.has(d.key) ? map.get(d.key) : null));
    };
    const sc = c.series && c.series !== c.x ? col(c.series) : null;
    if (sc && sc.values) {
      const sf = state.filters[sc.name];
      const vals = sc.values.filter((v) => !sf || sf.has(v));
      if (vals.length > 8) note = `Se muestran 8 de ${vals.length} series`;
      sets = vals.slice(0, 8).map((v) => {
        const color = p.series[sc.values.indexOf(v) % 8];
        return { label: String(v), values: align(rows.filter((r) => r[sc.name] === v), c.y), color, bg: color };
      });
    } else if (c.ys && c.ys.length && c.agg !== 'count') {
      const names = [c.y, ...c.ys.filter((n) => col(n))].slice(0, 8);
      sets = names.map((n, i) => ({ label: n, values: i === 0 ? values : align(rows, n), color: p.series[i], bg: i === 0 ? bg.map((x) => (x === base ? p.series[0] : x)) : p.series[i] }));
    }
    const multi = sets.length > 1;
    if (multi) {
      tooltipCb.callbacks.label = (ctx) => ` ${ctx.dataset.label}: ${fmtV(c.type === 'hbar' ? ctx.parsed.x : ctx.parsed.y)}`;
    }
    const legend = multi
      ? { display: true, position: mobile ? 'bottom' : 'top', align: 'start', labels: { color: p.text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 12, font: exp ? { size: 13 } : undefined } }
      : { display: false };
    // Línea de tendencia (regresión lineal) en series de tiempo con una sola serie.
    let trendSet = null;
    if ((c.type === 'line' || c.type === 'area') && c.trend && !multi && xc.type === 'date') {
      const lr = window.Insights.linreg(values);
      if (lr) {
        const meanV = values.filter((v) => typeof v === 'number').reduce((a, v, _, arr) => a + v / arr.length, 0);
        const rel = meanV ? (lr.slope / Math.abs(meanV)) * 100 : 0;
        const per = { day: 'día', week: 'semana', month: 'mes', quarter: 'trimestre', year: 'año' }[c.grain] || 'periodo';
        note = note || `Línea punteada: tendencia ${lr.slope >= 0 ? 'al alza' : 'a la baja'} (${rel >= 0 ? '+' : ''}${D.fmtNum(Math.round(rel * 10) / 10)}% por ${per})`;
        trendSet = { label: 'Tendencia', data: values.map((_, i) => lr.at(i)), borderColor: p.muted, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, fill: false, tension: 0 };
      }
    }
    const subtitle = note ? { display: true, text: note, color: p.muted, align: 'start', font: { size: exp ? 13 : 11 }, padding: { bottom: 6 } } : { display: false };

    if (c.type === 'line' || c.type === 'area') {
      return {
        type: 'line',
        data: {
          labels,
          datasets: [...sets.map((st) => ({
            label: st.label, data: st.values, borderColor: st.color, backgroundColor: alpha(st.color, multi ? 0.08 : 0.14), fill: c.type === 'area' && !multi ? 'origin' : false,
            borderWidth: exp ? 2.5 : 2, tension: 0.25, pointRadius: data.length > 40 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: st.color, pointBorderColor: p.surface, pointBorderWidth: 2, spanGaps: true,
          })), ...(trendSet ? [trendSet] : [])],
        },
        options: {
          ...base0, onClick, onHover,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend, subtitle, tooltip: { ...tooltipCb, filter: (it) => it.dataset.label !== 'Tendencia' } },
          scales: { x: { ...axis(), grid: { display: false } }, y: { ...valueAxis(), beginAtZero: !multi && !c.ys } },
        },
      };
    }

    const horizontal = c.type === 'hbar';
    return {
      type: 'bar',
      data: { labels, datasets: sets.map((st) => ({ label: st.label, data: st.values, backgroundColor: st.bg, borderColor: p.surface, borderWidth: multi ? 1 : 0, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 44, categoryPercentage: 0.8, barPercentage: 0.9 })) },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        ...base0, onClick, onHover,
        interaction: { mode: multi ? 'index' : 'nearest', axis: horizontal ? 'y' : 'x', intersect: false },
        plugins: { legend, subtitle, tooltip: tooltipCb },
        scales: horizontal
          ? { x: valueAxis(), y: { ...axis(), grid: { display: false }, ticks: { ...axis().ticks, autoSkip: data.length > 25 } } }
          : { x: { ...axis(), grid: { display: false } }, y: valueAxis() },
      },
    };
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function downloadChart(c) {
    const ch = state.instances.get(c.id);
    if (!ch) return;
    const src = ch.canvas;
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = palette().surface;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    const name = `${chartTitle(c).replace(/[^\w\sáéíóúñü-]/gi, '').trim() || 'grafica'}.png`;
    out.toBlob((blob) => blob && saveFile(name, blob), 'image/png');
  }

  // Descarga un archivo. Dentro de claude.ai usa la capacidad "downloads" (pide confirmación);
  // en un navegador normal usa un enlace de descarga.
  let downloadsApi;
  function getDownloads() {
    if (downloadsApi === undefined) {
      downloadsApi = window.claude && typeof window.claude.use === 'function'
        ? window.claude.use('downloads').catch(() => null)
        : Promise.resolve(null);
    }
    return downloadsApi;
  }
  getDownloads();
  async function saveFile(filename, blob) {
    const dl = await getDownloads();
    if (dl) {
      try { await dl.save({ filename, data: blob }); }
      catch (err) {
        if (err && err.code === 'declined') return;
        if (err && err.code === 'rate_limited') toast('Ya hay una descarga pendiente de confirmar.');
        else toast('No se pudo descargar el archivo en esta vista.');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Diálogo de gráfica ----------

  const dlg = $('#chartDialog');
  let dlgType = 'bar';
  $('#typeGrid').append(...CHART_TYPES.map((t) => el('button', {
    type: 'button', class: 'type-opt', role: 'radio', 'aria-checked': 'false', 'data-type': t.id,
    onclick: () => { dlgType = t.id; syncDialog(); },
  }, el('span', { html: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="${t.icon}"/></svg>` }), t.label)));

  $('#btnAddChart').addEventListener('click', () => openDialog(null));

  function fillSelect(sel, cols, value) {
    const typeName = { number: 'número', date: 'fecha', text: 'texto' };
    sel.replaceChildren(...cols.map((c) => el('option', { value: c.name }, `${c.name} (${typeName[c.type]})`)));
    if (value && cols.some((c) => c.name === value)) sel.value = value;
  }

  function openDialog(chart) {
    state.editing = chart;
    $('#dialogTitle').textContent = chart ? 'Editar gráfica' : 'Nueva gráfica';
    const m = metrics();
    const t = timeInfo();
    const defaults = chart || { type: t.periodic ? 'line' : 'bar', x: (t.periodic ? t.date : categories()[0] || state.columns[0]).name, y: m[0] ? m[0].name : null, agg: defaultAgg(m[0], t), grain: t.grain || 'month', limit: 10, sort: '', title: '', series: '', ys: [] };
    dlgType = defaults.type;
    $('#fTitle').value = defaults.title || '';
    syncDialog(defaults);
    dlg.showModal();
  }

  function syncDialog(init) {
    const fX = $('#fX'), fY = $('#fY'), fAgg = $('#fAgg');
    document.querySelectorAll('.type-opt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === dlgType)));
    const nums = state.columns.filter((c) => c.type === 'number');
    const scatter = dlgType === 'scatter';
    const prevX = init ? init.x : fX.value;
    const prevY = init ? init.y : fY.value;

    fillSelect(fX, scatter ? nums : state.columns, prevX);
    fillSelect(fY, nums, prevY);
    if (scatter && nums.length > 1 && fY.value === fX.value) fY.value = nums.find((c) => c.name !== fX.value).name;
    if (init) {
      fAgg.value = init.agg === 'none' ? (nums.length ? 'sum' : 'count') : init.agg;
      $('#fGrain').value = init.grain || 'month';
      $('#fLimit').value = String(init.limit ?? 10);
      $('#fSort').value = init.sort || 'value-desc';
    }
    // Series: desglose por categoría o comparar varias columnas.
    const fS = $('#fSeries');
    const prevS = init ? init.series || '' : fS.value;
    const sCols = state.columns.filter((c) => c.type === 'text' && c.unique >= 2 && c.unique <= 30 && c.name !== fX.value);
    fS.replaceChildren(el('option', { value: '' }, 'Ninguno'), ...sCols.map((c) => el('option', { value: c.name }, `${c.name} (${c.unique})`)));
    fS.value = sCols.some((c) => c.name === prevS) ? prevS : '';
    const prevYs = init ? init.ys || [] : [...document.querySelectorAll('#fYs input:checked')].map((i) => i.value);
    const ysBox = $('#fYs');
    ysBox.replaceChildren(...nums.filter((c) => c.name !== fY.value && !c.idLike).map((c) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', value: c.name, checked: prevYs.includes(c.name) }), ` ${c.name}`)));
    const multiOk = ['bar', 'hbar', 'line', 'area'].includes(dlgType) && fAgg.value !== 'count' && fAgg.value !== 'distinct';
    $('#fSeriesWrap').hidden = !['bar', 'hbar', 'line', 'area'].includes(dlgType);
    $('#fYsWrap').hidden = !multiOk || !!fS.value || nums.length < 2;
    if (!nums.length) fAgg.value = fAgg.value === 'distinct' ? 'distinct' : 'count';
    [...fAgg.options].forEach((o) => { o.disabled = !nums.length && !['count', 'distinct'].includes(o.value); });

    const xc = col(fX.value);
    $('#fXLabel').textContent = scatter ? 'Eje X (número)' : 'Agrupar por (eje X)';
    $('#fYLabel').textContent = scatter ? 'Eje Y (número)' : 'Valor';
    $('#fAggWrap').hidden = scatter;
    $('#fYWrap').hidden = !scatter && fAgg.value === 'count';
    $('#fGrainWrap').hidden = scatter || !xc || xc.type !== 'date';
    $('#fLimitWrap').hidden = scatter || !xc || xc.type !== 'text';
    $('#fSortWrap').hidden = scatter || !xc || xc.type !== 'text';

    let hint = '';
    if (scatter && nums.length < 2) hint = 'La dispersión necesita al menos dos columnas numéricas.';
    else if (fAgg.value === 'distinct') hint = 'Cuenta cuántos valores distintos de la columna "Valor" hay en cada grupo.';
    else if (dlgType === 'pie') hint = 'Las donas muestran hasta 7 categorías; el resto se agrupa en "Otros".';
    else if (xc && xc.type === 'number' && xc.unique > 60) hint = 'Esta columna numérica tiene muchos valores distintos; considera agrupar por una columna de texto o fecha.';
    $('#fHint').textContent = hint;
    $('#btnSaveChart').disabled = scatter && nums.length < 2;
    if (fAgg.value === 'distinct') fillSelect(fY, state.columns, prevY);
  }

  ['#fX', '#fAgg', '#fY', '#fSeries'].forEach((s) => $(s).addEventListener('change', () => syncDialog()));

  $('#chartForm').addEventListener('submit', (ev) => {
    if (ev.submitter && ev.submitter.value !== 'save') return;
    const scatter = dlgType === 'scatter';
    const agg = scatter ? 'none' : $('#fAgg').value;
    const cfg = {
      type: dlgType,
      x: $('#fX').value,
      y: agg === 'count' ? null : $('#fY').value,
      agg,
      grain: $('#fGrain').value,
      limit: Number($('#fLimit').value),
      sort: $('#fSort').value,
      title: $('#fTitle').value.trim(),
      series: ['bar', 'hbar', 'line', 'area'].includes(dlgType) ? $('#fSeries').value : '',
      ys: $('#fYsWrap').hidden ? [] : [...document.querySelectorAll('#fYs input:checked')].map((i) => i.value),
    };
    if (state.editing) Object.assign(state.editing, cfg);
    else state.charts.push({ id: state.nextId++, wide: false, ...cfg });
    renderCharts();
  });

  // ---------- Asistente de hojas ----------

  const B = window.BookKit;
  const bookDlg = $('#bookDialog');
  const KIND = { data: 'Datos', notes: 'Notas / instrucciones', calendar: 'Calendario (tabla de apoyo)', empty: 'Vacía' };

  function analyzeBook() {
    const book = state.book;
    const kinds = {};
    book.order.forEach((s) => { kinds[s] = B.classify(s, book.sheets[s]); });
    const data = book.order.filter((s) => kinds[s].kind === 'data').sort((a, b) => kinds[b].score - kinds[a].score);
    state.bookInfo = { kinds, recommended: data[0] || book.order.find((s) => book.sheets[s].rows.length) || book.order[0], suggestions: B.suggest(book, kinds) };
  }

  function addSheet(name, table) {
    let n = name, k = 2;
    while (state.book.sheets[n]) n = `${name} (${k++})`;
    state.book.sheets[n] = table;
    state.book.order.push(n);
    $('#sheetSelect').append(el('option', { value: n }, n));
    analyzeBook();
    return n;
  }

  function openBookDialog() { renderBook(); bookDlg.showModal(); }
  $('#btnBook').addEventListener('click', openBookDialog);
  $('#btnCloseBook').addEventListener('click', () => bookDlg.close());
  $('#btnBookGo').addEventListener('click', () => bookDlg.close());
  $('#btnBookAgent').addEventListener('click', () => { bookDlg.close(); $('#btnAgent').click(); });
  bookDlg.addEventListener('click', (e) => { if (e.target === bookDlg) bookDlg.close(); });

  function renderBook() {
    const { kinds, recommended, suggestions } = state.bookInfo;
    const book = state.book;
    const count = (k) => book.order.filter((s) => kinds[s].kind === k).length;
    const parts = [`${count('data')} con datos`];
    if (count('notes')) parts.push(`${count('notes')} de notas`);
    if (count('calendar')) parts.push(`${count('calendar')} de calendario`);
    $('#bookTitle').textContent = `Tu archivo tiene ${book.order.length} hojas`;
    $('#bookSummary').textContent = `${parts.join(', ')}. Elige cuál ver en el dashboard o combina varias. Te recomiendo empezar con “${recommended}”.`;

    const body = [];
    // Notas del archivo (p. ej. hoja LEEME): suelen explicar cómo usar los datos.
    book.order.filter((s) => kinds[s].kind === 'notes').forEach((s) => {
      body.push(el('details', { class: 'notes clean-section' }, el('summary', {}, `Leer las notas de “${s}”`), el('pre', {}, kinds[s].lines.slice(0, 80).join('\n'))));
    });

    body.push(el('div', { class: 'sheet-list' }, book.order.map((s) => {
      const t = book.sheets[s];
      const k = kinds[s];
      const isRec = s === recommended;
      return el('article', { class: `sheet${s === state.sheet ? ' current' : ''}` },
        el('div', {}, isRec ? el('span', { class: 'tag rec' }, 'Recomendada') : null, el('span', { class: 'tag' }, KIND[k.kind])),
        el('h3', {}, s),
        el('div', { class: 'meta' }, `${D.fmtNum(t.rows.length)} filas · ${t.columns.length} columnas${k.kind === 'data' ? ' · ' + B.describeSheet(t) : ''}`),
        el('div', { class: 'cols' }, t.columns.slice(0, 8).map((c) => c.name).join(', ') + (t.columns.length > 8 ? '…' : '')),
        k.kind === 'notes' ? null : el('button', { class: `btn sm${isRec ? ' primary' : ''}`, onclick: () => { bookDlg.close(); if (s !== state.sheet) openSheet(s); } },
          s === state.sheet ? 'Abierta · ir al dashboard' : k.kind === 'calendar' ? 'Ver de todos modos' : 'Ver dashboard'));
    })));

    if (suggestions.length) {
      body.push(el('div', { class: 'book-section' }, el('h3', {}, 'Combinaciones sugeridas'),
        suggestions.slice(0, 8).map((sg) => el('div', { class: 'suggestion' }, el('span', {}, sg.text),
          el('button', { class: 'btn sm', onclick: () => applySuggestion(sg) }, sg.type === 'join' ? 'Unir y ver' : 'Apilar y ver')))));
    }

    // Unión manual.
    const usable = book.order.filter((s) => kinds[s].kind !== 'notes' && kinds[s].kind !== 'empty');
    if (usable.length >= 2) {
      const selA = el('select', { 'aria-label': 'Hoja base' }, usable.map((s) => el('option', { value: s }, s)));
      const selB = el('select', { 'aria-label': 'Hoja a unir' }, usable.map((s) => el('option', { value: s }, s)));
      const selK = el('select', { 'aria-label': 'Columna en común' });
      const btn = el('button', { class: 'btn primary' }, 'Unir');
      const hint = el('p', { class: 'hint' });
      selA.value = state.sheet && usable.includes(state.sheet) ? state.sheet : usable[0];
      selB.value = usable.find((s) => s !== selA.value);
      const syncKeys = () => {
        const common = selA.value === selB.value ? [] : B.commonColumns(book.sheets[selA.value], book.sheets[selB.value]);
        selK.replaceChildren(...common.map(([a, b]) => el('option', { value: `${a}\u0000${b}` }, a === b ? a : `${a} = ${b}`)));
        btn.disabled = !common.length;
        hint.textContent = selA.value === selB.value ? 'Elige dos hojas distintas.' : common.length ? 'Se agregan a la hoja base las columnas de la otra hoja donde coincida la columna elegida (como BUSCARV).' : 'Estas hojas no tienen columnas con el mismo nombre.';
      };
      selA.addEventListener('change', syncKeys);
      selB.addEventListener('change', syncKeys);
      btn.addEventListener('click', () => {
        const [ka, kb] = selK.value.split('\u0000');
        applySuggestion({ type: 'join', a: selA.value, b: selB.value, ka, kb });
      });
      syncKeys();
      body.push(el('div', { class: 'book-section' }, el('h3', {}, 'Unir hojas manualmente'),
        el('div', { class: 'join-form' },
          el('label', { class: 'field' }, el('span', {}, 'Hoja base'), selA),
          el('label', { class: 'field' }, el('span', {}, 'Agregar columnas de'), selB),
          el('label', { class: 'field' }, el('span', {}, 'Columna en común'), selK),
          btn), hint));
    }
    $('#bookBody').replaceChildren(...body);
  }

  function applySuggestion(sg) {
    let name, table;
    if (sg.type === 'join') {
      table = B.join(state.book, sg.a, sg.b, sg.ka, sg.kb);
      name = `${sg.a} + ${sg.b}`;
    } else {
      table = B.stack(state.book, sg.sheets);
      name = `Combinada (${sg.sheets.length} hojas)`;
    }
    const n = addSheet(name, table);
    bookDlg.close();
    openSheet(n);
    toast(`Se creó la hoja “${n}”.`);
  }

  // ---------- Limpieza de datos ----------

  const C = window.Cleaner;
  const cleanDlg = $('#cleanDialog');

  function analyzeData() {
    const t = state.tbl;
    state.report = C.analyze(t);
    state.outliers = window.Insights.outlierRows(state.rows, metrics());
    if (!state.outliers.rows.size) state.excludeOutliers = false;
    state.report.visible = state.report.issues.filter((i) => !t.ignored.has(i.id));
    const warns = state.report.visible.filter((i) => i.severity === 'warn').length;
    const badge = $('#cleanBadge');
    badge.hidden = !warns;
    badge.textContent = warns;
    renderBanner();
    if (cleanDlg.open) renderClean();
  }

  function renderBanner() {
    const b = $('#cleanBanner');
    const r = state.report;
    const warns = r.visible.filter((i) => i.severity === 'warn').length;
    if (state.bannerClosed || (!warns && !state.tbl.log.length)) { b.hidden = true; return; }
    b.hidden = false;
    b.classList.toggle('ok', !warns);
    const text = warns
      ? `Encontramos ${warns} posible(s) problema(s) en tus datos que pueden afectar el dashboard. Calidad: ${r.score}/100.`
      : `Datos limpios. Calidad: ${r.score}/100 · ${state.tbl.log.length} corrección(es) aplicada(s).`;
    b.replaceChildren(
      el('span', { class: 'grow' }, text),
      el('button', { class: 'btn sm primary', onclick: openClean }, warns ? 'Revisar y limpiar' : 'Ver detalles'),
      el('button', { class: 'icon-btn', 'aria-label': 'Ocultar aviso', title: 'Ocultar aviso', onclick: () => { state.bannerClosed = true; b.hidden = true; } }, '×'));
  }

  function openClean() { renderClean(); cleanDlg.showModal(); }
  $('#btnClean').addEventListener('click', openClean);
  $('#btnCloseClean').addEventListener('click', () => cleanDlg.close());
  cleanDlg.addEventListener('click', (e) => { if (e.target === cleanDlg) cleanDlg.close(); });

  function commit(next, message) {
    const t = state.tbl;
    t.history.push({ columns: t.columns, rows: t.rows, log: t.log.length });
    t.log.push(message);
    setData(next.columns, next.rows);
  }

  function runAction(issue, action) {
    commit(action.run(), action.message);
    toast(action.message);
  }

  function applyRecommended() {
    const t = state.tbl;
    const before = { columns: t.columns, rows: t.rows, log: t.log.length };
    const done = new Set();
    const msgs = [];
    let cur = { columns: t.columns, rows: t.rows, meta: t.meta };
    for (let guard = 0; guard < 100; guard++) {
      const issue = C.analyze(cur).issues.find((i) => i.recommended && !t.ignored.has(i.id) && !done.has(i.id));
      if (!issue) break;
      done.add(issue.id);
      const next = issue.actions[0].run();
      D.restat(next.columns, next.rows);
      cur = { ...next, meta: t.meta };
      msgs.push(issue.actions[0].message);
    }
    if (!msgs.length) return;
    t.history.push(before);
    t.log.push(...msgs);
    setData(cur.columns, cur.rows);
    toast(`Se aplicaron ${msgs.length} corrección(es).`);
  }

  function undo() {
    const t = state.tbl;
    const prev = t.history.pop();
    if (!prev) return;
    t.log.length = prev.log;
    setData(prev.columns, prev.rows);
    toast('Se deshizo el último cambio.');
  }

  function restoreOriginal() {
    const t = state.tbl;
    if (!t.history.length) return;
    t.history.push({ columns: t.columns, rows: t.rows, log: t.log.length });
    t.log.push('Se restauraron los datos originales.');
    setData(C.cloneCols(t.original.columns), t.original.rows);
    toast('Datos originales restaurados.');
  }

  function scoreColor(s) { return s >= 90 ? 'var(--good)' : s >= 70 ? 'var(--warning)' : 'var(--critical)'; }
  function scoreLabel(s) { return s >= 90 ? 'Buena' : s >= 70 ? 'Regular' : 'Baja'; }

  function renderClean() {
    const t = state.tbl;
    const r = state.report;
    const body = $('#cleanBody');
    const recommended = r.visible.filter((i) => i.recommended).length;

    const summary = el('div', { class: 'clean-summary' },
      el('div', { class: 'score', style: `--score:${r.score};--score-color:${scoreColor(r.score)}`, role: 'img', 'aria-label': `Calidad ${r.score} de 100` },
        el('div', {}, el('b', {}, String(r.score)), el('span', {}, `Calidad ${scoreLabel(r.score).toLowerCase()}`))),
      el('div', { class: 'clean-stats' },
        [['Filas', r.stats.rows], ['Columnas', r.stats.columns], ['Celdas vacías', r.stats.emptyCells], ['Valores no válidos', r.stats.invalid], ['Filas duplicadas', r.stats.duplicates]]
          .map(([k, v]) => el('div', {}, el('b', {}, D.fmtNum(v)), el('span', {}, k)))));

    const actions = el('div', { class: 'clean-actions' },
      el('button', { class: 'btn primary', disabled: !recommended, onclick: applyRecommended, title: 'Elimina duplicados y filas de totales, y unifica valores escritos de distintas formas' },
        recommended ? `Aplicar correcciones recomendadas (${recommended})` : 'Sin correcciones recomendadas'),
      el('button', { class: 'btn', disabled: !t.history.length, onclick: undo }, 'Deshacer'),
      el('button', { class: 'btn ghost', disabled: !t.history.length, onclick: restoreOriginal }, 'Restaurar original'),
      el('button', { class: 'btn ghost', onclick: () => exportCSV(state.rows, '_limpio') }, 'Descargar CSV'),
      el('button', { class: 'btn ghost', onclick: exportXLSX }, 'Descargar Excel'));

    const issues = r.visible.length
      ? el('div', { class: 'issues' }, r.visible.map((i) => el('article', { class: `issue ${i.severity}` },
        el('div', { class: 'issue-head' },
          el('span', { class: `sev ${i.severity}` }, i.severity === 'warn' ? '⚠ Revisar' : 'ⓘ Sugerencia'),
          el('h3', {}, i.title)),
        el('p', {}, i.detail),
        i.samples && i.samples.length ? el('div', { class: 'samples' }, i.samples.map((x) => el('code', { title: x }, x))) : null,
        el('div', { class: 'issue-actions' },
          i.actions.map((a, k) => el('button', { class: `btn sm${k === 0 ? ' primary' : ''}`, onclick: () => runAction(i, a) }, a.label)),
          el('button', { class: 'btn sm ghost', onclick: () => { t.ignored.add(i.id); analyzeData(); } }, 'Ignorar')))))
      : el('div', { class: 'empty-state' }, el('b', { class: 'sev good' }, '✓ Sin problemas pendientes'), el('div', { class: 'small' }, 'No se encontraron duplicados, valores inconsistentes ni celdas con formato incorrecto.'));

    const sections = [];
    if (r.autoFixes.length) {
      sections.push(el('details', { class: 'clean-section' }, el('summary', {}, `Correcciones automáticas al importar (${r.autoFixes.length})`),
        el('ul', {}, r.autoFixes.map((x) => el('li', {}, x)))));
    }
    if (t.log.length) {
      sections.push(el('details', { class: 'clean-section', open: true }, el('summary', {}, `Cambios aplicados (${t.log.length})`),
        el('ul', {}, t.log.map((x) => el('li', {}, x)))));
    }
    const ignored = r.issues.length - r.visible.length;
    if (ignored) {
      sections.push(el('p', { class: 'small muted' }, `${ignored} problema(s) ignorado(s). `,
        el('button', { class: 'btn sm ghost', onclick: () => { t.ignored.clear(); analyzeData(); } }, 'Mostrar de nuevo')));
    }
    body.replaceChildren(summary, actions, issues, ...sections);
  }

  function toast(msg) {
    let tEl = $('#toast');
    if (!tEl) { tEl = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(tEl); }
    tEl.textContent = msg;
    tEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => tEl.classList.remove('show'), 2600);
  }

  function baseName() { return state.fileName.replace(/\.[^.]+$/, ''); }

  function exportCSV(rowsIn, suffix) {
    const rows = rowsIn.map((r) => {
      const o = {};
      state.columns.forEach((c) => {
        const v = r[c.name];
        o[c.name] = v instanceof Date ? D.dateKey(v, 'day').key : v;
      });
      return o;
    });
    const csv = '\uFEFF' + Papa.unparse(rows, { columns: state.columns.map((c) => c.name) });
    saveFile(baseName() + suffix + '.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  }

  function exportXLSX() {
    const names = state.columns.map((c) => c.name);
    const aoa = [names, ...state.rows.map((r) => names.map((n) => (r[n] === null || r[n] === undefined ? null : r[n])))];
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: 'yyyy-mm-dd' });
    ws['!cols'] = names.map((n) => ({ wch: Math.min(40, Math.max(10, n.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (state.sheet || 'Datos').slice(0, 31));
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveFile(baseName() + '_limpio.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  // ---------- Tabla ----------

  function tableRows() {
    let rows = filteredRows(undefined, { table: true });
    const q = state.table.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => state.columns.some((c) => {
        const v = r[c.name];
        return v !== null && D.fmtCell(v, c.type, c.percent, c.currency).toLowerCase().includes(q);
      }));
    }
    const { sort, dir } = state.table;
    if (sort) {
      rows = [...rows].sort((a, b) => {
        const x = a[sort], y = b[sort];
        if (x === null) return 1;
        if (y === null) return -1;
        if (typeof x === 'string') return x.localeCompare(y, 'es', { numeric: true }) * dir;
        return (x - y) * dir;
      });
    }
    return rows;
  }

  function renderTable() {
    const rows = tableRows();
    const { page, size, sort, dir } = state.table;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const cur = Math.min(page, pages - 1);
    const slice = rows.slice(cur * size, cur * size + size);
    const typeName = { number: '#', date: 'fecha', text: 'abc' };

    const thead = el('thead', {}, el('tr', {}, state.columns.map((c) => el('th', {
      class: c.type === 'number' ? 'num' : '', scope: 'col', 'aria-sort': sort === c.name ? (dir > 0 ? 'ascending' : 'descending') : 'none',
      onclick: () => { state.table.dir = state.table.sort === c.name ? -state.table.dir : 1; state.table.sort = c.name; renderTable(); },
    }, c.name, el('span', { class: 'type' }, sort === c.name ? (dir > 0 ? '▲' : '▼') : typeName[c.type])))));
    const tbody = el('tbody', {}, slice.map((r) => el('tr', {}, state.columns.map((c) => el('td', { class: c.type === 'number' ? 'num' : '' }, D.fmtCell(r[c.name], c.type, c.percent, c.currency))))));
    $('#dataTable').replaceChildren(thead, tbody);
    $('#rowCount').textContent = `· ${D.fmtNum(rows.length)} filas`;

    const pager = $('#pager');
    pager.replaceChildren(
      el('span', { class: 'page' }, rows.length ? `${D.fmtNum(cur * size + 1)}–${D.fmtNum(Math.min(rows.length, (cur + 1) * size))} de ${D.fmtNum(rows.length)}${pages > 1 ? ` · página ${cur + 1} de ${pages}` : ' · una sola página'}` : 'Sin resultados'),
      el('button', { class: 'btn sm', disabled: cur === 0, onclick: () => { state.table.page = cur - 1; renderTable(); } }, '‹ Anterior'),
      el('button', { class: 'btn sm', disabled: cur >= pages - 1, onclick: () => { state.table.page = cur + 1; renderTable(); } }, 'Siguiente ›'));
  }

  let searchTimer;
  $('#tableSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.table.search = e.target.value; state.table.page = 0; renderTable(); }, 200);
  });

  $('#btnExport').addEventListener('click', () => exportCSV(tableRows(), '_filtrado'));

  // ---------- Sesión: guardar y restaurar el estado completo ----------

  function filtersSummary() {
    const parts = Object.entries(state.filters).map(([c, set]) => `${c}: ${[...set].join(', ')}`);
    const df = state.dateFilter;
    if (df && (df.from || df.to)) parts.push(`${df.col}: ${df.from ? D.fmtDate(df.from) : '…'} – ${df.to ? D.fmtDate(df.to) : '…'}`);
    if (state.excludeOutliers) parts.push(`sin ${state.outliers.rows.size} valores atípicos`);
    return parts;
  }

  // Objeto plano (clonable) con todo lo necesario para reconstruir el dashboard.
  function serialize() {
    if (!state.book) return null;
    const sheets = {};
    state.book.order.forEach((n) => {
      const t = state.book.sheets[n];
      sheets[n] = { columns: t.columns.map((c) => ({ ...c })), rows: t.rows, meta: t.meta || {}, log: t.log || [], ignored: t.ignored ? [...t.ignored] : [] };
    });
    const df = state.dateFilter;
    return {
      id: state.sessionId,
      fileName: state.fileName,
      size: state.fileSize || 0,
      loadedAt: state.loadedAt || Date.now(),
      updatedAt: Date.now(),
      sheet: state.sheet,
      rowCount: state.rows.length,
      book: { order: [...state.book.order], sheets },
      dash: {
        filters: Object.fromEntries(Object.entries(state.filters).map(([k, v]) => [k, [...v]])),
        dateFilter: df ? { col: df.col, from: df.from ? df.from.getTime() : null, to: df.to ? df.to.getTime() : null } : null,
        charts: state.charts.map((c) => ({ ...c })),
        explorer: { ...state.explorer },
        excludeOutliers: state.excludeOutliers,
        aiInsights: state.aiInsights,
        nextId: state.nextId,
      },
      health: state.report ? { score: state.report.score, stats: state.report.stats, cambios: (state.tbl && state.tbl.log) || [] } : null,
    };
  }

  // Reconstruye fechas aunque el navegador las haya guardado como texto o número.
  function reviveDates(t) {
    const dateCols = t.columns.filter((c) => c.type === 'date').map((c) => c.name);
    if (!dateCols.length) return;
    t.rows.forEach((r) => dateCols.forEach((k) => {
      const v = r[k];
      if (v !== null && v !== undefined && !(v instanceof Date)) { const d = new Date(v); r[k] = isNaN(d) ? null : d; }
    }));
  }

  function restore(rec) {
    const sheets = {};
    rec.book.order.forEach((n) => {
      const src = rec.book.sheets[n];
      const t = { columns: src.columns, rows: src.rows, meta: src.meta || {} };
      reviveDates(t);
      D.restat(t.columns, t.rows);
      t.original = { columns: window.Cleaner.cloneCols(t.columns), rows: t.rows };
      t.history = [];
      t.log = src.log || [];
      t.ignored = new Set(src.ignored || []);
      sheets[n] = t;
    });
    openBook({ sheets, order: rec.book.order }, rec.fileName, { silent: true, sheet: rec.sheet, sessionId: rec.id, loadedAt: rec.loadedAt, size: rec.size });
    const d = rec.dash || {};
    const names = new Set(state.columns.map((c) => c.name));
    state.filters = {};
    Object.entries(d.filters || {}).forEach(([k, vals]) => { if (names.has(k) && vals.length) state.filters[k] = new Set(vals); });
    if (d.dateFilter && names.has(d.dateFilter.col)) {
      state.dateFilter = { col: d.dateFilter.col, from: d.dateFilter.from ? new Date(d.dateFilter.from) : null, to: d.dateFilter.to ? new Date(d.dateFilter.to) : null };
    }
    if (Array.isArray(d.charts) && d.charts.length) state.charts = d.charts.filter((c) => names.has(c.x));
    if (d.explorer) state.explorer = { ...d.explorer };
    state.excludeOutliers = !!d.excludeOutliers && state.outliers.rows.size > 0;
    state.aiInsights = d.aiInsights || null;
    state.nextId = Math.max(d.nextId || 1, ...state.charts.map((c) => c.id + 1));
    buildFilters();
    refresh();
  }

  // Vuelve a la pantalla de carga (nueva sesión).
  function resetToUpload() {
    state.instances.forEach((ch) => ch.destroy());
    state.instances.clear();
    state.book = null;
    state.columns = [];
    state.rows = [];
    state.charts = [];
    state.sessionId = null;
    $('#dashView').hidden = true;
    $('#uploadView').hidden = false;
    ['#btnNewFile', '#btnAgent', '#fileInfo', '#sheetPicker', '#btnBook'].forEach((q) => { $(q).hidden = true; });
    $('#sessionBanner').hidden = true;
    document.querySelector('#agentClose') && document.querySelector('#agentClose').click();
  }

  // Funciones que usa el asistente (js/agent.js).
  window.DashApp = {
    state, col, metrics, categories, timeInfo, defaultAgg, chartTitle, filteredRows, toast,
    openSheet, setData, commit, applyRecommended, runAction, undo, refresh, renderCharts, analyzeData, applySuggestion,
    restoreOriginal, syncFilters: () => { buildFilters(); refresh(); },
    // Exportación y sesión (js/export.js, js/session.js)
    buildConfig, palette, kpiTiles, insights, filtersSummary, saveFile, isMobile, renderInsights,
    serialize, restore, resetToUpload, notifyChange,
  };
})();
