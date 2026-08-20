#!/usr/bin/env python3
"""
Проверка одного домена по страновым топ-листам CrUX (crux-top-lists-country).

Показывает, в каких ТОП-20 неевропейских стран (без США) домен входит
и в каком бакете популярности (меньше = популярнее).

Ранги в этих списках — бакеты: 1000 / 5000 / 10000 / 50000 / 100000 /
500000 / 1000000 (верхняя граница баечта). «1000» = топ-1000 страны.

Использование:
    python crux_geo_check.py example.ru
    python crux_geo_check.py example.ru another.ru
"""

import argparse, gzip, sys, urllib.request
from datetime import date

# ТОП-20 стран по числу интернет-пользователей, без Европы и США
# (+ ru в конце как референс — наш рынок)
COUNTRIES = [
    "cn", "in", "id", "br", "ng", "jp", "mx", "ph", "vn", "bd",
    "ir", "eg", "tr", "pk", "th", "et", "cd", "kr", "co", "ar",
    "ru",
]

COUNTRY_URL = (
    "https://raw.githubusercontent.com/InternetHealthReport"
    "/crux-top-lists-country/main/data/country/{cc}/{ym}.csv.gz"
)


def norm(s: str) -> str:
    s = s.strip().lower().split("#")[0].strip()
    s = s.removeprefix("https://").removeprefix("http://")
    s = s.removeprefix("www.")
    return s.split("/")[0]


def latest_country(cc: str) -> str | None:
    y, m = date.today().year, date.today().month
    for _ in range(6):
        url = COUNTRY_URL.format(cc=cc, ym=f"{y}{m:02d}")
        try:
            urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=20)
            return url
        except Exception:
            m -= 1
            if m == 0:
                y, m = y - 1, 12
    return None


def scan_country(url: str, targets: set[str]) -> tuple[dict[str, int], int]:
    """Стримит gz, ищет домены. Возвращает ({domain: rank}, total_rows)."""
    found: dict[str, int] = {}
    total = 0
    with urllib.request.urlopen(url, timeout=300) as resp:
        with gzip.GzipFile(fileobj=resp) as gz:
            for line in gz:
                total += 1
                if total == 1:
                    continue  # header
                try:
                    s = line.decode("utf-8", "ignore")
                except Exception:
                    continue
                origin, _, rank = s.partition(",")
                if not rank.strip().isdigit():
                    continue
                d = norm(origin)
                if d in targets:
                    found.setdefault(d, int(rank.strip()))
    return found, max(total - 1, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("domains", nargs="+")
    args = ap.parse_args()
    targets = {norm(d) for d in args.domains}
    print(f"Проверяю: {', '.join(sorted(targets))}\n")

    # предзагружаем доступные URL (HEAD, быстро)
    print("Ищу свежие срезы по странам...")
    urls: dict[str, str] = {}
    for cc in COUNTRIES:
        u = latest_country(cc)
        if u:
            urls[cc] = u
    print(f"Найдено срезов: {len(urls)}/{len(COUNTRIES)}\n")

    header = f"{'страна':<7} " + " ".join(f"{d:<14}" for d in sorted(targets))
    print(header)
    print("-" * len(header))

    foreign_hit = {d: 0 for d in targets}
    for cc in COUNTRIES:
        u = urls.get(cc)
        if not u:
            print(f"{cc.upper():<7} (нет среза)")
            continue
        found, total = scan_country(u, targets)
        cells = []
        for d in sorted(targets):
            if d in found:
                cells.append(f"{found[d]:<14}")
                if cc != "ru":
                    foreign_hit[d] += 1
            else:
                cells.append(f"{'—':<14}")
        print(f"{cc.upper():<7} " + " ".join(cells))

    print("\nИтог (иностранных неевропейских стран, где домен в топе):")
    for d in sorted(targets):
        ru_rank = None
        print(f"  {d}: {foreign_hit[d]} стран(ы) неевропейских (ru в референсе)")


if __name__ == "__main__":
    main()
