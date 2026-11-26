# Отчёт аудита репозитория `Feniiiks83/FoxDenApp.github.io`
**Дата:** 27.11.2026 · **Метод:** программный анализ (Python: инвентаризация + SHA-256, парсинг HTML/CSS/JS, граф достижимости от `index.html`, полнотекстовый grep по всем текстовым файлам). Скрипты: `audit_inventory.py`, `audit_links.py`, `audit_verify.py`.

---

## 1. Краткая сводка

| Показатель | Значение |
|---|---|
| Всего файлов в репозитории (без `.git/`) | **18** |
| Суммарный размер | **1002.5 КБ** |
| Точных дубликатов по SHA-256 | 0 (содержимое всех файлов уникально) |
| Достигнимо из `index.html` (граф связей) | `index.html → styles.css, app.js, download.html, infoapp.html, workproxies.txt, proxies.json`; `app.js → version_metadata.json` |
| **Категория 1 — точно не используются (безопасно удалять)** | **3 файла / 824.6 КБ** |
| Категория 2 — требуют ручной проверки | 1 файл / 11.7 КБ |
| Категория 3 — дубликаты/похожие имена | 1 пара (`style.css` vs `styles.css`) |

> Примечание: исходники приложения (APK/`repomix-output.xml`) к задаче не прикреплены, поэтому URL приложения извлекались косвенно — из самого репозитория (`version_metadata.json`, `app.js`, README). Автономные `.txt`/`.json`/`.html` без ссылок в категорию «100% на удаление» не внесены (см. правила ШАГА 2).

---

## 2. Категория 1 — Точно не используются (можно безопасно удалять)

Проверено скриптом: **0 упоминаний** во всех 14 текстовых файлах репозитория (HTML, CSS, JS, JSON, TXT, MD, YML, PY), недостижимы из `index.html`, не referenced workflow'ами как обязательные.

