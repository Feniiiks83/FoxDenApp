#!/usr/bin/env python3
"""ШАГ 3: Программный анализ связей (HTML/CSS/JS/MD/YML/PY) + граф достижимости.

Извлекаем все ссылки из:
 - HTML: href, src, srcset, poster, action, data-*, inline <style>/<script>
 - CSS : url(...), @import
 - JS  : fetch/XHR/строковые литералы с путями к локальным файлам и github.io/raw URL
 - Прочие текстовые файлы (md, yml, py, json, txt): любые упоминания имён файлов репозитория
Строим граф достижимости от точек входа и ищем кандидатов на удаление.
"""
import json
import os
import re
import posixpath
from collections import defaultdict

ROOT = "/workspace"
EXCLUDE_DIRS = {".git"}
MY_SCRIPTS = {"audit_inventory.py", "audit_links.py"}  # скрипты аудита сами по себе

with open(os.path.join(ROOT, "_inventory.json"), encoding="utf-8") as f:
    inventory = json.load(f)
all_files = [x["path"] for x in inventory if not os.path.basename(x["path"]).startswith(("audit_", "_inventory"))]
size_map = {x["path"]: x["size"] for x in inventory}

TEXT_EXT = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".md", ".yml", ".yaml", ".py", ".xml"}

def read(rel):
    try:
        with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""

# ---------- Извлечение ссылок ----------
ATTR_RE = re.compile(r'(href|src|poster|action|srcset|data-[a-z-]+)\s*=\s*["\']([^"\']+)["\']', re.I)
CSS_URL_RE = re.compile(r'url\(\s*["\']?([^"\'\)]+)["\']?\s*\)', re.I)
IMPORT_RE = re.compile(r'@import\s+["\']([^"\']+)["\']', re.I)
JS_STR_RE = re.compile(r'''['"`]([^'"`\n]{1,200}?\.(?:txt|json|html?|css|js|png|jpe?g|svg|webp|ico|apk|xml|woff2?|ttf))['"`]''', re.I)
ANY_PATH_RE = re.compile(r'''[\w./~:-]+\.(?:txt|json|html?|css|js|png|jpe?g|svg|webp|ico|apk|xml)''', re.I)

def normalize(target, source_rel):
    """Приводит ссылку к относительному пути в репо; None — если внешняя/неприменимая."""
    t = target.strip().strip("'\"` ,")
    if not t or t.startswith(("#", "javascript:", "mailto:", "tel:", "data:", "blob:")):
        return None
    # полные URL этого репозитория
    m = re.match(r'https?://(?:raw\.githubusercontent\.com|github\.com)/Feniiiks83/FoxDenApp\.github\.io/(?:raw/)?(?:main|master|refs/heads/main)/(.+)', t, re.I)
    if m:
        return posixpath.normpath(m.group(1).split("?")[0].split("#")[0])
    m = re.match(r'https?://feniiiks83\.github\.io/(.+)', t, re.I)
    if m:
        return posixpath.normpath(m.group(1).split("?")[0].split("#")[0])
    if t.startswith(("http://", "https://", "//")):
        return None  # внешняя ссылка
    t = t.split("?")[0].split("#")[0]
    base = posixpath.dirname(source_rel)
    return posixpath.normpath(posixpath.join(base, t)) if base else posixpath.normpath(t)

edges = defaultdict(set)          # source -> {targets}
ref_count = defaultdict(set)      # target -> {источники, где упомянут}
per_file_refs = {}

for rel in all_files:
    ext = os.path.splitext(rel)[1].lower()
    if ext not in TEXT_EXT and ext != "":
        continue
    content = read(rel)
    targets = set()
    if ext in {".html", ".htm"}:
        for attr, val in ATTR_RE.findall(content):
            if attr.lower().startswith("srcset"):
                for part in val.split(","):
                    targets.add(part.strip().split()[0] if part.strip() else "")
            else:
                targets.add(val)
        for css in re.findall(r'<style[^>]*>(.*?)</style>', content, re.S | re.I):
            targets |= set(CSS_URL_RE.findall(css)) | set(IMPORT_RE.findall(css))
        for js in re.findall(r'<script[^>]*>(.*?)</script>', content, re.S | re.I):
            targets |= set(JS_STR_RE.findall(js))
    elif ext == ".css":
        targets |= set(CSS_URL_RE.findall(content)) | set(IMPORT_RE.findall(content))
    elif ext in {".js", ".mjs"}:
        targets |= set(JS_STR_RE.findall(content))
    else:
        # md/yml/py/json/txt — любые упоминания путей/файлов
        targets |= set(ANY_PATH_RE.findall(content))
    resolved = set()
    for t in targets:
        n = normalize(t, rel)
        if n:
            resolved.add(n)
            edges[rel].add(n)
    per_file_refs[rel] = sorted(targets)

for src, tgts in edges.items():
    for t in tgts:
        ref_count[t].add(src)

# ---------- Точки входа ----------
entry_points = {"index.html"}
# download.html / infoapp.html связаны с index.html? проверим ниже через граф.

reachable = set()
frontier = list(entry_points)
while frontier:
    cur = frontier.pop()
    if cur in reachable:
        continue
    reachable.add(cur)
    frontier.extend(edges.get(cur, []))

print("=== РАЗРЕШЁННЫЕ ССЫЛКИ ПО ФАЙЛАМ ===")
for src in sorted(edges):
    print(f"{src}:")
    for t in sorted(edges[src]):
        exists = "OK " if t in size_map else "MISSING"
        print(f"   [{exists}] -> {t}")

print("\n=== УПОМИНАНИЯ КАЖДОГО ФАЙЛА РЕПОЗИТОРИЯ (кто на него ссылается) ===")
for rel in all_files:
    refs = sorted(ref_count.get(rel, set()))
    fn_only = os.path.basename(rel)
    # доп. проверка: простое вхождение имени файла в текст других файлов
    name_hits = []
    for other in all_files:
        if other == rel or os.path.splitext(other)[1].lower() not in TEXT_EXT and other.endswith(".py") is False and os.path.splitext(other)[1].lower() not in TEXT_EXT:
            pass
        if os.path.splitext(other)[1].lower() in TEXT_EXT or other.endswith((".py", ".yml", ".md", ".txt", ".json")):
            if fn_only and fn_only in read(other):
                name_hits.append(other)
    status = "REACHABLE" if rel in reachable else ("ENTRY" if rel in entry_points else "UNREACHABLE")
    print(f"{rel} [{status}] graph_refs={refs} name_in_text={sorted(name_hits)}")

print("\n=== ИТОГОВАЯ ДОСТИЖИМОСТЬ ОТ index.html ===")
unreach = [p for p in all_files if p not in reachable and os.path.splitext(p)[1].lower() in {".html", ".htm", ".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".json", ".txt"}]
print("Недостижимы из index.html (веб-ресурсы):", unreach)
