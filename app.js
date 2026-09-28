/* ============================================================
   NFoxApp Landing — app.js
   Динамический парсинг прокси/серверов с внешних GitHub-источников,
   TCP-валидация, интерактивные карточки, копирование tg://-ссылок,
   AI-интерактив, метаданные релиза и CTA на GitHub Releases.
   ============================================================ */
'use strict';

/* ---------------- Конфигурация ---------------- */

const RELEASES_URL = 'https://github.com/Feniiiks83/FoxDenApp/releases/latest';
const VERSION_SOURCE = 'version_metadata.json';
const CHECK_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10000;
const MAX_RENDER_CARDS = 120; // защита от перегрузки DOM при больших списках

/** Внешние Raw GitHub-источники + локальный fallback. */
const SOURCES = [
    {
        id: 'workproxies',
        name: 'FoxDen · workproxies.txt (локально)',
        url: 'workproxies.txt',
        fallback: true,
    },
    {
        id: 'fenniks',
        name: 'FoxDenApp.github.io · workproxies (Raw)',
        url: 'https://raw.githubusercontent.com/Feniiiks83/FoxDenApp.github.io/main/workproxies.txt',
    },
    {
        id: 'argh94',
        name: 'Argh94/Proxy-List · MTProto (Raw)',
        url: 'https://raw.githubusercontent.com/Argh94/Proxy-List/main/MTProto.txt',
    },
    {
        id: 'solispirit',
        name: 'SoliSpirit/mtproto · all_proxies (Raw)',
        url: 'https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt',
    },
];

/* ---------------- Утилиты ---------------- */

const $ = (sel) => document.querySelector(sel);

let toastTimer = null;
function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        // Fallback для небезопасного контекста (http)
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        ta.remove();
        return ok;
    }
}

function withTimeout(promiseFactory, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        Promise.resolve()
            .then(typeof promiseFactory === 'function' ? promiseFactory() : promiseFactory)
            .then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); }
            );
    });
}

/* ---------------- Безопасный fetch ---------------- */

async function safeFetch(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = ('AbortController' in window) ? new AbortController() : null;
    const timer = setTimeout(() => controller && controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            cache: 'no-store',
            signal: controller ? controller.signal : undefined,
        });
        if (!resp.ok) {
            if (resp.status === 429) throw new Error('HTTP 429: превышен лимит запросов GitHub. Повторите позже.');
            if (resp.status === 404) throw new Error('HTTP 404: источник не найден.');
            throw new Error(`HTTP ${resp.status}`);
        }
        return await resp.text();
    } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('Превышено время ожидания ответа (timeout).');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------- Универсальный парсер прокси ----------------
   Поддерживаемые форматы строк:
     tg://proxy?server=H&port=P&secret=S
     https://t.me/proxy?server=H&port=P&secret=S
     H:P:SECRET                        (server:port:secret, hex или base64)
     IP:PORT                           (без секрета)
     IP:PORT:USER:PASS                 (SOCKS5-style auth)
   Пустые строки и комментарии (#, //) игнорируются без ошибок в консоли.
--------------------------------------------------------------- */

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]*$/;

function looksLikeHost(h) {
    if (!h) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;           // IPv4
    if (/^[0-9a-fA-F:]+$/.test(h) && h.includes(':')) return true; // IPv6
    return HOST_RE.test(h) && h.includes('.');                  // домен
}

function classifyType(secret, user) {
    if (user) return 'SOCKS5';
    const s = (secret || '').toLowerCase();
    if (s.startsWith('ee')) return 'MTProto';
    if (s.startsWith('dd')) return 'SOCKS5';
    if (/^[0-9a-f]{32}$/.test(s)) return 'MTProto (obfs4)';
    if (s) return 'MTProto';
    return 'Simple';
}

