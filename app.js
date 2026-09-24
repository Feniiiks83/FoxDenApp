/* ============================================================
   NFoxApp Landing — app.js
   Парсинг workproxies.txt, проверка доступности прокси,
   копирование tg:// ссылок, интерактив AI-карт, APK-метаданные.
   ============================================================ */
'use strict';

const PROXY_SOURCE = 'workproxies.txt';
const VERSION_SOURCE = 'version_metadata.json';
const CHECK_CONCURRENCY = 6;

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

/* ---------------- Парсинг прокси ---------------- */

/**
 * Разбирает строки форматов:
 *   https://t.me/proxy?server=H&port=P&secret=S
 *   tg://proxy?server=H&port=P&secret=S
 *   H:P:SECRET   (server:port:secret)
 */
function parseProxyLine(raw) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return null;

    // URL-формат
    const urlMatch = line.match(/server=([^&\s]+)[&\s].*?port=(\d+)[&\s].*?secret=([0-9a-fA-F]+|[A-Za-z0-9_\-]+)/);
    if (urlMatch) {
        return makeProxy(urlMatch[1], parseInt(urlMatch[2], 10), urlMatch[3]);
    }

    // Формат server:port:secret
    const plainMatch = line.match(/^([^:\s]+):(\d{2,5}):([0-9a-fA-F]{16,}|[A-Za-z0-9_\-]{16,})$/);
    if (plainMatch) {
        return makeProxy(plainMatch[1], parseInt(plainMatch[2], 10), plainMatch[3]);
    }
    return null;
}

function makeProxy(server, port, secret) {
    const isMtproto = secret.toLowerCase().startsWith('ee');
    const isSocks5 = secret.toLowerCase().startsWith('dd');
    return {
        server,
        port,
        secret,
        type: isMtproto ? 'MTProto' : (isSocks5 ? 'SOCKS5' : 'Simple'),
        tgUrl: `tg://proxy?server=${encodeURIComponent(server)}&port=${port}&secret=${encodeURIComponent(secret)}`,
        webUrl: `https://t.me/proxy?server=${encodeURIComponent(server)}&port=${port}&secret=${encodeURIComponent(secret)}`,
        status: 'unknown',   // unknown | pending | online | offline
        ping: null,
    };
}

function dedupeProxies(list) {
    const seen = new Set();
    return list.filter((p) => {
        const key = `${p.server}:${p.port}:${p.secret}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function loadProxies() {
    try {
        const resp = await fetch(`${PROXY_SOURCE}?t=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        const parsed = dedupeProxies(
            text.split(/\r?\n/).map(parseProxyLine).filter(Boolean)
        );
        if (!parsed.length) throw new Error('Список пуст или имеет неизвестный формат');
        return parsed;
    } catch (err) {
        console.error('[NFox] Не удалось загрузить прокси:', err);
        return [];
    }
}

/* ---------------- Проверка доступности ----------------
   Браузер не может открыть сырой TCP-сокет, поэтому используем
   публичный HTTP-валидатор check-host.net (no-cors режим:
   доверяем факту успешного соединения валидатора). При недоступности
   сети статус остаётся «неизвестным».
----------------------------------------------------------- */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
}

async function checkProxy(proxy) {
    proxy.status = 'pending';
    renderRowStatus(proxy);
    const t0 = performance.now();
    try {
        await withTimeout(
            fetch(`https://check-host.net/check-tcp?host=${encodeURIComponent(proxy.server + ':' + proxy.port)}&max_hits=1`, {
                mode: 'no-cors',
                signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
            }),
            8000
        );
        proxy.ping = Math.round(performance.now() - t0);
        proxy.status = 'online';
    } catch (_) {
        proxy.status = 'offline';
        proxy.ping = null;
    }
    renderRowStatus(proxy);
    updateSummary();
}

async function checkAll(proxies) {
    const btn = $('#checkAllBtn');
    const badge = $('#pxChecking');
    if (btn) btn.disabled = true;
    if (badge) badge.hidden = false;

    const queue = [...proxies];
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
            const p = queue.shift();
            if (p) await checkProxy(p);
        }
    });
    await Promise.all(workers);

    if (btn) btn.disabled = false;
    if (badge) badge.hidden = true;
    sortTableByStatus();
    showToast('✅ Проверка списка завершена');
}

/* ---------------- Рендер таблицы ---------------- */

