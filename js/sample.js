// Genera un conjunto de datos de ventas de ejemplo (determinístico).
window.buildSampleCSV = function buildSampleCSV() {
  let seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const regiones = ['Norte', 'Centro', 'Sur', 'Occidente'];
  const catalogo = {
    'Electrónica': [['Audífonos', 899], ['Bocina', 1299], ['Tablet', 5499], ['Smartwatch', 3299]],
    'Hogar': [['Cafetera', 1499], ['Licuadora', 999], ['Lámpara', 549]],
    'Oficina': [['Silla', 2799], ['Escritorio', 4599], ['Monitor', 3899]],
    'Deportes': [['Bicicleta', 7999], ['Tenis', 1799], ['Mancuernas', 699]],
  };
  const vendedores = ['Ana López', 'Carlos Ruiz', 'María Pérez', 'Jorge Díaz', 'Lucía Gómez', 'Pedro Sánchez'];
  const canales = ['Tienda', 'En línea', 'Distribuidor'];

  const header = ['Fecha', 'Región', 'Categoría', 'Producto', 'Vendedor', 'Canal', 'Unidades', 'Precio unitario', 'Ventas', 'Costo', 'Utilidad'];
  const rows = [];
  const start = new Date(2025, 0, 1).getTime();
  const day = 86400000;
  for (let i = 0; i < 720; i++) {
    const d = new Date(start + Math.floor(rnd() * 365) * day);
    const month = d.getMonth();
    const cat = pick(Object.keys(catalogo));
    const [prod, precio] = pick(catalogo[cat]);
    const season = 1 + 0.5 * Math.sin((month - 2) / 12 * Math.PI * 2) + (month >= 10 ? 0.6 : 0);
    const unidades = Math.max(1, Math.round((1 + rnd() * 9) * season));
    const ventas = unidades * precio;
    const costo = Math.round(ventas * (0.55 + rnd() * 0.2));
    const fecha = `${d.getFullYear()}-${String(month + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    rows.push([fecha, pick(regiones), cat, prod, pick(vendedores), pick(canales), unidades, precio, ventas, costo, ventas - costo]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Datos "sucios" a propósito para probar la limpieza de datos.
  const dirty = (i, col, v) => { rows[i][col] = v; };
  [15, 80, 140, 300, 512].forEach((i) => dirty(i, 1, rows[i][1].toUpperCase()));   // NORTE
  [33, 210, 404].forEach((i) => dirty(i, 1, rows[i][1].toLowerCase()));             // norte
  [57, 333].forEach((i) => dirty(i, 2, rows[i][2].replace('ó', 'o')));              // Electronica
  [12, 99, 250, 610, 700, 711].forEach((i) => dirty(i, 4, ''));                     // vendedor vacío
  [45, 460].forEach((i) => dirty(i, 6, 'N/D'));                                      // unidades no válidas
  [5, 120, 377, 590].forEach((i) => rows.splice(i, 0, rows[i].slice()));            // duplicados
  rows.push(['', '', '', 'TOTAL', '', '', '', '', rows.reduce((s, r) => s + (+r[8] || 0), 0), '', '']);
  rows.unshift(header);
  return rows.map((r) => r.join(',')).join('\n');
};