function makeProxy(server, port, secret, user, pass, sourceId) {
    server = String(server).trim().replace(/\.+$/, ''); // хосты вида "host.info." из SoliSpirit
    port = parseInt(port, 10);
    if (!server || !looksLikeHost(server)) return null;
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    const type = classifyType(secret, user);
    const params = `server=${encodeURIComponent(server)}&port=${port}` +
        (secret ? `&secret=${encodeURIComponent(secret)}` : '') +
        (user ? `&user=${encodeURIComponent(user)}` : '') +
        (pass ? `&pass=${encodeURIComponent(pass)}` : '');
    return {
        server,
        port,
        secret: secret || '',
        user: user || '',
        pass: pass || '',
        type,
        tgUrl: `tg://proxy?${params}`,
        webUrl: `https://t.me/proxy?${params}`,
        hasSecret: Boolean(secret),
        source: sourceId || 'local',
        status: 'unknown',   // unknown | pending | online | offline
        ping: null,
    };
}

function parseProxyLine(raw, sourceId) {
    const line = String(raw || '').trim();
    if (!line) return null;                                   // пустые строки
    if (line.startsWith('#') || line.startsWith('//')) return null; // комментарии

    // 1. URL-формат tg://proxy?... или https://t.me/proxy?...
    if (/proxy\?/.test(line)) {
        try {
            const qs = line.split('?').slice(1).join('?');
            const q = new URLSearchParams(qs);
            const server = q.get('server');
            const port = q.get('port');
            const secret = q.get('secret') || '';
            if (server && port) {
                return makeProxy(server, port, secret, q.get('user'), q.get('pass'), sourceId);
            }
        } catch (e) { /* некорректная строка — пропускаем молча */ }
        return null;
    }

    // 2. Классические форматы через двоеточие
    const parts = line.split(':');
    if (parts.length >= 2 && parts.length <= 4) {
        const host = parts[0];
        const port = parts[1];
        if (/^\d{2,5}$/.test(port) && looksLikeHost(host)) {
            if (parts.length === 2) return makeProxy(host, port, '', '', '', sourceId);       // IP:PORT
            if (parts.length === 3) return makeProxy(host, port, parts[2], '', '', sourceId);  // H:P:SECRET
            return makeProxy(host, port, '', parts[2], parts[3], sourceId);                    // IP:PORT:USER:PASS
        }
    }
    return null;
}

