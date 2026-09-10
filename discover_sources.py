#!/usr/bin/env python3
"""Descobre e gera manifesto extremo de fontes públicas de proxies."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

USER_AGENT = "proxy-discover/1.0"
PROXY_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b")

ISO_COUNTRIES = [
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
    "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
    "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
    "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
    "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
    "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
    "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
    "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
    "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
    "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
    "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
    "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
    "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
    "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
    "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
    "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
]

THORDATA_SOURCES = "https://raw.githubusercontent.com/Thordata/awesome-free-proxy-list/main/scripts/sources.txt"

GITHUB_REPOS = [
    "hproxy-com/free-proxy-list",
    "xyzs996/free-proxy-health-list",
    "komutan234/Proxy-List-Free",
    "Moleway/Free-Proxy-List",
    "proxmint/free-proxy-list",
    "6yyn/free-proxy-list",
    "relayglass/free-proxy-list",
    "proxy-free/free-proxy-list",
    "gfpcom/free-proxy-list",
    "nikita29a/FreeProxyList",
    "watchttvv/free-proxy-list",
    "joy-deploy/free-proxy-list",
    "NikolaiT/free-proxy-list",
    "gproxynet/free-proxy-list",
]

GITHUB_PATHS = [
    "all.txt", "http.txt", "https.txt", "socks4.txt", "socks5.txt",
    "proxies.txt", "proxy.txt", "list.txt", "data.txt",
    "proxies/all.txt", "proxies/http.txt", "proxies/https.txt",
    "proxies/socks4.txt", "proxies/socks5.txt",
    "proxies/all/data.txt", "proxies/protocols/http/data.txt",
    "proxies/protocols/https/data.txt", "proxies/protocols/socks4/data.txt",
    "proxies/protocols/socks5/data.txt",
    "proxy_files/http_proxies.txt", "proxy_files/socks5_proxies.txt",
    "online-proxies/txt/proxies.txt", "online-proxies/txt/proxies-http.txt",
    "online-proxies/txt/proxies-socks5.txt", "all-proxies.txt",
    "protocols/http.txt", "protocols/socks5.txt",
]

HTML_SITES = {
    "html_free_proxy_list": "https://free-proxy-list.net/",
    "html_sslproxies": "https://www.sslproxies.org/",
    "html_us_proxy": "https://www.us-proxy.org/",
    "html_socks_proxy": "https://www.socks-proxy.net/",
}

EXTREME_STATIC = {
    "hproxy_10k": "https://hproxy.com/api/proxy-list?format=txt&limit=10000",
    "hproxy_5k": "https://hproxy.com/api/proxy-list?format=txt&limit=5000",
    "hproxy_elite": "https://hproxy.com/api/proxy-list?format=txt&anonymity=elite&limit=5000",
    "hproxy_anonymous": "https://hproxy.com/api/proxy-list?format=txt&anonymity=anonymous&limit=5000",
    "hproxy_transparent": "https://hproxy.com/api/proxy-list?format=txt&anonymity=transparent&limit=5000",
    "openproxy_https": "https://api.openproxylist.xyz/https.txt",
    "shiftytr_mixed": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/proxy.txt",
    "proxyfree_all": "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/all.txt",
    "proxyfree_http": "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/http.txt",
    "proxyfree_socks5": "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks5.txt",
    "proxyfree_socks4": "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks4.txt",
    "proxifly_cdn_all": "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt",
    "proxifly_cdn_http": "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt",
    "proxifly_cdn_https": "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt",
    "proxifly_cdn_socks4": "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt",
    "proxifly_cdn_socks5": "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt",
    "proxyscrape_v4_elite": "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&anonymity=elite&proxy_format=ipport&format=text",
    "proxyscrape_v4_anonymous": "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&anonymity=anonymous&proxy_format=ipport&format=text",
    "proxyscrape_v4_transparent": "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&anonymity=transparent&proxy_format=ipport&format=text",
    "proxyscrape_elite_v2": "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&anonymity=elite",
    "proxyscrape_anonymous_v2": "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&anonymity=anonymous",
    "hproxy_com_all": "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/all.txt",
    "hproxy_com_http": "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt",
    "hproxy_com_https": "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt",
    "hproxy_com_socks4": "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks4.txt",
    "hproxy_com_socks5": "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt",
    "xyz_health_all": "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/all.txt",
    "xyz_health_http": "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/http.txt",
    "xyz_health_https": "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/https.txt",
    "xyz_health_socks4": "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/socks4.txt",
    "xyz_health_socks5": "https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/socks5.txt",
    "komutan_http": "https://raw.githubusercontent.com/komutan234/Proxy-List-Free/main/proxies/http.txt",
    "komutan_socks5": "https://raw.githubusercontent.com/komutan234/Proxy-List-Free/main/proxies/socks5.txt",
    "moleway_all": "https://raw.githubusercontent.com/Moleway/Free-Proxy-List/main/all.txt",
    "moleway_http": "https://raw.githubusercontent.com/Moleway/Free-Proxy-List/main/http.txt",
    "proxmint_all": "https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/all.txt",
    "proxmint_http": "https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/http.txt",
    "6yyn_http": "https://raw.githubusercontent.com/6yyn/free-proxy-list/main/http.txt",
    "relayglass_all": "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/all.txt",
}


def fetch_text(url: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def load_manifest(path: Path) -> dict[str, str]:
    sources: dict[str, str] = {}
    if not path.exists():
        return sources
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            name, url = line.split("|", 1)
            sources[name.strip()] = url.strip()
    return sources


def load_thordata_sources() -> dict[str, str]:
    sources: dict[str, str] = {}
    try:
        text = fetch_text(THORDATA_SOURCES)
    except (urllib.error.URLError, TimeoutError, OSError):
        return sources
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        url = line.split()[0]
        if url.startswith("http"):
            slug = re.sub(r"[^a-zA-Z0-9]+", "_", url.split("/")[-1].replace(".txt", ""))[:40]
            sources[f"thordata_src_{slug}"] = url
    return sources


def github_search_repos(pages: int = 3) -> list[str]:
    repos: list[str] = []
    for page in range(1, pages + 1):
        url = (
            "https://api.github.com/search/repositories"
            f"?q=free+proxy+list+in:name&sort=updated&per_page=30&page={page}"
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
            payload = json.loads(fetch_text(url))
            for item in payload.get("items", []):
                full_name = item.get("full_name")
                if full_name:
                    repos.append(full_name)
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            break
    return repos


def probe_github_path(repo: str, branch: str, path: str) -> tuple[str, str, int] | None:
    url = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
    try:
        text = fetch_text(url, timeout=10)
        count = len(PROXY_RE.findall(text))
        if count > 0:
            safe = re.sub(r"[^a-zA-Z0-9_]+", "_", f"gh_{repo}_{path}")[:80]
            return safe, url, count
    except (urllib.error.URLError, TimeoutError, OSError):
        pass
    return None


def discover_github_sources(repos: list[str], workers: int = 40) -> dict[str, str]:
    sources: dict[str, str] = {}
    jobs: list[tuple[str, str, str]] = []
    for repo in repos:
        for path in GITHUB_PATHS:
            jobs.append((repo, "main", path))
            jobs.append((repo, "master", path))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(probe_github_path, *job) for job in jobs]
        for future in as_completed(futures):
            result = future.result()
            if result:
                name, url, _count = result
                if name not in sources:
                    sources[name] = url
    return sources


def build_country_sources() -> dict[str, str]:
    sources: dict[str, str] = {}
    for cc in ISO_COUNTRIES:
        cl = cc.lower()
        sources[f"hproxy_{cl}"] = f"https://hproxy.com/api/proxy-list?format=txt&country={cl}&limit=500"
        sources[f"proxyscrape_http_{cl}"] = (
            f"https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&country={cc}&timeout=10000"
        )
        sources[f"proxyscrape_socks5_{cl}"] = (
            f"https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&country={cc}&timeout=10000"
        )
        sources[f"iplocate_{cl}"] = (
            f"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/{cc}/proxies.txt"
        )
        sources[f"databay_{cl}"] = (
            f"https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/by-country/{cc}/http.txt"
        )
        sources[f"databay_{cl}_socks5"] = (
            f"https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/by-country/{cc}/socks5.txt"
        )
    return sources


def build_extreme_manifest(base: Path | None = None, discover_github: bool = True) -> dict[str, str]:
    all_sources: dict[str, str] = {}
    if base and base.exists():
        all_sources.update(load_manifest(base))
    all_sources.update(EXTREME_STATIC)
    all_sources.update(load_thordata_sources())
    all_sources.update(build_country_sources())
    all_sources.update(HTML_SITES)

    if discover_github:
        repos = list(dict.fromkeys(GITHUB_REPOS + github_search_repos(pages=3)))
        all_sources.update(discover_github_sources(repos))

    return all_sources


def write_manifest(sources: dict[str, str], output: Path) -> None:
    lines = [
        "# Manifesto extremo — gerado automaticamente por discover_sources.py",
        f"# Total de fontes: {len(sources)}",
        "",
    ]
    for name in sorted(sources):
        lines.append(f"{name}|{sources[name]}")
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gera manifesto extremo de fontes de proxies")
    parser.add_argument("--base", default="proxy_sources.txt")
    parser.add_argument("--output", default="proxy_sources_extreme.txt")
    parser.add_argument("--no-github-discover", action="store_true")
    parser.add_argument("--workers", type=int, default=40)
    args = parser.parse_args(argv)

    print("Descobrindo fontes extremas...")
    sources = build_extreme_manifest(
        Path(args.base),
        discover_github=not args.no_github_discover,
    )
    write_manifest(sources, Path(args.output))
    print(f"Gerado: {args.output} ({len(sources)} fontes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
