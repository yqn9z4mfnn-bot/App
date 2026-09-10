#!/usr/bin/env python3
"""Coleta proxies de centenas de fontes públicas (mapeamento profundo)."""

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
from pathlib import Path
from typing import Callable, Iterable

PROXY_LINE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$")
PROXY_IN_LINE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})\b")
PROTOCOL_PREFIX = re.compile(r"^(?:https?|socks4|socks5)://", re.I)
USER_AGENT = "proxy-scraper/3.0 (+https://github.com/yqn9z4mfnn-bot/App)"

COUNTRIES = [
    "US", "BR", "DE", "FR", "GB", "CN", "IN", "RU", "JP", "KR", "CA", "AU", "NL",
    "IT", "ES", "MX", "AR", "CL", "CO", "PE", "VE", "ID", "TH", "VN", "PH", "MY",
    "SG", "HK", "TW", "PL", "UA", "TR", "EG", "ZA", "NG", "SA", "AE", "IL", "PK",
    "BD", "BE", "CH", "AT", "SE", "NO", "DK", "FI", "IE", "PT", "GR", "CZ", "RO",
    "HU", "BG", "SK", "HR", "RS", "SI", "LT", "LV", "EE", "NZ",
]

HTML_SOURCES: dict[str, str] = {
    "html_free_proxy_list": "https://free-proxy-list.net/",
    "html_sslproxies": "https://www.sslproxies.org/",
    "html_us_proxy": "https://www.us-proxy.org/",
    "html_socks_proxy": "https://www.socks-proxy.net/",
}


@dataclass
class FetchResult:
    source: str
    url: str
    proxies: set[str] = field(default_factory=set)
    error: str | None = None


def fetch_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
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

    stripped = text.strip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
            if isinstance(payload, list):
                for item in payload:
                    if isinstance(item, dict):
                        ip = item.get("ip") or item.get("host")
                        port = item.get("port")
                        if ip and port:
                            add_proxy(proxies, f"{ip}:{port}")
            return proxies
        except json.JSONDecodeError:
            pass

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


def parse_html_proxies(html: str) -> set[str]:
    proxies: set[str] = set()
    textarea = re.search(r"<textarea[^>]*>(.*?)</textarea>", html, re.S | re.I)
    if textarea:
        for line in textarea.group(1).splitlines():
            line = line.strip()
            if line:
                add_proxy(proxies, line.split()[0])
    for ip, port in re.findall(
        r"(\d{1,3}(?:\.\d{1,3}){3})[\s\S]{0,40}?<td>(\d{2,5})</td>", html
    ):
        add_proxy(proxies, f"{ip}:{port}")
    for ip, port in re.findall(r"(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})", html):
        add_proxy(proxies, f"{ip}:{port}")
    return proxies


def load_sources_file(path: Path) -> dict[str, str]:
    sources: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            name, url = line.split("|", 1)
            sources[name.strip()] = url.strip()
    return sources


def build_dynamic_sources() -> dict[str, str]:
    sources: dict[str, str] = {}
    for country in COUNTRIES:
        cc = country.upper()
        cl = country.lower()
        sources[f"iplocate_{cl}"] = (
            f"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/{cc}/proxies.txt"
        )
        sources[f"databay_{cl}"] = (
            f"https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/by-country/{cc}/http.txt"
        )
        sources[f"databay_{cl}_socks5"] = (
            f"https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/by-country/{cc}/socks5.txt"
        )
        sources[f"databay_{cl}_socks4"] = (
            f"https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/by-country/{cc}/socks4.txt"
        )
    return sources


def fetch_source(name: str, url: str) -> FetchResult:
    result = FetchResult(source=name, url=url)
    try:
        result.proxies = parse_proxies(fetch_text(url))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        result.error = str(exc)
    return result


def fetch_html_source(name: str, url: str) -> FetchResult:
    result = FetchResult(source=name, url=url)
    try:
        result.proxies = parse_html_proxies(fetch_text(url))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        result.error = str(exc)
    return result