function dedupeProxies(list) {
    const seen = new Set();
    return list.filter((p) => {
        const key = `${p.server}:${p.port}:${p.secret}:${p.user}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseProxyText(text, sourceId) {
    return dedupeProxies(
        String(text || '')
            .split(/\r?\n/)
            .map((l) => parseProxyLine(l, sourceId))
            .filter(Boolean)
    );
}

/* ---------------- Загрузка источника ---------------- */

async function loadSource(source) {
    const text = await safeFetch(`${source.url}?t=${Date.now()}`);
    const parsed = parseProxyText(text, source.id);
    if (!parsed.length) throw new Error('Список пуст или имеет неизвестный формат');
    return parsed;
}

/* ---------------- Состояние и рендер карточек ---------------- */

let PROXIES = [];       // полный список текущего источника
let RENDERED = [];      // то, что сейчас в DOM (после среза и фильтра)
let currentSourceId = SOURCES[0].id;
let checkRunId = 0;     // инвалидация старых циклов проверки при смене источника

function getSource(id) {
    return SOURCES.find((s) => s.id === id) || SOURCES[0];
}

function statusLabel(status) {
    return { unknown: 'не проверен', pending: 'проверка…', online: 'онлайн', offline: 'офлайн' }[status] || '—';
}

function skeletonHTML(count) {
    const one = `
        <div class="glass card px-card skeleton-card" aria-hidden="true">
            <div class="px-card-head">
                <span class="sk sk-dot"></span><span class="sk sk-line" style="flex:2"></span>
            </div>
            <div class="sk sk-block"></div>
            <div class="px-card-actions"><span class="sk sk-btn"></span><span class="sk sk-btn"></span></div>
        </div>`;
    return Array.from({ length: count }, () => one).join('');
}

function renderSkeletons(count = 8) {
    const grid = $('#proxyGrid');
    if (grid) grid.innerHTML = skeletonHTML(count);
    setSummaryCounts(PROXIES);
}

function renderErrorPanel(message) {
    const grid = $('#proxyGrid');
    if (!grid) return;
    grid.innerHTML = `
        <div class="error-panel glass" role="alert">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div class="error-panel-text">
                <b>Не удалось загрузить список серверов</b>
                <span>${escapeHtml(message || 'Ошибка сети')}</span>
            </div>
            <button class="btn btn-small btn-primary" id="retryLoadBtn">
                <i class="fa-solid fa-rotate-right"></i> Повторить
            </button>
        </div>`;
    const btn = $('#retryLoadBtn');
    if (btn) btn.addEventListener('click', () => switchSource(currentSourceId));
}

function proxyCardHTML(p, i) {
    const typeCls = p.type.startsWith('MTProto') ? 'mtproto' : (p.type === 'SOCKS5' ? 'socks5' : 'simple');
    const badge = p.source !== 'workproxies'
        ? `<span class="px-src">${escapeHtml(getSource(p.source).name.split('·')[0].trim())}</span>`
        : '';
    const secretPreview = p.secret
        ? p.secret.slice(0, 28) + (p.secret.length > 28 ? '…' : '')
        : 'IP:PORT — без секрета';
    const secondaryAction = p.hasSecret
        ? `<a class="btn btn-small btn-ghost px-open" href="${escapeHtml(p.webUrl)}" target="_blank" rel="noopener" title="Открыть в Telegram">
             <i class="fa-solid fa-paper-plane"></i> Открыть
           </a>`
        : `<button class="btn btn-small btn-ghost px-check-one" data-check="${i}" title="Проверить доступность">
             <i class="fa-solid fa-stethoscope"></i> Проверить
           </button>`;
    return `
        <div class="glass card px-card reveal active" data-idx="${i}" tabindex="0">
            <div class="px-card-head">
                <span class="px-dot ${p.status}"></span>
                <span class="px-host" title="${escapeHtml(p.server)}">${escapeHtml(p.server)}</span>
                <span class="px-port">:${p.port}</span>
            </div>
            <div class="px-card-meta">
                <span class="px-type ${typeCls}">${escapeHtml(p.type)}</span>
                <span class="px-status-text">${statusLabel(p.status)}</span>
                <span class="px-ping">${p.ping != null ? p.ping + ' мс' : ''}</span>
                ${badge}
            </div>
            <div class="px-secret" title="${escapeHtml(p.secret || 'секрет отсутствует')}">${escapeHtml(secretPreview)}</div>
            <div class="px-card-actions">
                <button class="btn btn-small btn-primary px-copy-btn" data-copy="${i}" title="Скопировать tg://proxy ссылку">
                    <i class="fa-solid fa-copy"></i> Копировать tg://
                </button>
                ${secondaryAction}
            </div>
        </div>`;
}

function getVisibleProxies() {
    const searchEl = $('#proxySearch');
    const q = (searchEl ? searchEl.value : '').trim().toLowerCase();
    let list = PROXIES;
    if (q) {
        list = list.filter((p) =>
            p.server.toLowerCase().includes(q) ||
            String(p.port).includes(q) ||
            p.type.toLowerCase().includes(q) ||
            getSource(p.source).name.toLowerCase().includes(q)
        );
    }
    return list;
}

function renderProxyCards() {
    const grid = $('#proxyGrid');
    if (!grid) return;
    const visible = getVisibleProxies();
    RENDERED = visible.slice(0, MAX_RENDER_CARDS);

    if (!visible.length) {
        grid.innerHTML = `
            <div class="proxy-empty glass">
                <i class="fa-solid fa-magnifying-glass"></i>
                Ничего не найдено по запросу. Измените фильтр или выберите другой источник.
            </div>`;
        updateSummary();
        return;
    }

    const capNote = visible.length > RENDERED.length
        ? `<p class="list-cap-note">Показаны первые ${MAX_RENDER_CARDS} из ${visible.length}. Уточните поиск, чтобы сузить список.</p>`
        : '';
    grid.innerHTML = RENDERED.map(proxyCardHTML).join('') + capNote;

    bindCardEvents();
    updateSummary();
}

function bindCardEvents() {
    const grid = $('#proxyGrid');
    if (!grid) return;

    grid.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const p = RENDERED[parseInt(btn.dataset.copy, 10)];
            if (!p) return;
            const ok = await copyText(p.tgUrl);
            showToast(ok ? '📋 tg://proxy ссылка скопирована' : 'Не удалось скопировать');
        });
    });

    grid.querySelectorAll('[data-check]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const p = RENDERED[parseInt(btn.dataset.check, 10)];
            if (p) checkProxy(p);
        });
    });
}

function cardFor(proxy) {
    const idx = RENDERED.indexOf(proxy);
    return idx >= 0 ? document.querySelector(`#proxyGrid .px-card[data-idx="${idx}"]`) : null;
}

function renderCardStatus(proxy) {
    const card = cardFor(proxy);
    if (!card) return;
    const dot = card.querySelector('.px-dot');
    const txt = card.querySelector('.px-status-text');
    const ping = card.querySelector('.px-ping');
    if (dot) dot.className = 'px-dot ' + proxy.status;
    if (txt) txt.textContent = statusLabel(proxy.status);
    if (ping) ping.textContent = proxy.ping != null ? `${proxy.ping} мс` : '';
}

function setSummaryCounts(list) {
    const total = list.length;
    const online = list.filter((p) => p.status === 'online').length;
    const offline = list.filter((p) => p.status === 'offline').length;
    const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    set('#pxTotal', total);
    set('#pxOnline', online);
    set('#pxOffline', offline);
    set('#statProxies', total || '—');
    set('#phoneProxyCount', total || '—');
}

function updateSummary() {
    setSummaryCounts(PROXIES);
    const info = $('#proxyShownInfo');
    if (info) {
        const visible = getVisibleProxies().length;
        info.textContent = visible > RENDERED.length
            ? `показано ${RENDERED.length} из ${visible}`
            : `показано ${RENDERED.length}`;
    }
}

function sortCardsByStatus() {
    const order = { online: 0, pending: 1, unknown: 2, offline: 3 };
    PROXIES.sort((a, b) => (order[a.status] - order[b.status]) || ((a.ping ?? 1e9) - (b.ping ?? 1e9)));
    renderProxyCards();
}

/* ---------------- Проверка доступности ----------------
   Браузер не может открыть сырой TCP-сокет напрямую, поэтому
   используется публичный валидатор check-host.net (no-cors режим).
   При недоступности сети статус остаётся «не проверен».
----------------------------------------------------------- */

async function checkProxy(proxy) {
    proxy.status = 'pending';
    renderCardStatus(proxy);
    const t0 = performance.now();
    try {
        await withTimeout(() => fetch(
            `https://check-host.net/check-tcp?host=${encodeURIComponent(proxy.server + ':' + proxy.port)}&max_hits=1`,
            { mode: 'no-cors' }
        ), 8000);
        proxy.ping = Math.round(performance.now() - t0);
        proxy.status = 'online';
    } catch (_) {
        proxy.status = 'offline';
        proxy.ping = null;
    }
    renderCardStatus(proxy);
    updateSummary();
}

async function checkAll(proxies) {
    const runId = ++checkRunId;
    const btn = $('#checkAllBtn');
    const badge = $('#pxChecking');
    if (btn) btn.disabled = true;
    if (badge) badge.hidden = false;

    const queue = [...proxies];
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
        while (queue.length && runId === checkRunId) {
            const p = queue.shift();
            if (p) await checkProxy(p);
        }
    });
    await Promise.all(workers);

    if (runId !== checkRunId) return; // источник сменили во время проверки
    if (btn) btn.disabled = false;
    if (badge) badge.hidden = true;
    sortCardsByStatus();
    showToast('✅ Проверка списка завершена');
}

