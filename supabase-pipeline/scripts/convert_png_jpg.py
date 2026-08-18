#!/usr/bin/env python3
"""
Разовая миграция: конвертирует существующие PNG-скриншоты в Storage в JPEG.
Не обращается к thum.io — работает только с уже сохранёнными файлами.

Запуск:
    python convert_png_jpg.py --supabase-url ... --supabase-key ...

Требует: pip install pillow requests
"""
import argparse
from io import BytesIO

import requests
from PIL import Image

NON_EU = []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--supabase-url", required=True)
    ap.add_argument("--supabase-key", required=True)
    ap.add_argument("--limit", type=int, default=0, help="0 = все")
    args = ap.parse_args()

    url = args.supabase_url.rstrip("/")
    H = {
        "apikey": args.supabase_key,
        "Authorization": f"Bearer {args.supabase_key}",
        "Content-Type": "application/json",
    }

    # домены со скриншотом .png (или старые thum.io URL)
    r = requests.get(
        f"{url}/rest/v1/domains",
        headers=H,
        params={"screenshot_path": "not.is.null", "select": "domain,screenshot_path", "limit": str(args.limit or 2000)},
        timeout=30,
    )
    rows = [x for x in r.json() if x.get("screenshot_path") and ".png" in x["screenshot_path"]]
    print(f"PNG-скриншотов для конвертации: {len(rows)}")

    ok = 0
    for i, d in enumerate(rows, 1):
        domain = d["domain"]
        try:
            # скачать PNG
            png = requests.get(d["screenshot_path"], timeout=30).content
            img = Image.open(BytesIO(png))
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")
            out = BytesIO()
            img.save(out, "JPEG", quality=80)
            jpg = out.getvalue()

            # загрузить .jpg
            filename = f"{domain}.jpg"
            up = requests.post(
                f"{url}/storage/v1/object/screenshots/{filename}",
                headers={
                    "apikey": args.supabase_key,
                    "Authorization": f"Bearer {args.supabase_key}",
                    "Content-Type": "image/jpeg",
                    "x-upsert": "true",
                },
                data=jpg,
                timeout=30,
            )
            if up.status_code not in (200, 201, 409):
                print(f"[{i}/{len(rows)}] {domain}: upload fail {up.status_code}")
                continue

            # подписать (signedURL приходит относительным — добавляем домен)
            sign = requests.post(
                f"{url}/storage/v1/object/sign/screenshots/{filename}",
                headers=H,
                json={"expiresIn": 31536000},
                timeout=30,
            ).json()
            signed = sign.get("signedURL", "")
            if signed.startswith("/"):
                signed = url + signed

            # обновить путь
            requests.patch(
                f"{url}/rest/v1/domains",
                headers={**H, "Prefer": "return=minimal"},
                params={"domain": f"eq.{domain}"},
                json={"screenshot_path": signed, "screenshot_source": "storage"},
                timeout=30,
            )

            # удалить старый .png
            requests.delete(
                f"{url}/storage/v1/object/screenshots/{domain}.png",
                headers={"apikey": args.supabase_key, "Authorization": f"Bearer {args.supabase_key}"},
                timeout=30,
            )

            ok += 1
            print(f"[{i}/{len(rows)}] {domain}: {len(png)//1024}KB -> {len(jpg)//1024}KB")
        except Exception as e:
            print(f"[{i}/{len(rows)}] {domain}: ERROR {e}")

    print(f"\nГотово: {ok}/{len(rows)} сконвертировано")


if __name__ == "__main__":
    main()
