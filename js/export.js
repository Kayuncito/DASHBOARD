// Exportación y compartido del dashboard: PNG de alta resolución (1080 px, ideal para celular/WhatsApp),
// PDF ejecutivo A4 multipágina (sin cortar gráficas) y Compartir nativo (Web Share API).
//
// En lugar de capturar la página tal como se ve (que en un celular aplasta las gráficas y deja controles
// visibles), se arma un reporte aparte con ancho virtual fijo, se vuelven a dibujar las gráficas a ese
// tamaño exacto (sin animación y a doble densidad) y solo entonces se captura con html2canvas.
(function () {
  'use strict';
  const A = window.DashApp;
  const D = window.DataKit;
  const S = A.state;
  const $ = (q) => document.querySelector(q);

  const LAYOUT = {
    png: { width: 1080, pad: 48, gap: 24, cols: 2, kpiCols: 2, chartH: 360, wideH: 400, font: 20 },
    pdf: { width: 1200, pad: 40, gap: 22, cols: 2, kpiCols: 3, chartH: 300, wideH: 330, font: 16 },
  };

  // Colores sólidos del tema activo (nunca transparente: WhatsApp pinta el fondo de negro).
  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const dark = cs.colorScheme.includes('dark');
    return {
      dark,
      bg: dark ? v('--bg') || '#111110' : '#ffffff',
      card: dark ? v('--surface-1') || '#1a1a19' : '#f7f7f5',
      border: v('--border') || '#e2e1dc',
      text: v('--text-primary') || '#0b0b0b',
      text2: v('--text-secondary') || '#52514e',
      muted: v('--text-muted') || '#7a7974',
      accent: v('--accent') || '#2a78d6',
    };
  }

  const h = (tag, style, ...kids) => {
    const n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    kids.flat().forEach((k) => k !== null && k !== undefined && n.append(k));
    return n;
  };

  function stamp() {
    const d = new Date();
    return d.toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
  }
  function baseName() { return (S.fileName || 'datos').replace(/\.[^.]+$/, '').replace(/[^\w\-áéíóúñü ]/gi, '').trim() || 'datos'; }
  function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // ---------- Construcción del reporte fuera de pantalla ----------

  function buildReport(mode) {
    const L = LAYOUT[mode];
    const C = colors();
    const inner = L.width - L.pad * 2;
    const host = h('div', `position:fixed;left:0;top:0;z-index:-1;width:${L.width}px;padding:${L.pad}px;box-sizing:border-box;background:${C.bg};color:${C.text};font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:${L.font}px;line-height:1.4;`);
    host.className = 'report-host';
    const charts = [];

    // Encabezado: título, archivo, fecha y filtros activos.
    const filters = A.filtersSummary();
    const sheetTxt = S.book && S.book.order.length > 1 ? ` · hoja “${S.sheet}”` : '';
    host.append(h('div', `padding-bottom:${L.gap}px;margin-bottom:${L.gap}px;border-bottom:3px solid ${C.accent};`,
      h('div', `font-size:${L.font * 0.8}px;color:${C.accent};font-weight:700;letter-spacing:.08em;text-transform:uppercase;`, 'Reporte de datos'),
      h('div', `font-size:${L.font * 1.6}px;font-weight:700;margin-top:4px;overflow-wrap:anywhere;`, `${S.fileName}${sheetTxt}`),
      h('div', `color:${C.text2};margin-top:6px;`, `Generado el ${stamp()} · ${D.fmtNum(A.filteredRows().length)} registros analizados`),
      h('div', `color:${C.text2};margin-top:4px;`, filters.length ? `Filtros aplicados: ${filters.join(' | ')}` : 'Sin filtros: se incluyen todos los registros')));
    host.lastChild.dataset.block = 'header';

    // KPIs: cifra abreviada + cifra exacta debajo (en una imagen no hay tooltip).
    const tiles = A.kpiTiles();
    const kpiBox = h('div', `display:flex;flex-wrap:wrap;gap:${L.gap * 0.6}px;margin-bottom:${L.gap}px;`);
    tiles.forEach((t) => kpiBox.append(h('div', `box-sizing:border-box;min-width:0;flex:0 0 calc(${100 / L.kpiCols}% - ${L.gap * 0.6 * (L.kpiCols - 1) / L.kpiCols}px);background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:${L.font * 0.8}px ${L.font}px;`,
      h('div', `font-size:${L.font * 0.75}px;color:${C.text2};overflow-wrap:anywhere;`, t.label),
      h('div', `font-size:${L.font * 1.7}px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px;overflow-wrap:anywhere;`, t.value),
      t.exact ? h('div', `font-size:${L.font * 0.72}px;color:${C.text2};font-variant-numeric:tabular-nums;overflow-wrap:anywhere;`, `Exacto: ${t.exact}`) : null,
      t.sub ? h('div', `font-size:${L.font * 0.68}px;color:${C.muted};margin-top:2px;overflow-wrap:anywhere;`, t.sub) : null)));
    kpiBox.dataset.block = 'kpis';
    host.append(kpiBox);

    // Gráficas en cuadrícula de 2 columnas; las "anchas" ocupan la fila completa.
    const cw = (inner - L.gap) / L.cols;
    const rowsOfCards = [];
    let pending = [];
    S.charts.forEach((c) => {
      if (c.wide) { if (pending.length) rowsOfCards.push(pending); rowsOfCards.push([c]); pending = []; }
      else { pending.push(c); if (pending.length === L.cols) { rowsOfCards.push(pending); pending = []; } }
    });
    if (pending.length) rowsOfCards.push(pending);
    rowsOfCards.forEach((group) => {
      const row = h('div', `display:flex;gap:${L.gap}px;margin-bottom:${L.gap}px;align-items:stretch;`);
      row.dataset.block = 'charts';
      group.forEach((c) => {
        const full = group.length === 1 && c.wide;
        const w = full ? inner : cw;
        const ch = full ? L.wideH : L.chartH;
        const pad = Math.round(L.font * 0.9);
        const canvas = document.createElement('canvas');
        const cvW = Math.round(w - pad * 2);
        canvas.width = cvW; canvas.height = ch;
        canvas.style.cssText = `display:block;width:${cvW}px;height:${ch}px;`;
        const card = h('div', `box-sizing:border-box;width:${w}px;flex:none;background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:${pad}px;`,
          h('div', `font-size:${L.font * 0.9}px;font-weight:700;margin-bottom:8px;overflow-wrap:anywhere;`, A.chartTitle(c)));
        const cfg = A.buildConfig(c, { export: true, mobile: false });
        if (cfg) { card.append(canvas); charts.push({ canvas, cfg }); }
        else card.append(h('div', `height:${ch}px;display:flex;align-items:center;justify-content:center;color:${C.muted};`, 'Sin datos para los filtros actuales'));
        row.append(card);
      });
      host.append(row);
    });

    // Pie: Smart Insights + registros procesados tras la limpieza.
    const ins = A.insights().slice(0, mode === 'png' ? 5 : 8);
    const t = S.tbl;
    const orig = t && t.original ? t.original.rows.length : S.rows.length;
    const footer = h('div', `background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:${L.font}px;`,
      h('div', `font-size:${L.font * 1.05}px;font-weight:700;margin-bottom:8px;`, '✨ Smart Insights'),
      ins.length ? ins.map((i) => h('div', `display:flex;gap:10px;margin:6px 0;color:${C.text};`, h('span', '', i.icon), h('span', 'overflow-wrap:anywhere;', i.text))) : h('div', `color:${C.muted};`, 'No se detectaron hallazgos destacados.'),
      S.aiInsights ? h('div', `margin-top:10px;padding-top:10px;border-top:1px dashed ${C.border};white-space:pre-wrap;overflow-wrap:anywhere;`, h('b', '', '🤖 Análisis de la IA: '), S.aiInsights.text) : null,
      h('div', `margin-top:12px;padding-top:10px;border-top:1px solid ${C.border};color:${C.text2};font-size:${L.font * 0.8}px;`,
        `Registros procesados: ${D.fmtNum(S.rows.length)}${orig !== S.rows.length ? ` (de ${D.fmtNum(orig)} originales)` : ''}`,
        t && t.log && t.log.length ? ` · ${t.log.length} corrección(es) de limpieza aplicadas` : '',
        ` · Generado con Dashboard de Datos`));
    footer.dataset.block = 'footer';
    host.append(footer);
    return { host, charts, colors: C, layout: L };
  }

  async function render(mode) {
    if (typeof html2canvas !== 'function') throw new Error('No se cargó html2canvas.');
    const rep = buildReport(mode);
    document.body.append(rep.host);
    const instances = [];
    try {
      // Dibuja cada gráfica de forma síncrona al tamaño exacto (animation: false, devicePixelRatio: 2).
      rep.charts.forEach(({ canvas, cfg }) => {
        const ch = new Chart(canvas, cfg);
        ch.resize(parseFloat(canvas.style.width), parseFloat(canvas.style.height));
        ch.update('none');
        instances.push(ch);
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const canvas = await html2canvas(rep.host, {
        scale: 2, backgroundColor: rep.colors.bg, useCORS: true, logging: false,
        width: rep.layout.width, windowWidth: rep.layout.width, scrollX: 0, scrollY: 0, x: 0, y: 0,
      });
      // Posición de cada bloque (para el PDF sin cortes).
      const blocks = [...rep.host.querySelectorAll('[data-block]')].map((b) => ({ top: b.offsetTop, height: b.offsetHeight, kind: b.dataset.block }));
      return { canvas, blocks, layout: rep.layout, colors: rep.colors };
    } finally {
      instances.forEach((c) => c.destroy());
      rep.host.remove();
    }
  }

  const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo generar la imagen.'))), type, q));

  async function makePNG() {
    const { canvas } = await render('png');
    return { blob: await toBlob(canvas, 'image/png'), name: `Reporte_${baseName()}_${today()}.png`, type: 'image/png' };
  }

  async function makePDF() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) throw new Error('No se cargó jsPDF.');
    const { canvas, blocks, layout, colors: C } = await render('pdf');
    const scale = canvas.width / layout.width;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
    const margin = 12, footerH = 8;
    const contentW = pageW - margin * 2;
    const pxToMm = contentW / (layout.width - layout.pad * 2);
    const rgb = (hex) => { const m = hex.replace('#', ''); const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const paintBg = () => { if (C.dark) { doc.setFillColor(...rgb(C.bg)); doc.rect(0, 0, pageW, pageH, 'F'); } };
    paintBg();
    let y = margin;
    for (const b of blocks) {
      // Recorta el bloque completo del lienzo grande (nunca a la mitad).
      const sx = Math.round(layout.pad * scale), sy = Math.round(b.top * scale);
      const sw = Math.round((layout.width - layout.pad * 2) * scale), sh = Math.round(b.height * scale);
      const piece = document.createElement('canvas');
      piece.width = sw; piece.height = sh;
      const ctx = piece.getContext('2d');
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, sw, sh);
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      let wMm = contentW, hMm = b.height * pxToMm;
      const maxH = pageH - margin * 2 - footerH;
      if (hMm > maxH) { const k = maxH / hMm; hMm = maxH; wMm = contentW * k; } // bloque más alto que una hoja: se reduce
      // Si no cabe en lo que queda de la hoja, salto de página.
      if (y + hMm > pageH - margin - footerH && y > margin) { doc.addPage(); paintBg(); y = margin; }
      doc.addImage(piece.toDataURL('image/png'), 'PNG', margin + (contentW - wMm) / 2, y, wMm, hMm, undefined, 'FAST');
      y += hMm + 4;
    }
    // Pie de página: archivo y número de página.
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(...rgb(C.muted));
      doc.text(`${S.fileName} · ${today()}`, margin, pageH - 6);
      doc.text(`Página ${i} de ${total}`, pageW - margin, pageH - 6, { align: 'right' });
    }
    return { blob: doc.output('blob'), name: `Reporte_${baseName()}_${today()}.pdf`, type: 'application/pdf' };
  }

  // ---------- Compartir (Web Share API) ----------

  function canShareFiles() {
    try {
      if (!navigator.canShare || !window.File) return false;
      return navigator.canShare({ files: [new File(['x'], 'prueba.png', { type: 'image/png' })] });
    } catch { return false; }
  }

  async function share(file) {
    const f = new File([file.blob], file.name, { type: file.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try {
        await navigator.share({ files: [f], title: file.name, text: `Reporte de ${S.fileName}` });
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return true; // el usuario cerró el menú
      }
    }
    return false;
  }

  // ---------- Interfaz ----------

  const menu = $('#exportMenu');
  const btn = $('#btnExportMenu');
  const busy = $('#busyOverlay');
  function setBusy(text) {
    busy.hidden = !text;
    if (text) $('#busyText').textContent = text;
  }
  function closeMenu() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.querySelectorAll('.share-only').forEach((b) => { b.hidden = !canShareFiles(); });
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  async function run(kind) {
    closeMenu();
    if (!S.book) return;
    const isPdf = kind.endsWith('pdf');
    setBusy(isPdf ? 'Generando reporte PDF en alta definición…' : 'Generando imagen en alta definición…');
    // Deja que el aviso se pinte antes del trabajo pesado.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const file = isPdf ? await makePDF() : await makePNG();
      setBusy('');
      if (kind.startsWith('share')) {
        const ok = await share(file);
        if (!ok) { A.toast('Este navegador no permite compartir archivos; se descargará.'); await A.saveFile(file.name, file.blob); }
      } else {
        await A.saveFile(file.name, file.blob);
        A.toast(`Listo: ${file.name}`);
      }
    } catch (err) {
      console.error(err);
      setBusy('');
      A.toast(`No se pudo generar el reporte: ${err.message || err}`);
    }
  }
  menu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => run(b.dataset.export)));

  window.DashExport = { makePNG, makePDF, canShareFiles, buildReport };
})();