def fetch_geonode() -> FetchResult:
    result = FetchResult(
        source="geonode_api",
        url="https://proxylist.geonode.com/api/proxy-list?limit=500",
    )
    try:
        first = json.loads(fetch_text(result.url + "&page=1&sort_by=lastChecked&sort_type=desc"))
        total = int(first.get("total", 0))
        pages = max(1, (total + 499) // 500)
        result.url = f"{result.url}&pages=1..{pages}"
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


def fetch_monosans_json() -> FetchResult:
    result = FetchResult(
        source="monosans_json",
        url="https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json",
    )
    try:
        payload = json.loads(fetch_text(result.url))
        for item in payload:
            if isinstance(item, dict):
                host = item.get("host") or item.get("ip")
                port = item.get("port")
                if host and port:
                    add_proxy(result.proxies, f"{host}:{port}")
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        result.error = str(exc)
    return result


def fetch_proxyscrape_json() -> FetchResult:
    result = FetchResult(
        source="proxyscrape_mirror_json",
        url="https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.json",
    )
    try:
        payload = json.loads(fetch_text(result.url))
        for item in payload:
            if isinstance(item, dict):
                ip = item.get("ip")
                port = item.get("port")
                if ip and port:
                    add_proxy(result.proxies, f"{ip}:{port}")
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        result.error = str(exc)
    return result


SPECIAL_FETCHERS: dict[str, Callable[[], FetchResult]] = {
    "geonode_api": fetch_geonode,
    "monosans_json": fetch_monosans_json,
    "proxyscrape_mirror_json": fetch_proxyscrape_json,
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


def collect_all_sources(sources_file: Path) -> dict[str, str]:
    all_sources = load_sources_file(sources_file)
    all_sources.update(build_dynamic_sources())
    all_sources.update(HTML_SOURCES)
    return all_sources


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Mapeamento profundo de proxies em fontes públicas"
    )
    parser.add_argument(
        "--sources",
        default="proxy_sources.txt",
        help="Arquivo manifesto de fontes (nome|url)",
    )
    parser.add_argument("--output", "-o", default="proxies.txt")
    parser.add_argument("--json", default="proxies_report.json")
    parser.add_argument("--map", default="sources_map.json", help="Mapa completo de fontes")
    parser.add_argument("--test", type=int, default=0, metavar="N")
    parser.add_argument("--workers", type=int, default=40)
    args = parser.parse_args(list(argv) if argv is not None else None)

    sources_path = Path(args.sources)
    text_sources = collect_all_sources(sources_path)
    html_names = set(HTML_SOURCES)
    total_sources = len(text_sources) + len(SPECIAL_FETCHERS)

    print(f"Mapeamento profundo: {total_sources} fontes públicas\n")

    results: list[FetchResult] = []
    all_proxies: set[str] = set()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = []
        for name, url in text_sources.items():
            if name in html_names:
                futures.append(pool.submit(fetch_html_source, name, url))
            else:
                futures.append(pool.submit(fetch_source, name, url))
        futures.extend(pool.submit(fn) for fn in SPECIAL_FETCHERS.values())

        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            if result.error:
                status = f"ERRO: {result.error[:70]}"
            elif len(result.proxies) == 0:
                status = "0 proxies (vazio)"
            else:
                status = f"{len(result.proxies)} proxies"
            print(f"  [{result.source}] {status}")

    for result in results:
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
    empty_sources = [r for r in results if not r.error and not r.proxies]
    failed_sources = [r for r in results if r.error]

    report = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "mode": "ultra-deep",
        "sources_total": total_sources,
        "sources_with_data": len(ok_sources),
        "sources_empty": len(empty_sources),
        "sources_failed": len(failed_sources),
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
            [{"name": r.source, "count": len(r.proxies), "url": r.url} for r in ok_sources],
            key=lambda x: x["count"],
            reverse=True,
        )[:25],
        "total_unique": len(sorted_proxies),
        "output_file": args.output,
        "tested": args.test,
        "working_from_test": working,
    }

    sources_map = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_file": str(sources_path),
        "static_sources": len(load_sources_file(sources_path)),
        "dynamic_country_sources": len(build_dynamic_sources()),
        "html_sources": list(HTML_SOURCES.keys()),
        "special_fetchers": list(SPECIAL_FETCHERS.keys()),
        "all_source_urls": {r.source: r.url for r in sorted(results, key=lambda r: r.source)},
    }

    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    with open(args.map, "w", encoding="utf-8") as fh:
        json.dump(sources_map, fh, indent=2, ensure_ascii=False)

    print(f"\nFontes com dados: {len(ok_sources)}/{total_sources}")
    print(f"Fontes vazias: {len(empty_sources)} | Falhas: {len(failed_sources)}")
    print(f"Total único: {len(sorted_proxies)} proxies")
    print(f"Salvo em: {args.output}")
    print(f"Relatório: {args.json}")
    print(f"Mapa de fontes: {args.map}")

    if args.test > 0:
        print(f"Funcionando no teste: {len(working)}/{min(args.test, len(sorted_proxies))}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
