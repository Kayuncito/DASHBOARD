// Lectura de archivos, detección de tipos y agregación.
(function () {
  'use strict';

  // ---------- Lectura ----------

  function readFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(ext)) return readWorkbook(file);
    return file.text().then((text) => ({ sheets: { Datos: parseDelimited(text) }, order: ['Datos'] }));
  }

  function readWorkbook(file) {
    return file.arrayBuffer().then((buf) => {
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheets = {};
      const order = [];
      wb.SheetNames.forEach((name) => {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true, blankrows: true });
        const table = fromMatrix(aoa);
        if (table.columns.length) { sheets[name] = table; order.push(name); }
      });
      if (!order.length) throw new Error('El libro no contiene hojas con datos.');
      return { sheets, order };
    });
  }

  function parseDelimited(text) {
    text = text.replace(/^﻿/, '');
    const res = Papa.parse(text, {
      skipEmptyLines: 'greedy',
      delimitersToGuess: ['\t', ';', ',', '|'],
    });
    let matrix = res.data;
    // Archivos de texto sin delimitador claro pero con columnas separadas por espacios múltiples.
    if (matrix.length > 1 && matrix.every((r) => r.length === 1) && /\S {2,}\S/.test(text)) {
      matrix = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.trim().split(/ {2,}/));
    }
    return fromMatrix(matrix);
  }

  // Celdas que no pudieron convertirse a su tipo (fila -> { columna: valor original }).
  const invalidCells = new WeakMap();

  const blankRow = (r) => r.every((v) => v === null || v === undefined || String(v).trim() === '');
  const filledCount = (r) => r.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length;

  // Busca la fila de encabezados: se saltan títulos o notas que el archivo tenga arriba de la tabla.
  function findHeaderRow(matrix) {
    const probe = matrix.slice(0, 60);
    const width = Math.max(...probe.map(filledCount));
    for (let i = 0; i < Math.min(15, probe.length); i++) {
      const r = probe[i];
      const n = filledCount(r);
      if (!n || n < Math.max(2, Math.ceil(width * 0.6))) continue;
      const texts = r.filter((v) => typeof v === 'string' && v.trim() !== '' && parseNumber(v) === null).length;
      // La fila siguiente debe tener datos con un ancho parecido.
      const next = probe.slice(i + 1).find((x) => !blankRow(x));
      if (texts >= n * 0.6 && (!next || filledCount(next) >= n * 0.5)) return i;
    }
    return probe.findIndex((r) => !blankRow(r));
  }

  // Convierte una matriz (con fila de encabezados) en { columns, rows, meta }.
  function fromMatrix(matrix) {
    const meta = { headerRow: 0, skippedTop: 0, emptyRows: 0, trimmed: 0, emptyCols: [], renamedHeaders: [] };
    const h = findHeaderRow(matrix);
    if (h < 0) return { columns: [], rows: [], meta };
    meta.headerRow = h + 1;
    meta.skippedTop = matrix.slice(0, h).filter((r) => !blankRow(r)).length;
    const rawHeader = matrix[h];
    let body = matrix.slice(h + 1);
    const before = body.length;
    body = body.filter((r) => !blankRow(r));
    meta.emptyRows = before - body.length;

    const width = Math.max(rawHeader.length, ...body.slice(0, 200).map((r) => r.length));
    const used = new Set();
    const names = [];
    for (let i = 0; i < width; i++) {
      const orig = rawHeader[i] == null ? '' : String(rawHeader[i]).replace(/\s+/g, ' ').trim();
      let n = orig || `Columna ${i + 1}`;
      let unique = n, k = 2;
      while (used.has(unique)) unique = `${n} (${k++})`;
      used.add(unique);
      names.push(unique);
      if (!orig) meta.renamedHeaders.push({ from: '(vacío)', to: unique });
      else if (unique !== orig) meta.renamedHeaders.push({ from: orig, to: unique });
    }

    const columns = names.map((name, i) => ({ name, ...inferType(body.map((r) => r[i])) }));
    // Descartar columnas totalmente vacías.
    const keep = columns.map((c, i) => [c, i]).filter(([c]) => c.type !== 'empty');
    meta.emptyCols = columns.filter((c) => c.type === 'empty').map((c) => c.name);
    meta.renamedHeaders = meta.renamedHeaders.filter((r) => !meta.emptyCols.includes(r.to));

    const rows = body.map((r) => {
      const o = {};
      let bad = null;
      keep.forEach(([c, i]) => {
        const raw = r[i];
        const v = convert(raw, c.type);
        if (v === null && !isBlank(raw)) (bad || (bad = {}))[c.name] = raw;
        if (c.type === 'text' && typeof raw === 'string' && raw !== v && v !== null) meta.trimmed++;
        o[c.name] = v;
      });
      if (bad) invalidCells.set(o, bad);
      return o;
    });
    const finalCols = keep.map(([c]) => c);
    finalCols.forEach((c) => describe(c, rows));
    return { columns: finalCols, rows, meta };
  }

  // Recalcula las estadísticas de las columnas después de modificar filas.
  function restat(columns, rows) { columns.forEach((c) => describe(c, rows)); }

  // ---------- Tipos ----------

  function isBlank(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }

  function parseNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    let s = v.trim().replace(/[\s$€£¥]/g, '').replace(/^\((.*)\)$/, '-$1');
    let pct = false;
    if (s.endsWith('%')) { pct = true; s = s.slice(0, -1); }
    if (!s) return null;
    if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) { /* 1234.5 */ }
    else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');          // 1,234.5
    else if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,5
    else if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');                           // 1234,5
    else if (/^[-+]?\.\d+$/.test(s)) { /* .5 */ }
    else return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return pct ? n / 100 : n;
  }

  function parseDate(v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    let m;
    // ISO: 2025-03-14, 2025/03/14, opcionalmente con hora.
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) {
      return mk(+m[1], +m[2], +m[3], m[4], m[5], m[6]);
    }
    // Día primero: 14/03/2025 (si el primer número > 12 o por convención en español).
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) {
      let a = +m[1], b = +m[2], y = +m[3];
      if (y < 100) y += 2000;
      let d = a, mo = b;
      if (b > 12 && a <= 12) { d = b; mo = a; }
      return mk(y, mo, d, m[4], m[5], m[6]);
    }
    // Mes en texto: "14 mar 2025", "Mar 2025", "enero 2025".
    const months = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
    if ((m = s.toLowerCase().match(/^(?:(\d{1,2})[\s-]+(?:de\s+)?)?([a-zé]{3})[a-zé]*\.?[\s-]+(?:de\s+)?(\d{4})$/))) {
      const mo = months[m[2]];
      if (mo) return mk(+m[3], mo, m[1] ? +m[1] : 1);
    }
    return null;
  }

  function mk(y, mo, d, h, mi, se) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
    const dt = new Date(y, mo - 1, d, +(h || 0), +(mi || 0), +(se || 0));
    return dt.getMonth() === mo - 1 ? dt : null;
  }

  function inferType(values) {
    const vals = values.filter((v) => !isBlank(v));
    if (!vals.length) return { type: 'empty' };
    const sample = vals.length > 2000 ? vals.filter((_, i) => i % Math.ceil(vals.length / 2000) === 0) : vals;
    const ratio = (fn) => sample.filter((v) => fn(v) !== null).length / sample.length;
    if (sample.some((v) => v instanceof Date) && ratio(parseDate) >= 0.9) return { type: 'date' };
    // Claves con ceros a la izquierda ("01", "007") son códigos, no cantidades.
    if (sample.filter((v) => typeof v === 'string' && /^0\d+$/.test(v.trim())).length >= sample.length * 0.2) return { type: 'text' };
    if (ratio(parseNumber) >= 0.95) {
      // Años sueltos (2019, 2020…) se tratan como categoría.
      const nums = sample.map(parseNumber).filter((n) => n !== null);
      const looksYear = nums.every((n) => Number.isInteger(n) && n >= 1900 && n <= 2100);
      const uniq = new Set(nums).size;
      if (looksYear && uniq <= 50) return { type: 'text' };
      return { type: 'number' };
    }
    if (ratio(parseDate) >= 0.9) return { type: 'date' };
    return { type: 'text' };
  }

  function convert(v, type) {
    if (isBlank(v)) return null;
    if (type === 'number') return parseNumber(v);
    if (type === 'date') return parseDate(v);
    if (v instanceof Date) return v.toLocaleDateString('es');
    return String(v).replace(/\s+/g, ' ').trim();
  }

  // Estadísticas de cada columna para sugerir gráficas y filtros.
  function describe(col, rows) {
    const vals = rows.map((r) => r[col.name]).filter((v) => v !== null);
    col.filled = vals.length;
    if (col.type === 'text') {
      const counts = new Map();
      vals.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
      col.unique = counts.size;
      col.values = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
      // Categórica si se repiten valores con suficiente frecuencia.
      const longText = col.values.slice(0, 50).some((v) => /^https?:\/\//i.test(v)) || col.values.slice(0, 50).reduce((a, v) => a + v.length, 0) / Math.min(50, col.values.length || 1) > 40;
      col.categorical = !longText && counts.size <= 200 && counts.size <= Math.max(12, vals.length * 0.5);
    } else if (col.type === 'number') {
      let min = Infinity, max = -Infinity, sum = 0;
      vals.forEach((v) => { if (v < min) min = v; if (v > max) max = v; sum += v; });
      Object.assign(col, { min, max, sum, unique: new Set(vals).size });
      col.integer = vals.every(Number.isInteger);
      // Identificadores (IDs consecutivos) no son buenas métricas.
      // Porcentajes guardados como fracción (0.25 = 25%), p. ej. celdas de Excel con formato %.
      col.percent = /(%|porcentaje|participaci|tasa|proporci|pct|ratio|rate|share|^t[a-z]?_)/i.test(col.name) && min >= -1 && max <= 1 && !col.integer;
      // Números que son posiciones o partes de fecha (mes 1-12, trimestre 1-4, día), no cantidades.
      col.ordinalLike = col.integer && max <= 31 && min >= 0 && /(num|n[uú]mero|mes|month|d[ií]a|day|trimestre|quarter|semana|week|bimestre|semestre|orden|rank)/i.test(col.name);
      col.idLike = col.integer && col.unique === vals.length && vals.length > 20 && /(^|\b)(id|folio|no\.?|n[uú]m|c[oó]digo|clave)\b/i.test(col.name);
    } else if (col.type === 'date') {
      let min = Infinity, max = -Infinity;
      vals.forEach((v) => { const t = v.getTime(); if (t < min) min = t; if (t > max) max = t; });
      col.min = new Date(min); col.max = new Date(max);
      col.unique = new Set(vals.map((v) => v.getTime())).size;
      // Datos periódicos: todas las fechas son inicio de mes (mensual, trimestral, anual).
      col.monthStart = vals.length > 0 && vals.every((v) => v.getDate() === 1 && !v.getHours());
    }
  }

  // ---------- Agregación ----------

  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function dateKey(d, grain) {
    const y = d.getFullYear(), m = d.getMonth();
    switch (grain) {
      case 'year': return { key: `${y}`, label: `${y}` };
      case 'quarter': { const q = Math.floor(m / 3) + 1; return { key: `${y}-Q${q}`, label: `T${q} ${y}` }; }
      case 'month': return { key: `${y}-${pad(m + 1)}`, label: `${MONTHS[m]} ${y}` };
      case 'week': {
        const s = new Date(y, m, d.getDate() - ((d.getDay() + 6) % 7));
        return { key: `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`, label: `${s.getDate()} ${MONTHS[s.getMonth()]} ${s.getFullYear()}` };
      }
      default: return { key: `${y}-${pad(m + 1)}-${pad(d.getDate())}`, label: `${d.getDate()} ${MONTHS[m]} ${y}` };
    }
  }

  function autoGrain(col) {
    const days = (col.max - col.min) / 86400000;
    if (days <= 45) return 'day';
    if (days <= 200) return 'week';
    if (days <= 365 * 3) return 'month';
    if (days <= 365 * 8) return 'quarter';
    return 'year';
  }

  function makeAcc(agg) {
    return { agg, n: 0, sum: 0, min: Infinity, max: -Infinity, set: agg === 'distinct' ? new Set() : null };
  }
  function addAcc(acc, v) {
    if (acc.agg === 'count') { acc.n++; return; }
    if (v === null || v === undefined) return;
    if (acc.agg === 'distinct') { acc.set.add(v instanceof Date ? v.getTime() : v); return; }
    acc.n++; acc.sum += v;
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
  }
  function finishAcc(acc) {
    switch (acc.agg) {
      case 'count': return acc.n;
      case 'distinct': return acc.set.size;
      case 'sum': return acc.sum;
      case 'avg': return acc.n ? acc.sum / acc.n : null;
      case 'min': return acc.n ? acc.min : null;
      case 'max': return acc.n ? acc.max : null;
    }
    return null;
  }

  // Agrupa filas por la columna x y calcula agg(y).
  // Devuelve [{ key, label, value, raw }] (raw = valor original para filtrar).
  function aggregate(rows, xCol, yName, agg, opts = {}) {
    const groups = new Map();
    const x = xCol.name;
    for (const r of rows) {
      const v = r[x];
      if (v === null || v === undefined) continue;
      let key, label, raw = v;
      if (xCol.type === 'date') ({ key, label } = dateKey(v, opts.grain || 'month'));
      else if (xCol.type === 'number') { key = v; label = fmtNum(v); }
      else { key = v; label = v; }
      let g = groups.get(key);
      if (!g) { g = { key, label, raw, acc: makeAcc(agg) }; groups.set(key, g); }
      addAcc(g.acc, agg === 'count' ? 1 : r[yName]);
    }
    let out = [...groups.values()].map((g) => ({ key: g.key, label: g.label, raw: g.raw, value: finishAcc(g.acc) }));

    const ordered = xCol.type !== 'text'; // fechas y números siguen su orden natural
    const sort = ordered ? 'label' : (opts.sort || 'value-desc');
    if (sort === 'label') out.sort((a, b) => (ordered ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : String(a.label).localeCompare(String(b.label), 'es', { numeric: true })));
    else if (sort === 'value-asc') out.sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
    else out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    // Limitar categorías, agrupando el resto en "Otros" (solo si la agregación es sumable).
    const limit = opts.limit || 0;
    if (limit && out.length > limit && xCol.type === 'text') {
      const byValue = [...out].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      const keepKeys = new Set(byValue.slice(0, limit).map((d) => d.key));
      const rest = out.filter((d) => !keepKeys.has(d.key));
      out = out.filter((d) => keepKeys.has(d.key));
      if ((agg === 'sum' || agg === 'count') && !opts.noOther) {
        out.push({ key: '__otros__', label: `Otros (${rest.length})`, raw: null, value: rest.reduce((s, d) => s + (d.value || 0), 0), other: true });
      }
    }
    return out;
  }

  function summarize(rows, name, agg) {
    const acc = makeAcc(agg);
    rows.forEach((r) => addAcc(acc, agg === 'count' ? 1 : r[name]));
    return finishAcc(acc);
  }

  // ---------- Formato ----------

  const nf = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
  const nfCompact = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 });
  function fmtNum(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : nf.format(v); }
  function fmtCompact(v) { return v === null || v === undefined ? '—' : Math.abs(v) < 10000 ? nf.format(v) : nfCompact.format(v); }
  function fmtDate(d) { return d ? d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }
  const pf = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 2 });
  function fmtPct(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : pf.format(v); }
  function fmtCell(v, type, percent) {
    if (v === null || v === undefined) return '';
    if (type === 'number') return percent ? fmtPct(v) : fmtNum(v);
    if (type === 'date') {
      const hasTime = v.getHours() || v.getMinutes();
      return hasTime ? v.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : fmtDate(v);
    }
    return String(v);
  }

  window.DataKit = { invalidCells, restat, parseNumber, readFile, parseDelimited, aggregate, summarize, autoGrain, fmtNum, fmtCompact, fmtDate, fmtCell, fmtPct, dateKey };
})();
