import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    }});
  }

  const { domain } = await req.json().catch(() => ({}));
  if (!domain) return new Response(JSON.stringify({ error: "domain required" }), {
    status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

  try {
    const resp = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ParserBot/4.0)" },
    });
    if (!resp.ok) return new Response(JSON.stringify({ name: "", description: "" }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
    const html = await resp.text();
    const ogT = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    const ogD = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    const mD = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const t = html.match(/<title>([^<]+)<\/title>/i);
    const name = (ogT?.[1] || t?.[1] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
    const desc = (ogD?.[1] || mD?.[1] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
    return new Response(JSON.stringify({ name, description }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch {
    return new Response(JSON.stringify({ name: "", description: "" }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
