#!/usr/bin/env python3
"""ШАГ 1: Полная инвентаризация репозитория (путь, расширение, размер, SHA-256)."""
import hashlib
import json
import os
from collections import defaultdict

ROOT = "/workspace"

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

files = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d != ".git"]
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT)
        ext = os.path.splitext(fn)[1].lower() or "(no ext)"
        files.append({
            "path": rel,
            "ext": ext,
            "size": os.path.getsize(full),
            "sha256": sha256(full),
        })

files.sort(key=lambda x: x["path"])
with open(os.path.join(ROOT, "_inventory.json"), "w", encoding="utf-8") as f:
    json.dump(files, f, ensure_ascii=False, indent=2)

print(f"Всего файлов (без .git): {len(files)}")
total = sum(x['size'] for x in files)
print(f"Суммарный размер: {total} байт ({total/1024:.1f} КБ)")

# Дубликаты по хэшу
by_hash = defaultdict(list)
for x in files:
    by_hash[x["sha256"]].append(x["path"])
dups = {h: p for h, p in by_hash.items() if len(p) > 1}
print("\nТочные дубликаты по SHA-256:")
if not dups:
    print("  (нет файлов с идентичным содержимым)")
for h, p in dups.items():
    print(f"  {h[:12]}... -> {p}")

print("\nИнвентарь:")
for x in files:
    print(f"  {x['path']} | {x['ext']} | {x['size']} B | {x['sha256'][:12]}")
