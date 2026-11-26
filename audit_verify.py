#!/usr/bin/env python3
"""ШАГ 4: Финальная верификация кандидатов — полнотекстовый grep по всем текстовым файлам."""
import os, re

ROOT = "/workspace"
TEXT_EXT = {".html", ".htm", ".css", ".js", ".json", ".txt", ".md", ".yml", ".yaml", ".py"}
SKIP_PREFIX = ("audit_", "_inventory")

candidates = [
    "style.css",
    "screenshots  /icon_nfoxapp.png",   # папка с двумя пробелами
    "icon_nfoxapp.png",
    "icon_nfoxapp_rounded.png",
    "screen1.jpg",
]

texts = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d != ".git"]
    for fn in filenames:
        rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
        if fn.startswith(SKIP_PREFIX) or rel.startswith(SKIP_PREFIX):
            continue
        if os.path.splitext(fn)[1].lower() in TEXT_EXT:
            with open(os.path.join(dirpath, fn), encoding="utf-8", errors="replace") as f:
                texts.append((rel, f.read()))

print(f"Просканировано текстовых файлов: {len(texts)}\n")
for cand in candidates:
    names = [cand, os.path.basename(cand)]
    hits = []
    for rel, content in texts:
        for n in set(names):
            for i, line in enumerate(content.splitlines(), 1):
                if n in line and rel != cand:
                    hits.append(f"{rel}:{i}: {line.strip()[:120]}")
    print(f"=== Кандидат: {cand} ===")
    if hits:
        for h in sorted(set(hits)):
            print("  HIT:", h)
    else:
        print("  0 упоминаний во всех текстовых файлах репозитория")
    print()
