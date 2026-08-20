#!/usr/bin/env python3
"""
Выкачивает страновые топы CrUX (crux-top-lists-country), отбирает только
.ru-домены в «иностранном хвосте» (без СНГ, Европы, US/CA/AU/NZ, Турции).

Результат: (domain, country, bucket) — домен, страна, бакет популярности.
Список стран кэшируется в .countries_cache.json (GitHub API лимит 60/час).

Использование:
    python crux_foreign_fetch.py                     # CSV в data/foreign_presence.csv
    python crux_foreign_fetch.py --limit 10          # тест на 10 странах
    python crux_foreign_fetch.py --supabase-url ... --supabase-key ...
"""

import argparse, csv, gzip, json, sys, urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

# Исключаем: СНГ + ближнее зарубежье + Европа + US/CA/AU/NZ + Турция
EXCLUDE = {
    # СНГ + ближнее зарубежье
    "am", "az", "by", "ge", "kz", "kg", "md", "ru", "tj", "tm", "uz", "ua",
    # ЕС-27
    "at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr",
    "hu", "ie", "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk",
    "si", "es", "se",
    # EFTA + UK
    "is", "li", "no", "ch", "gb",
    # Балканы (не ЕС)
    "al", "ba", "me", "mk", "rs",
    # Микрогосударства
    "ad", "mc", "sm", "va",
    # Развитые западные
    "us", "ca", "au", "nz",
    # Турция (не ботнет-источник, диаспора/туризм)
    "tr",
    # Русскоязычная диаспора/экспаты (не ботнет)
    "il", "ae",
}

COUNTRY_URL = (
    "https://raw.githubusercontent.com/InternetHealthReport"
    "/crux-top-lists-country/main/data/country/{cc}/{ym}.csv.gz"
)
API_URL = (
    "https://api.github.com/repos/InternetHealthReport"
    "/crux-top-lists-country/contents/data/country"
)
CACHE = Path(__file__).parent / ".countries_cache.json"


def norm(s: str) -> str:
    s = s.strip().lower().split("#")[0].strip()
    s = s.removeprefix("https://").removeprefix("http://")
    s = s.removeprefix("www.")
    return s.split("/")[0]


def list_countries() -> list[str]:
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    req = urllib.request.Request(API_URL, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode())
    codes = sorted(x["name"] for x in data if x["type"] == "dir")
    CACHE.write_text(json.dumps(codes), encoding="utf-8")
    return codes


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


def scan_ru(url: str) -> dict[str, int]:
    """Возвращает {domain: min_bucket} для .ru-доменов в одном срезе."""
    out: dict[str, int] = {}
    with urllib.request.urlopen(url, timeout=300) as resp:
        with gzip.GzipFile(fileobj=resp) as gz:
            for i, line in enumerate(gz):
                if i == 0:
                    continue  # header
                try:
                    s = line.decode("utf-8", "ignore")
                except Exception:
                    continue
                origin, _, rank = s.partition(",")
                if not rank.strip().isdigit():
                    continue
                d = norm(origin)
                if d.endswith(".ru"):
                    b = int(rank.strip())
                    if d not in out or b < out[d]:
                        out[d] = b
    return out


def upload_supabase(rows: list[tuple[str, str, int]], url: str, key: str):
    BATCH = 500
    total = len(rows)
    for i in range(0, total, BATCH):
        batch = rows[i : i + BATCH]
        body = json.dumps([
            {"domain": d, "country": c, "bucket": b} for d, c, b in batch
        ])
        req = urllib.request.Request(
            f"{url}/rest/v1/foreign_presence",
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
            print(f"  [{i + len(batch):,}/{total:,}]")
        except Exception as e:
            print(f"  batch {i} error: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="сколько стран обработать (0 = все)")
    ap.add_argument("--csv-out", default=str(Path(__file__).parent / "data" / "foreign_presence.csv"))
    ap.add_argument("--supabase-url")
    ap.add_argument("--supabase-key")
    args = ap.parse_args()

    codes = list_countries()
    targets_all = [c for c in codes if c not in EXCLUDE]
    excluded = len(codes) - len(targets_all)
    targets = targets_all[: args.limit] if args.limit else targets_all
    print(f"Всего стран в репо: {len(codes)} | исключено: {excluded} | сканируем: {len(targets)}")

    foreign: dict[str, dict[str, int]] = defaultdict(dict)
    done = 0
    for cc in targets:
        u = latest_country(cc)
        if not u:
            continue
        try:
            ru = scan_ru(u)
        except Exception as e:
            print(f"  {cc}: ошибка {e}")
            continue
        for domain, bucket in ru.items():
            if cc not in foreign[domain] or bucket < foreign[domain][cc]:
                foreign[domain][cc] = bucket
        done += 1
        if done % 10 == 0:
            print(f"  обработано {done}/{len(targets)} | уникальных .ru накоплено: {len(foreign):,}")

    rows: list[tuple[str, str, int]] = []
    for domain in sorted(foreign):
        for cc in sorted(foreign[domain]):
            rows.append((domain, cc, foreign[domain][cc]))

    print(f"\nГотово: стран {done} | уникальных .ru-доменов {len(foreign):,} | строк {len(rows):,}")

    if args.supabase_url and args.supabase_key:
        print("Загрузка в Supabase...")
        upload_supabase(rows, args.supabase_url, args.supabase_key)
    else:
        p = Path(args.csv_out)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["domain", "country", "bucket"])
            w.writerows(rows)
        print(f"CSV: {p}")


if __name__ == "__main__":
    main()
