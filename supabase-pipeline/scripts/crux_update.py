#!/usr/bin/env python3
"""
CrUX rank updater — загружает списки из crux-top-lists (GitHub)
и пишет в Supabase (таблица crux_ranks).

Бесплатно, без API-ключей, раз в месяц.

Использование:
    python crux_update.py                     # обновить (global + ru)
    python crux_update.py --country us        # другая страна
    python crux_update.py --supabase-url ... --supabase-key ...
"""

import argparse, csv, gzip, io, sys, urllib.request
from datetime import date
from pathlib import Path

GLOBAL_URL = (
    "https://raw.githubusercontent.com/zakird/crux-top-lists"
    "/main/data/global/current.csv.gz"
)
COUNTRY_URL = (
    "https://raw.githubusercontent.com/InternetHealthReport"
    "/crux-top-lists-country/main/data/country/{cc}/{ym}.csv.gz"
)


def norm(s: str) -> str:
    """origin → голый домен"""
    s = s.strip().lower().split("#")[0].strip()
    s = s.removeprefix("https://").removeprefix("http://")
    s = s.removeprefix("www.")
    return s.split("/")[0]


def fetch_csv_gz(url: str) -> csv.reader:
    """Качает .csv.gz и возвращает reader"""
    with urllib.request.urlopen(url, timeout=120) as r:
        raw = gzip.decompress(r.read())
    return csv.reader(io.StringIO(raw.decode()))


def load_scope(url: str) -> list[tuple[str, int]]:
    """Загружает один scope (global или страну), возвращает [(domain, rank)]"""
    print(f"  [+] {url.rsplit('/', 1)[-1]}")
    reader = fetch_csv_gz(url)
    next(reader, None)  # skip header
    seen: dict[str, int] = {}
    for origin, rank in reader:
        d = norm(origin)
        rk = int(rank)
        if d not in seen or rk < seen[d]:
            seen[d] = rk
    result = [(d, rk) for d, rk in seen.items()]
    print(f"      {len(result):,} доменов")
    return result


def latest_country(cc: str) -> str | None:
    """Пробует последние 4 месяца, берёт первый доступный срез"""
    y, m = date.today().year, date.today().month
    for _ in range(4):
        url = COUNTRY_URL.format(cc=cc, ym=f"{y}{m:02d}")
        try:
            req = urllib.request.Request(url, method="HEAD")
            urllib.request.urlopen(req, timeout=30)
            return url
        except Exception:
            m -= 1
            if m == 0:
                y, m = y - 1, 12
    return None


def output_csv(scope: str, rows: list[tuple[str, int]], out: str):
    """Пишет CSV для ручной загрузки в Supabase"""
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["domain", "scope", "rank"])
        for domain, rank in rows:
            writer.writerow([domain, scope, rank])
    print(f"  CSV: {path} ({len(rows)} rows)")


def upload_supabase(scope: str, rows: list[tuple[str, int]], url: str, key: str):
    """Загружает данные напрямую в Supabase REST API"""
    import json

    BATCH = 500
    total = len(rows)

    for i in range(0, total, BATCH):
        batch = rows[i : i + BATCH]
        body = json.dumps([
            {"domain": d, "scope": scope, "rank": r} for d, r in batch
        ])

        req = urllib.request.Request(
            f"{url}/rest/v1/crux_ranks",
            data=body.encode(),
            headers={
                "Content-Type": "application/json",
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Prefer": "resolution=merge-duplicates",
            },
            method="POST",
        )

        try:
            urllib.request.urlopen(req, timeout=30)
            print(f"  [{scope}] {min(i + BATCH, total):,}/{total:,}")
        except Exception as e:
            print(f"  [{scope}] batch {i} error: {e}")


def main():
    ap = argparse.ArgumentParser(description="CrUX rank updater")
    ap.add_argument("--country", default="ru", help="код страны (по умолчанию ru)")
    ap.add_argument("--supabase-url", help="Supabase URL")
    ap.add_argument("--supabase-key", help="Supabase service_role key")
    ap.add_argument("--csv-dir", default="data", help="папка для CSV-файлов (если без Supabase)")
    args = ap.parse_args()

    print("=" * 50)
    print("CrUX Rank Updater")
    print("=" * 50)

    # 1. Global
    print("\n[1] Global")
    global_rows = load_scope(GLOBAL_URL)

    # 2. Country
    print(f"\n[2] {args.country.upper()}")
    country_url = latest_country(args.country)
    if country_url:
        country_rows = load_scope(country_url)
    else:
        print(f"  [!] Срез {args.country.upper()} не найден, пропускаю")
        country_rows = []

    # 3. Output
    if args.supabase_url and args.supabase_key:
        print("\n[3] Upload to Supabase")
        upload_supabase("global", global_rows, args.supabase_url, args.supabase_key)
        if country_rows:
            upload_supabase(args.country, country_rows, args.supabase_url, args.supabase_key)
    else:
        print("\n[3] Save to CSV")
        output_csv("global", global_rows, f"{args.csv_dir}/crux_global.csv")
        if country_rows:
            output_csv(args.country, country_rows, f"{args.csv_dir}/crux_{args.country}.csv")

    print(f"\nГотово: global={len(global_rows):,}, {args.country}={len(country_rows):,}")


if __name__ == "__main__":
    main()
