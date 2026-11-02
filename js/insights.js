// Motor estadístico local: Smart Insights sin IA (Pareto, anomalías, tendencias, correlaciones)
// y resumen estadístico compacto que se usa como contexto para los modelos de IA.
(function () {
  'use strict';
  const D = window.DataKit;

  // ---------- Estadística básica ----------

  function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
    const cov = sxy - (sx * sy) / n;
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    if (vx <= 0 || vy <= 0) return null;
    return cov / Math.sqrt(vx * vy);
  }
  function describeR(r) {
    const a = Math.abs(r);
    const force = a >= 0.8 ? 'muy fuerte' : a >= 0.6 ? 'fuerte' : a >= 0.4 ? 'moderada' : a >= 0.2 ? 'débil' : 'casi nula';
    return `correlación ${force} ${r >= 0 ? 'positiva' : 'negativa'}`;
  }
  // Regresión lineal sobre la posición (0, 1, 2…): pendiente por periodo.
  function linreg(values) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
    const n = pts.length;
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(([x, y]) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    return { slope, intercept, at: (i) => intercept + slope * i };
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, b = Math.floor(pos), r = pos - b;
    return sorted[b + 1] !== undefined ? sorted[b] + r * (sorted[b + 1] - sorted[b]) : sorted[b];
  }
  // Filas con valores extremos (método IQR, k = 3) en alguna de las columnas indicadas.
  function outlierRows(rows, cols, k = 3) {
    const out = new Set();
    const detail = [];
    cols.forEach((c) => {
      const vals = rows.map((r) => r[c.name]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
      if (vals.length < 20) return;
      const q1 = quantile(vals, 0.25), q3 = quantile(vals, 0.75), iqr = q3 - q1;
      if (!(iqr > 0)) return;
      const lo = q1 - k * iqr, hi = q3 + k * iqr;
      let n = 0;
      rows.forEach((r) => { const v = r[c.name]; if (typeof v === 'number' && (v < lo || v > hi)) { out.add(r); n++; } });
      if (n) detail.push({ col: c.name, n, lo, hi });
    });
    return { rows: out, detail };
  }

  // ---------- Smart Insights ----------

  const fmt = (v, c) => D.fmtValue(v, c, true);
  const pctTxt = (x) => `${D.fmtNum(Math.round(x * 1000) / 10)}%`;

  // ctx: { rows, columns, metrics, categories, time, label, log, agg(metric) }
  function generate(ctx) {
    const { rows } = ctx;
    const out = [];
    if (!rows.length) return out;
    const additive = ctx.metrics.filter((m) => !m.percent && !(ctx.time && ctx.time.periodic) && (m.min ?? 0) >= 0);
    const main = ctx.metrics[0];

    // 1. Pareto / concentración por categoría.
    const groupCols = [...ctx.categories.filter((c) => c.unique >= 4), ...(ctx.label ? [ctx.label] : [])].slice(0, 3);
    additive.slice(0, 2).forEach((m) => {
      groupCols.forEach((g) => {
        const data = D.aggregate(rows, g, m.name, 'sum', { noOther: true }).filter((d) => (d.value || 0) > 0);
        const total = data.reduce((a, d) => a + d.value, 0);
        if (data.length < 4 || !total) return;
        let cum = 0, k = 0;
        while (k < data.length && cum / total < 0.8) cum += data[k++].value;
        const shareGroups = k / data.length;
        if (shareGroups <= 0.4) {
          out.push({ kind: 'pareto', icon: '📊', score: 90 - shareGroups * 50,
            text: `El ${pctTxt(shareGroups)} de ${g.name} (${k} de ${data.length}) genera el ${pctTxt(cum / total)} de ${m.name}. Los principales: ${data.slice(0, Math.min(k, 3)).map((d) => d.label).join(', ')}.` });
        } else {
          const top = data[0];
          out.push({ kind: 'concentracion', icon: '🏆', score: 62,
            text: `${top.label} lidera ${m.name} por ${g.name} con ${fmt(top.value, m)} (${pctTxt(top.value / total)} del total).` });
        }
      });
    });

    // 2. Tendencia en el tiempo (primer vs último periodo + pendiente).
    const t = ctx.time;
    if (t && t.date) {
      ctx.metrics.slice(0, 3).forEach((m) => {
        const agg = ctx.agg(m);
        const series = D.aggregate(rows, t.date, m.name, agg, { grain: t.grain }).filter((d) => typeof d.value === 'number');
        if (series.length < 4) return;
        const vals = series.map((d) => d.value);
        const first = series[0], last = series[series.length - 1];
        const lr = linreg(vals);
        const meanV = vals.reduce((a, v) => a + v, 0) / vals.length;
        if (lr && meanV) {
          const relSlope = lr.slope / Math.abs(meanV);
          if (Math.abs(relSlope) >= 0.005) {
            // La tendencia (pendiente) y el cambio entre extremos pueden diferir: se reportan por separado y con signo.
            const diff = last.value - first.value;
            const change = m.percent ? `${diff >= 0 ? '+' : '−'}${D.fmtNum(Math.abs(diff * 100))} pp` : first.value ? `${diff >= 0 ? '+' : '−'}${pctTxt(Math.abs(diff / first.value))}` : '';
            const perPeriod = m.percent ? `${D.fmtNum(Math.round(lr.slope * 1000) / 10)} pp` : `${relSlope >= 0 ? '+' : '−'}${pctTxt(Math.abs(relSlope))}`;
            out.push({ kind: 'tendencia', icon: lr.slope > 0 ? '📈' : '📉', score: 70 + Math.min(20, Math.abs(relSlope) * 400),
              text: `${m.name} tiene tendencia ${lr.slope > 0 ? 'al alza' : 'a la baja'} (${perPeriod} por periodo en promedio). Pasó de ${fmt(first.value, m)} (${first.label}) a ${fmt(last.value, m)} (${last.label})${change ? `, ${change}` : ''}.` });
          } else {
            out.push({ kind: 'estable', icon: '➖', score: 30, text: `${m.name} se mantiene estable entre ${first.label} y ${last.label} (alrededor de ${fmt(meanV, m)}).` });
          }
        }
        // 3. Anomalías: periodos a más de 2 desviaciones estándar de la media.
        const sd = Math.sqrt(vals.reduce((a, v) => a + (v - meanV) ** 2, 0) / (vals.length - 1));
        if (sd > 0) {
          const anom = series.filter((d) => Math.abs(d.value - meanV) > 2 * sd);
          if (anom.length && anom.length <= Math.max(2, series.length * 0.1)) {
            const a = anom.sort((x, y) => Math.abs(y.value - meanV) - Math.abs(x.value - meanV))[0];
            out.push({ kind: 'anomalia', icon: '⚠️', score: 75,
              text: `Anomalía: en ${a.label} ${m.name} fue ${fmt(a.value, m)}, ${a.value > meanV ? 'muy por encima' : 'muy por debajo'} de su promedio (${fmt(meanV, m)}; más de 2σ).${anom.length > 1 ? ` Hay ${anom.length} periodos atípicos.` : ''}` });
          }
        }
      });
    } else if (main && main.std > 0) {
      // Sin fechas: registros a más de 2σ.
      const hi = main.mean + 2 * main.std, lo = main.mean - 2 * main.std;
      const n = rows.filter((r) => typeof r[main.name] === 'number' && (r[main.name] > hi || r[main.name] < lo)).length;
      if (n && n <= rows.length * 0.1) {
        out.push({ kind: 'anomalia', icon: '⚠️', score: 50, text: `${n} registro(s) tienen ${main.name} fuera de lo normal (a más de 2σ del promedio ${fmt(main.mean, main)}).` });
      }
    }

    // 4. Correlaciones fuertes entre columnas numéricas.
    const nums = ctx.metrics.slice(0, 8);
    const pairs = [];
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const xs = [], ys = [];
        rows.forEach((r) => { const a = r[nums[i].name], b = r[nums[j].name]; if (typeof a === 'number' && typeof b === 'number') { xs.push(a); ys.push(b); } });
        const r = pearson(xs, ys);
        if (r !== null && Math.abs(r) >= 0.7 && Math.abs(r) < 0.999) pairs.push({ a: nums[i], b: nums[j], r });
      }
    }
    pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 2).forEach((p) => out.push({
      kind: 'correlacion', icon: '🔗', score: 50 + Math.abs(p.r) * 20,
      text: `${p.a.name} y ${p.b.name} tienen ${describeR(p.r)} (r = ${p.r.toFixed(2)}): cuando uno ${p.r > 0 ? 'sube, el otro también' : 'sube, el otro baja'}.`,
    }));

    // 5. Calidad de datos.
    if (ctx.log && ctx.log.length) out.push({ kind: 'limpieza', icon: '🧹', score: 20, text: `Limpieza aplicada: ${ctx.log.slice(-3).join(' ')}` });

    // Variedad: como máximo 2 hallazgos del mismo tipo.
    const perKind = {};
    return out.sort((a, b) => b.score - a.score).filter((i) => (perKind[i.kind] = (perKind[i.kind] || 0) + 1) <= 2).slice(0, 8);
  }

  // ---------- Resumen estadístico (contexto compacto para la IA) ----------

  function median(sorted) { return quantile(sorted, 0.5); }
  function stats(ctx) {
    const { rows, columns } = ctx;
    const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
    const cols = columns.map((c) => {
      const o = { nombre: c.name, tipo: c.type === 'number' ? (c.percent ? 'porcentaje (fracción 0-1)' : c.currency ? 'moneda' : 'número') : c.type === 'date' ? 'fecha' : c.idLike ? 'identificador' : c.categorical ? 'categoría' : 'texto', vacios: rows.length - (c.filled || 0) };
      if (c.type === 'number') {
        const vals = rows.map((r) => r[c.name]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
        Object.assign(o, { suma: r3(c.sum), media: r3(c.mean), mediana: r3(median(vals)), min: r3(c.min), max: r3(c.max), desv_std: r3(c.std) });
      } else if (c.type === 'date' && c.min) {
        Object.assign(o, { desde: D.dateKey(c.min, 'day').key, hasta: D.dateKey(c.max, 'day').key, fechas_distintas: c.unique });
      } else if (c.type === 'text') {
        const counts = new Map();
        rows.forEach((r) => { const v = r[c.name]; if (v !== null && v !== undefined) counts.set(v, (counts.get(v) || 0) + 1); });
        o.valores_distintos = c.unique;
        if (!c.idLike) o.top5 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v} (${n})`);
      }
      return o;
    });
    // Muestra representativa: primeras, del medio y últimas filas.
    const idx = [...new Set([0, 1, Math.floor(rows.length / 2), rows.length - 2, rows.length - 1].filter((i) => i >= 0 && i < rows.length))];
    const muestra = idx.map((i) => Object.fromEntries(columns.map((c) => {
      const v = rows[i][c.name];
      return [c.name, v instanceof Date ? D.dateKey(v, 'day').key : r3(v)];
    })));
    return { filas: rows.length, columnas: cols, muestra };
  }

  window.Insights = { generate, stats, pearson, describeR, linreg, outlierRows, quantile };
})();
