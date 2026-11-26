/* ---------------- Конфигурация ---------------- */
const VERIFIED_JSON_URL = 'proxies.json';
const RAW_FALLBACK_URL = 'https://raw.githubusercontent.com/Feniiiks83/FoxDenApp.github.io/main/proxies.json';
const RELEASES_API_URL = 'https://api.github.com/repos/Feniiiks83/FoxDenApp/releases/latest';
const RELEASES_URL = 'https://github.com/Feniiiks83/FoxDenApp/releases/latest';
const MAX_RENDER_CARDS = 120;

let PROXIES = [];
let RENDERED = [];
let META = { updated_at: null, checked_total: 0, online_count: 0 };

/* ---------------- Загрузка проверенного списка ---------------- */
async function loadVerifiedProxies() {
    renderSkeletons(8);
    let data = null;

    for (const url of [VERIFIED_JSON_URL, RAW_FALLBACK_URL]) {
        try {
            const resp = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
            if (!resp.ok) continue;
            const json = await resp.json();
            if (Array.isArray(json.proxies) && json.proxies.length) {
                data = json;
                break;
            }
        } catch (_) { /* пробуем fallback */ }
    }

    if (!data) {
        PROXIES = [];
        renderErrorPanel('Не удалось загрузить проверенный список прокси.');
        updateSummary();
        return;
    }

    META = {
        updated_at: data.updated_at || null,
        checked_total: data.checked_total || data.proxies.length,
        online_count: data.online_count || data.proxies.length,
    };

    // Сортируем от минимального реального пинга к максимальному
    PROXIES = data.proxies
        .filter((p) => p.server && p.port)
        .map((p) => ({
            ...p,
            status: 'online',
            tgUrl: p.tg_url || `tg://proxy?server=${encodeURIComponent(p.server)}&port=${p.port}${p.secret ? `&secret=${encodeURIComponent(p.secret)}` : ''}`,
            webUrl: p.web_url || `https://t.me/proxy?server=${encodeURIComponent(p.server)}&port=${p.port}${p.secret ? `&secret=${encodeURIComponent(p.secret)}` : ''}`,
            hasSecret: Boolean(p.secret),
        }))
        .sort((a, b) => (a.ping ?? 9999) - (b.ping ?? 9999));

    populateSourceFilter(PROXIES);
    renderProxyCards();
    showToast(`✅ Загружено ${PROXIES.length} проверенных прокси`);
}

/* ---------------- Фильтр по источникам из проверенного пула ---------------- */
function populateSourceFilter(list) {
    const sel = $('#sourceSelect');
    if (!sel) return;
    const sources = Array.from(new Set(list.map((p) => p.source).filter(Boolean))).sort();
    sel.innerHTML = [
        `<option value="all">Все проверенные (${list.length})</option>`,
        ...sources.map((src) => {
            const cnt = list.filter((p) => p.source === src).length;
            return `<option value="${escapeHtml(src)}">${escapeHtml(src)} (${cnt})</option>`;
        }),
    ].join('');
}

function getVisibleProxies() {
    const sel = $('#sourceSelect');
    const sourceFilter = sel ? sel.value : 'all';
    const q = ($('#proxySearch')?.value || '').trim().toLowerCase();

    return PROXIES.filter((p) => {
        if (sourceFilter !== 'all' && p.source !== sourceFilter) return false;
        if (!q) return true;
        return (
            p.server.toLowerCase().includes(q) ||
            String(p.port).includes(q) ||
            (p.type || '').toLowerCase().includes(q) ||
            (p.source || '').toLowerCase().includes(q)
        );
    });
}

/* ---------------- Цветовая индикация реального пинга ---------------- */
function pingQualityClass(ms) {
    if (ms == null) return 'unknown';
    if (ms < 180) return 'online';   // зелёный: быстрый
    if (ms < 450) return 'pending';  // жёлтый: средний
    return 'offline';                // красный: высокий пинг, но живой
}

function formatUpdatedAt(iso) {
    if (!iso) return 'недавно';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'недавно';
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 2) return 'только что';
    if (mins < 60) return `${mins} мин. назад`;
    const hours = Math.round(mins / 60);
    return `${hours} ч. назад`;
}

function updateSummary() {
    const visible = getVisibleProxies();
    const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    set('#pxTotal', META.checked_total || PROXIES.length);
    set('#pxOnline', PROXIES.length);
    set('#pxOffline', Math.max(0, (META.checked_total || PROXIES.length) - PROXIES.length));
    set('#statProxies', PROXIES.length || '—');
    set('#phoneProxyCount', PROXIES.length || '—');

    const info = $('#proxyShownInfo');
    if (info) {
        info.textContent = `проверено ${formatUpdatedAt(META.updated_at)} · показано ${Math.min(visible.length, MAX_RENDER_CARDS)}`;
    }
}
