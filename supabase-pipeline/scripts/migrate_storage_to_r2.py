#!/usr/bin/env python3
"""
Разовая миграция: переносит скриншоты из Supabase Storage в Cloudflare R2.
Обновляет domains.screenshot_path на публичный r2.dev URL.

Запуск:
    python migrate_storage_to_r2.py --supabase-url ... --supabase-key ...

Требует: pip install boto3 requests
"""
import argparse
import boto3
import requests
from botocore.config import Config

R2_ACCOUNT_ID = "24d95089d18aa43ca7e507ea6a9a27af"
R2_ACCESS_KEY = "d90ce3727d8af392d27559cc44642cfa"
R2_SECRET_KEY = "8d7d45b765d61c2709ffd5f5060c3785f39862fc6a1fe394028347cc588ca012"
R2_PUBLIC_URL = "https://pub-f025141ef55f496a853b8165d38599df.r2.dev"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--supabase-url", required=True)
    ap.add_argument("--supabase-key", required=True)
    ap.add_argument("--limit", type=int, default=0, help="0 = все")
    args = ap.parse_args()

    url = args.supabase_url.rstrip("/")
    H = {"apikey": args.supabase_key, "Authorization": f"Bearer {args.supabase_key}", "Content-Type": "application/json"}

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )

    # домены со скриншотом (storage или thumio, но не r2)
    r = requests.get(
        f"{url}/rest/v1/domains",
        headers=H,
        params={"screenshot_path": "not.is.null", "screenshot_source": "neq.r2", "select": "domain,screenshot_path,screenshot_source", "limit": str(args.limit or 2000)},
        timeout=30,
    )
    rows = r.json()
    print(f"Скриншотов для переноса: {len(rows)}")

    ok = 0
    for i, d in enumerate(rows, 1):
        domain = d["domain"]
        try:
            # скачать из Supabase Storage (или thum.io)
            img = requests.get(d["screenshot_path"], timeout=30).content
            if len(img) < 1000:
                continue

            # определить расширение
            ct = d.get("screenshot_source")
            key = f"{domain}.jpg"  # всё приводим к jpg (уже сконвертировано воркером)

            # загрузить в R2
            s3.put_object(Bucket="screenshots", Key=key, Body=img, ContentType="image/jpeg")

            # обновить path
            public = f"{R2_PUBLIC_URL}/{key}"
            requests.patch(
                f"{url}/rest/v1/domains",
                headers={**H, "Prefer": "return=minimal"},
                params={"domain": f"eq.{domain}"},
                json={"screenshot_path": public, "screenshot_source": "r2"},
                timeout=30,
            )

            ok += 1
            print(f"[{i}/{len(rows)}] {domain}: -> R2 ({len(img)//1024}KB)")
        except Exception as e:
            print(f"[{i}/{len(rows)}] {domain}: ERROR {e}")

    print(f"\nГотово: {ok}/{len(rows)} перенесено в R2")


if __name__ == "__main__":
    main()
