#!/usr/bin/env python3
"""
Автоматический сборщик и реальный TCP-валидатор MTProto/SOCKS5 прокси для NFoxApp.
Собирает списки из внешних источников, делает реальный TCP-handshake с замером
задержки, отсеивает мёртвые узлы и сохраняет proxies.json + workproxies.txt.
"""

import asyncio
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCES = [
    ("Argh94", "https://raw.githubusercontent.com/Argh94/Proxy-List/main/MTProto.txt"),
    ("SoliSpirit", "https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt"),
    ("tgmtproxy", "https://raw.githubusercontent.com/tgmtproxy/mtproxy/main/mtproto.txt"),
]

LOCAL_FALLBACK = Path("workproxies.txt")
OUTPUT_JSON = Path("proxies.json")
OUTPUT_TXT = Path("workproxies.txt")

TIMEOUT_SEC = 2.5       # таймаут одного TCP-подключения
PROBES = 2              # количество замеров на сервер
MAX_PING_MS = 1200      # отсекаем слишком медленные узлы
CONCURRENCY = 60        # параллельных TCP-проверок
MAX_SAVE = 150          # максимум лучших серверов в итоговом списке

HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def valid_host(host: str) -> bool:
    if not host or len(host) > 253:
        return False
    if IPV4_RE.match(host):
        return all(0 <= int(part) <= 255 for part in host.split("."))
    return bool(HOST_RE.match(host)) and "." in host


def classify_type(secret: str, user: str) -> str:
    if user:
        return "SOCKS5"
    s = secret.lower()
    if s.startswith("ee"):
        return "MTProto (FakeTLS)"
    if s.startswith("dd"):
        return "MTProto (Secure)"
    if s:
        return "MTProto"
    return "SOCKS5"


def build_entry(server: str, port_raw: str, secret: str, user: str, pwd: str, source: str) -> dict | None:
    server = server.strip().rstrip(".")
    if not valid_host(server):
        return None
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        return None
    if not (1 <= port <= 65535):
        return None

    secret = (secret or "").strip()
    user = (user or "").strip()
    pwd = (pwd or "").strip()

    params = {"server": server, "port": str(port)}
    if secret:
        params["secret"] = secret
    if user:
        params["user"] = user
    if pwd:
        params["pass"] = pwd

    qs = urllib.parse.urlencode(params)
    return {
        "server": server,
        "port": port,
        "secret": secret,
        "type": classify_type(secret, user),
        "source": source,
        "tg_url": f"tg://proxy?{qs}",
        "web_url": f"https://t.me/proxy?{qs}",
    }


def parse_line(raw: str, source: str) -> dict | None:
    line = raw.strip()
    if not line or line.startswith(("#", "//")):
        return None

    if "proxy?" in line:
        try:
            qs = line.split("?", 1)[1]
            q = urllib.parse.parse_qs(qs)
            server = q.get("server", [""])[0]
            port = q.get("port", [""])[0]
            secret = q.get("secret", [""])[0]
            user = q.get("user", [""])[0]
            pwd = q.get("pass", [""])[0]
            return build_entry(server, port, secret, user, pwd, source)
        except Exception:
            return None

    parts = line.split(":")
    if 2 <= len(parts) <= 4 and parts[1].isdigit():
        if len(parts) == 2:
            return build_entry(parts[0], parts[1], "", "", "", source)
        if len(parts) == 3:
            return build_entry(parts[0], parts[1], parts[2], "", "", source)
        return build_entry(parts[0], parts[1], "", parts[2], parts[3], source)
    return None


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "NFoxApp-ProxyChecker/2.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def collect_candidates() -> list[dict]:
    seen = set()
    candidates = []

    def ingest(text: str, source: str):
        for line in text.splitlines():
            item = parse_line(line, source)
            if not item:
                continue
            key = (item["server"].lower(), item["port"], item["secret"])
            if key not in seen:
                seen.add(key)
                candidates.append(item)

    for name, url in SOURCES:
        try:
            text = fetch_text(url)
            ingest(text, name)
            print(f"[OK] {name}: loaded")
        except Exception as exc:
            print(f"[WARN] {name} failed: {exc}")

    # Добавляем текущие прокси как резервный пул для перепроверки
    if LOCAL_FALLBACK.exists():
        ingest(LOCAL_FALLBACK.read_text(encoding="utf-8", errors="ignore"), "FoxDen")

    return candidates


async def tcp_ping_once(host: str, port: int) -> float | None:
    t0 = time.perf_counter()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=TIMEOUT_SEC,
        )
        latency_ms = (time.perf_counter() - t0) * 1000.0
        writer.close()
        try:
            await asyncio.wait_for(writer.wait_closed(), timeout=0.5)
        except Exception:
            pass
        return latency_ms
    except Exception:
        return None


async def verify_proxy(item: dict, sem: asyncio.Semaphore) -> dict | None:
    async with sem:
        pings = []
        for _ in range(PROBES):
            ms = await tcp_ping_once(item["server"], item["port"])
            if ms is None:
                # Первый замер не прошёл — сразу отбрасываем нестабильный сервер
                if not pings:
                    return None
                continue
            pings.append(ms)

        if not pings:
            return None

        avg_ping = round(sum(pings) / len(pings))
        if avg_ping > MAX_PING_MS:
            return None

        verified = dict(item)
        verified["ping"] = avg_ping
        verified["status"] = "online"
        return verified


async def main() -> None:
    candidates = collect_candidates()
    print(f"Total unique candidates: {len(candidates)}")
    if not candidates:
        print("No candidates fetched, keeping previous files.")
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(verify_proxy(c, sem) for c in candidates))
    alive = [r for r in results if r is not None]
    alive.sort(key=lambda x: x["ping"])
    top_alive = alive[:MAX_SAVE]

    print(f"Verified online: {len(alive)} / {len(candidates)} (saved top {len(top_alive)})")

    # Защита от затирания файлов, если пропала сеть на раннере
    if not top_alive:
        print("Zero online proxies found, keeping previous files untouched.")
        return

    now_iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "updated_at": now_iso,
        "checked_total": len(candidates),
        "online_count": len(top_alive),
        "proxies": top_alive,
    }
    OUTPUT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    txt_lines = [p["web_url"] for p in top_alive]
    OUTPUT_TXT.write_text("\n".join(txt_lines) + "\n", encoding="utf-8")
    print(f"Saved {OUTPUT_JSON} and {OUTPUT_TXT} successfully.")


if __name__ == "__main__":
    asyncio.run(main())
