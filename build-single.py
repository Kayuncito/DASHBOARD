"""Genera dist/Dashboard-de-Datos.html: todo el sitio en un solo archivo HTML.

Uso: python3 build-single.py
"""
import re
from pathlib import Path

root = Path(__file__).parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'css/styles.css').read_text(encoding='utf-8')
html = html.replace('<link rel="stylesheet" href="css/styles.css">', '<style>\n' + css + '\n</style>')


def inline(m):
    code = (root / m.group(1)).read_text(encoding='utf-8')
    code = re.sub(r'</(script)', r'<\\/\1', code, flags=re.I)  # no cerrar la etiqueta antes de tiempo
    code = code.replace('\ufffd', '\\ufffd')  # carácter de reemplazo literal -> escape JS equivalente
    return '<script>\n' + code + '\n</script>'


html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
out = root / 'dist' / 'Dashboard-de-Datos.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding='utf-8')
print(f'{out} ({out.stat().st_size // 1024} KB)')
