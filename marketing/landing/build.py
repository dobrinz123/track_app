"""Rebuild page.html (Artifact body) and index.html (standalone) from index.template.html."""
from pathlib import Path

here = Path(__file__).parent
w, h = (here / "tmr-path.txt").read_text(encoding="utf-8").splitlines()[0].split()
path = (here / "tmr-path.txt").read_text(encoding="utf-8").splitlines()[1]
t = (here / "index.template.html").read_text(encoding="utf-8")
t = t.replace("{{VB_W}}", str(int(w) + 60)).replace("{{VB_H}}", str(int(h) + 60)).replace("{{TMR_PATH}}", path)
(here / "page.html").write_text(t, encoding="utf-8")
cut = t.index("</style>") + len("</style>")
(here / "index.html").write_text(
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + t[:cut] + "\n</head>\n<body>\n" + t[cut:] + "\n</body>\n</html>\n", encoding="utf-8")
print("built page.html + index.html")
