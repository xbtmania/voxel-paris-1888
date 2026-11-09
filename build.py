"""Build the self-contained GitHub Pages entry point.

Reads the three.js runtime from node_modules, the app source and the HTML
template, then writes both the Pages entry point (`index.html`) and the
descriptive standalone copy (`voxel-paris-1888.html`).
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
three = (ROOT / "node_modules" / "three" / "build" / "three.min.js").read_text(encoding="utf-8")
app = (ROOT / "src" / "app.js").read_text(encoding="utf-8")
template = (ROOT / "src" / "index.template.html").read_text(encoding="utf-8")

html = template.replace("/*__THREE__*/", three).replace("/*__APP__*/", app)

for filename in ("index.html", "voxel-paris-1888.html"):
    out = ROOT / filename
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")
