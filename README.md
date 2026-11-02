# Dashboard de Datos

Sitio web estático para importar archivos **CSV**, **XLSX/XLS** o **TXT** y generar **dashboards interactivos** al instante. Todo se procesa en el navegador: los datos no se envían a ningún servidor.

## Cómo usarlo

1. Abre `index.html` en tu navegador (doble clic) o publícalo con GitHub Pages.
2. Arrastra un archivo o haz clic en la zona de carga. También puedes probar con **datos de ejemplo**.
3. Se genera un dashboard automático con indicadores (KPIs), gráficas y la tabla de datos.

## Funciones

- **Formatos**: CSV y TXT (detecta coma, punto y coma, tabulador o `|`; codificación UTF-8, UTF-16 o Windows-1252 para ñ y acentos; salta títulos y notas arriba de la tabla), XLSX/XLS/ODS con selector de hojas.
- **Perfilado de columnas sobre el 100% de las filas**: moneda (`$`), porcentaje (`%`), números con miles en formato MX o europeo, fechas mixtas y seriales de Excel, categorías, texto libre e identificadores (folios/IDs que no se grafican).
- **Detección de tipos**: números (incluye `1,234.50`, `1.234,50`, `$`, `%`), fechas (`2025-03-14`, `14/03/2025`, `14 mar 2025`) y texto.
- **Exportar / Compartir**: imagen PNG de 1080 px para celular/WhatsApp, PDF ejecutivo A4 multipágina que nunca corta una gráfica a la mitad, y botón de compartir nativo (iOS/Android). El reporte se arma aparte con ancho fijo y gráficas redibujadas a doble densidad, con encabezado (archivo, fecha, filtros), KPIs con la cifra exacta, Smart Insights y fondo sólido (claro u oscuro).
- **Sesión automática (IndexedDB)**: el archivo limpio, el esquema, los filtros, las gráficas y los insights de IA se guardan solos; al volver a abrir la página todo se restaura. Guarda los últimos 3 archivos (selector “Recientes”), con opciones de nueva sesión y borrar datos locales.
- **Smart Insights sin IA**: Pareto/concentración, tendencias con pendiente, anomalías (más de 2σ) y correlaciones de Pearson, calculados en el navegador. Con IA se pueden redactar hallazgos ejecutivos.
- **Explorador (tabla dinámica)**: elige Eje X, Métrica Y y operación (suma, promedio, conteo, máximo, mínimo) y agrégalo como gráfica.
- **Dashboard automático**: tendencia en el tiempo, barras por categoría, dona, dispersión y KPIs (totales, promedios, periodo).
- **Constructor de gráficas**: barras, barras horizontales, línea, área, dona y dispersión; cálculo por conteo, suma, promedio, mínimo, máximo o valores únicos; agrupación de fechas por día, semana, mes, trimestre o año.
- **Filtros cruzados**: haz clic en una barra o segmento para filtrar todo el dashboard; filtros por lista y rango de fechas.
- **Tabla** con búsqueda, ordenamiento y paginación; **exporta** los datos filtrados a CSV.
- **Archivos con varias hojas**: un asistente identifica cada hoja (datos, notas/instrucciones o calendario), abre la más útil, muestra las notas del archivo y sugiere cómo combinarlas: **unir** hojas por una columna en común (como BUSCARV, p. ej. agregar Año/Mes/Trimestre desde una tabla calendario) o **apilar** hojas con las mismas columnas.
- **Series de tiempo**: detecta datos mensuales/trimestrales, promedia en vez de sumar, agrupa en una misma gráfica las columnas comparables y muestra el último valor con su cambio contra el periodo anterior.
- **Varias series por gráfica**: desglosa por una categoría (p. ej. Mujeres / Hombres) o compara varias columnas numéricas.
- **Asistente (texto o voz)**: pide en tus palabras lo que quieras hacer (“elimina duplicados y haz una gráfica de ventas por región”, “¿qué estado tiene mayor desempleo?”). Dentro de Claude usa IA y actúa sobre el dashboard: consulta, filtra, grafica, limpia, edita columnas y combina hojas, todo con deshacer. Fuera de Claude puedes usar **tu propia clave de la API de Claude** (botón ⚙ del asistente: Claude, OpenAI o Gemini; la clave se guarda solo en tu navegador) o el modo sin IA, que entiende las peticiones comunes.
- **Limpieza de datos**: analizador con puntuación de calidad que detecta filas duplicadas, filas de totales/subtotales, valores escritos de distintas formas (`Norte` / `norte` / `NORTE`), celdas vacías, valores con formato incorrecto (`N/D` en una columna numérica), columnas que mezclan números y texto, valores atípicos y columnas vacías o constantes. Cada problema trae acciones (eliminar, rellenar, unificar, convertir) con **deshacer**, **restaurar original** y descarga de los datos limpios en **CSV** o **Excel**.
- **Correcciones automáticas al importar**: detecta el encabezado aunque haya títulos arriba de la tabla, elimina filas y columnas vacías, quita espacios sobrantes y renombra encabezados vacíos o repetidos.
- Descarga de cada gráfica como **PNG**, tema **claro/oscuro** y diseño adaptable a móvil.

## Estructura

```
index.html        Página principal
css/styles.css    Estilos (tema claro/oscuro)
js/data.js        Lectura de archivos, detección de tipos y agregación
js/clean.js       Analizador de calidad y acciones de limpieza
js/book.js        Asistente de hojas: clasificación, unión y apilado
js/agent.js       Asistente por texto/voz (IA de Claude, OpenAI o Gemini con clave propia; comandos básicos sin IA)
js/insights.js    Motor estadístico local (insights, Pearson, tendencias, atípicos) y contexto JSON para la IA
js/export.js      Exportación PNG / PDF y compartir nativo
js/session.js     Persistencia de sesión en IndexedDB y archivos recientes
js/app.js         Interfaz: filtros, KPIs, gráficas, tabla y panel de limpieza
js/sample.js      Datos de ejemplo
vendor/           Chart.js 4.4.1, SheetJS 0.18.5, PapaParse 5.4.1, html2canvas 1.4.1, jsPDF 2.5.2 y el SDK oficial de Anthropic 1.3.0 (licencias MIT/Apache), incluidos para funcionar sin internet
```

## Publicar con GitHub Pages

1. En el repositorio: **Settings → Pages**.
2. En **Build and deployment → Source**, elige **Deploy from a branch**.
3. Selecciona la rama (por ejemplo `main`) y la carpeta **/ (root)**, y guarda.
4. En uno o dos minutos el sitio estará en https://kayuncito.github.io/DASHBOARD/.

> GitHub Pages en repositorios **privados** requiere un plan GitHub Pro, Team o Enterprise. Con el plan gratuito, el repositorio debe ser público.
