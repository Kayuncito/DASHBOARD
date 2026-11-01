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

  // ---------- Modo básico (sin IA) ----------

  function basic(text) {
    const t = norm(text);
    const m = (re) => t.match(re);
    let r;
    if (/deshac/.test(t)) return ACTIONS.limpieza({ accion: 'deshacer' });
    if (/restaur/.test(t)) return ACTIONS.limpieza({ accion: 'restaurar' });
    if (/(quita|borra|limpia|elimina)r? (todos )?(los )?filtros/.test(t)) return ACTIONS.filtrar({ quitar_todos: true });
    if (/duplicad/.test(t)) {
      const i = S.report.visible.find((x) => x.id === 'dups');
      return i ? ACTIONS.limpieza({ accion: 'aplicar', problema_id: 'dups', opcion: 0 }) : 'No encontré filas duplicadas.';
    }
    if (/(limpia|limpieza|corrige|arregla)/.test(t)) return ACTIONS.limpieza({ accion: 'recomendadas' });
    if ((r = m(/(?:abre|abrir|ver|muestra) (?:la )?hoja (.+)/))) return ACTIONS.hojas({ accion: 'abrir', hoja: r[1] });
    if ((r = m(/(?:elimina|borra|quita)r? (?:la )?columna (.+)/))) return ACTIONS.editar_datos({ operacion: 'eliminar_columna', columna: r[1] });
    if ((r = m(/renombra(?:r)? (?:la )?(?:columna )?(.+?) (?:a|como|por) (.+)/))) return ACTIONS.editar_datos({ operacion: 'renombrar_columna', columna: r[1], nuevo_nombre: text.split(/ (?:a|como|por) /i).pop().trim() });
    if ((r = m(/(?:filtra|filtrar|solo|solamente|muestra solo)(?: por)? (.+?) (?:=|es|igual a|:) (.+)/))) return ACTIONS.filtrar({ columna: r[1], valores: r[2].split(/,| y /).map((s) => s.trim()) });
    if ((r = m(/grafica(?: de (?:barras|linea|lineas|pastel|dona))? (?:de |del |la |el )?(.+?) por (.+)/))) {
      const tipo = /linea/.test(t) ? 'line' : /pastel|dona/.test(t) ? 'pie' : 'bar';
      const y = findCol(r[1], { required: false });
      return ACTIONS.crear_grafica({ tipo, x: r[2], y: y && y.type === 'number' ? y.name : undefined, calculo: y && y.type === 'number' ? undefined : 'count' });
    }
    return null;
  }

  // ---------- Interfaz ----------

  const panel = $('#agentPanel');
  const log = $('#agentLog');
  const input = $('#agentInput');
  const sendBtn = $('#agentSend');
  const stopBtn = $('#agentStop');
  const micBtn = $('#agentMic');
  let sample = null, toolsOk = false, busy = null;
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
    if (!log.childElementCount) {
      bubble('assistant', sample && toolsOk
        ? 'Hola. Dime qué quieres hacer con tus datos: limpiarlos, preguntarme algo, filtrar, crear gráficas o combinar hojas. Puedes escribir o usar el micrófono.'
        : 'Hola. Estás en modo básico (sin IA): entiendo comandos como “elimina duplicados”, “limpia los datos”, “filtra Región = Norte”, “gráfica de Ventas por Región”, “elimina columna X”, “renombra X a Y”, “abre hoja X” o “deshacer”. Para pedir cualquier cosa con tus palabras, abre esta página dentro de Claude.');
    }
    setTimeout(() => input.focus(), 50);
  }
  function close() { panel.hidden = true; document.body.classList.remove('agent-open'); }
  $('#btnAgent').addEventListener('click', () => (panel.hidden ? open() : close()));
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

    if (!(sample && toolsOk)) {
      try {
        const out = basic(text);
        bubble('assistant', out || 'No entendí ese comando en modo básico. Prueba con: “elimina duplicados”, “limpia los datos”, “filtra Región = Norte”, “gráfica de Ventas por Región” o “deshacer”.');
      } catch (e) { bubble('assistant', `No se pudo: ${e.message}`); }
      suggestions();
      return;
    }

    turns.push({ role: 'user', content: text });
    const history = turns.slice(-7);
    const msgs = history.map((t, i) => (i === history.length - 1
      ? { role: 'user', content: `${INSTRUCTIONS}\n\n=== ESTADO ACTUAL DEL DASHBOARD ===\n${context()}\n=== FIN DEL ESTADO ===\n\nPetición del usuario: ${t.content}` }
      : t));
    const ctl = new AbortController();
    setBusy(ctl);
    const out = bubble('assistant', 'Pensando…');
    out.classList.add('pending');
    const tools = TOOLS.map((tool) => ({
      ...tool,
      execute: (args, cx) => {
        if (cx && cx.signal && cx.signal.aborted) throw new Error('Cancelado');
        const label = { consultar: 'Consultando datos', crear_grafica: 'Creando gráfica', quitar_grafica: 'Quitando gráfica', filtrar: 'Aplicando filtro', limpieza: 'Limpiando datos', editar_datos: 'Editando datos', hojas: 'Trabajando con hojas' }[tool.name];
        stepNote(`⚙ ${label}…`);
        log.append(out);
        const res = ACTIONS[tool.name](args || {});
        suggestions();
        return res;
      },
    }));
    try {
      const { text: answer } = await sample(msgs, {
        tools, modelTier: 'quick', signal: ctl.signal,
        onText: ({ text: t }) => { out.classList.remove('pending'); out.textContent = t; log.scrollTop = log.scrollHeight; },
      });
      out.classList.remove('pending');
      out.textContent = answer;
      turns.push({ role: 'assistant', content: answer });
    } catch (e) {
      out.classList.remove('pending');
      const code = e && e.code;
      if (code === 'cancelled') out.textContent = (e.text || '') + ' (detenido)';
      else if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled' || code === 'tools_unavailable') {
        toolsOk = false;
        out.textContent = 'No tengo permiso para usar Claude en esta página, así que cambio a modo básico (comandos simples).';
      } else if (code === 'rate_limited') out.textContent = 'Se alcanzó el límite de uso por ahora. Intenta de nuevo en un momento.';
      else if (code === 'session_expired') out.textContent = 'Tu sesión de Claude expiró; vuelve a iniciar sesión.';
      else if (code === 'refused') out.textContent = 'No puedo ayudar con esa petición. Intenta pedirlo de otra forma.';
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

  (async () => {
    if (!(window.claude && typeof window.claude.use === 'function')) return;
    try {
      const s = await window.claude.use('sample');
      if (!s) return;
      const lim = await s.limits().catch(() => null);
      sample = s;
      toolsOk = !!(lim && lim.tools);
      $('#agentMode').textContent = toolsOk ? 'Con IA (Claude)' : 'Modo básico';
    } catch { /* sin IA */ }
  })();

})();
