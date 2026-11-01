// Analizador de calidad y limpieza de datos.
// analyze(table) devuelve { score, stats, autoFixes, issues }.
// Cada acción de un problema devuelve una tabla nueva { columns, rows } sin modificar la anterior,
// así se puede deshacer simplemente guardando la versión previa.
(function () {
  'use strict';
  const D = window.DataKit;
  const nf = (n) => D.fmtNum(n);

  const keyOf = (v) => (v instanceof Date ? 'd' + v.getTime() : v === null || v === undefined ? '∅' : typeof v + ':' + v);
  // Clave para comparar textos que "son lo mismo": sin mayúsculas, acentos, espacios ni puntos finales.
  const normText = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,;:]+$/, '').replace(/\s+/g, ' ').trim();
  const TOTAL_RE = /^(sub ?total(es)?|total(es)?( general)?|gran total|suma total|grand total)\b/i;

  // Copia una fila conservando sus marcas de celdas no válidas (menos las columnas indicadas).
  function cloneRow(r, dropInvalid = []) {
    const o = { ...r };
    const bad = D.invalidCells.get(r);
    if (bad) {
      const rest = { ...bad };
      dropInvalid.forEach((c) => delete rest[c]);
      if (Object.keys(rest).length) D.invalidCells.set(o, rest);
    }
    return o;
  }
  function withVal(r, name, v) { const o = cloneRow(r, [name]); o[name] = v; return o; }
  const cloneCols = (cols) => cols.map((c) => ({ ...c }));

  function sample(list, n = 5) {
    const uniq = [...new Set(list.map((v) => (v instanceof Date ? D.fmtDate(v) : String(v))))];
    return uniq.slice(0, n).concat(uniq.length > n ? [`+${uniq.length - n} más`] : []);
  }

  function analyze(table) {
    const { columns, rows } = table;
    const meta = table.meta || {};
    const issues = [];
    const add = (i) => issues.push(i);
    const n = rows.length;

    // ---- Correcciones que ya se aplicaron al importar ----
    const autoFixes = [];
    if (meta.skippedTop) autoFixes.push(`Se detectó el encabezado en la fila ${meta.headerRow}; se omitieron ${meta.skippedTop} fila(s) de título o notas arriba de la tabla.`);
    if (meta.emptyRows) autoFixes.push(`Se eliminaron ${nf(meta.emptyRows)} fila(s) completamente vacías.`);
    if (meta.emptyCols && meta.emptyCols.length) autoFixes.push(`Se descartaron ${meta.emptyCols.length} columna(s) sin datos.`);
    if (meta.trimmed) autoFixes.push(`Se quitaron espacios sobrantes en ${nf(meta.trimmed)} celda(s) de texto.`);
    (meta.renamedHeaders || []).forEach((r) => autoFixes.push(`Encabezado ${r.from === '(vacío)' ? 'vacío' : `repetido “${r.from}”`} renombrado a “${r.to}”.`));

    // ---- Filas duplicadas ----
    const seen = new Set();
    const dupIdx = [];
    rows.forEach((r, i) => {
      const k = columns.map((c) => keyOf(r[c.name])).join('|');
      if (seen.has(k)) dupIdx.push(i); else seen.add(k);
    });
    if (dupIdx.length) {
      const drop = new Set(dupIdx);
      add({
        id: 'dups', severity: 'warn', recommended: true,
        title: `${nf(dupIdx.length)} fila(s) duplicadas`,
        detail: 'Filas idénticas en todas sus columnas. Inflan los totales y conteos del dashboard.',
        samples: dupIdx.slice(0, 3).map((i) => `Fila ${i + 1}: ${columns.slice(0, 4).map((c) => D.fmtCell(rows[i][c.name], c.type)).join(' · ')}`),
        actions: [{ label: 'Eliminar duplicados (conservar la primera)', run: () => ({ columns, rows: rows.filter((_, i) => !drop.has(i)) }), message: `Se eliminaron ${nf(dupIdx.length)} filas duplicadas.` }],
      });
    }

    // ---- Filas de totales / subtotales ----
    const textCols = columns.filter((c) => c.type === 'text');
    const totalIdx = [];
    rows.forEach((r, i) => { if (textCols.some((c) => typeof r[c.name] === 'string' && TOTAL_RE.test(r[c.name]))) totalIdx.push(i); });
    if (totalIdx.length && totalIdx.length < n * 0.2) {
      const drop = new Set(totalIdx);
      add({
        id: 'totals', severity: 'warn', recommended: true,
        title: `${nf(totalIdx.length)} fila(s) de totales o subtotales`,
        detail: 'Parecen filas de resumen copiadas de un reporte. Si se quedan, los valores se cuentan dos veces.',
        samples: totalIdx.slice(0, 3).map((i) => `Fila ${i + 1}: ${columns.slice(0, 4).map((c) => D.fmtCell(rows[i][c.name], c.type)).join(' · ')}`),
        actions: [{ label: 'Eliminar estas filas', run: () => ({ columns, rows: rows.filter((_, i) => !drop.has(i)) }), message: `Se eliminaron ${nf(totalIdx.length)} filas de totales.` }],
      });
    }

    // ---- Problemas por columna ----
    let emptyCells = 0, invalidTotal = 0;
    columns.forEach((c) => {
      const name = c.name;
      const nulls = [];
      const invalid = [];
      rows.forEach((r, i) => {
        if (r[name] === null || r[name] === undefined) {
          const bad = D.invalidCells.get(r);
          if (bad && name in bad) invalid.push([i, bad[name]]);
          else nulls.push(i);
        }
      });
      emptyCells += nulls.length;
      invalidTotal += invalid.length;
      const pct = (k) => `${nf((k / n) * 100)}%`;

      // Columna casi vacía
      if (nulls.length / n >= 0.9 && n > 1) {
        add({
          id: `sparse:${name}`, severity: 'info', column: name,
          title: `“${name}” está casi vacía (${pct(nulls.length)} sin datos)`,
          detail: 'Aporta poca información al análisis.',
          actions: [dropColumn(columns, rows, name)],
        });
        return;
      }

      // Valores con formato incorrecto (no son número / fecha)
      if (invalid.length) {
        const typeName = c.type === 'number' ? 'números' : 'fechas';
        const badRows = new Set(invalid.map(([i]) => i));
        add({
          id: `invalid:${name}`, severity: 'warn', column: name, recommended: false,
          title: `${nf(invalid.length)} valor(es) no válidos en “${name}”`,
          detail: `La columna contiene ${typeName}, pero estos valores no se pudieron interpretar y se ignoran en los cálculos.`,
          samples: sample(invalid.map(([, v]) => v)),
          actions: [
            { label: 'Dejar como vacíos', run: () => ({ columns, rows: rows.map((r, i) => (badRows.has(i) ? cloneRow(r, [name]) : r)) }), message: `Valores no válidos de “${name}” marcados como vacíos.` },
            { label: 'Eliminar esas filas', run: () => ({ columns, rows: rows.filter((_, i) => !badRows.has(i)) }), message: `Se eliminaron ${nf(badRows.size)} filas con valores no válidos.` },
          ],
        });
      }

      // Celdas vacías
      if (nulls.length) {
        const empty = new Set(nulls);
        const fill = (v, label) => ({
          label,
          run: () => ({ columns, rows: rows.map((r, i) => (empty.has(i) ? withVal(r, name, v) : r)) }),
          message: `Se rellenaron ${nf(nulls.length)} celdas vacías en “${name}”.`,
        });
        const actions = [];
        if (c.type === 'number') {
          const avg = D.summarize(rows, name, 'avg');
          const med = median(rows.map((r) => r[name]).filter((v) => typeof v === 'number'));
          actions.push(fill(0, 'Rellenar con 0'));
          actions.push(fill(round(avg), `Rellenar con el promedio (${nf(avg)})`));
          actions.push(fill(med, `Rellenar con la mediana (${nf(med)})`));
        } else if (c.type === 'text') {
          actions.push(fill('Sin dato', 'Rellenar con “Sin dato”'));
        }
        actions.push({ label: 'Eliminar filas vacías en esta columna', run: () => ({ columns, rows: rows.filter((_, i) => !empty.has(i)) }), message: `Se eliminaron ${nf(nulls.length)} filas sin “${name}”.` });
        add({
          id: `nulls:${name}`, severity: nulls.length / n > 0.05 ? 'warn' : 'info', column: name,
          title: `${nf(nulls.length)} celda(s) vacías en “${name}” (${pct(nulls.length)})`,
          detail: 'Las celdas vacías se excluyen de sumas, promedios y agrupaciones.',
          actions,
        });
      }

      // Texto con variantes de escritura ("Norte", "norte", "NORTE ")
      if (c.type === 'text' && c.unique <= 2000) {
        const groups = new Map();
        const freq = new Map();
        rows.forEach((r) => {
          const v = r[name];
          if (typeof v !== 'string') return;
          freq.set(v, (freq.get(v) || 0) + 1);
          const k = normText(v);
          if (!groups.has(k)) groups.set(k, new Set());
          groups.get(k).add(v);
        });
        const multi = [...groups.values()].filter((s) => s.size > 1);
        if (multi.length) {
          const map = new Map();
          multi.forEach((set) => {
            const best = [...set].sort((a, b) => freq.get(b) - freq.get(a))[0];
            set.forEach((v) => { if (v !== best) map.set(v, best); });
          });
          const affected = rows.filter((r) => map.has(r[name])).length;
          add({
            id: `variants:${name}`, severity: 'warn', column: name, recommended: true,
            title: `“${name}” tiene ${multi.length} valor(es) escritos de distintas formas`,
            detail: `Mayúsculas, acentos o puntuación diferentes hacen que un mismo valor aparezca como categorías separadas (${nf(affected)} celdas).`,
            samples: multi.slice(0, 4).map((s) => [...s].map((v) => `“${v}”`).join(' / ')),
            actions: [{
              label: 'Unificar (usar la forma más común)',
              run: () => ({ columns, rows: rows.map((r) => (map.has(r[name]) ? withVal(r, name, map.get(r[name])) : r)) }),
              message: `Se unificaron ${nf(affected)} celdas en “${name}”.`,
            }],
          });
        }

        // Columna de texto que en realidad es numérica con algunos valores sucios
        const vals = rows.map((r) => r[name]).filter((v) => typeof v === 'string');
        const numeric = vals.filter((v) => D.parseNumber(v) !== null).length;
        if (vals.length >= 5 && numeric / vals.length >= 0.6 && numeric < vals.length) {
          const bads = vals.filter((v) => D.parseNumber(v) === null);
          add({
            id: `mixed:${name}`, severity: 'warn', column: name,
            title: `“${name}” mezcla números con texto`,
            detail: `${pct(numeric)} de los valores son números, pero la columna se trata como texto por ${nf(bads.length)} valor(es) que no lo son. Al convertirla podrás sumarla y promediarla.`,
            samples: sample(bads),
            actions: [{
              label: 'Convertir a número (lo demás queda vacío)',
              run: () => {
                const cols = cloneCols(columns).map((x) => (x.name === name ? { ...x, type: 'number' } : x));
                const out = rows.map((r) => {
                  const o = cloneRow(r);
                  const v = r[name];
                  const num = typeof v === 'string' ? D.parseNumber(v) : null;
                  o[name] = num;
                  if (num === null && v !== null) D.invalidCells.set(o, { ...(D.invalidCells.get(o) || {}), [name]: v });
                  return o;
                });
                return { columns: cols, rows: out };
              },
              message: `“${name}” ahora es una columna numérica.`,
            }],
          });
        }
      }

      // Valores atípicos (muy lejos del resto) en columnas numéricas
      if (c.type === 'number' && !c.idLike) {
        const nums = rows.map((r) => r[name]).filter((v) => typeof v === 'number');
        if (nums.length >= 20) {
          const sorted = [...nums].sort((a, b) => a - b);
          const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
          if (iqr > 0) {
            const lo = q1 - 3 * iqr, hi = q3 + 3 * iqr;
            const out = new Set();
            rows.forEach((r, i) => { const v = r[name]; if (typeof v === 'number' && (v < lo || v > hi)) out.add(i); });
            if (out.size && out.size <= Math.max(1, nums.length * 0.01)) {
              add({
                id: `outliers:${name}`, severity: 'info', column: name,
                title: `${nf(out.size)} valor(es) atípicos en “${name}”`,
                detail: `Están muy lejos del rango habitual (${nf(round(q1))} – ${nf(round(q3))}). Pueden ser errores de captura o casos reales; revísalos antes de eliminarlos.`,
                samples: sample([...out].map((i) => rows[i][name])),
                actions: [{ label: 'Eliminar esas filas', run: () => ({ columns, rows: rows.filter((_, i) => !out.has(i)) }), message: `Se eliminaron ${nf(out.size)} filas con valores atípicos.` }],
              });
            }
          }
        }
      }

      // Columna con un solo valor
      if (n > 1 && c.unique === 1 && nulls.length === 0 && invalid.length === 0) {
        add({
          id: `const:${name}`, severity: 'info', column: name,
          title: `“${name}” tiene el mismo valor en todas las filas`,
          detail: 'No sirve para comparar ni filtrar.',
          actions: [dropColumn(columns, rows, name)],
        });
      }
    });

    const cells = n * columns.length || 1;
    const completeness = 1 - (emptyCells + invalidTotal) / cells;
    const uniqueness = n ? 1 - (dupIdx.length + totalIdx.length) / n : 1;
    const consistency = 1 - Math.min(1, issues.filter((i) => /^(variants|mixed)/.test(i.id)).length / Math.max(1, columns.length));
    const score = Math.round(100 * completeness * uniqueness * (0.85 + 0.15 * consistency));

    const order = { warn: 0, info: 1 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    return {
      score,
      stats: { rows: n, columns: columns.length, emptyCells, invalid: invalidTotal, duplicates: dupIdx.length },
      autoFixes,
      issues,
    };
  }

  function dropColumn(columns, rows, name) {
    return {
      label: 'Eliminar columna',
      run: () => ({
        columns: columns.filter((c) => c.name !== name),
        rows: rows.map((r) => { const o = cloneRow(r, [name]); delete o[name]; return o; }),
      }),
      message: `Se eliminó la columna “${name}”.`,
    };
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q, b = Math.floor(pos), r = pos - b;
    return sorted[b + 1] !== undefined ? sorted[b] + r * (sorted[b + 1] - sorted[b]) : sorted[b];
  }
  function median(arr) { return arr.length ? quantile([...arr].sort((a, b) => a - b), 0.5) : 0; }
  function round(v) { return Math.round(v * 100) / 100; }

  window.Cleaner = { analyze, cloneCols };
})();
