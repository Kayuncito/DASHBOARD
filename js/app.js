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
  const metricRank = (c) => { const i = METRIC_TIERS.findIndex((re) => re.test(c.name)); return i < 0 ? (/(precio|price|tarifa|rate|%)/i.test(c.name) ? 99 : 50) : i; };

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
  };

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
    const table = D.parseDelimited(window.buildSampleCSV());
    openBook({ sheets: { Ventas: table }, order: ['Ventas'] }, 'ventas_ejemplo.csv');
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
      openBook(book, file.name);
    } catch (err) {
      console.error(err);
      showError('No se pudo leer el archivo: ' + (err.message || err));
    } finally {
      dropZone.querySelector('.dz-title').textContent = 'Arrastra tu archivo aquí';
    }
  }

  function openBook(book, name) {
    state.book = book;
    state.fileName = name;
    const sel = $('#sheetSelect');
    sel.replaceChildren(...book.order.map((s) => el('option', { value: s }, s)));
    $('#sheetPicker').hidden = book.order.length < 2;
    openSheet(book.order[0]);
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
    state.tbl = t;
    state.columns = t.columns;
    state.rows = t.rows;
    state.filters = {};
    state.table = { page: 0, sort: null, dir: 1, search: '', size: 50 };
    $('#tableSearch').value = '';
    const dateCol = t.columns.find((c) => c.type === 'date');
    state.dateFilter = dateCol ? { col: dateCol.name, from: null, to: null } : null;
    state.charts = suggestCharts();
    state.bannerClosed = false;

    $('#uploadView').hidden = true;
    $('#dashView').hidden = false;
    $('#btnNewFile').hidden = false;
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
    if (!state.charts.length) state.charts = suggestCharts();
    updateInfo();
    buildFilters();
    analyzeData();
    refresh();
  }

  // ---------- Columnas útiles ----------

  const col = (name) => state.columns.find((c) => c.name === name);
  function metrics() {
    const nums = state.columns.filter((c) => c.type === 'number' && !c.idLike && c.unique > 1);
    return nums.map((c, i) => [c, metricRank(c), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([c]) => c);
  }
  function categories() {
    return state.columns.filter((c) => c.type === 'text' && c.categorical && c.unique >= 2);
  }

  function suggestCharts() {
    const m = metrics();
    const cats = categories();
    const date = state.columns.find((c) => c.type === 'date');
    const m1 = m[0];
    const agg = m1 ? 'sum' : 'count';
    const y = m1 ? m1.name : null;
    const out = [];
    const add = (c) => out.push({ id: state.nextId++, limit: 10, sort: null, title: '', ...c });

    if (date) add({ type: 'area', x: date.name, y, agg, grain: D.autoGrain(date), wide: true });
    if (cats[0]) add({ type: 'bar', x: cats[0].name, y, agg });
    const small = [...cats].filter((c) => c.unique <= 6).sort((a, b) => a.unique - b.unique)[0];
    if (small) add({ type: 'pie', x: small.name, y, agg, limit: 6 });
    const restCats = cats.filter((c) => c !== cats[0] && c !== small);
    if (restCats[0]) add({ type: 'hbar', x: restCats[0].name, y, agg });
    if (restCats[1] && m[1]) add({ type: 'hbar', x: restCats[1].name, y: m[1].name, agg: 'avg' });
    else if (restCats[1]) add({ type: 'bar', x: restCats[1].name, y, agg });
    if (m.length >= 2 && out.length < 6) add({ type: 'scatter', x: m[0].name, y: m[1].name, agg: 'none' });

    if (!out.length) {
      const first = state.columns.find((c) => c.type === 'text') || state.columns[0];
      if (first) add({ type: 'bar', x: first.name, y: null, agg: 'count' });
    }
    return out;
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
  function filteredRows(except) {
    const fs = Object.entries(state.filters).filter(([c]) => c !== except);
    const df = state.dateFilter && (state.dateFilter.from || state.dateFilter.to) && state.dateFilter.col !== except ? state.dateFilter : null;
    if (!fs.length && !df) return state.rows;
    return state.rows.filter((r) => {
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
    renderKpis();
    renderCharts();
    state.table.page = 0;
    renderTable();
  }

  // ---------- KPIs ----------

  function renderKpis() {
    const rows = filteredRows();
    const box = $('#kpis');
    const tiles = [];
    const total = state.rows.length;
    tiles.push({ label: 'Registros', value: D.fmtNum(rows.length), sub: rows.length === total ? 'Total del archivo' : `de ${D.fmtNum(total)} (${D.fmtNum((rows.length / total) * 100)}%)` });
    metrics().slice(0, 3).forEach((m) => {
      const sum = D.summarize(rows, m.name, 'sum');
      const avg = D.summarize(rows, m.name, 'avg');
      tiles.push({ label: `${m.name} · total`, value: D.fmtCompact(sum), title: D.fmtNum(sum), sub: `Promedio: ${D.fmtNum(avg)}` });
    });
    if (state.dateFilter) {
      const dc = state.dateFilter.col;
      let min = null, max = null;
      rows.forEach((r) => { const v = r[dc]; if (v) { if (!min || v < min) min = v; if (!max || v > max) max = v; } });
      tiles.push({ label: `Periodo (${dc})`, value: min ? `${Math.round((max - min) / 86400000) + 1} días` : '—', sub: min ? `${D.fmtDate(min)} – ${D.fmtDate(max)}` : 'Sin fechas' });
    } else {
      const cats = categories();
      if (cats[0]) tiles.push({ label: `${cats[0].name} · únicos`, value: D.fmtNum(D.summarize(rows, cats[0].name, 'distinct')), sub: `de ${D.fmtNum(cats[0].unique)} en total` });
    }
    box.replaceChildren(...tiles.map((t) => el('div', { class: 'kpi', title: t.title },
      el('div', { class: 'label' }, t.label), el('div', { class: 'value' }, t.value), el('div', { class: 'sub' }, t.sub))));
  }

  // ---------- Gráficas ----------

  function chartTitle(c) {
    if (c.title) return c.title;
    if (c.type === 'scatter') return `${c.y} vs ${c.x}`;
    if (c.agg === 'count') return `Registros por ${c.x}`;
    return `${AGG_LABEL[c.agg]} de ${c.y} por ${c.x}`;
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
  }

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

  function buildConfig(c) {
    const p = palette();
    const xc = col(c.x);
    if (!xc) return null;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = p.text;

    const tooltip = {
      backgroundColor: p.surface, titleColor: p.primary, bodyColor: p.text, borderColor: p.border, borderWidth: 1,
      padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
    };
    const axis = (title) => ({
      grid: { color: p.grid, drawTicks: false }, border: { display: false },
      ticks: { color: p.text, padding: 6, maxRotation: 0, autoSkip: true, callback(v) { const l = this.getLabelForValue ? this.getLabelForValue(v) : v; return typeof l === 'number' ? D.fmtCompact(l) : truncate(String(l), 18); } },
      title: title ? { display: true, text: title, color: p.muted } : undefined,
    });
    const valueAxis = (title) => ({
      grid: { color: p.grid, drawTicks: false }, border: { display: false }, beginAtZero: true,
      ticks: { color: p.text, padding: 6, callback: (v) => D.fmtCompact(v) },
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
      return {
        type: 'scatter',
        data: { datasets: [{ label: chartTitle(c), data: pts, backgroundColor: alpha(p.series[0], 0.55), borderColor: p.surface, borderWidth: 1, pointRadius: 4, pointHoverRadius: 6 }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
          plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (ctx) => `${c.x}: ${D.fmtNum(ctx.parsed.x)} · ${c.y}: ${D.fmtNum(ctx.parsed.y)}` } } },
          scales: {
            x: { ...valueAxis(c.x), beginAtZero: false, type: 'linear' },
            y: { ...valueAxis(c.y), beginAtZero: false },
          },
        },
      };
    }

    // Excluir el filtro de la propia columna X para poder resaltar la selección.
    const own = xc.type === 'text' ? state.filters[c.x] : null;
    const rows = filteredRows(own ? c.x : undefined);
    const isPie = c.type === 'pie';
    const limit = xc.type === 'text' ? (isPie ? Math.min(c.limit || 6, 7) : c.limit) : 0;
    const data = D.aggregate(rows, xc, c.y, c.agg, { grain: c.grain, limit, sort: c.sort || undefined });
    if (!data.length) return null;

    const labels = data.map((d) => d.label);
    const values = data.map((d) => d.value);
    const selected = (d) => !own || own.has(d.raw);
    const valueName = c.agg === 'count' ? 'Registros' : `${AGG_LABEL[c.agg]} de ${c.y}`;
    const onClick = xc.type === 'text' ? (evt, els) => {
      if (!els.length) return;
      const d = data[els[0].index];
      // Diferir: Chart.js sigue procesando el evento y no debe destruirse dentro de él.
      if (d && !d.other) setTimeout(() => toggleFilter(c.x, d.raw), 0);
    } : undefined;
    const onHover = (evt, els) => { evt.native.target.style.cursor = els.length && onClick ? 'pointer' : 'default'; };
    const tooltipCb = {
      ...tooltip,
      callbacks: {
        label: (ctx) => {
          const v = isPie ? ctx.parsed : (c.type === 'hbar' ? ctx.parsed.x : ctx.parsed.y);
          let s = ` ${valueName}: ${D.fmtNum(v)}`;
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
          responsive: true, maintainAspectRatio: false, cutout: '58%', animation: { duration: 300 }, onClick, onHover,
          plugins: {
            legend: { position: 'right', labels: { color: p.text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 12, generateLabels: (ch) => Chart.overrides.doughnut.plugins.legend.labels.generateLabels(ch).map((l) => ({ ...l, text: truncate(l.text, 22) })) } },
            tooltip: tooltipCb,
          },
        },
      };
    }

    const base = p.series[0];
    const bg = data.map((d) => (d.other ? p.other : selected(d) ? base : alpha(base, 0.25)));
    if (c.type === 'line' || c.type === 'area') {
      return {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: valueName, data: values, borderColor: base, backgroundColor: alpha(base, 0.14), fill: c.type === 'area' ? 'origin' : false,
            borderWidth: 2, tension: 0.25, pointRadius: data.length > 40 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: base, pointBorderColor: p.surface, pointBorderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, onClick, onHover,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: tooltipCb },
          scales: { x: { ...axis(), grid: { display: false } }, y: valueAxis() },
        },
      };
    }

    const horizontal = c.type === 'hbar';
    return {
      type: 'bar',
      data: { labels, datasets: [{ label: valueName, data: values, backgroundColor: bg, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 44, categoryPercentage: 0.8, barPercentage: 0.9 }] },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, onClick, onHover,
        interaction: { mode: 'nearest', axis: horizontal ? 'y' : 'x', intersect: false },
        plugins: { legend: { display: false }, tooltip: tooltipCb },
        scales: horizontal
          ? { x: valueAxis(), y: { ...axis(), grid: { display: false } } }
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
    const defaults = chart || { type: 'bar', x: (categories()[0] || state.columns[0]).name, y: m[0] ? m[0].name : null, agg: m[0] ? 'sum' : 'count', grain: 'month', limit: 10, sort: '', title: '' };
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

  ['#fX', '#fAgg'].forEach((s) => $(s).addEventListener('change', () => syncDialog()));

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
    };
    if (state.editing) Object.assign(state.editing, cfg);
    else state.charts.push({ id: state.nextId++, wide: false, ...cfg });
    renderCharts();
  });

  // ---------- Limpieza de datos ----------

  const C = window.Cleaner;
  const cleanDlg = $('#cleanDialog');

  function analyzeData() {
    const t = state.tbl;
    state.report = C.analyze(t);
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
    let rows = filteredRows();
    const q = state.table.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => state.columns.some((c) => {
        const v = r[c.name];
        return v !== null && D.fmtCell(v, c.type).toLowerCase().includes(q);
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
    const tbody = el('tbody', {}, slice.map((r) => el('tr', {}, state.columns.map((c) => el('td', { class: c.type === 'number' ? 'num' : '' }, D.fmtCell(r[c.name], c.type))))));
    $('#dataTable').replaceChildren(thead, tbody);
    $('#rowCount').textContent = `· ${D.fmtNum(rows.length)} filas`;

    const pager = $('#pager');
    pager.replaceChildren(
      el('span', {}, rows.length ? `${D.fmtNum(cur * size + 1)}–${D.fmtNum(Math.min(rows.length, (cur + 1) * size))} de ${D.fmtNum(rows.length)}` : 'Sin resultados'),
      el('button', { class: 'btn sm', disabled: cur === 0, onclick: () => { state.table.page = cur - 1; renderTable(); } }, '‹ Anterior'),
      el('button', { class: 'btn sm', disabled: cur >= pages - 1, onclick: () => { state.table.page = cur + 1; renderTable(); } }, 'Siguiente ›'));
  }

  let searchTimer;
  $('#tableSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.table.search = e.target.value; state.table.page = 0; renderTable(); }, 200);
  });

  $('#btnExport').addEventListener('click', () => exportCSV(tableRows(), '_filtrado'));
})();