| Путь к файлу | Тип | Размер | Причина |
|---|---|---|---|
| `screenshots  /icon_nfoxapp.png` ⚠️ (папка с двумя пробелами в имени) | PNG | 394 267 B (385 КБ) | Временный/случайный артефакт: опечатка в имени директории (`screenshots␣␣ ` вместо `screenshots`). 0 упоминаний; ссылка `screenshots/icon_nfoxapp.png` физически разрешается в `screenshots/` и **битая**. |
| `screenshots/icon_nfoxapp_rounded.png` | PNG | 444 915 B (434.5 КБ) | Изолированный ресурс: 0 упоминаний ни в одном HTML/CSS/JS/MD/YML/PY; не favicon (в `<head>` нет `<link rel="icon">`); почти весь вес репозитория. |
| `style.css` | CSS | 5 243 B (5.1 КБ) | Старая версия стилей (светлая/иная палитра «Только тёмная тема #0B101E»). Рабочий `index.html` подключает **только `styles.css`** (строка 12). Единственное упоминание — `cp ... style.css` в `deploy.yml`, где `cp` защищён `2>/dev/null \|\| true`, то есть отсутствие файла для CI безразлично. См. также Категорию 3. |

**Итого освобождается: 844 425 Б ≈ 824.6 КБ (≈82 % всего репозитория).**

«Мёртвых» связок (cluster) не найдено: `download.html`, `infoapp.html` достижимы из `index.html` и живые; изолированы только одиночные файлы выше.

Дополнительно обнаружено (не файлы, а битые ссылки — починить при случае):
- `download.html:74` → `NFOXAPP.apk` — файла нет в репозитории (скачивание, судя по `version_metadata.json`, переведено на путь `downloads/nfoxapp_v1.0.1.apk` / GitHub Releases).
- `README.md:24-27` → `screenshots/screen2.jpg … screen5.jpg` — отсутствуют (есть только `screen1.jpg`).
- `dns_update.yml` / `monitor.py` ожидают `dns_stats.json` — генерируется CI, в репо отсутствует (это нормально).

---

## 3. Категория 2 — Требуют ручной проверки

| Путь к файлу | Размер | Почему нельзя удалять вслепую |
|---|---|---|
| `proxies.json` | 11 964 B (11.7 КБ) | Не входит в граф `fetch()` из `app.js` (там используются `workproxies.txt` и `version_metadata.json`), но на него ведёт прямая ссылка `index.html:144` («proxies.json»), и он копируется в `_site` workflow'ом `deploy.yml`. Похож на манифест прокси для внешнего потребления (приложение/пользователи могут читать его напрямую по `https://feniiiks83.github.io/.../proxies.json`). Исходники APK не предоставлены — проверить, читает ли мобильное приложение этот URL. |

Файлы, проверенные и **защищённые** (не предложены к удалению): `index.html`, `download.html`, `infoapp.html` (справка,linked from index), `app.js`, `styles.css`, `workproxies.txt` (источник прокси для приложения), `version_metadata.json` (метаданные обновлений, читается `app.js`), `monitor.py` + `requirements.txt` (используются `dns_update.yml`), `README.md`, `.gitignore`, `.github/workflows/*`, `screenshots/screen1.jpg` (используется README).

---

## 4. Категория 3 — Дубликаты и похожие файлы

| Пара | Реально используемый | Лишний |
|---|---|---|
| `style.css` vs `styles.css` | **`styles.css`** (19 668 B) — подключён в `index.html:12`: `<link rel="stylesheet" href="styles.css">`; это рабочая glassmorphism-тема | **`style.css`** (5 243 B) — старая черновая версия; в `index.html`/`download.html`/`infoapp.html` подключений нет (grep = 0 реальных use-sites). SHA-256 различаются (`7620dd…` vs `daa59d…`) — это не побайтовый дубликат, а устаревшая вариация. Удалить вместе с правкой `deploy.yml` (см. ниже). |
| `screenshots  /icon_nfoxapp.png` vs `screenshots/icon_nfoxapp_rounded.png` | Ни один не используется | Оба — разные растровые версии одной иконки приложения (hash'и различаются, содержимое функционально идентично). Оба в Категории 1. |

После удаления `style.css` рекомендуется убрать его имя из строки 35 `deploy.yml` (`cp index.html styles.css style.css app.js _site/` → `cp index.html styles.css app.js _site/`) — команда и так терпит ошибку, но cleaner лучше.

---

## 5. Готовые Git-команды для удаления (только Категория 1)

```bash
cd FoxDenApp.github.io

# 1. Резервная ветка (текущее состояние сохранено на случай отката)
git checkout main && git pull
git branch backup/pre-cleanup-2026-11-27
git push origin backup/pre-cleanup-2026-11-27

# 2. Рабочая ветка чистки
git checkout -b cleanup/remove-unused-files

# 3. Удаление файлов Категории 1 (проверить пути перед rm!)
git rm "style.css"
git rm "screenshots/icon_nfoxapp_rounded.png"
git rm "screenshots  /icon_nfoxapp.png"        # папка с ДВУМЯ пробелами в имени
# если git откажется принимать путь с пробелами:
#   git rm --cached -r "screenshots  " && rm -rf "screenshots  "

# 4. Синхронизировать workflow (убрать cp style.css)
sed -i 's/cp index.html styles.css style.css app.js/cp index.html styles.css app.js/' .github/workflows/deploy.yml
git add .github/workflows/deploy.yml

# 5. Коммит и пуш
git commit -m "chore(cleanup): remove unused style.css and orphaned icon PNGs (~825 KB)"
git push -u origin cleanup/remove-unused-files

# 6. Открыть PR -> merge -> удалить ветку
gh pr create --title "Cleanup: remove unused files" --body "Category 1 only; see github_cleanup_report.md"
```

Откат при необходимости: `git revert HEAD` или `git checkout backup/pre-cleanup-2026-11-27`.