/* ---------------- Копирование всего списка ---------------- */

async function copyAllLinks() {
    const visible = getVisibleProxies();
    if (!visible.length) { showToast('Список ещё не загружен'); return; }
    const text = visible.map((p) => p.tgUrl).join('\n');
    const ok = await copyText(text);
    showToast(ok ? `📋 Скопировано ${visible.length} tg:// ссылок` : 'Не удалось скопировать');
}

/* ---------------- Смена источника ---------------- */

function initSourceSelect() {
    const sel = $('#sourceSelect');
    if (!sel) return;
    sel.innerHTML = SOURCES.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    sel.value = currentSourceId;
    sel.addEventListener('change', () => switchSource(sel.value));
}

async function switchSource(sourceId) {
    currentSourceId = sourceId;
    checkRunId++;                       // остановить текущую проверку
    const sel = $('#sourceSelect');
    if (sel && sel.value !== sourceId) sel.value = sourceId;

    renderSkeletons(8);

    try {
        const list = await loadSource(getSource(sourceId));
        if (currentSourceId !== sourceId) return; // пользователь уже переключился
        PROXIES = list;
        renderProxyCards();
        showToast(`Загружено серверов: ${PROXIES.length}`);
    } catch (err) {
        console.warn('[NFox] Ошибка загрузки источника:', err);
        if (currentSourceId !== sourceId) return;
        PROXIES = [];
        renderErrorPanel(err.message || String(err));
        updateSummary();
    }
}

