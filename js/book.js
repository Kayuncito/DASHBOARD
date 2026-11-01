// Análisis de libros con varias hojas: qué es cada hoja, cómo se relacionan y cómo combinarlas.
(function () {
  'use strict';
  const D = window.DataKit;
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_-]+/g, '');
  const keyOf = (v) => (v instanceof Date ? 'd' + v.getTime() : v === null || v === undefined ? null : typeof v === 'string' ? 's' + norm(v) : 'n' + v);

  // ¿Qué tipo de hoja es? notes = texto/instrucciones, calendar = tabla de fechas de apoyo, data = datos.
  function classify(name, t) {
    const cols = t.columns;
    const n = t.rows.length;
    if (!cols.length || !n) return { kind: 'empty', score: -1 };
    const text = cols.filter((c) => c.type === 'text');
    const nums = cols.filter((c) => c.type === 'number');
    const dates = cols.filter((c) => c.type === 'date');
    const avgLen = (() => {
      let sum = 0, k = 0;
      t.rows.slice(0, 200).forEach((r) => text.forEach((c) => { const v = r[c.name]; if (typeof v === 'string') { sum += v.length; k++; } }));
      return k ? sum / k : 0;
    })();
    if (!nums.length && !dates.length && (cols.length <= 2 || avgLen >= 30)) {
      const lines = [cols.map((c) => c.name).join(' · '), ...t.rows.map((r) => cols.map((c) => r[c.name]).filter((v) => v !== null).join(' · '))].filter(Boolean);
      return { kind: 'notes', score: -1, lines };
    }
    const d = dates[0];
    const metricCols = nums.filter((c) => !c.idLike && !c.ordinalLike);
    if (d && (/^(dim[_\s-]?)?(fecha|calendario|calendar|dates?|tiempo|time)\b/i.test(name) || (d.unique === n && n >= 300 && metricCols.every((c) => c.integer && c.max <= 9999)))) {
      if (!metricCols.some((c) => !c.integer)) return { kind: 'calendar', score: 0 };
    }
    const cats = text.filter((c) => c.categorical && c.unique >= 2);
    const score = metricCols.length * 2 + (d ? 3 : 0) + Math.min(cats.length, 3) + Math.min(n, 1000) / 250;
    return { kind: 'data', score };
  }

  // Descripción corta del contenido de una hoja.
  function describeSheet(t) {
    const parts = [];
    const d = t.columns.find((c) => c.type === 'date');
    if (d && d.min) parts.push(`${D.fmtDate(d.min)} – ${D.fmtDate(d.max)}`);
    const metrics = t.columns.filter((c) => c.type === 'number' && !c.idLike && !c.ordinalLike);
    const pct = metrics.filter((c) => c.percent).length;
    if (metrics.length) parts.push(`${metrics.length} columna(s) numérica(s)${pct ? `, ${pct} de porcentaje` : ''}`);
    const cats = t.columns.filter((c) => c.type === 'text' && c.categorical && c.unique >= 2 && c.unique <= 50);
    if (cats.length) parts.push(`categorías: ${cats.slice(0, 3).map((c) => `${c.name} (${c.unique})`).join(', ')}`);
    return parts.join(' · ');
  }

  // Columnas que dos hojas comparten (mismo nombre y tipo).
  function commonColumns(a, b) {
    const out = [];
    a.columns.forEach((ca) => {
      const cb = b.columns.find((x) => norm(x.name) === norm(ca.name) && x.type === ca.type);
      if (cb) out.push([ca.name, cb.name]);
    });
    return out;
  }
  function isUniqueKey(t, name) {
    const seen = new Set();
    for (const r of t.rows) {
      const k = keyOf(r[name]);
      if (k === null || seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  }

  // Sugerencias de combinación entre hojas.
  function suggest(book, kinds) {
    const names = book.order.filter((s) => kinds[s].kind === 'data' || kinds[s].kind === 'calendar');
    const out = [];
    // Unir (como BUSCARV): B aporta columnas a A usando una columna que en B no se repite.
    for (const a of names) {
      if (kinds[a].kind !== 'data') continue;
      for (const b of names) {
        if (a === b) continue;
        const ta = book.sheets[a], tb = book.sheets[b];
        for (const [ka, kb] of commonColumns(ta, tb)) {
          if (!isUniqueKey(tb, kb)) continue;
          const adds = tb.columns.filter((c) => c.name !== kb).map((c) => c.name);
          if (!adds.length) continue;
          // Debe haber coincidencias reales.
          const keys = new Set(tb.rows.map((r) => keyOf(r[kb])));
          const hits = ta.rows.filter((r) => keys.has(keyOf(r[ka]))).length;
          if (hits < ta.rows.length * 0.5) continue;
          out.push({
            type: 'join', a, b, ka, kb, adds,
            priority: kinds[b].kind === 'calendar' ? 2 : 1,
            text: kinds[b].kind === 'calendar'
              ? `Agregar a “${a}” las columnas de calendario de “${b}” (${adds.slice(0, 4).join(', ')}${adds.length > 4 ? '…' : ''}) usando “${ka}”. Así podrás filtrar y agrupar por año, mes o trimestre.`
              : `Unir “${a}” con “${b}” usando “${ka}”: agrega ${adds.length} columna(s) (${adds.slice(0, 4).join(', ')}${adds.length > 4 ? '…' : ''}).`,
          });
          break;
        }
      }
    }
    // Apilar: hojas con las mismas columnas (p. ej. una hoja por mes o por sucursal).
    const groups = new Map();
    names.filter((s) => kinds[s].kind === 'data').forEach((s) => {
      const sig = book.sheets[s].columns.map((c) => norm(c.name)).sort().join('|');
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(s);
    });
    groups.forEach((list) => {
      if (list.length >= 2) out.push({ type: 'stack', sheets: list, priority: 3, text: `Apilar ${list.length} hojas con las mismas columnas (${list.slice(0, 4).join(', ')}${list.length > 4 ? '…' : ''}) en una sola tabla, con una columna “Hoja” para distinguirlas.` });
    });
    return out.sort((x, y) => y.priority - x.priority);
  }

  // Une B a A (left join). Columnas repetidas reciben el nombre de la hoja.
  function join(book, a, b, ka, kb) {
    const ta = book.sheets[a], tb = book.sheets[b];
    const map = new Map();
    tb.rows.forEach((r) => { const k = keyOf(r[kb]); if (k !== null && !map.has(k)) map.set(k, r); });
    const taken = new Set(ta.columns.map((c) => c.name));
    const addCols = tb.columns.filter((c) => c.name !== kb).map((c) => {
      const to = taken.has(c.name) ? `${c.name} (${b})` : c.name;
      taken.add(to);
      return { from: c.name, col: { ...c, name: to } };
    });
    const rows = ta.rows.map((r) => {
      const m = map.get(keyOf(r[ka]));
      const o = { ...r };
      addCols.forEach(({ from, col }) => { o[col.name] = m ? m[from] : null; });
      return o;
    });
    const columns = [...ta.columns.map((c) => ({ ...c })), ...addCols.map((x) => x.col)];
    D.restat(columns, rows);
    return { columns, rows, meta: {} };
  }

  // Apila hojas con columnas compatibles y agrega la columna "Hoja".
  function stack(book, list) {
    const columns = [{ name: 'Hoja', type: 'text' }];
    const seen = new Set(['hoja']);
    list.forEach((s) => book.sheets[s].columns.forEach((c) => {
      if (!seen.has(norm(c.name))) { seen.add(norm(c.name)); columns.push({ ...c }); }
    }));
    const rows = [];
    list.forEach((s) => book.sheets[s].rows.forEach((r) => {
      const o = { Hoja: s };
      columns.slice(1).forEach((c) => {
        const k = Object.keys(r).find((x) => norm(x) === norm(c.name));
        o[c.name] = k ? r[k] : null;
      });
      rows.push(o);
    }));
    D.restat(columns, rows);
    return { columns, rows, meta: {} };
  }

  window.BookKit = { classify, describeSheet, suggest, commonColumns, join, stack };
})();
