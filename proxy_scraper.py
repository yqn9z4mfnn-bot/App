#!/usr/bin/env python3
"""Coleta proxies de fontes públicas conhecidas."""

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
from typing import Iterable

PROXY_LINE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$")

SOURCES: dict[str, str] = {
    "hproxy": "https://hproxy.com/api/proxy-list?format=txt&limit=500",
    "proxyscrape_http": (
        "https://api.proxyscrape.com/v2/?request=displayproxies"
        "&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all"
    ),
    "proxyscrape_socks5": (
        "https://api.proxyscrape.com/v2/?request=displayproxies"
        "&protocol=socks5&timeout=10000&country=all"
    ),
    "vpslab_http": (
        "https://raw.githubusercontent.com/vpslabcloud/vpslab-free-proxy-list/main/http_all.txt"
    ),
    "vpslab_socks5": (
        "https://raw.githubusercontent.com/vpslabcloud/vpslab-free-proxy-list/main/socks5_all.txt"
    ),
    "thespeedx_http": (
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt"
    ),
    "thespeedx_socks5": (
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt"
    ),
    "monosans_http": (
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt"
    ),
    "monosans_socks5": (
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt"
    ),
}


@dataclass
class FetchResult:
    source: str
    url: str
    proxies: set[str] = field(default_factory=set)
    error: str | None = None


def fetch_text(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "proxy-scraper/1.0 (+https://github.com/yqn9z4mfnn-bot/App)"},
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


def parse_proxies(text: str) -> set[str]:
    proxies: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.split()[0]
        if not PROXY_LINE.match(line):
            continue
        ip, port_str = line.rsplit(":", 1)
        port = int(port_str)
        if 1 <= port <= 65535 and is_valid_proxy_ip(ip):
            proxies.add(line)
    return proxies


def fetch_source(name: str, url: str) -> FetchResult:
    result = FetchResult(source=name, url=url)
    try:
        result.proxies = parse_proxies(fetch_text(url))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        result.error = str(exc)
    return result


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
    parser = argparse.ArgumentParser(description="Coleta proxies de sites públicos")
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
        default=20,
        help="Threads para teste de conectividade",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    print(f"Buscando proxies em {len(SOURCES)} fontes públicas...\n")

    results: list[FetchResult] = []
    all_proxies: set[str] = set()

    with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
        futures = {
            pool.submit(fetch_source, name, url): name for name, url in SOURCES.items()
        }
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            status = f"{len(result.proxies)} proxies" if not result.error else f"ERRO: {result.error}"
            print(f"  [{result.source}] {status}")

    for result in sorted(results, key=lambda r: r.source):
        all_proxies.update(result.proxies)

    sorted_proxies = sorted(all_proxies, key=lambda p: tuple(map(int, p.rsplit(":", 1)[0].split("."))))

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

    report = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "sources": [
            {
                "name": r.source,
                "url": r.url,
                "count": len(r.proxies),
                "error": r.error,
            }
            for r in sorted(results, key=lambda r: r.source)
        ],
        "total_unique": len(sorted_proxies),
        "output_file": args.output,
        "tested": args.test,
        "working_from_test": working,
    }

    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    print(f"\nTotal único: {len(sorted_proxies)} proxies")
    print(f"Salvo em: {args.output}")
    print(f"Relatório: {args.json}")

    if args.test > 0:
        print(f"Funcionando no teste: {len(working)}/{min(args.test, len(sorted_proxies))}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
