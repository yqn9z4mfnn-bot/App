#!/usr/bin/env python3
"""Exporta proxies verificados (tráfego web OK) em arquivos separados."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def export(verified_json: Path = Path("proxies_verified/verified.json"), out_dir: Path = Path("proxies_web")) -> dict:
    data = json.loads(verified_json.read_text(encoding="utf-8"))
    out_dir.mkdir(exist_ok=True)

    by_proto: dict[str, list[str]] = {"http": [], "socks5": [], "socks4": []}
    sorted_rows = sorted(data, key=lambda r: r["latency_ms"])

    for row in sorted_rows:
        proxy = row["proxy"]
        proto = row.get("protocol") or "http"
        if proto in by_proto:
            by_proto[proto].append(proxy)

    (out_dir / "all.txt").write_text(
        "\n".join(r["proxy"] for r in sorted_rows) + "\n",
        encoding="utf-8",
    )
    (out_dir / "all_detalhado.txt").write_text(
        "\n".join(
            f"{r['proxy']}\t{r['latency_ms']}ms\t{r.get('country_code', 'XX')}\t"
            f"{r.get('protocol', '')}\t{r.get('city', '')}"
            for r in sorted_rows
        )
        + "\n",
        encoding="utf-8",
    )

    for proto, lines in by_proto.items():
        (out_dir / f"{proto}.txt").write_text(
            "\n".join(lines) + ("\n" if lines else ""),
            encoding="utf-8",
        )

    verified_dir = verified_json.parent
    country_src = verified_dir / "by_country"
    if country_src.exists():
        country_dest = out_dir / "by_country"
        if country_dest.exists():
            shutil.rmtree(country_dest)
        shutil.copytree(country_src, country_dest)

    for tier in verified_dir.glob("speed_*.txt"):
        shutil.copy(tier, out_dir / tier.name)

    summary = {
        "total": len(sorted_rows),
        "http": len(by_proto["http"]),
        "socks5": len(by_proto["socks5"]),
        "socks4": len(by_proto["socks4"]),
        "output_dir": str(out_dir),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


if __name__ == "__main__":
    if not Path("proxies_verified/verified.json").exists():
        print("Execute verify_proxies.py antes.", file=sys.stderr)
        sys.exit(1)
    result = export()
    print(json.dumps(result, indent=2))