/* ---------------- AI-карточки: подсветка под курсором ---------------- */

function initAiCards() {
    document.querySelectorAll('.ai-card').forEach((card) => {
        card.addEventListener('pointermove', (e) => {
            const r = card.getBoundingClientRect();
            card.style.setProperty('--mx', `${e.clientX - r.left}px`);
            card.style.setProperty('--my', `${e.clientY - r.top}px`);
        });
        card.addEventListener('click', () => {
            const model = card.dataset.model || 'AI';
            showToast(`🤖 ${model.toUpperCase()} доступен внутри WebView-шелла NFoxApp`);
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
        });
    });

    const shellBtn = $('#openShellBtn');
    if (shellBtn) {
        shellBtn.addEventListener('click', () => {
            window.open('https://chat.deepseek.com', '_blank', 'noopener');
        });
    }
}

/* ---------------- Версия / APK ---------------- */

function forceReleasesHref(el) {
    if (!el) return;
    el.href = RELEASES_URL;
    el.removeAttribute('download');
    el.target = '_blank';
    el.rel = 'noopener';
}

async function loadVersionInfo() {
    try {
        const resp = await fetch(`${VERSION_SOURCE}?t=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) return;
        const meta = await resp.json();
        const badge = $('#apkVersionBadge');
        const heroBadge = $('.hero-badge');
        const list = $('#changelogList');
        if (badge && meta.versionName) badge.textContent = 'v' + meta.versionName;
        if (heroBadge && meta.versionName) {
            heroBadge.innerHTML = `<span class="pulse-dot"></span> v${escapeHtml(meta.versionName)} Stable · Android 8.0+`;
        }
        if (list && meta.releaseNotes) {
            list.innerHTML = meta.releaseNotes
                .split(/\r?\n/)
                .map((s) => s.replace(/^[•\-]\s*/, '').trim())
                .filter(Boolean)
                .map((s) => `<li>${escapeHtml(s)}</li>`)
                .join('');
        }
    } catch (e) {
        console.warn('[NFox] version_metadata.json недоступен:', e);
    } finally {
        // CTA всегда ведёт на актуальную страницу Releases репозитория
        forceReleasesHref($('#apkDownloadBtn'));
        forceReleasesHref($('#heroDownloadBtn'));
    }
}

/* ---------------- Меню, reveal-анимации ---------------- */

function initBurger() {
    const burger = $('#burgerBtn');
    const nav = $('#mainNav');
    if (!burger || !nav) return;
    burger.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        burger.classList.toggle('open', open);
        burger.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
        burger.classList.remove('open');
        nav.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
    }));
}

function initReveal() {
    const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active', 'in-view');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal, .ai-card').forEach((el) => io.observe(el));
}

/* ---------------- Старт ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
    initBurger();
    initReveal();
    initAiCards();
    initSourceSelect();
    loadVersionInfo();

    // Поиск/фильтр по хосту, порту, типу и источнику
    const search = $('#proxySearch');
    if (search) {
        let debounce = null;
        search.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(renderProxyCards, 180);
        });
    }

    const checkBtn = $('#checkAllBtn');
    if (checkBtn) checkBtn.addEventListener('click', () => checkAll(getVisibleProxies()));

    const copyBtn = $('#copyAllBtn');
    if (copyBtn) copyBtn.addEventListener('click', copyAllLinks);

    await switchSource(currentSourceId);

    // Автозапуск мягкой проверки при первом появлении секции монитора
    const monitor = $('#proxy-monitor');
    if (monitor && 'IntersectionObserver' in window) {
        const auto = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                auto.disconnect();
                if (PROXIES.length) checkAll(getVisibleProxies());
            }
        }, { threshold: 0.2 });
        auto.observe(monitor);
    }
});
