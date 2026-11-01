// Asistente: pide en lenguaje natural (escrito o por voz) qué hacer con los datos.
// Dentro de claude.ai usa a Claude (capacidad "sample") con herramientas que actúan sobre el dashboard.
// Fuera de claude.ai entiende un conjunto de comandos básicos sin IA.
(function () {
  'use strict';
  const A = window.DashApp;
  const D = window.DataKit;
  const C = window.Cleaner;
  const $ = (s) => document.querySelector(s);
  const S = A.state;

  // ---------- Utilidades ----------

  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_\s]+/g, ' ').trim();
  // Encuentra una columna aunque el nombre venga aproximado ("tasa desocupacion" -> "Tasa_desocupacion").
  function findCol(name, { required = true } = {}) {
    if (name === undefined || name === null || name === '') { if (required) throw new Error('Falta indicar la columna.'); return null; }
    const n = norm(name);
    const cols = S.columns;
    const hit = cols.find((c) => norm(c.name) === n) || cols.find((c) => norm(c.name).includes(n)) || cols.find((c) => n.includes(norm(c.name)));
    if (!hit && required) throw new Error(`No existe la columna "${name}". Columnas: ${cols.map((c) => c.name).join(', ')}`);
    return hit || null;
  }
  function matchValue(c, v) {
    if (!c.values) return v;
    const n = norm(v);
    return c.values.find((x) => norm(x) === n) ?? c.values.find((x) => norm(x).includes(n)) ?? v;
  }
  const typeName = (c) => (c.type === 'number' ? (c.percent ? 'porcentaje (fracción 0-1)' : 'número') : c.type === 'date' ? 'fecha' : 'texto');

  function fmtVal(v, c) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return D.dateKey(v, 'day').key;
    if (typeof v === 'number') return c && c.percent ? `${D.fmtNum(v * 100)}%` : Math.round(v * 1000) / 1000;
    return v;
  }

  // ---------- Contexto que se le da al asistente ----------

  function context() {
    const t = S.tbl;
    const lines = [];
    const book = S.book;
    if (book.order.length > 1) lines.push(`Hojas del archivo: ${book.order.map((s) => `${s} (${book.sheets[s].rows.length} filas)`).join('; ')}`);
    lines.push(`Hoja abierta: "${S.sheet}" con ${S.rows.length} filas.`);
    lines.push('Columnas:');
    S.columns.forEach((c) => {
      let extra = '';
      if (c.type === 'number') extra = ` rango ${fmtVal(c.min, c)} a ${fmtVal(c.max, c)}`;
      else if (c.type === 'date' && c.min) extra = ` de ${D.dateKey(c.min, 'day').key} a ${D.dateKey(c.max, 'day').key}`;
      else if (c.type === 'text') extra = ` ${c.unique} valores distintos${c.unique <= 15 ? ': ' + c.values.slice(0, 15).join(' | ') : ', p. ej. ' + c.values.slice(0, 4).join(' | ')}`;
      const empty = S.rows.length - (c.filled || 0);
      lines.push(`- ${c.name} [${typeName(c)}]${extra}${empty ? ` · ${empty} vacías` : ''}`);
    });
    const f = Object.entries(S.filters).map(([k, v]) => `${k} = ${[...v].join(', ')}`);
    if (S.dateFilter && (S.dateFilter.from || S.dateFilter.to)) f.push(`${S.dateFilter.col} entre ${S.dateFilter.from ? D.dateKey(S.dateFilter.from, 'day').key : '…'} y ${S.dateFilter.to ? D.dateKey(S.dateFilter.to, 'day').key : '…'}`);
    lines.push(`Filtros activos: ${f.length ? f.join('; ') : 'ninguno'}`);
    lines.push(`Gráficas en el dashboard: ${S.charts.length ? S.charts.map((c, i) => `#${i + 1} ${A.chartTitle(c)} (${c.type})`).join('; ') : 'ninguna'}`);
    const issues = S.report ? S.report.visible : [];
    lines.push(`Problemas de limpieza detectados (calidad ${S.report ? S.report.score : '?'}/100):`);
    if (!issues.length) lines.push('- ninguno');
    issues.slice(0, 15).forEach((i) => lines.push(`- id "${i.id}": ${i.title}. Opciones: ${i.actions.map((a, k) => `[${k}] ${a.label}`).join(' ')}`));
    if (t.log.length) lines.push(`Cambios ya aplicados: ${t.log.slice(-8).join(' / ')}`);
    lines.push('Primeras filas:');
    S.rows.slice(0, 3).forEach((r) => lines.push(JSON.stringify(Object.fromEntries(S.columns.map((c) => [c.name, fmtVal(r[c.name], c)])))));
    return lines.join('\n');
  }

  // ---------- Acciones (herramientas) ----------

  function applyRows(columns, rows, message) {
    A.commit({ columns, rows }, message);
    return `${message} Ahora hay ${D.fmtNum(S.rows.length)} filas.`;
  }

  function test(v, op, target, c) {
    if (op === 'vacio') return v === null || v === undefined || v === '';
    if (op === 'no_vacio') return !(v === null || v === undefined || v === '');
    if (v === null || v === undefined) return false;
    let a = v, b = target;
    if (c.type === 'number') { b = D.parseNumber(String(target)); if (c.percent && b > 1) b /= 100; }
    else if (c.type === 'date') { a = v.getTime(); const d = new Date(target); b = isNaN(d) ? NaN : d.getTime(); }
    else { a = norm(v); b = norm(target); }
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
      case 'contiene': return String(a).includes(String(b));
      default: throw new Error(`Operador no válido: ${op}`);
    }
  }

  const ACTIONS = {
    consultar(input) {
      const rows0 = S.rows;
      let rows = rows0;
      (Array.isArray(input.filtros) ? input.filtros : []).forEach((f) => {
        const c = findCol(f.columna);
        const op = f.operador || '=';
        const vals = Array.isArray(f.valores) ? f.valores : [f.valor ?? f.valores];
        rows = rows.filter((r) => vals.some((v) => test(r[c.name], op, c.type === 'text' ? matchValue(c, v) : v, c)));
      });
      const agg = input.calculo || 'sum';
      const yc = agg === 'count' ? null : findCol(input.valor);
      if (yc && yc.type !== 'number' && agg !== 'distinct') throw new Error(`"${yc.name}" no es numérica.`);
      if (!input.agrupar_por) {
        const v = D.summarize(rows, yc ? yc.name : null, agg);
        return { filas_consideradas: rows.length, resultado: fmtVal(v, yc) };
      }
      const xc = findCol(input.agrupar_por);
      const t = A.timeInfo();
      const data = D.aggregate(rows, xc, yc ? yc.name : null, agg, { grain: input.agrupar_fechas || t.grain || 'month', sort: xc.type === 'text' ? (input.orden === 'asc' ? 'value-asc' : 'value-desc') : 'label', noOther: true });
      const top = Math.min(Number(input.top) || 15, 40);
      return { filas_consideradas: rows.length, grupos: data.length, resultados: data.slice(0, top).map((d) => ({ [xc.name]: d.label, valor: fmtVal(d.value, yc) })) };
    },

    crear_grafica(input) {
      const types = ['bar', 'hbar', 'line', 'area', 'pie', 'scatter'];
      const type = types.includes(input.tipo) ? input.tipo : 'bar';
      const xc = findCol(input.x);
      const t = A.timeInfo();
      let agg = input.calculo || null;
      const yc = input.y ? findCol(input.y) : null;
      if (!agg) agg = yc ? A.defaultAgg(yc, t) : 'count';
      if (agg !== 'count' && !yc) throw new Error('Indica la columna numérica (y) o usa calculo "count".');
      const cfg = {
        id: S.nextId++, type, x: xc.name, y: agg === 'count' ? null : yc.name, agg: type === 'scatter' ? 'none' : agg,
        grain: input.agrupar_fechas || t.grain || D.autoGrain(xc), limit: Number(input.max_categorias) || 10, sort: null,
        title: input.titulo || '', wide: !!input.ancha,
        series: input.desglosar_por ? findCol(input.desglosar_por).name : '',
        ys: Array.isArray(input.comparar_con) ? input.comparar_con.map((n) => findCol(n).name) : [],
      };
      S.charts.unshift(cfg);
      A.renderCharts();
      return `Gráfica creada: "${A.chartTitle(cfg)}". Está al inicio del dashboard.`;
    },

    quitar_grafica(input) {
      const i = Number(input.numero) - 1;
      if (!(i >= 0 && i < S.charts.length)) throw new Error(`No hay gráfica #${input.numero}. Hay ${S.charts.length}.`);
      const [c] = S.charts.splice(i, 1);
      A.renderCharts();
      return `Se quitó la gráfica "${A.chartTitle(c)}".`;
    },

    filtrar(input) {
      if (input.quitar_todos) {
        S.filters = {};
        if (S.dateFilter) S.dateFilter.from = S.dateFilter.to = null;
        A.refresh();
        return 'Se quitaron todos los filtros.';
      }
      const c = findCol(input.columna);
      if (c.type === 'date') {
        const p = (s) => (s ? new Date(`${s}T00:00:00`) : null);
        if (!S.dateFilter || S.dateFilter.col !== c.name) S.dateFilter = { col: c.name, from: null, to: null };
        S.dateFilter.from = p(input.desde);
        S.dateFilter.to = input.hasta ? new Date(`${input.hasta}T23:59:59`) : null;
        A.refresh();
        return `Filtro de fechas aplicado en ${c.name}.`;
      }
      const vals = (Array.isArray(input.valores) ? input.valores : input.valores ? [input.valores] : []).map((v) => matchValue(c, v));
      if (!vals.length) { delete S.filters[c.name]; A.refresh(); return `Se quitó el filtro de ${c.name}.`; }
      if (c.type !== 'text') throw new Error('Solo se puede filtrar por lista en columnas de texto; usa consultar o eliminar_filas para números.');
      S.filters[c.name] = new Set(vals);
      A.refresh();
      return `Filtro aplicado: ${c.name} = ${vals.join(', ')} (${D.fmtNum(A.filteredRows().length)} filas visibles).`;
    },

    limpieza(input) {
      const acc = input.accion;
      if (acc === 'recomendadas') {
        const before = S.tbl.log.length;
        A.applyRecommended();
        const done = S.tbl.log.slice(before);
        return done.length ? done.join(' ') : 'No había correcciones recomendadas pendientes.';
      }
      if (acc === 'deshacer') { if (!S.tbl.history.length) return 'No hay cambios que deshacer.'; A.undo(); return 'Se deshizo el último cambio.'; }
      if (acc === 'restaurar') { A.restoreOriginal(); return 'Se restauraron los datos originales.'; }
      if (acc === 'aplicar') {
        const issue = (S.report ? S.report.visible : []).find((i) => i.id === input.problema_id);
        if (!issue) throw new Error(`No existe el problema "${input.problema_id}". Revisa la lista de problemas del contexto.`);
        const a = issue.actions[Number(input.opcion) || 0];
        if (!a) throw new Error('Opción no válida.');
        A.runAction(issue, a);
        return `${a.message} Ahora hay ${D.fmtNum(S.rows.length)} filas.`;
      }
      throw new Error('accion debe ser recomendadas, aplicar, deshacer o restaurar.');
    },

    editar_datos(input) {
      const op = input.operacion;
      const cols = S.columns;
      const rows = S.rows;
      const c = op === 'eliminar_filas' && input.columna === undefined ? null : findCol(input.columna);
      switch (op) {
        case 'renombrar_columna': {
          const to = String(input.nuevo_nombre || '').trim();
          if (!to) throw new Error('Falta nuevo_nombre.');
          if (cols.some((x) => x !== c && norm(x.name) === norm(to))) throw new Error(`Ya existe una columna "${to}".`);
          const ncols = cols.map((x) => (x === c ? { ...x, name: to } : x));
          const nrows = rows.map((r) => { const o = {}; cols.forEach((x) => { o[x === c ? to : x.name] = r[x.name]; }); return o; });
          S.charts.forEach((ch) => { ['x', 'y', 'series'].forEach((k) => { if (ch[k] === c.name) ch[k] = to; }); if (ch.ys) ch.ys = ch.ys.map((n) => (n === c.name ? to : n)); });
          if (S.filters[c.name]) { S.filters[to] = S.filters[c.name]; delete S.filters[c.name]; }
          if (S.dateFilter && S.dateFilter.col === c.name) S.dateFilter.col = to;
          return applyRows(ncols, nrows, `Columna “${c.name}” renombrada a “${to}”.`);
        }
        case 'eliminar_columna':
          return applyRows(cols.filter((x) => x !== c), rows.map((r) => { const o = { ...r }; delete o[c.name]; return o; }), `Se eliminó la columna “${c.name}”.`);
        case 'reemplazar': {
          const from = norm(input.buscar);
          let to = input.reemplazar_con ?? null;
          if (c.type === 'number' && to !== null) to = D.parseNumber(String(to));
          let k = 0;
          const nrows = rows.map((r) => {
            const v = r[c.name];
            const hit = input.buscar === '' || input.buscar === null ? v === null : v !== null && norm(v instanceof Date ? D.dateKey(v, 'day').key : v) === from;
            if (!hit) return r;
            k++;
            return { ...r, [c.name]: to };
          });
          if (!k) return `No se encontró “${input.buscar}” en ${c.name}.`;
          return applyRows(cols, nrows, `Se reemplazaron ${k} valores en “${c.name}”.`);
        }
        case 'eliminar_filas': {
          const op2 = input.operador || '=';
          let nrows;
          if (c) nrows = rows.filter((r) => !test(r[c.name], op2, c.type === 'text' ? matchValue(c, input.valor) : input.valor, c));
          else throw new Error('Indica la columna de la condición.');
          const k = rows.length - nrows.length;
          if (!k) return 'Ninguna fila cumple esa condición; no se eliminó nada.';
          return applyRows(cols, nrows, `Se eliminaron ${k} filas donde ${c.name} ${op2} ${input.valor ?? ''}.`);
        }
        case 'rellenar_vacios': {
          let v = input.valor;
          if (c.type === 'number') {
            if (v === 'promedio') v = D.summarize(rows, c.name, 'avg');
            else v = D.parseNumber(String(v));
            if (v === null) throw new Error('Valor numérico no válido.');
          }
          let k = 0;
          const nrows = rows.map((r) => (r[c.name] === null || r[c.name] === undefined ? (k++, { ...r, [c.name]: v }) : r));
          return applyRows(cols, nrows, `Se rellenaron ${k} celdas vacías de “${c.name}”.`);
        }
        case 'mayusculas': case 'minusculas': case 'tipo_titulo': {
          if (c.type !== 'text') throw new Error(`“${c.name}” no es de texto.`);
          const f = op === 'mayusculas' ? (s) => s.toLocaleUpperCase('es') : op === 'minusculas' ? (s) => s.toLocaleLowerCase('es')
            : (s) => s.toLocaleLowerCase('es').replace(/(^|[\s(-])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('es'));
          const nrows = rows.map((r) => (typeof r[c.name] === 'string' ? { ...r, [c.name]: f(r[c.name]) } : r));
          return applyRows(cols, nrows, `Texto de “${c.name}” convertido.`);
        }
        default: throw new Error('operacion no válida.');
      }
    },

    hojas(input) {
      const book = S.book;
      const find = (n) => book.order.find((s) => norm(s) === norm(n)) || book.order.find((s) => norm(s).includes(norm(n)));
      if (input.accion === 'abrir') {
        const s = find(input.hoja);
        if (!s) throw new Error(`No existe la hoja "${input.hoja}". Hojas: ${book.order.join(', ')}`);
        A.openSheet(s);
        return `Hoja “${s}” abierta (${S.rows.length} filas).`;
      }
      if (input.accion === 'unir') {
        const a = find(input.hoja_base), b = find(input.hoja_extra);
        if (!a || !b) throw new Error(`Hojas no encontradas. Hojas: ${book.order.join(', ')}`);
        const common = window.BookKit.commonColumns(book.sheets[a], book.sheets[b]);
        const pair = input.columna ? common.find(([x]) => norm(x) === norm(input.columna)) : common[0];
        if (!pair) throw new Error(`“${a}” y “${b}” no comparten esa columna. En común: ${common.map(([x]) => x).join(', ') || 'ninguna'}`);
        A.applySuggestion({ type: 'join', a, b, ka: pair[0], kb: pair[1] });
        return `Se unió “${b}” a “${a}” usando “${pair[0]}”. Hoja nueva abierta: “${S.sheet}”.`;
      }
      if (input.accion === 'apilar') {
        const list = (input.hojas || []).map(find).filter(Boolean);
        if (list.length < 2) throw new Error('Indica al menos dos hojas.');
        A.applySuggestion({ type: 'stack', sheets: list });
        return `Se apilaron ${list.length} hojas en “${S.sheet}”.`;
      }
      throw new Error('accion debe ser abrir, unir o apilar.');
    },
  };

  const TOOLS = [
    {
      name: 'consultar', description: 'Calcula un dato sobre la hoja abierta para responder preguntas (totales, promedios, rankings, máximos). Devuelve una tabla pequeña. No modifica nada.',
      inputSchema: { type: 'object', properties: {
        valor: { type: 'string', description: 'Columna numérica a calcular (omitir si calculo=count).' },
        calculo: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count', 'distinct'] },
        agrupar_por: { type: 'string', description: 'Columna para agrupar (opcional).' },
        agrupar_fechas: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        filtros: { type: 'array', items: { type: 'object', properties: { columna: { type: 'string' }, operador: { type: 'string', enum: ['=', '!=', '>', '<', '>=', '<=', 'contiene'] }, valores: { type: 'array', items: { type: 'string' } } }, required: ['columna', 'valores'] } },
        orden: { type: 'string', enum: ['desc', 'asc'] }, top: { type: 'number' },
      }, required: ['calculo'] },
    },
    {
      name: 'crear_grafica', description: 'Agrega una gráfica al dashboard. Tasas y series de tiempo se promedian (avg); cantidades que se acumulan se suman (sum).',
      inputSchema: { type: 'object', properties: {
        tipo: { type: 'string', enum: ['bar', 'hbar', 'line', 'area', 'pie', 'scatter'] },
        x: { type: 'string', description: 'Columna del eje X / para agrupar.' },
        y: { type: 'string', description: 'Columna numérica.' },
        calculo: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count', 'distinct'] },
        desglosar_por: { type: 'string', description: 'Columna de texto: una serie por cada valor (p. ej. Sexo).' },
        comparar_con: { type: 'array', items: { type: 'string' }, description: 'Otras columnas numéricas a mostrar en la misma gráfica.' },
        agrupar_fechas: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        max_categorias: { type: 'number' }, titulo: { type: 'string' }, ancha: { type: 'boolean' },
      }, required: ['tipo', 'x'] },
    },
    { name: 'quitar_grafica', description: 'Quita la gráfica número N (según la lista del contexto).', inputSchema: { type: 'object', properties: { numero: { type: 'number' } }, required: ['numero'] } },
    {
      name: 'filtrar', description: 'Filtra todo el dashboard. Texto: lista de valores (vacía = quitar ese filtro). Fecha: desde/hasta AAAA-MM-DD. quitar_todos=true quita todos los filtros.',
      inputSchema: { type: 'object', properties: { columna: { type: 'string' }, valores: { type: 'array', items: { type: 'string' } }, desde: { type: 'string' }, hasta: { type: 'string' }, quitar_todos: { type: 'boolean' } } },
    },
    {
      name: 'limpieza', description: 'Limpieza con el analizador: "recomendadas" aplica duplicados/totales/variantes; "aplicar" ejecuta la opción de un problema del contexto por su id; "deshacer" revierte el último cambio; "restaurar" vuelve a los datos originales.',
      inputSchema: { type: 'object', properties: { accion: { type: 'string', enum: ['recomendadas', 'aplicar', 'deshacer', 'restaurar'] }, problema_id: { type: 'string' }, opcion: { type: 'number' } }, required: ['accion'] },
    },
    {
      name: 'editar_datos', description: 'Modifica la hoja abierta (se puede deshacer): renombrar_columna, eliminar_columna, reemplazar (buscar -> reemplazar_con), eliminar_filas (columna operador valor; operadores = != > < >= <= contiene vacio no_vacio), rellenar_vacios (valor, o "promedio"), mayusculas, minusculas, tipo_titulo.',
      inputSchema: { type: 'object', properties: {
        operacion: { type: 'string', enum: ['renombrar_columna', 'eliminar_columna', 'reemplazar', 'eliminar_filas', 'rellenar_vacios', 'mayusculas', 'minusculas', 'tipo_titulo'] },
        columna: { type: 'string' }, nuevo_nombre: { type: 'string' }, buscar: { type: 'string' }, reemplazar_con: { type: 'string' },
        operador: { type: 'string', enum: ['=', '!=', '>', '<', '>=', '<=', 'contiene', 'vacio', 'no_vacio'] }, valor: { type: 'string' },
      }, required: ['operacion', 'columna'] },
    },
    {
      name: 'hojas', description: 'Trabaja con las hojas del archivo: abrir una hoja, unir (agrega a hoja_base las columnas de hoja_extra usando una columna en común) o apilar varias hojas.',
      inputSchema: { type: 'object', properties: { accion: { type: 'string', enum: ['abrir', 'unir', 'apilar'] }, hoja: { type: 'string' }, hoja_base: { type: 'string' }, hoja_extra: { type: 'string' }, columna: { type: 'string' }, hojas: { type: 'array', items: { type: 'string' } } }, required: ['accion'] },
    },
  ];

  const INSTRUCTIONS = `Eres el asistente de un dashboard de datos que corre en el navegador. Respondes en español de México, breve y claro.
Usa las herramientas para actuar sobre los datos: no inventes columnas ni valores; usa los nombres exactos del contexto.
- Para preguntas sobre los datos usa "consultar" y responde con las cifras (formato con separador de miles, porcentajes con %).
- Para cambiar datos, limpiar, filtrar, graficar o combinar hojas, hazlo con las herramientas y confirma en 1-2 frases qué cambió.
- Las tasas/porcentajes y las cifras mensuales de una serie de tiempo se promedian, no se suman.
- Si la petición es ambigua o destructiva y no está claro qué quiere, pregunta antes de actuar.
- Todos los cambios a los datos se pueden deshacer; menciónalo cuando borres algo.
- Si algo no se puede hacer con las herramientas, dilo y sugiere cómo hacerlo en la interfaz.`;

  // ---------- Modo sin IA: intérprete de peticiones en español ----------
  // Detecta la intención por palabras clave y las columnas/valores que se mencionan.

  const clean = (s) => norm(s).replace(/[¿?¡!.,;:"“”'()]/g, ' ').replace(/\s+/g, ' ').trim();
  const has = (t, re) => re.test(t);

  // Columnas mencionadas en el texto, con su posición y qué tan seguro es el acierto.
  function mentionedCols(t) {
    const out = [];
    S.columns.forEach((c) => {
      const n = clean(c.name);
      let pos = t.indexOf(n), score = 3;
      if (pos < 0) {
        const toks = n.split(' ').filter((w) => w.length >= 3);
        const hits = toks.filter((w) => new RegExp(`\\b${w}`).test(t));
        if (toks.length && hits.length === toks.length) { score = 2; pos = t.search(new RegExp(`\\b${toks[0]}`)); }
        else if (hits.length && hits[0].length >= 4) { score = 1; pos = t.search(new RegExp(`\\b${hits[0]}`)); }
      }
      if (pos >= 0) out.push({ c, pos, score, len: n.length });
    });
    // Si varias columnas compiten por el mismo texto, gana la de mejor acierto.
    out.sort((a, b) => b.score - a.score || b.len - a.len);
    const taken = [];
    const res = [];
    out.forEach((m) => {
      if (m.score < 3 && taken.some(([p, l]) => m.pos >= p && m.pos < p + l)) return;
      if (m.score === 1 && res.some((r) => r.score >= 2)) {
        const w = clean(m.c.name).split(' ')[0];
        if (res.some((r) => clean(r.c.name).includes(w))) return;
      }
      taken.push([m.pos, m.len]);
      res.push(m);
    });
    return res.sort((a, b) => a.pos - b.pos);
  }
  // Valores de categorías mencionados ("norte", "mujeres", "enoe").
  function mentionedValues(t, cols) {
    const out = [];
    S.columns.filter((c) => c.type === 'text' && c.values && c.unique <= 300).forEach((c) => {
      c.values.forEach((v) => {
        const n = clean(v);
        if (n.length < 2 || /^\d+$/.test(n) && n.length < 3) return;
        const re = new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
        if (re.test(t) && !cols.some((m) => clean(m.c.name) === n)) out.push({ c, v, pos: t.search(re) });
      });
    });
    return out;
  }
  const fmtC = (c, v) => (v === null || v === undefined || Number.isNaN(v) ? 'sin dato' : c && c.percent ? D.fmtPct(v) : D.fmtNum(v));
  function aggFrom(t, metric) {
    if (has(t, /promedio|media|average/)) return 'avg';
    if (has(t, /\b(suma|sumar|total|acumulad)/)) return 'sum';
    if (has(t, /\bmaxim|\bmax\b/)) return 'max';
    if (has(t, /\bminim|\bmin\b/)) return 'min';
    if (has(t, /cuant[oa]s? (registros|filas|veces)|conteo|numero de (registros|filas)|cantidad de (registros|filas)/)) return 'count';
    return metric ? A.defaultAgg(metric, A.timeInfo()) : 'count';
  }
  const AGG_TXT = { sum: 'total', avg: 'promedio', max: 'máximo', min: 'mínimo', count: 'número de registros', distinct: 'valores distintos' };

  function splitRequests(text) {
    // "elimina duplicados y luego haz una gráfica…" -> dos peticiones
    const verbs = 'haz|has|crea|genera|grafica|filtra|elimina|borra|quita|muestra|muestrame|dime|renombra|cambia|limpia|abre|une|junta|agrega|pon|reemplaza|rellena|deshaz|deshacer|ordena|compara';
    return text.split(new RegExp(`(?:,|;|\\by\\b|\\bluego\\b|\\bdespues\\b|\\btambien\\b)\\s+(?=(?:luego |despues |tambien )?(?:${verbs})\\b)`, 'i')).map((s) => s.trim()).filter(Boolean);
  }

  function help() {
    const m = A.metrics()[0], cat = A.categories()[0], t = A.timeInfo();
    const ex = ['“limpia los datos”', '“elimina duplicados”', '“deshacer”'];
    if (m && cat) ex.unshift(`“¿qué ${cat.name} tiene el mayor ${m.name}?”`, `“gráfica de ${m.name} por ${cat.name}”`, `“filtra ${cat.name} = ${cat.values[0]}”`);
    if (m && t.date) ex.unshift(`“gráfica de línea de ${m.name} por ${t.date.name}”`, `“¿cuál fue el último ${m.name}?”`);
    if (m) ex.push(`“¿cuál es el promedio de ${m.name}?”`, `“top 5 por ${m.name}”`);
    return `Puedo ayudarte con preguntas, gráficas, filtros y limpieza. Prueba, por ejemplo: ${ex.slice(0, 8).join(', ')}.`;
  }

  function describeSheets() {
    const book = S.book;
    const info = S.bookInfo || {};
    const KIND = { data: 'datos', notes: 'notas/instrucciones', calendar: 'calendario de apoyo', empty: 'vacía' };
    const lines = book.order.map((s) => `• ${s}: ${KIND[(info.kinds && info.kinds[s] && info.kinds[s].kind) || 'data']}, ${D.fmtNum(book.sheets[s].rows.length)} filas${info.kinds && info.kinds[s] && info.kinds[s].kind === 'data' ? ' · ' + window.BookKit.describeSheet(book.sheets[s]) : ''}`);
    const sug = (info.suggestions || []).slice(0, 3).map((x) => `• ${x.text}`);
    return `El archivo tiene ${book.order.length} hoja(s):\n${lines.join('\n')}${sug.length ? `\n\nTe sugiero:\n${sug.join('\n')}\n(Dime por ejemplo “une ${info.suggestions[0].a || ''} con ${info.suggestions[0].b || ''}”.)` : ''}`;
  }

  function interpretOne(text) {
    const t = clean(text);
    if (!t) return null;
    const cols = mentionedCols(t);
    const vals = mentionedValues(t, cols);
    const num = cols.filter((m) => m.c.type === 'number').map((m) => m.c);
    const nonNum = cols.filter((m) => m.c.type !== 'number').map((m) => m.c);
    const afterPor = t.includes(' por ') ? t.slice(t.indexOf(' por ') + 5) : '';
    const byCol = afterPor ? (mentionedCols(afterPor)[0] || {}).c : null;

    // --- Ayuda, deshacer, restaurar
    if (has(t, /^(ayuda|help)$|que (puedes|sabes) hacer|como te uso|que comandos/)) return help();
    if (has(t, /deshac|deshaz|revierte|regresa(lo)? como estaba|ctrl z/)) return ACTIONS.limpieza({ accion: 'deshacer' });
    if (has(t, /restaur|datos originales|como estaba(n)? al principio/)) return ACTIONS.limpieza({ accion: 'restaurar' });

    // --- Hojas
    if (has(t, /\bhojas?\b/) && has(t, /que (contiene|tiene|hay)|cuales|describe|explica|resumen|conviene|sirve/)) return S.book.order.length > 1 ? describeSheets() : `El archivo solo tiene una hoja: “${S.sheet}”.`;
    if (has(t, /\b(une|unir|junta|juntar|combina|combinar|cruza|buscarv)\b/)) {
      const names = S.book.order.filter((s) => t.includes(clean(s))).sort((a, b) => t.indexOf(clean(a)) - t.indexOf(clean(b)));
      if (names.length >= 2) return ACTIONS.hojas({ accion: 'unir', hoja_base: names[0], hoja_extra: names[1] });
      const sg = (S.bookInfo && S.bookInfo.suggestions || []).find((x) => x.type === 'join' && (!names.length || names.includes(x.a) || names.includes(x.b)));
      if (sg) return ACTIONS.hojas({ accion: 'unir', hoja_base: sg.a, hoja_extra: sg.b, columna: sg.ka });
      return 'Dime qué hojas unir, por ejemplo: “une fact_mensual con dim_fecha”.';
    }
    if (has(t, /\b(apila|apilar)\b/)) return ACTIONS.hojas({ accion: 'apilar', hojas: S.book.order.filter((s) => t.includes(clean(s))) });
    const sheetHit = S.book.order.find((s) => t.includes(clean(s)));
    if (sheetHit && has(t, /\b(abre|abrir|ver|ve a|cambia a|muestra|ir a|usa)\b/)) return ACTIONS.hojas({ accion: 'abrir', hoja: sheetHit });

    // --- Filtros
    if (has(t, /(quita|borra|limpia|elimina|remueve|sin)\w* (todos )?(los )?filtros|ver todo|mostrar todo|muestra todo/)) return ACTIONS.filtrar({ quitar_todos: true });
    if (has(t, /(quita|borra|elimina)\w* (el )?filtro/) && nonNum[0]) return ACTIONS.filtrar({ columna: nonNum[0].name, valores: [] });

    // --- Limpieza
    if (has(t, /duplicad|repetid/)) {
      const i = S.report && S.report.visible.find((x) => x.id === 'dups');
      return i ? ACTIONS.limpieza({ accion: 'aplicar', problema_id: 'dups', opcion: 0 }) : 'No encontré filas duplicadas.';
    }
    if (has(t, /(rellena|llena|completa)\w* (los )?(vacios|vacias|huecos|celdas vacias|nulos)/) || has(t, /(vacios|vacias) con/)) {
      const c = num[0] || nonNum[0];
      if (!c) return 'Dime en qué columna rellenar los vacíos, por ejemplo: “rellena los vacíos de Vendedor con Sin dato”.';
      const m = text.match(/con\s+(.+)$/i);
      const v = has(t, /promedio/) ? 'promedio' : m ? m[1].trim() : c.type === 'number' ? '0' : 'Sin dato';
      return ACTIONS.editar_datos({ operacion: 'rellenar_vacios', columna: c.name, valor: v });
    }
    if (has(t, /\b(limpia|limpiar|limpieza|corrige|corregir|arregla|arreglar|depura|depurar)\b/)) {
      const r = ACTIONS.limpieza({ accion: 'recomendadas' });
      const left = S.report ? S.report.visible.length : 0;
      return `${r}${left ? `\nQuedan ${left} sugerencia(s) por revisar en “Limpieza de datos” (por ejemplo: ${S.report.visible[0].title}).` : ''}`;
    }

    // --- Edición de columnas y filas
    let m;
    if ((m = text.match(/(?:renombra(?:r)?|cambia(?:r)? el nombre de)\s+(?:la\s+)?(?:columna\s+)?(.+?)\s+(?:a|como|por)\s+(.+)$/i))) {
      return ACTIONS.editar_datos({ operacion: 'renombrar_columna', columna: m[1].trim(), nuevo_nombre: m[2].trim().replace(/^["“]|["”]$/g, '') });
    }
    if (has(t, /(elimina|borra|quita|remueve)\w* (la |las )?columnas?\b/) && cols[0]) {
      return cols.map((x) => ACTIONS.editar_datos({ operacion: 'eliminar_columna', columna: x.c.name })).join('\n');
    }
    if (has(t, /(elimina|borra|quita|remueve)\w* (las )?(filas|registros|renglones)/)) {
      const c = cols[0] && cols[0].c;
      if (!c) return 'Dime la condición, por ejemplo: “elimina las filas donde Unidades sea menor a 2”.';
      let op = '=', val = '';
      if (has(t, /vaci|sin dato|en blanco/)) op = 'vacio';
      else {
        if (has(t, /mayor o igual|al menos/)) op = '>=';
        else if (has(t, /menor o igual|a lo mas/)) op = '<=';
        else if (has(t, /mayor|mas de|arriba de|superior/)) op = '>';
        else if (has(t, /menor|menos de|debajo de|inferior/)) op = '<';
        else if (has(t, /distint|diferente|no sea/)) op = '!=';
        else if (has(t, /contenga|contiene/)) op = 'contiene';
        const v = vals.find((x) => x.c === c);
        const nm = t.match(/(-?\d+(?:[.,]\d+)?)\s*%?/);
        val = v ? v.v : nm ? nm[1].replace(',', '.') : (text.match(/(?:sea|es|igual a|contenga|contiene|=)\s+(.+)$/i) || [])[1] || '';
      }
      return ACTIONS.editar_datos({ operacion: 'eliminar_filas', columna: c.name, operador: op, valor: String(val).trim() });
    }
    if ((m = text.match(/(?:reemplaza(?:r)?|sustituye|cambia(?:r)?)\s+["“]?(.+?)["”]?\s+(?:por|con|a)\s+["“]?(.+?)["”]?(?:\s+en\s+(?:la\s+columna\s+)?(.+))?$/i)) && !has(t, /grafica|nombre/)) {
      const c = m[3] ? findCol(m[3]) : (vals.find((x) => clean(x.v) === clean(m[1])) || {}).c || nonNum[0];
      if (!c) return 'Dime en qué columna reemplazar, por ejemplo: “reemplaza norte por Norte en Región”.';
      return ACTIONS.editar_datos({ operacion: 'reemplazar', columna: c.name, buscar: m[1], reemplazar_con: m[2] });
    }
    if (has(t, /mayuscula|minuscula|tipo titulo|primera letra/) && nonNum[0]) {
      const op = has(t, /tipo titulo|primera letra|nombre propio/) ? 'tipo_titulo' : has(t, /minuscula/) ? 'minusculas' : 'mayusculas';
      return ACTIONS.editar_datos({ operacion: op, columna: nonNum[0].name });
    }

    // --- Gráficas
    if ((m = t.match(/(quita|elimina|borra)\w* (la )?grafica (numero )?(\d+)/))) return ACTIONS.quitar_grafica({ numero: Number(m[4]) });
    if (has(t, /grafic|chart|visualiza|dibuja|diagrama|plot|evolucion|tendencia|como ha (cambiado|evolucionado)/)) {
      const tm = A.timeInfo();
      let tipo = has(t, /linea|tendencia|evolucion|en el tiempo|como ha/) ? 'line' : has(t, /area/) ? 'area' : has(t, /pastel|dona|pie|circular|pay/) ? 'pie'
        : has(t, /horizontal/) ? 'hbar' : has(t, /dispersion|scatter|relacion entre/) ? 'scatter' : null;
      let x = byCol || nonNum.find((c) => c.type === 'date') || nonNum[0] || null;
      const metrics = num.filter((c) => c !== x);
      if (tipo === 'scatter') {
        if (num.length < 2) return 'Para una gráfica de dispersión dime dos columnas numéricas, por ejemplo: “dispersión de Precio contra Unidades”.';
        return ACTIONS.crear_grafica({ tipo, x: num[0].name, y: num[1].name });
      }
      if (!x) x = (tipo === 'line' || tipo === 'area' || !A.categories()[0]) && tm.date ? tm.date : A.categories()[0] || tm.date;
      if (!x) return 'Dime por qué columna agrupar, por ejemplo: “gráfica de Ventas por Región”.';
      if (!tipo) tipo = x.type === 'date' ? 'line' : 'bar';
      const series = nonNum.find((c) => c !== x && c.type === 'text' && c.unique <= 30 && (has(t, /desglos|separad|por cada|segun/) || afterPor.includes(clean(c.name))));
      const y = metrics[0] || null;
      const calc = y ? aggFrom(t, y) : 'count';
      return ACTIONS.crear_grafica({ tipo, x: x.name, y: y ? y.name : undefined, calculo: calc, desglosar_por: series ? series.name : undefined, comparar_con: metrics.slice(1, 4).map((c) => c.name) });
    }

    // --- Filtros por valor ("solo Norte", "filtra Región = Norte", "muestra mujeres")
    if (vals.length && has(t, /\b(filtra|filtrar|solo|solamente|unicamente|nada mas|muestra|muestrame|ver|deja|enfoca)\b|=/)) {
      const groups = new Map();
      vals.forEach((v) => { if (!groups.has(v.c.name)) groups.set(v.c.name, []); groups.get(v.c.name).push(v.v); });
      return [...groups.entries()].map(([c, vs]) => ACTIONS.filtrar({ columna: c, valores: vs })).join('\n');
    }
    if ((m = text.match(/(?:filtra|solo|solamente)(?:\s+por)?\s+(.+?)\s*(?:=|es|igual a|:)\s*(.+)$/i))) {
      return ACTIONS.filtrar({ columna: m[1], valores: m[2].split(/,|\s+y\s+/).map((s) => s.trim()) });
    }
    if (has(t, /\b(desde|entre|del?) (\d{4})\b/) || has(t, /\ben (el )?(ano )?\d{4}\b/)) {
      const tm = A.timeInfo();
      const years = (t.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
      if (tm.date && years.length && has(t, /filtra|solo|muestra|desde|entre|ver/)) {
        const from = `${Math.min(...years)}-01-01`;
        const to = has(t, /desde/) && years.length === 1 ? undefined : `${Math.max(...years)}-12-31`;
        return ACTIONS.filtrar({ columna: tm.date.name, desde: from, hasta: to });
      }
    }

    // --- Preguntas sobre los datos
    const metric = num[0] || null;
    // Sinónimos comunes para la columna de agrupación ("estado" -> Entidad, "año" -> Anio…).
    const SYN = { estado: /entidad|estado/, estados: /entidad|estado/, entidad: /entidad|estado/, entidades: /entidad|estado/, pais: /pais|country/, ano: /^(ano|anio|year)/, anos: /^(ano|anio|year)/, mes: /^mes/, meses: /^mes/, genero: /sexo|genero/, sexo: /sexo|genero/, vendedor: /vendedor|asesor|agente/, cliente: /cliente/, producto: /producto|articulo/, region: /region|zona/, sucursal: /sucursal|tienda/ };
    let synCol = null;
    Object.entries(SYN).some(([w, re]) => {
      if (!new RegExp(`\\b${w}\\b`).test(t)) return false;
      synCol = S.columns.find((c) => c.type !== 'number' && re.test(clean(c.name)) && !/corta|iso|ubicacion|clave/.test(clean(c.name))) || null;
      return !!synCol;
    });
    const labelCol = S.columns.find((c) => c.type === 'text' && c.unique >= 3 && c.unique >= (c.filled || 0) * 0.9 && !(c.values || []).every((v) => /^[\d\W_]+$/.test(v)) && !/corta|iso|ubicacion|clave|url/.test(clean(c.name)));
    const group = byCol && byCol.type !== 'number' ? byCol : nonNum.find((c) => c.type === 'text') || synCol || (byCol && byCol !== metric ? byCol : null);
    const minWords = has(t, /\bmenor|\bmas baj|\bminim|\bpeor|\bmenos\b|ultimo lugar/);
    const maxStrong = has(t, /\bmayor|\bmas alt|\bmaxim|\bmejor|primer lugar|lider|lidera/);
    const wantsMin = minWords && !maxStrong;
    const wantsMax = maxStrong || (!wantsMin && has(t, /\bmas\b|\btop\b/));
    const topN = (t.match(/\btop (\d+)|\blos (\d+) (primeros|mejores|mayores|principales)/) || []).slice(1).find(Boolean);
    if (has(t, /cuant[oa]s (registros|filas|renglones|datos)|total de (registros|filas)/)) {
      return `Hay ${D.fmtNum(A.filteredRows().length)} registros${A.filteredRows().length !== S.rows.length ? ` con los filtros actuales (de ${D.fmtNum(S.rows.length)} en total)` : ''}.`;
    }
    if ((m = t.match(/cuant[oa]s (.+?) (hay|distint|diferent|existen)/))) {
      const c = mentionedCols(m[1])[0];
      if (c) return `Hay ${D.fmtNum(D.summarize(S.rows, c.c.name, 'distinct'))} valores distintos de ${c.c.name}${c.c.values && c.c.unique <= 12 ? `: ${c.c.values.join(', ')}` : ''}.`;
    }
    if (has(t, /\bultim[oa]|mas recient|actual/) && metric) {
      const tm = A.timeInfo();
      if (tm.date) {
        const rows = A.filteredRows().filter((r) => r[tm.date.name] && typeof r[metric.name] === 'number').sort((a, b) => a[tm.date.name] - b[tm.date.name]);
        const last = rows[rows.length - 1];
        if (last) {
          const sameDate = rows.filter((r) => r[tm.date.name].getTime() === last[tm.date.name].getTime());
          const v = sameDate.length > 1 ? D.summarize(sameDate, metric.name, 'avg') : last[metric.name];
          return `El último ${metric.name} (${D.dateKey(last[tm.date.name], tm.grain === 'quarter' ? 'quarter' : 'month').label}) es ${fmtC(metric, v)}${sameDate.length > 1 ? ' (promedio de ese periodo)' : ''}.`;
        }
      }
    }
    // "la tasa máxima", "el valor mínimo de X" sin decir por qué agrupar: máximo/mínimo general y cuándo ocurrió.
    const askWho = has(t, /\b(que|cual|quien)(es)? (?!fue\b|es\b|era\b|ha\b)\w+ (tiene|tuvo|registra|presenta|vende|vendio|tienen)/);
    if (metric && !group && !topN && (wantsMax || wantsMin) && !askWho && (has(t, /\bmaxim|\bminim/) || A.timeInfo().onePer || !labelCol)) {
      const calc = wantsMin ? 'min' : 'max';
      const rows = A.filteredRows().filter((r) => typeof r[metric.name] === 'number');
      if (!rows.length) return `No hay datos de ${metric.name}.`;
      const best = rows.reduce((a, r) => ((calc === 'max' ? r[metric.name] > a[metric.name] : r[metric.name] < a[metric.name]) ? r : a));
      const tm = A.timeInfo();
      const when = tm.date && best[tm.date.name] ? ` (${D.dateKey(best[tm.date.name], tm.grain === 'quarter' ? 'quarter' : tm.grain === 'month' ? 'month' : 'day').label})` : labelCol && best[labelCol.name] ? ` (${best[labelCol.name]})` : '';
      return `El ${AGG_TXT[calc]} de ${metric.name} es ${fmtC(metric, best[metric.name])}${when}.`;
    }
    if ((wantsMax || wantsMin || topN) && (metric || group)) {
      const g = group || labelCol || A.categories()[0] || (A.timeInfo().date);
      const y = metric || A.metrics()[0];
      if (!g) return 'Dime por qué columna comparar, por ejemplo: “¿qué Región tiene el mayor Ventas?”.';
      const calc = y ? aggFrom(t, y) : 'count';
      const res = ACTIONS.consultar({ calculo: calc, valor: y ? y.name : undefined, agrupar_por: g.name, orden: wantsMin && !wantsMax ? 'asc' : 'desc', top: Number(topN) || 5 });
      if (!res.resultados || !res.resultados.length) return 'No hay datos para responder eso con los filtros actuales.';
      let list = res.resultados;
      if (g.type !== 'text') list = [...list].sort((a, b) => (wantsMin && !wantsMax ? 1 : -1) * ((parseFloat(String(a.valor)) || 0) - (parseFloat(String(b.valor)) || 0)));
      const first = list[0];
      const label = y ? `${AGG_TXT[calc]} de ${y.name}` : 'número de registros';
      const fmtV = (v) => (typeof v === 'number' ? fmtC(y, v) : v);
      const rest = list.slice(1, Number(topN) || 5).map((r) => `${r[g.name]} (${fmtV(r.valor)})`).join(', ');
      return `${topN ? `Top ${list.length}` : `${wantsMin && !wantsMax ? 'Menor' : 'Mayor'}`} ${label} por ${g.name}: ${first[g.name]} con ${fmtV(first.valor)}.${rest ? `\nLe siguen: ${rest}.` : ''}`;
    }
    if (metric && (has(t, /cual|cuanto|cuanta|dime|total|promedio|media|suma|maxim|minim|valor|resumen/) || cols.length === 1)) {
      const rows = A.filteredRows();
      const calc = has(t, /promedio|media|suma|total|maxim|minim/) ? aggFrom(t, metric) : null;
      if (calc && !group) return `El ${AGG_TXT[calc]} de ${metric.name} es ${fmtC(metric, D.summarize(rows, metric.name, calc))} (${D.fmtNum(rows.length)} registros).`;
      if (group) {
        const res = ACTIONS.consultar({ calculo: calc || A.defaultAgg(metric, A.timeInfo()), valor: metric.name, agrupar_por: group.name, top: 10 });
        return `${AGG_TXT[calc || A.defaultAgg(metric, A.timeInfo())]} de ${metric.name} por ${group.name}:\n${res.resultados.map((r) => `• ${r[group.name]}: ${typeof r.valor === 'number' ? fmtC(metric, r.valor) : r.valor}`).join('\n')}`;
      }
      return `${metric.name}: total ${fmtC(metric, D.summarize(rows, metric.name, 'sum'))}, promedio ${fmtC(metric, D.summarize(rows, metric.name, 'avg'))}, mínimo ${fmtC(metric, D.summarize(rows, metric.name, 'min'))}, máximo ${fmtC(metric, D.summarize(rows, metric.name, 'max'))} (${D.fmtNum(rows.length)} registros).`;
    }
    if (has(t, /resumen|describe|de que (trata|son)|que (hay|contiene|tiene) (el|este)? ?(archivo|dato|tabla)/)) {
      return `La hoja “${S.sheet}” tiene ${D.fmtNum(S.rows.length)} registros y ${S.columns.length} columnas: ${S.columns.map((c) => c.name).join(', ')}.${S.book.order.length > 1 ? ` El archivo tiene ${S.book.order.length} hojas (pregúntame “¿qué contiene cada hoja?”).` : ''}`;
    }
    if (vals.length) return ACTIONS.filtrar({ columna: vals[0].c.name, valores: vals.filter((v) => v.c === vals[0].c).map((v) => v.v) });
    return null;
  }

  function basic(text) {
    const parts = splitRequests(text);
    const answers = [];
    for (const p of parts) {
      try {
        const r = interpretOne(p);
        answers.push(r === null || r === undefined ? null : typeof r === 'string' ? r : JSON.stringify(r));
      } catch (e) { answers.push(`No se pudo “${p}”: ${e.message}`); }
    }
    if (answers.every((a) => a === null)) return `No entendí esa petición. ${help()}`;
    return answers.map((a, i) => a || `No entendí “${parts[i]}”.`).join('\n\n');
  }

  // ---------- Interfaz ----------

  const panel = $('#agentPanel');
  const log = $('#agentLog');
  const input = $('#agentInput');
  const sendBtn = $('#agentSend');
  const stopBtn = $('#agentStop');
  const micBtn = $('#agentMic');
  let sample = null, toolsOk = false, busy = null, tier = 'quick';
  // mode: checking (conectando) · tools (IA con herramientas) · plan (IA que devuelve un plan) · basic (sin IA)
  const inClaude = !!(window.claude && typeof window.claude.use === 'function');
  let mode = inClaude ? 'checking' : 'basic';
  let basicReason = inClaude ? '' : 'Abriste la página fuera de Claude (GitHub Pages o archivo descargado), donde no hay IA disponible.';
  const MODE_LABEL = { checking: 'Conectando con Claude…', tools: 'Con IA (Claude)', plan: 'Con IA (Claude)', basic: 'Sin IA · modo básico', apikey: 'Con IA (tu clave)' };
  // Modelos disponibles con clave propia (precio aproximado por petición del asistente).
  const MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'el más capaz · ~$0.06 USD por petición', fallback: true },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'muy bueno · ~$0.03 USD por petición', fallback: true },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'rápido y económico · ~$0.002 USD por petición', fallback: false },
  ];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
  };
  // La clave vive solo en este navegador (o solo en esta sesión si no se marca "recordar").
  const keyCfg = { key: store.get('dash-api-key') || '', model: store.get('dash-api-model') || MODELS[0].id };
  let welcome = null;
  function welcomeText() {
    if (mode === 'checking') return 'Conectando con Claude… Puedes escribir tu petición mientras tanto.';
    if (mode === 'basic') return `Hola. Funciono sin IA (${basicReason.replace(/\.$/, '')}), pero entiendo las peticiones más comunes escritas con tus palabras. ${help()}\n\nPara usar IA aquí, toca ⚙ y pega tu clave de la API de Claude.`;
    return 'Hola. Dime qué quieres hacer con tus datos: limpiarlos, preguntarme algo, filtrar, crear gráficas o combinar hojas. Puedes escribir o dictar.';
  }
  function setMode(m, reason) {
    mode = m;
    if (reason) basicReason = reason;
    const mdl = MODELS.find((x) => x.id === keyCfg.model);
    $('#agentMode').textContent = m === 'apikey' ? `Con IA · ${mdl ? mdl.name.replace('Claude ', '') : keyCfg.model}` : MODE_LABEL[m];
    $('#agentMode').classList.toggle('rec', m === 'tools' || m === 'plan' || m === 'apikey');
    if (welcome && log.firstChild === welcome && log.childElementCount === 1) welcome.textContent = welcomeText();
  }
  const turns = [];

  function bubble(role, text) {
    const b = document.createElement('div');
    b.className = `msg ${role}`;
    b.textContent = text;
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  function stepNote(text) {
    const b = document.createElement('div');
    b.className = 'msg step';
    b.textContent = text;
    log.append(b);
    log.scrollTop = log.scrollHeight;
  }

  function suggestions() {
    const box = $('#agentChips');
    box.replaceChildren();
    if (!S.columns.length) return;
    const m = A.metrics()[0];
    const cat = A.categories()[0];
    const t = A.timeInfo();
    const list = [];
    if (S.report && S.report.visible.length) list.push('Limpia los datos y dime qué corregiste');
    if (m && cat) list.push(`¿Qué ${cat.name} tiene el mayor ${m.name}?`);
    if (m && t.date) list.push(`Haz una gráfica de línea de ${m.name} por ${t.date.name}`);
    if (cat) list.push(`Filtra solo ${cat.name} = ${cat.values[0]}`);
    if (S.book && S.book.order.length > 1) list.push('¿Qué contiene cada hoja y cuáles conviene unir?');
    list.push('Deshacer el último cambio');
    list.slice(0, 5).forEach((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.textContent = q;
      b.addEventListener('click', () => { input.value = q; send(); });
      box.append(b);
    });
  }

  function open() {
    panel.hidden = false;
    document.body.classList.add('agent-open');
    suggestions();
    if (!log.childElementCount) welcome = bubble('assistant', welcomeText());
    setTimeout(() => input.focus(), 50);
  }
  function close() { panel.hidden = true; document.body.classList.remove('agent-open'); }
  $('#btnAgent').addEventListener('click', () => (panel.hidden ? open() : close()));
  $('#btnAgentTop').addEventListener('click', () => (panel.hidden ? open() : close()));
  $('#agentClose').addEventListener('click', close);

  function setBusy(ctl) {
    busy = ctl;
    sendBtn.hidden = !!ctl;
    stopBtn.hidden = !ctl;
    input.disabled = !!ctl;
  }
  stopBtn.addEventListener('click', () => busy && busy.abort());

  async function send() {
    const text = input.value.trim();
    if (!text || busy || !S.columns.length) return;
    input.value = '';
    bubble('user', text);

    if (mode === 'checking') await ready;
    if (mode === 'basic') {
      try {
        bubble('assistant', basic(text));
      } catch (e) { bubble('assistant', `No se pudo: ${e.message}`); }
      suggestions();
      return;
    }

    turns.push({ role: 'user', content: text });
    const history = turns.slice(-7);
    const ctl = new AbortController();
    setBusy(ctl);
    const out = bubble('assistant', 'Pensando…');
    out.classList.add('pending');
    const onText = ({ text: t }) => { out.classList.remove('pending'); out.textContent = t; log.scrollTop = log.scrollHeight; };
    const LABEL = { consultar: 'Consultando datos', crear_grafica: 'Creando gráfica', quitar_grafica: 'Quitando gráfica', filtrar: 'Aplicando filtro', limpieza: 'Limpiando datos', editar_datos: 'Editando datos', hojas: 'Trabajando con hojas' };
    const run = (name, args) => {
      if (!ACTIONS[name]) throw new Error(`Herramienta desconocida: ${name}`);
      stepNote(`⚙ ${LABEL[name]}…`);
      log.append(out);
      const res = ACTIONS[name](args || {});
      suggestions();
      return res;
    };
    const withState = (extra) => `${INSTRUCTIONS}\n\n=== ESTADO ACTUAL DEL DASHBOARD ===\n${context()}\n=== FIN DEL ESTADO ===\n\n${extra}`;
    try {
      let answer;
      if (mode === 'apikey') {
        answer = await runWithKey(history, ctl, out, run);
      } else if (mode === 'tools') {
        const msgs = history.map((t, i) => (i === history.length - 1 ? { role: 'user', content: withState(`Petición del usuario: ${t.content}`) } : t));
        const tools = TOOLS.map((tool) => ({ ...tool, execute: (args, cx) => { if (cx && cx.signal && cx.signal.aborted) throw new Error('Cancelado'); return run(tool.name, args); } }));
        ({ text: answer } = await sample(msgs, { tools, modelTier: tier, signal: ctl.signal, onText }));
      } else {
        // Plan: Claude devuelve las acciones en JSON y la página las ejecuta.
        const catalog = TOOLS.map((t) => `- ${t.name}: ${t.description} Argumentos (JSON Schema): ${JSON.stringify(t.inputSchema || {})}`).join('\n');
        const ask = withState(`Herramientas disponibles (las ejecuta la página):\n${catalog}\n\nResponde SOLO con un objeto JSON: {"acciones":[{"herramienta":"nombre","args":{...}}],"respuesta":"mensaje breve para el usuario"}. Usa "acciones": [] si solo hace falta responder o preguntar algo. Si necesitas cifras para responder, incluye acciones "consultar" y deja "respuesta" vacía: después recibirás los resultados.\n\nPetición del usuario: ${text}`);
        const msgs = history.map((t, i) => (i === history.length - 1 ? { role: 'user', content: ask } : t));
        const plan = await sample.json(msgs, { modelTier: tier, signal: ctl.signal });
        const acts = Array.isArray(plan && plan.acciones) ? plan.acciones.slice(0, 8) : [];
        const results = [];
        for (const a of acts) {
          if (ctl.signal.aborted) break;
          try { results.push({ herramienta: a.herramienta, resultado: run(String(a.herramienta), a.args) }); }
          catch (err) { results.push({ herramienta: a.herramienta, error: err.message }); }
        }
        answer = plan && typeof plan.respuesta === 'string' ? plan.respuesta.trim() : '';
        const needFollow = results.some((r) => r.error || r.herramienta === 'consultar') || !answer;
        if (needFollow && results.length) {
          const follow = `${INSTRUCTIONS}\n\nEl usuario pidió: "${text}". Ya se ejecutaron estas acciones y estos son los resultados:\n${JSON.stringify(results).slice(0, 12000)}\n\nEscribe la respuesta final para el usuario en español, breve, con las cifras. Si hubo errores, explica qué no se pudo hacer.`;
          ({ text: answer } = await sample(follow, { modelTier: tier, signal: ctl.signal, onText, cache: false }));
        }
        if (!answer) answer = results.length ? results.map((r) => (r.error ? `No se pudo: ${r.error}` : typeof r.resultado === 'string' ? r.resultado : JSON.stringify(r.resultado))).join('\n') : 'Listo.';
      }
      out.classList.remove('pending');
      out.textContent = answer;
      turns.push({ role: 'assistant', content: answer });
    } catch (e) {
      out.classList.remove('pending');
      const code = e && e.code;
      const A_ = window.Anthropic;
      if (mode === 'apikey' && A_ && e instanceof A_.APIError) {
        if (e instanceof A_.APIUserAbortError) out.textContent = '(detenido)';
        else if (e instanceof A_.AuthenticationError) out.textContent = 'La clave de API no es válida. Revísala en ⚙ (debe empezar con sk-ant-).';
        else if (e instanceof A_.PermissionDeniedError) out.textContent = 'Tu clave no tiene permiso para usar ese modelo. Prueba otro modelo en ⚙.';
        else if (e instanceof A_.RateLimitError) out.textContent = 'Se alcanzó el límite de uso de tu cuenta de Anthropic por ahora. Intenta en un momento.';
        else if (e instanceof A_.BadRequestError && /credit|balance|billing/i.test(e.message)) out.textContent = 'Tu cuenta de Anthropic no tiene saldo. Recarga créditos en console.anthropic.com (Billing).';
        else if (e instanceof A_.APIConnectionError) out.textContent = 'No se pudo conectar con Anthropic. Revisa tu internet e intenta de nuevo.';
        else out.textContent = `Error de la API (${e.status || 'sin código'}): ${e.message}`;
        turns.pop();
        return;
      }
      if (code === 'refused_key') { out.textContent = 'Claude no puede ayudar con esa petición. Intenta pedirlo de otra forma.'; turns.pop(); return; }
      if (code === 'cancelled') out.textContent = (e.text || '') + ' (detenido)';
      else if (code === 'tools_unavailable') {
        setMode('plan');
        out.textContent = 'Ajusté la forma de trabajar para esta vista. Envía tu petición otra vez, por favor.';
      } else if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled' || code === 'capability_removed') {
        setMode('basic', code === 'not_granted' ? 'No se dio permiso para usar Claude en esta página (puedes permitirlo desde el menú de permisos del artefacto y recargar).' : 'Claude no está disponible para esta cuenta o vista.');
        out.textContent = `Cambio a modo básico: ${basicReason}`;
      } else if (code === 'rate_limited') out.textContent = 'Se alcanzó el límite de uso por ahora. Intenta de nuevo en un momento.';
      else if (code === 'session_expired') out.textContent = 'Tu sesión de Claude expiró; vuelve a iniciar sesión.';
      else if (code === 'refused') out.textContent = 'No puedo ayudar con esa petición. Intenta pedirlo de otra forma.';
      else if (code === 'invalid_json') out.textContent = 'No entendí bien la respuesta de la IA. Intenta pedirlo con otras palabras.';
      else out.textContent = (e && e.text ? e.text + '\n\n' : '') + 'Hubo un problema de conexión. Intenta de nuevo.';
      turns.pop();
    } finally {
      setBusy(null);
      suggestions();
      input.focus();
    }
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // ---------- IA con clave propia (API de Claude desde el navegador) ----------

  async function runWithKey(history, ctl, out, run) {
    const Anthropic = window.Anthropic;
    if (!Anthropic) throw new Error('No se cargó la librería de Anthropic.');
    const client = new Anthropic({ apiKey: keyCfg.key, dangerouslyAllowBrowser: true, maxRetries: 1 });
    const model = MODELS.find((x) => x.id === keyCfg.model) || MODELS[0];
    const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    const last = history[history.length - 1];
    const messages = [
      ...history.slice(0, -1),
      { role: 'user', content: `=== ESTADO ACTUAL DEL DASHBOARD ===\n${context()}\n=== FIN DEL ESTADO ===\n\nPetición del usuario: ${last.content}` },
    ];
    const texts = [];
    for (let round = 0; round < 8; round++) {
      const params = {
        model: model.id,
        max_tokens: 16000,
        // Instrucciones fijas en caché: las peticiones siguientes las cobran mucho más barato.
        system: [{ type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
        output_config: { effort: 'medium' },
      };
      // Si el modelo declina por sus filtros de seguridad, el servidor reintenta con el modelo recomendado.
      const resp = model.fallback
        ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal: ctl.signal })
        : await client.messages.create(params, { signal: ctl.signal });
      if (resp.stop_reason === 'refusal') { const err = new Error('refused'); err.code = 'refused_key'; throw err; }
      const said = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (said) { texts.push(said); out.classList.remove('pending'); out.textContent = texts.join('\n\n'); }
      messages.push({ role: 'assistant', content: resp.content });
      if (resp.stop_reason === 'pause_turn') continue;
      if (resp.stop_reason !== 'tool_use') break;
      const results = [];
      for (const b of resp.content.filter((x) => x.type === 'tool_use')) {
        try {
          const r = run(b.name, b.input);
          results.push({ type: 'tool_result', tool_use_id: b.id, content: typeof r === 'string' ? r : JSON.stringify(r) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: b.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return texts.length ? texts[texts.length - 1] : 'Listo.';
  }

  const setBox = $('#agentSettings');
  const keyInput = $('#agentKey');
  const modelSel = $('#agentModel');
  modelSel.replaceChildren(...MODELS.map((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name} — ${m.note}`; return o; }));
  function syncSettings() {
    modelSel.value = keyCfg.model;
    keyInput.value = keyCfg.key ? '••••••••' + keyCfg.key.slice(-4) : '';
    $('#agentKeyStatus').textContent = keyCfg.key ? `Clave guardada (termina en ${keyCfg.key.slice(-4)}).` : 'Sin clave: el asistente usa ' + (inClaude ? 'la IA de Claude o el modo básico.' : 'el modo básico.');
    $('#agentForget').hidden = !keyCfg.key;
  }
  $('#agentSettingsBtn').addEventListener('click', () => { setBox.hidden = !setBox.hidden; syncSettings(); });
  keyInput.addEventListener('focus', () => { if (keyInput.value.startsWith('••')) keyInput.value = ''; });
  $('#agentSaveKey').addEventListener('click', () => {
    const v = keyInput.value.trim();
    if (v && !v.startsWith('••')) {
      if (!/^sk-ant-/.test(v)) { $('#agentKeyStatus').textContent = 'Esa no parece una clave de Anthropic (empieza con sk-ant-).'; return; }
      keyCfg.key = v;
    }
    keyCfg.model = modelSel.value;
    if ($('#agentRemember').checked && keyCfg.key) store.set('dash-api-key', keyCfg.key); else store.del('dash-api-key');
    store.set('dash-api-model', keyCfg.model);
    if (!keyCfg.key) { syncSettings(); return; }
    setMode('apikey');
    setBox.hidden = true;
    bubble('assistant', `Listo: uso IA con tu clave y ${MODELS.find((m) => m.id === keyCfg.model).name}. ¿Qué quieres hacer con tus datos?`);
    suggestions();
  });
  $('#agentForget').addEventListener('click', () => {
    keyCfg.key = '';
    store.del('dash-api-key');
    syncSettings();
    if (mode === 'apikey') { setMode(sample ? (toolsOk ? 'tools' : 'plan') : 'basic'); bubble('assistant', 'Clave borrada de este navegador.'); }
  });

  // ---------- Voz ----------

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  if (!SR) micBtn.title = 'Tu navegador no permite dictado aquí; usa el micrófono del teclado';
  micBtn.addEventListener('click', () => {
    if (!SR) { bubble('assistant', 'Este navegador no permite dictar desde la página. En el celular toca el micrófono de tu teclado para dictar.'); return; }
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'es-MX';
    rec.interimResults = true;
    rec.continuous = false;
    micBtn.classList.add('rec');
    let final = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (const r of ev.results) { if (r.isFinal) final = r[0].transcript; else interim += r[0].transcript; }
      input.value = final || interim;
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') bubble('assistant', 'No hay permiso para usar el micrófono en esta página. Puedes dictar con el micrófono del teclado de tu celular.');
      else if (ev.error !== 'no-speech' && ev.error !== 'aborted') bubble('assistant', `No se pudo usar el micrófono (${ev.error}).`);
    };
    rec.onend = () => {
      micBtn.classList.remove('rec');
      rec = null;
      if (final.trim()) send();
    };
    try { rec.start(); } catch { micBtn.classList.remove('rec'); rec = null; }
  });

  // ---------- Conexión con Claude ----------

  const ready = (async () => {
    if (keyCfg.key) { setMode('apikey'); return; }
    if (!inClaude) { setMode('basic'); return; }
    try {
      const s = await window.claude.use('sample');
      if (!s) { setMode('basic', 'Claude no está disponible en esta vista (puede faltar permiso o no estar habilitado para tu cuenta).'); return; }
      const lim = await s.limits().catch(() => null);
      sample = s;
      toolsOk = !!(lim && lim.tools);
      if (lim && Array.isArray(lim.modelTiers) && !lim.modelTiers.includes('quick')) tier = lim.modelTiers.includes('default') ? 'default' : undefined;
      setMode(toolsOk ? 'tools' : 'plan');
    } catch {
      setMode('basic', 'No se pudo conectar con Claude.');
    }
  })();
  setMode(mode);
})();
