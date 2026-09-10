#!/usr/bin/env python3
"""Coleta proxies de fontes públicas conhecidas (busca profunda)."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Iterable

PROXY_LINE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$")
PROXY_IN_LINE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})\b")
PROTOCOL_PREFIX = re.compile(r"^(?:https?|socks4|socks5)://", re.I)

TEXT_SOURCES: dict[str, str] = {
    # APIs públicas
    "hproxy_all": "https://hproxy.com/api/proxy-list?format=txt&limit=2000",
    "hproxy_http": "https://hproxy.com/api/proxy-list?format=txt&protocol=http&limit=1000",
    "hproxy_socks4": "https://hproxy.com/api/proxy-list?format=txt&protocol=socks4&limit=1000",
    "hproxy_socks5": "https://hproxy.com/api/proxy-list?format=txt&protocol=socks5&limit=1000",
    "proxyscrape_v4_all": (
        "https://api.proxyscrape.com/v4/free-proxy-list/get"
        "?request=display_proxies&proxy_format=ipport&format=text"
    ),
    "proxyscrape_v2_http": (
        "https://api.proxyscrape.com/v2/?request=displayproxies"
        "&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all"
    ),
    "proxyscrape_v2_https": (
        "https://api.proxyscrape.com/v2/?request=displayproxies"
        "&protocol=http&timeout=10000&country=all&ssl=yes&anonymity=all"
    ),
    "proxyscrape_v2_socks4": (
        "https://api.proxyscrape.com/v2/?request=displayproxies"
        "&protocol=socks4&timeout=10000&country=all"
    ),
    "proxyscrape_v2_socks5": (
        "https://api.proxyscrape.com/v2/?request=displayproxies"
        "&protocol=socks5&timeout=10000&country=all"
    ),
    "openproxylist_http": "https://api.openproxylist.xyz/http.txt",
    "openproxylist_socks5": "https://api.openproxylist.xyz/socks5.txt",
    "spys_http": "https://spys.me/proxy.txt",
    "spys_socks": "https://spys.me/socks.txt",
    # ProxyScrape mirror (jsDelivr)
    "proxyscrape_mirror_all": (
        "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.txt"
    ),
    "proxyscrape_mirror_http": (
        "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/http/data.txt"
    ),
    "proxyscrape_mirror_socks4": (
        "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/socks4/data.txt"
    ),
    "proxyscrape_mirror_socks5": (
        "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/socks5/data.txt"
    ),
    # GitHub — listas grandes
    "sevenworks_http": (
        "https://raw.githubusercontent.com/SevenworksDev/proxy-list/main/proxies/http.txt"
    ),
    "sevenworks_socks5": (
        "https://raw.githubusercontent.com/SevenworksDev/proxy-list/main/proxies/socks5.txt"
    ),
    "zevtyardt_http": "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt",
    "zevtyardt_socks5": "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt",
    "ercin_http": "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt",
    "ercin_https": "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt",
    "ercin_socks4": "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks4.txt",
    "ercin_socks5": "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt",
    "obcbo_http": "https://raw.githubusercontent.com/ObcbO/getproxy/master/file/http.txt",
    "obcbo_socks5": "https://raw.githubusercontent.com/ObcbO/getproxy/master/file/socks5.txt",
    "aslisk_https": "https://raw.githubusercontent.com/aslisk/proxyhttps/main/https.txt",
    "b4rcode_http": "https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt",
    "b4rcode_socks5": "https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/SOCKS5.txt",
    "proxyscraper_http": "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt",
    "proxyscraper_socks4": "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks4.txt",
    "proxyscraper_socks5": "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks5.txt",
    "anonym0us_http": (
        "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt"
    ),
    "anonym0us_socks5": (
        "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt"
    ),
    "thespeedx_http": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "thespeedx_socks4": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt",
    "thespeedx_socks5": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "jetkai_http": (
        "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt"
    ),
    "jetkai_https": (
        "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt"
    ),
    "jetkai_socks4": (
        "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks4.txt"
    ),
    "jetkai_socks5": (
        "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt"
    ),
    "monosans_all": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt",
    "monosans_http": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "monosans_socks4": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt",
    "monosans_socks5": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    "thordata_all": "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/all.txt",
    "thordata_http": "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/http.txt",
    "thordata_socks5": "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/proxies/socks5.txt",
    "stormsia_all": "https://raw.githubusercontent.com/stormsia/proxy-list/main/working_proxies.txt",
    "stormsia_http": "https://raw.githubusercontent.com/stormsia/proxy-list/main/http.txt",
    "stormsia_socks4": "https://raw.githubusercontent.com/stormsia/proxy-list/main/socks4.txt",
    "stormsia_socks5": "https://raw.githubusercontent.com/stormsia/proxy-list/main/socks5.txt",
    "vpslab_http": (
        "https://raw.githubusercontent.com/vpslabcloud/vpslab-free-proxy-list/main/http_all.txt"
    ),
    "vpslab_http_elite": (
        "https://raw.githubusercontent.com/vpslabcloud/vpslab-free-proxy-list/main/http_elite.txt"
    ),
    "vpslab_socks4": (
        "https://raw.githubusercontent.com/vpslabcloud/vpslab-free-proxy-list/main/socks4_all.txt"
    ),
    "vpslab_socks5": (
        "https://raw.githubusercontent.com/vpslabcloud/vpslab-free-proxy-list/main/socks5_all.txt"
    ),
    "clarketm_raw": "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    "sunny9577": "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt",
    "opsxcq": "https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt",
    "shiftytr_http": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
    "shiftytr_https": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
    "shiftytr_socks4": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt",
    "shiftytr_socks5": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt",
    "roosterkid_https": "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    "roosterkid_socks4": "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt",
    "roosterkid_socks5": "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
    "hideip_http": "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt",
    "hideip_socks5": "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt",
    "prxchk_http": "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",
    "prxchk_socks5": "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt",
    "aliilapro_http": "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt",
    "aliilapro_socks5": "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks5.txt",
    "hendrikbgr": "https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy_list.txt",
    "vakhov_all": "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/proxylist.txt",
    "vakhov_socks4": "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt",
    "vakhov_socks5": "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt",
    "hookzof_socks5": "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
    "fate0_json": "https://raw.githubusercontent.com/fate0/proxylist/master/proxy.list",
}


@dataclass
class FetchResult:
    source: str
    url: str
    proxies: set[str] = field(default_factory=set)
    error: str | None = None


def fetch_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "proxy-scraper/2.0 (+https://github.com/yqn9z4mfnn-bot/App)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def is_valid_proxy_ip(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(part) for part in parts]
    except ValueError:
        return False
    if any(octet < 0 or octet > 255 for octet in octets):
        return False
    if octets[0] == 0 or octets[0] == 127 or octets[0] >= 224:
        return False
    return True


def add_proxy(proxies: set[str], candidate: str) -> None:
    candidate = candidate.strip()
    if not candidate:
        return
    candidate = PROTOCOL_PREFIX.sub("", candidate)
    if "@" in candidate:
        candidate = candidate.rsplit("@", 1)[-1]
    if not PROXY_LINE.match(candidate):
        return
    ip, port_str = candidate.rsplit(":", 1)
    try:
        port = int(port_str)
    except ValueError:
        return
    if 1 <= port <= 65535 and is_valid_proxy_ip(ip):
        proxies.add(candidate)


def parse_proxies(text: str) -> set[str]:
    proxies: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("{") and line.endswith("}"):
            try:
                data = json.loads(line)
                host = data.get("host") or data.get("ip")
                port = data.get("port")
                if host and port:
                    add_proxy(proxies, f"{host}:{port}")
            except json.JSONDecodeError:
                pass
            continue
        token = line.split()[0]
        if PROXY_LINE.match(token):
            add_proxy(proxies, token)
            continue
        match = PROXY_IN_LINE.search(line)
        if match:
            add_proxy(proxies, match.group(1))
    return proxies


def fetch_source(name: str, url: str) -> FetchResult:
    result = FetchResult(source=name, url=url)
    try:
        result.proxies = parse_proxies(fetch_text(url))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        result.error = str(exc)
    return result


def fetch_geonode(pages: int = 5) -> FetchResult:
    result = FetchResult(
        source="geonode_api",
        url=f"https://proxylist.geonode.com/api/proxy-list?limit=500&page=1..{pages}",
    )
    try:
        for page in range(1, pages + 1):
            url = (
                "https://proxylist.geonode.com/api/proxy-list"
                f"?limit=500&page={page}&sort_by=lastChecked&sort_type=desc"
            )
            payload = json.loads(fetch_text(url))
            for item in payload.get("data", []):
                ip = item.get("ip")
                port = item.get("port")
                if ip and port:
                    add_proxy(result.proxies, f"{ip}:{port}")
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        result.error = str(exc)
    return result


SPECIAL_FETCHERS: dict[str, Callable[[], FetchResult]] = {
    "geonode_api": lambda: fetch_geonode(pages=5),
}


def test_proxy(proxy: str, timeout: float = 5.0) -> tuple[str, bool, str]:
    ip, port_str = proxy.rsplit(":", 1)
    port = int(port_str)
    import socket

    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return proxy, True, "ok"
    except OSError as exc:
        return proxy, False, str(exc)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Coleta proxies de sites públicos (busca profunda)")
    parser.add_argument(
        "--output",
        "-o",
        default="proxies.txt",
        help="Arquivo de saída (ip:port por linha)",
    )
    parser.add_argument(
        "--json",
        default="proxies_report.json",
        help="Relatório JSON com detalhes por fonte",
    )
    parser.add_argument(
        "--test",
        type=int,
        default=0,
        metavar="N",
        help="Testa conectividade dos N primeiros proxies únicos",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=30,
        help="Threads para download e teste",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    total_sources = len(TEXT_SOURCES) + len(SPECIAL_FETCHERS)
    print(f"Busca profunda em {total_sources} fontes públicas...\n")

    results: list[FetchResult] = []
    all_proxies: set[str] = set()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(fetch_source, name, url) for name, url in TEXT_SOURCES.items()
        ]
        futures.extend(pool.submit(fn) for fn in SPECIAL_FETCHERS.values())

        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            if result.error:
                status = f"ERRO: {result.error}"
            elif len(result.proxies) == 0:
                status = "0 proxies (vazio)"
            else:
                status = f"{len(result.proxies)} proxies"
            print(f"  [{result.source}] {status}")

    for result in sorted(results, key=lambda r: r.source):
        all_proxies.update(result.proxies)

    sorted_proxies = sorted(
        all_proxies,
        key=lambda p: tuple(map(int, p.rsplit(":", 1)[0].split("."))),
    )

    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sorted_proxies))
        if sorted_proxies:
            fh.write("\n")

    working: list[str] = []
    if args.test > 0:
        sample = sorted_proxies[: args.test]
        print(f"\nTestando conectividade de {len(sample)} proxies...")
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(test_proxy, proxy) for proxy in sample]
            for future in as_completed(futures):
                proxy, ok, detail = future.result()
                mark = "✓" if ok else "✗"
                print(f"  {mark} {proxy} — {detail}")
                if ok:
                    working.append(proxy)

    ok_sources = [r for r in results if not r.error and r.proxies]
    failed_sources = [r for r in results if r.error or not r.proxies]

    report = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "mode": "deep",
        "sources_total": total_sources,
        "sources_ok": len(ok_sources),
        "sources_failed_or_empty": len(failed_sources),
        "sources": [
            {
                "name": r.source,
                "url": r.url,
                "count": len(r.proxies),
                "error": r.error,
            }
            for r in sorted(results, key=lambda r: r.source)
        ],
        "top_sources": sorted(
            [
                {"name": r.source, "count": len(r.proxies)}
                for r in ok_sources
            ],
            key=lambda x: x["count"],
            reverse=True,
        )[:15],
        "total_unique": len(sorted_proxies),
        "output_file": args.output,
        "tested": args.test,
        "working_from_test": working,
    }

    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    print(f"\nFontes com dados: {len(ok_sources)}/{total_sources}")
    print(f"Total único: {len(sorted_proxies)} proxies")
    print(f"Salvo em: {args.output}")
    print(f"Relatório: {args.json}")

    if args.test > 0:
        print(f"Funcionando no teste: {len(working)}/{min(args.test, len(sorted_proxies))}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
