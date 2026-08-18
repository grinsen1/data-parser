#!/usr/bin/env python3
"""
Миграция: Supabase Storage → Cloudflare R2.
Скачивает напрямую через Storage API (download endpoint + service key),
загружает в R2, обновляет screenshot_path/source, удаляет из Storage.

Запуск:
    python migrate_storage_to_r2.py --supabase-url ... --supabase-key ...
"""
import argparse
import concurrent.futures
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

    # все домены со скриншотом (кроме уже r2), с пагинацией
    rows = []
    offset = 0
    while True:
        r = requests.get(
            f"{url}/rest/v1/domains",
            headers=H,
            params={"screenshot_path": "not.is.null", "select": "domain,screenshot_source", "limit": "1000", "offset": str(offset)},
            timeout=60,
        )
        page = r.json()
        if not page:
            break
        rows.extend(x for x in page if x.get("screenshot_source") != "r2")
        offset += 1000
    print(f"Для переноса: {len(rows)}", flush=True)

    def migrate(d):
        domain = d["domain"]
        try:
            # скачать из Storage напрямую (download endpoint)
            # пробуем .jpg потом .png
            for ext in ("jpg", "png"):
                dl = requests.get(
                    f"{url}/storage/v1/object/screenshots/{domain}.{ext}",
                    headers=H,
                    timeout=30,
                )
                if dl.status_code == 200 and len(dl.content) > 1000:
                    img = dl.content
                    key = f"{domain}.{ext}"
                    break
            else:
                return f"NOFILE {domain}"

            # загрузить в R2
            s3.put_object(Bucket="screenshots", Key=key, Body=img, ContentType="image/jpeg" if key.endswith("jpg") else "image/png")

            # обновить path
            public = f"{R2_PUBLIC_URL}/{key}"
            requests.patch(
                f"{url}/rest/v1/domains",
                headers={**H, "Prefer": "return=minimal"},
                params={"domain": f"eq.{domain}"},
                json={"screenshot_path": public, "screenshot_source": "r2"},
                timeout=30,
            )
            return f"OK {domain} ({len(img)//1024}KB)"
        except Exception as e:
            return f"ERR {domain}: {e}"

    ok = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        for i, res in enumerate(ex.map(migrate, rows), 1):
            if res.startswith("OK"):
                ok += 1
            if i % 50 == 0:
                print(f"[{i}/{len(rows)}] ok={ok}", flush=True)

    print(f"\nГотово: {ok}/{len(rows)} перенесено", flush=True)


if __name__ == "__main__":
    main()
