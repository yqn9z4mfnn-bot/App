#!/usr/bin/env python3
"""Testa conectividade TCP de todos os proxies coletados."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


def test_proxy(proxy: str, timeout: float) -> tuple[str, bool]:
    ip, port_str = proxy.rsplit(":", 1)
    try:
        port = int(port_str)
        with socket.create_connection((ip, port), timeout=timeout):
            return proxy, True
    except OSError:
        return proxy, False


def load_proxies(path: Path) -> list[str]:
    proxies: list[str] = []
    seen: set[str] = set()
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and line not in seen:
            seen.add(line)
            proxies.append(line)
    return proxies


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Testa todos os proxies de um arquivo")
    parser.add_argument("--input", "-i", default="proxies.txt")
    parser.add_argument("--output", "-o", default="proxies_working.txt")
    parser.add_argument("--report", default="test_report.json")
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--workers", type=int, default=400)
    parser.add_argument("--save-every", type=int, default=2000, help="Salva progresso a cada N testados")
    args = parser.parse_args(list(argv) if argv is not None else None)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Arquivo não encontrado: {input_path}", file=sys.stderr)
        return 1

    proxies = load_proxies(input_path)
    total = len(proxies)
    working: list[str] = []
    tested = 0
    started = time.time()

    print(f"Testando {total} proxies ({args.workers} threads, timeout {args.timeout}s)...\n")

    output_path = Path(args.output)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(test_proxy, proxy, args.timeout): proxy for proxy in proxies}

        for future in as_completed(futures):
            proxy, ok = future.result()
            tested += 1
            if ok:
                working.append(proxy)

            if tested % 500 == 0 or tested == total:
                elapsed = time.time() - started
                rate = tested / elapsed if elapsed else 0
                pct = tested * 100 / total
                eta = (total - tested) / rate if rate else 0
                print(
                    f"  [{tested}/{total}] {pct:.1f}% | "
                    f"ok: {len(working)} ({len(working)*100/max(tested,1):.1f}%) | "
                    f"{rate:.0f}/s | ETA {eta/60:.1f}min",
                    flush=True,
                )

            if tested % args.save_every == 0:
                output_path.write_text("\n".join(sorted(working)) + ("\n" if working else ""), encoding="utf-8")

    working_sorted = sorted(working, key=lambda p: tuple(map(int, p.rsplit(":", 1)[0].split("."))))
    output_path.write_text(
        "\n".join(working_sorted) + ("\n" if working_sorted else ""),
        encoding="utf-8",
    )

    elapsed = time.time() - started
    report = {
        "tested_at": datetime.now(timezone.utc).isoformat(),
        "input_file": str(input_path),
        "output_file": str(output_path),
        "total_tested": total,
        "working": len(working_sorted),
        "failed": total - len(working_sorted),
        "success_rate_pct": round(len(working_sorted) * 100 / max(total, 1), 2),
        "elapsed_seconds": round(elapsed, 1),
        "workers": args.workers,
        "timeout_seconds": args.timeout,
        "rate_per_second": round(total / elapsed, 1) if elapsed else 0,
    }

    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\nConcluído em {elapsed/60:.1f} min")
    print(f"Funcionando: {len(working_sorted)}/{total} ({report['success_rate_pct']}%)")
    print(f"Salvo em: {output_path}")
    print(f"Relatório: {args.report}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
