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
  if (!domain) return new Response(JSON.stringify({ name: "", description: "" }), {
    status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

  try {
    const resp = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ParserBot/4.0)" },
    });
    if (!resp.ok) return out("", "");

    // Detect encoding from Content-Type or fallback to UTF-8
    let html = "";
    const ct = resp.headers.get("content-type") ?? "";
    const charsetMatch = ct.match(/charset=([\w-]+)/i);
    const charset = charsetMatch?.[1]?.toLowerCase();

    if (charset === "windows-1251" || charset === "cp1251") {
      const buf = await resp.arrayBuffer();
      html = new TextDecoder("windows-1251").decode(buf);
    } else {
      html = await resp.text();
    }

    // Try OpenGraph first, then regular meta, then <title>
    let name = extract(html, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (!name) name = extract(html, /<title>([\s\S]*?)<\/title>/i);
    if (!name) name = extract(html, /<meta[^>]*name=["']title["'][^>]*content=["']([^"']+)["']/i);

    let description = extract(html, /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    if (!description) description = extract(html, /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);

    // Clean: decode HTML entities, collapse whitespace
    name = clean(name);
    description = clean(description);

    return out(name, description);
  } catch {
    return out("", "");
  }
});

function extract(html: string, re: RegExp): string {
  return html.match(re)?.[1] ?? "";
}

function clean(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function out(name: string, description: string) {
  return new Response(JSON.stringify({ name, description }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