let PROXIES = [];

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderProxyTable(proxies) {
    const tbody = $('#proxyTableBody');
    if (!tbody) return;
    if (!proxies.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="proxy-empty">
            Список недоступен. Откройте <a href="${PROXY_SOURCE}" target="_blank">${PROXY_SOURCE}</a> напрямую.</td></tr>`;
        return;
    }
    tbody.innerHTML = proxies.map((p, i) => `
        <tr data-idx="${i}">
            <td class="px-port">${i + 1}</td>
            <td class="px-server">${esc(p.server)}</td>
            <td class="px-port">${p.port}</td>
            <td><span class="px-type ${p.type === 'MTProto' ? 'mtproto' : 'simple'}">${esc(p.type)}</span></td>
            <td class="px-status-cell">
                <span class="px-status"><span class="px-dot"></span><span class="px-status-text">—</span></span>
            </td>
            <td class="px-ping-cell"><span class="px-ping">—</span></td>
            <td style="white-space:nowrap">
                <button class="px-copy" title="Скопировать tg:// ссылку" data-copy="${i}"><i class="fa-solid fa-copy"></i></button>
                <a class="px-open" href="${esc(p.webUrl)}" target="_blank" rel="noopener" title="Открыть в Telegram"><i class="fa-solid fa-up-right-from-square"></i></a>
            </td>
        </tr>`).join('');

    tbody.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const p = PROXIES[parseInt(btn.dataset.copy, 10)];
            if (!p) return;
            const ok = await copyText(p.tgUrl);
            showToast(ok ? '📋 tg://proxy ссылка скопирована' : 'Не удалось скопировать');
        });
    });

    updateSummary();
}

function rowFor(proxy) {
    const idx = PROXIES.indexOf(proxy);
    return idx >= 0 ? document.querySelector(`#proxyTableBody tr[data-idx="${idx}"]`) : null;
}

function renderRowStatus(proxy) {
    const row = rowFor(proxy);
    if (!row) return;
    const dot = row.querySelector('.px-dot');
    const txt = row.querySelector('.px-status-text');
    const ping = row.querySelector('.px-ping');
    if (dot) dot.className = 'px-dot ' + (proxy.status === 'unknown' ? '' : proxy.status);
    if (txt) txt.textContent = { unknown: '—', pending: 'проверка…', online: 'онлайн', offline: 'офлайн' }[proxy.status];
    if (ping) ping.textContent = proxy.ping != null ? `${proxy.ping} мс` : '—';
}

function updateSummary() {
    const total = PROXIES.length;
    const online = PROXIES.filter((p) => p.status === 'online').length;
    const offline = PROXIES.filter((p) => p.status === 'offline').length;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#pxTotal', total);
    set('#pxOnline', online);
    set('#pxOffline', offline);
    set('#statProxies', total || '—');
    set('#phoneProxyCount', total);
}

function sortTableByStatus() {
    const order = { online: 0, pending: 1, unknown: 2, offline: 3 };
    PROXIES.sort((a, b) => (order[a.status] - order[b.status]) || ((a.ping ?? 1e9) - (b.ping ?? 1e9)));
    renderProxyTable(PROXIES);
    PROXIES.forEach(renderRowStatus);
}

function filterTable(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('#proxyTableBody tr[data-idx]').forEach((row) => {
        const p = PROXIES[parseInt(row.dataset.idx, 10)];
        if (!p) return;
        const hit = !q || p.server.toLowerCase().includes(q) || String(p.port).includes(q) || p.type.toLowerCase().includes(q);
        row.style.display = hit ? '' : 'none';
    });
}

/* ---------------- Копирование всего списка ---------------- */

async function copyAllLinks() {
    if (!PROXIES.length) { showToast('Список ещё не загружен'); return; }
    const text = PROXIES.map((p) => p.tgUrl).join('\n');
    const ok = await copyText(text);
    showToast(ok ? `📋 Скопировано ${PROXIES.length} tg:// ссылок` : 'Не удалось скопировать');
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

async function loadVersionInfo() {
    try {
        const resp = await fetch(`${VERSION_SOURCE}?t=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) return;
        const meta = await resp.json();
        const badge = $('#apkVersionBadge');
        const dl = $('#apkDownloadBtn');
        const list = $('#changelogList');
        if (badge && meta.versionName) badge.textContent = 'v' + meta.versionName;
        if (dl && meta.downloadUrl) {
            dl.href = meta.downloadUrl;
            dl.setAttribute('download', '');
        }
        if (list && meta.releaseNotes) {
            list.innerHTML = meta.releaseNotes
                .split(/\r?\n/)
                .map((s) => s.replace(/^[•\-]\s*/, '').trim())
                .filter(Boolean)
                .map((s) => `<li>${esc(s)}</li>`)
                .join('');
        }
    } catch (e) {
        console.warn('[NFox] version_metadata.json недоступен:', e);
    }
}

/* ---------------- Меню, reveal-анимации ---------------- */

function initBurger() {
    const burger = $('#burgerBtn');
    const nav = $('#mainNav');
    if (!burger || !nav) return;
    burger.addEventListener('click', () => {
        burger.classList.toggle('open');
        nav.classList.toggle('open');
    });
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
        burger.classList.remove('open');
        nav.classList.remove('open');
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
    loadVersionInfo();

    PROXIES = await loadProxies();
    renderProxyTable(PROXIES);

    const search = $('#proxySearch');
    if (search) search.addEventListener('input', () => filterTable(search.value));

    const checkBtn = $('#checkAllBtn');
    if (checkBtn) checkBtn.addEventListener('click', () => checkAll(PROXIES));

    const copyBtn = $('#copyAllBtn');
    if (copyBtn) copyBtn.addEventListener('click', copyAllLinks);

    // Автозапуск мягкой проверки при первом появлении секции монитора
    const monitor = $('#proxy-monitor');
    if (monitor && 'IntersectionObserver' in window) {
        const auto = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                auto.disconnect();
                checkAll(PROXIES);
            }
        }, { threshold: 0.2 });
        auto.observe(monitor);
    }
});
