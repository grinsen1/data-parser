import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAGESPEED_API_KEY = Deno.env.get("PAGESPEED_API_KEY") ?? "";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    }});
  }

  const body = await req.json().catch(() => ({}));
  const domain = body.domain?.trim();
  if (!domain) return new Response(JSON.stringify({ error: "domain required" }), {
    status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const filename = `${domain}.png`;

  const { data: existing } = await supabase.storage.from("screenshots").createSignedUrl(filename, 120);
  if (existing?.signedUrl) {
    return new Response(JSON.stringify({ ok: true, url: existing.signedUrl, cached: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const params = new URLSearchParams({ url: `https://${domain}`, screenshot: "true", strategy: "desktop" });
  if (PAGESPEED_API_KEY) params.set("key", PAGESPEED_API_KEY);

  // Fire PageSpeed in background, return immediately
  EdgeRuntime.waitUntil((async () => {
    try {
      const resp = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) return;
      const json = await resp.json();
      const b64 = json?.lighthouseResult?.audits?.["final-screenshot"]?.details?.data;
      if (!b64) return;
      const clean = b64.replace(/^data:image\/\w+;base64,/, "");
      const binary = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
      await supabase.storage.from("screenshots").upload(filename, binary, {
        contentType: "image/png", upsert: true,
      });
    } catch { /* silent */ }
  })());

  return new Response(JSON.stringify({ ok: true, cached: false, pending: true }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});
