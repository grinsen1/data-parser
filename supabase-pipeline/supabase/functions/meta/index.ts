import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    }});
  }

  const body = await req.json().catch(() => ({}));
  const domain = body.domain;
  if (!domain) return out("", "", 400);

  try {
    const resp = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    });
    if (!resp.ok) return out("", "", resp.status);

    const buf = await resp.arrayBuffer();
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    console.log(`[${domain}] ct="${ct}" bufSize=${buf.byteLength}`);

    // Try UTF-8 first
    let html = new TextDecoder("utf-8").decode(buf);
    const titleIdx = html.indexOf("<title>");
    console.log(`[${domain}] utf8 titleIdx=${titleIdx} preview=${html.slice((titleIdx>0?titleIdx:0),(titleIdx>0?titleIdx:0)+100)}`);

    // Fallback to windows-1251 if needed
    if (ct.includes("windows-1251") || ct.includes("cp1251") || ct.includes("octet-stream") || !ct) {
      html = new TextDecoder("windows-1251").decode(buf);
      console.log(`[${domain}] switched to 1251`);
    }

    // Extract title
    let name = "";
    const ts = html.indexOf("<title>");
    if (ts >= 0) {
      const te = html.indexOf("</title>", ts);
      if (te > ts) name = html.substring(ts + 7, te);
    }

    // Extract description
    let desc = "";
    const ods = html.indexOf('og:description');
    if (ods >= 0) {
      const cs = html.indexOf("content=", ods);
      if (cs >= 0) {
        const q = html[cs + 8];
        const ce = html.indexOf(q, cs + 9);
        if (ce > cs) desc = html.substring(cs + 9, ce);
      }
    }
    if (!desc) {
      const mds = html.indexOf('<meta name="description"');
      if (mds >= 0) {
        const cs = html.indexOf("content=", mds);
        if (cs >= 0) {
          const q = html[cs + 8];
          const ce = html.indexOf(q, cs + 9);
          if (ce > cs) desc = html.substring(cs + 9, ce);
        }
      }
    }

    name = clean(name);
    desc = clean(desc);
    return out(name, desc, 200);
  } catch (e) {
    console.error(e);
    return out("", "", 500);
  }
});

function clean(s: string): string {
  if (!s) return "";
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
}

function out(name: string, description: string, status: number) {
  return new Response(JSON.stringify({ name, description, status }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
