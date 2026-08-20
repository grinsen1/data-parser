#!/usr/bin/env python3
"""
Считает, сколько .ru-доменов входит в топы разных стран (crux-top-lists-country).

Для каждой страны: всего строк, .ru всего, .ru по бакетам популярности.
Бакет 1000 = топ-1000 страны, 5000 = 1001–5000 и т.д.

Использование:
    python crux_ru_count.py
"""

import gzip, urllib.request
from collections import Counter
from datetime import date

COUNTRIES = [
    "cn", "in", "id", "br", "ng", "jp", "mx", "ph", "vn", "bd",
    "ir", "eg", "tr", "pk", "th", "et", "cd", "kr", "co", "ar",
    "ru",
]

BUCKETS = [1000, 5000, 10000, 50000, 100000, 500000, 1000000]

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


def scan_country(url: str):
    total = 0
    ru = 0
    by_bucket = Counter()
    with urllib.request.urlopen(url, timeout=300) as resp:
        with gzip.GzipFile(fileobj=resp) as gz:
            for line in gz:
                total += 1
                if total == 1:
                    continue
                try:
                    s = line.decode("utf-8", "ignore")
                except Exception:
                    continue
                origin, _, rank = s.partition(",")
                if not rank.strip().isdigit():
                    continue
                d = norm(origin)
                if d.endswith(".ru"):
                    ru += 1
                    by_bucket[int(rank.strip())] += 1
    return max(total - 1, 0), ru, by_bucket


def main():
    print("Считаю .ru в топах стран...\n")
    # заголовок
    print(f"{'страна':<7} {'всего':>9} {'ru всего':>9} {'ru %':>6} " +
          " ".join(f"b{b:<6}" for b in BUCKETS))
    print("-" * 100)

    for cc in COUNTRIES:
        u = latest_country(cc)
        if not u:
            print(f"{cc.upper():<7} (нет среза)")
            continue
        total, ru, bb = scan_country(u)
        pct = (ru / total * 100) if total else 0
        cells = " ".join(f"{bb.get(b, 0):<6}" for b in BUCKETS)
        print(f"{cc.upper():<7} {total:>9,} {ru:>9,} {pct:>5.2f}% " + cells)


if __name__ == "__main__":
    main()
