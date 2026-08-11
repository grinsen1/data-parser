import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAGESPEED_API_KEY = Deno.env.get("PAGESPEED_API_KEY") ?? "";

// ============================================================
// Edge Function: screenshot
// Делает скриншот сайта через Google PageSpeed API
// Сохраняет в Supabase Storage
// ============================================================

serve(async (req: Request) => {
  try {
    const { domain, id } = await req.json();
    if (!domain) return jsonErr(400, "domain is required");

    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const filename = `${cleanDomain}.png`;

    // 1. Проверяем кэш в Storage
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: existing } = await supabase.storage
      .from("screenshots")
      .createSignedUrl(filename, 60);

    if (existing?.signedUrl) {
      return new Response(JSON.stringify({
        ok: true,
        cached: true,
        url: existing.signedUrl,
        filename,
      }), { headers: ctype() });
    }

    // 2. Получаем скриншот через PageSpeed Insights API
    const screenshotB64 = await getPageSpeedScreenshot(cleanDomain);

    if (!screenshotB64) {
      return jsonErr(404, "screenshot not available");
    }

    // 3. Декодируем base64 → Uint8Array
    const binary = Uint8Array.from(atob(screenshotB64), (c) => c.charCodeAt(0));

    // 4. Сохраняем в Storage
    const { error: uploadErr } = await supabase.storage
      .from("screenshots")
      .upload(filename, binary, {
        contentType: "image/png",
        upsert: true,
      });

    if (uploadErr) {
      return jsonErr(500, `storage error: ${uploadErr.message}`);
    }

    // 5. Получаем публичную ссылку
    const { data: uploaded } = await supabase.storage
      .from("screenshots")
      .createSignedUrl(filename, 60 * 60 * 24 * 365); // год

    return new Response(JSON.stringify({
      ok: true,
      cached: false,
      url: uploaded?.signedUrl ?? "",
      filename,
    }), { headers: ctype() });

  } catch (e) {
    return jsonErr(500, String(e));
  }
});

// --------------------------------------------------------
// Google PageSpeed Insights API
// 25K/день бесплатно с ключом, без ключа ~1/сек
// --------------------------------------------------------
async function getPageSpeedScreenshot(domain: string): Promise<string | null> {
  const params = new URLSearchParams({
    url: `https://${domain}`,
    screenshot: "true",
    strategy: "desktop",
  });
  if (PAGESPEED_API_KEY) params.set("key", PAGESPEED_API_KEY);

  const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  // 3 попытки с экспоненциальной задержкой
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (resp.status === 429) {
        console.log(`[screenshot] 429, attempt ${attempt}/3`);
        await sleep(1000 * attempt);
        continue;
      }

      const json = await resp.json();
      const screenshot = json?.lighthouseResult?.audits?.["final-screenshot"]?.details?.data;

      if (screenshot) {
        return screenshot.replace(/^data:image\/\w+;base64,/, "");
      }

      return null;

    } catch (e) {
      console.log(`[screenshot] attempt ${attempt} failed: ${e}`);
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }

  return null;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function ctype() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
}

function jsonErr(code: number, msg: string) {
  return new Response(JSON.stringify({ error: true, code, message: msg }), {
    status: code,
    headers: ctype(),
  });
}
