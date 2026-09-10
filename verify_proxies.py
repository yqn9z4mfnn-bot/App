#!/usr/bin/env python3
"""Verifica proxies via HTTP/SOCKS, mede latência e agrupa por país."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

try:
    import socks  # PySocks
except ImportError:
    socks = None

TEST_URL = "http://httpbin.org/ip"
GEO_BATCH_URL = "http://ip-api.com/batch?fields=status,country,countryCode,query,isp,city"
USER_AGENT = "proxy-verify/1.0"
SOCKS_PORTS = {
    1080, 1081, 4145, 4153, 5678, 7777, 9050, 9051, 9898, 10000, 10001,
    10808, 11368, 12344, 18181, 23969, 45672, 51327, 55636, 63079,
}


def load_proxies(path: Path) -> list[str]:
    seen: set[str] = set()
    proxies: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and line not in seen:
            seen.add(line)
            proxies.append(line)
    return proxies


def try_http_proxy(proxy: str, timeout: float) -> tuple[bool, float, str | None]:
    proxy_url = f"http://{proxy}"
    handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    opener = urllib.request.build_opener(handler)
    opener.addheaders = [("User-Agent", USER_AGENT)]
    start = time.perf_counter()
    try:
        with opener.open(TEST_URL, timeout=timeout) as resp:
            if resp.status != 200:
                return False, 0.0, f"http_status_{resp.status}"
            resp.read(512)
        latency_ms = (time.perf_counter() - start) * 1000
        return True, latency_ms, "http"
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return False, 0.0, str(exc)[:120]


def try_socks_proxy(proxy: str, timeout: float, kind: int) -> tuple[bool, float, str | None]:
    if socks is None:
        return False, 0.0, "no_pysocks"
    ip, port_str = proxy.rsplit(":", 1)
    port = int(port_str)
    label = "socks5" if kind == socks.SOCKS5 else "socks4"
    start = time.perf_counter()
    sock = socks.socksocket()
    try:
        sock.set_proxy(kind, ip, port)
        sock.settimeout(timeout)
        sock.connect(("httpbin.org", 80))
        request = (
            f"GET /ip HTTP/1.1\r\nHost: httpbin.org\r\n"
            f"User-Agent: {USER_AGENT}\r\nConnection: close\r\n\r\n"
        )
        sock.sendall(request.encode())
        data = sock.recv(512)
        if b"HTTP/" not in data:
            return False, 0.0, "bad_socks_response"
        latency_ms = (time.perf_counter() - start) * 1000
        return True, latency_ms, label
    except OSError as exc:
        return False, 0.0, str(exc)[:120]
    finally:
        try:
            sock.close()
        except OSError:
            pass


def verify_proxy(proxy: str, timeout: float) -> dict:
    port = int(proxy.rsplit(":", 1)[1])
    ok = False
    latency_ms = 0.0
    protocol: str | None = None

    if port in SOCKS_PORTS and socks is not None:
        ok, latency_ms, protocol = try_socks_proxy(proxy, timeout, socks.SOCKS5)
        if not ok:
            ok, latency_ms, protocol = try_socks_proxy(proxy, timeout, socks.SOCKS4)
        if not ok:
            ok, latency_ms, protocol = try_http_proxy(proxy, timeout)
    else:
        ok, latency_ms, protocol = try_http_proxy(proxy, timeout)
        if not ok and socks is not None:
            ok, latency_ms, protocol = try_socks_proxy(proxy, timeout, socks.SOCKS5)

    return {
        "proxy": proxy,
        "ip": proxy.rsplit(":", 1)[0],
        "working": ok,
        "latency_ms": round(latency_ms, 1) if ok else None,
        "protocol": protocol if ok else None,
    }


def fetch_geo_batch(ips: list[str]) -> dict[str, dict]:
    payload = json.dumps(ips).encode("utf-8")
    req = urllib.request.Request(
        GEO_BATCH_URL,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    result: dict[str, dict] = {}
    for row in rows:
        if row.get("status") == "success":
            ip = row.get("query")
            if ip:
                result[ip] = {
                    "country": row.get("country", "Unknown"),
                    "country_code": row.get("countryCode", "XX"),
                    "city": row.get("city", ""),
                    "isp": row.get("isp", ""),
                }
    return result


def geolocate_ips(ips: list[str], batch_size: int = 100, pause: float = 4.2) -> dict[str, dict]:
    unique = sorted(set(ips))
    geo: dict[str, dict] = {}
    total_batches = (len(unique) + batch_size - 1) // batch_size
    for idx in range(0, len(unique), batch_size):
        batch = unique[idx : idx + batch_size]
        batch_num = idx // batch_size + 1
        print(f"  Geo [{batch_num}/{total_batches}] {len(batch)} IPs...", flush=True)
        try:
            geo.update(fetch_geo_batch(batch))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            print(f"    aviso: lote falhou ({exc}), tentando novamente...", flush=True)
            time.sleep(pause * 2)
            try:
                geo.update(fetch_geo_batch(batch))
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
                print(f"    lote ignorado", flush=True)
        if idx + batch_size < len(unique):
            time.sleep(pause)
    return geo


def write_outputs(results: list[dict], out_dir: Path) -> dict:
    working = [r for r in results if r["working"]]
    working.sort(key=lambda r: r["latency_ms"])

    by_country_dir = out_dir / "by_country"
    by_country_dir.mkdir(parents=True, exist_ok=True)

    country_groups: dict[str, list[dict]] = {}
    for row in working:
        cc = row.get("country_code") or "XX"
        country_groups.setdefault(cc, []).append(row)

    country_summary = []
    for cc in sorted(country_groups, key=lambda c: (-len(country_groups[c]), c)):
        rows = sorted(country_groups[cc], key=lambda r: r["latency_ms"])
        country_name = rows[0].get("country") or cc
        path = by_country_dir / f"{cc}.txt"
        lines = [
            f"{r['proxy']}\t{r['latency_ms']}ms\t{r['protocol']}\t{r.get('city','')}"
            for r in rows
        ]
        path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        country_summary.append(
            {
                "country_code": cc,
                "country": country_name,
                "count": len(rows),
                "fastest_ms": rows[0]["latency_ms"],
                "median_ms": rows[len(rows) // 2]["latency_ms"],
                "file": str(path),
            }
        )

    speed_tiers = {
        "ultra_fast_under_500ms": [r for r in working if r["latency_ms"] < 500],
        "fast_500_1500ms": [r for r in working if 500 <= r["latency_ms"] < 1500],
        "medium_1500_3000ms": [r for r in working if 1500 <= r["latency_ms"] < 3000],
        "slow_over_3000ms": [r for r in working if r["latency_ms"] >= 3000],
    }

    (out_dir / "all_by_speed.txt").write_text(
        "\n".join(
            f"{r['proxy']}\t{r['latency_ms']}ms\t{r.get('country_code','XX')}\t{r['protocol']}"
            for r in working
        )
        + ("\n" if working else ""),
        encoding="utf-8",
    )

    for tier, rows in speed_tiers.items():
        tier_path = out_dir / f"speed_{tier}.txt"
        tier_path.write_text(
            "\n".join(f"{r['proxy']}\t{r['latency_ms']}ms\t{r.get('country_code','XX')}" for r in rows)
            + ("\n" if rows else ""),
            encoding="utf-8",
        )

    summary = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "total_tested": len(results),
        "working": len(working),
        "failed": len(results) - len(working),
        "success_rate_pct": round(len(working) * 100 / max(len(results), 1), 2),
        "protocols": {},
        "speed_tiers": {k: len(v) for k, v in speed_tiers.items()},
        "countries": len(country_summary),
        "country_summary": country_summary,
        "top_20_fastest": working[:20],
    }

    for row in working:
        proto = row.get("protocol") or "unknown"
        summary["protocols"][proto] = summary["protocols"].get(proto, 0) + 1

    (out_dir / "verified.json").write_text(
        json.dumps(working, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (out_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return summary


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verifica HTTP/SOCKS, latência e país")
    parser.add_argument("--input", "-i", default="proxies_working.txt")
    parser.add_argument("--output-dir", "-d", default="proxies_verified")
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--workers", type=int, default=250)
    parser.add_argument("--save-every", type=int, default=500)
    args = parser.parse_args(list(argv) if argv is not None else None)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Arquivo não encontrado: {input_path}", file=sys.stderr)
        return 1

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    proxies = load_proxies(input_path)
    total = len(proxies)
    results: list[dict] = []
    started = time.time()

    print(f"Verificando {total} proxies (HTTP + SOCKS, {args.workers} threads)...\n")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(verify_proxy, proxy, args.timeout): proxy for proxy in proxies}
        done = 0
        working_count = 0

        for future in as_completed(futures):
            row = future.result()
            results.append(row)
            done += 1
            if row["working"]:
                working_count += 1

            if done % 500 == 0 or done == total:
                elapsed = time.time() - started
                rate = done / elapsed if elapsed else 0
                eta = (total - done) / rate if rate else 0
                print(
                    f"  [{done}/{total}] {done*100/total:.1f}% | "
                    f"ok: {working_count} | {rate:.1f}/s | ETA {eta/60:.1f}min",
                    flush=True,
                )

            if done % args.save_every == 0:
                partial = [r for r in results if r["working"]]
                (out_dir / "partial.json").write_text(
                    json.dumps(partial, indent=2), encoding="utf-8"
                )

    print(f"\nGeolocalizando {working_count} proxies funcionais...")
    working_ips = [r["ip"] for r in results if r["working"]]
    geo = geolocate_ips(working_ips)

    for row in results:
        if row["working"]:
            info = geo.get(row["ip"], {})
            row["country"] = info.get("country", "Unknown")
            row["country_code"] = info.get("country_code", "XX")
            row["city"] = info.get("city", "")
            row["isp"] = info.get("isp", "")

    summary = write_outputs(results, out_dir)
    elapsed = time.time() - started

    print(f"\nConcluído em {elapsed/60:.1f} min")
    print(f"Funcionam de verdade: {summary['working']}/{summary['total_tested']} ({summary['success_rate_pct']}%)")
    print(f"Países: {summary['countries']}")
    print(f"Protocolos: {summary['protocols']}")
    print(f"Velocidade: {summary['speed_tiers']}")
    print(f"Pasta: {out_dir}/")
    print(f"  all_by_speed.txt — todos ordenados por latência")
    print(f"  by_country/XX.txt — por país, do mais rápido ao mais lento")
    print(f"  speed_*.txt — faixas de velocidade")

    if summary.get("country_summary"):
        print("\nTop 10 países:")
        for c in summary["country_summary"][:10]:
            print(
                f"  {c['country_code']} ({c['country']}): {c['count']} proxies, "
                f"mais rápido {c['fastest_ms']}ms, mediana {c['median_ms']}ms"
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
