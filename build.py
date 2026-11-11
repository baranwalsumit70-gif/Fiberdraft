#!/usr/bin/env python3
"""Bundle the files in src/ into one self-contained index.html (the page GitHub Pages serves).

Run it after editing anything in src/:  python3 build.py
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'src'
html = (SRC / 'index.html').read_text(encoding='utf-8')
parts = {
    '/*STYLES*/': 'styles.css',
    '/*ICONS*/': 'icons.js',
    '/*ENGINE*/': 'engine.js',
    '/*KML*/': 'kml.js',
    '/*DEMO*/': 'demo.js',
    '/*APP*/': 'app.js',
}
for marker, name in parts.items():
    code = (SRC / name).read_text(encoding='utf-8')
    assert marker in html, f'{marker} is missing from src/index.html'
    assert name.endswith('.css') or '</script' not in code.lower(), f'{name} contains a closing script tag'
    html = html.replace(marker, code)
out = ROOT / 'index.html'
out.write_text(html, encoding='utf-8')
print(f'wrote {out.name} ({out.stat().st_size / 1024:.0f} KB)')
