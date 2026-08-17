// Universal Parser worker
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

async function doRank(domain: string): Promise<{ ok: boolean; error?: string }> {
  const { data: ranks } = await supabase
    .from("crux_ranks")
    .select("scope, rank")
    .eq("domain", domain);

  if (ranks && ranks.length > 0) {
    const g = ranks.find((r: any) => r.scope === "global")?.rank ?? null;
    const ru = ranks.find((r: any) => r.scope === "ru")?.rank ?? null;
    const best = [g, ru].filter((r): r is number => r != null);
    const rank = best.length > 0 ? Math.min(...best) : null;

    await supabase.from("domains").upsert({
      domain,
      rank,
      rank_source: "crux_ranks",
      updated_at: new Date().toISOString(),
    });
    return { ok: true };
  }

  await supabase.from("domains").upsert({
    domain,
    rank: null,
    rank_source: "crux_api_miss",
    updated_at: new Date().toISOString(),
  });
  return { ok: true };
}

async function doMeta(domain: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let head = "";
    while (head.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
      if (head.includes("</head>")) break;
    }
    reader.cancel();

    let html = head;
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("windows-1251") || ct.includes("cp1251") || ct.includes("octet-stream")) {
      let win = "";
      for (let i = 0; i < head.length; i++) {
        const b = head.charCodeAt(i) & 0xFF;
        win += b < 128 ? String.fromCharCode(b) : String.fromCharCode(b + 0x350);
      }
      html = win;
    }

    const title = extractTitle(html);
    const desc = extractDesc(html);

    await supabase.from("domains").upsert({
      domain,
      title,
      description: desc,
      updated_at: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  return m ? clean(m[1]) : "";
}

function extractDesc(html: string): string {
  const m = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? clean(m[1]) : "";
}

function clean(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
}

async function doScreenshot(domain: string): Promise<{ ok: boolean; error?: string }> {
  const filename = `${domain}.png`;

  const { data: existing } = await supabase.storage.from("screenshots").createSignedUrl(filename, 60);
  if (existing?.signedUrl) {
    await supabase.from("domains").upsert({
      domain,
      screenshot_path: existing.signedUrl,
      screenshot_source: "storage",
      updated_at: new Date().toISOString(),
    });
    return { ok: true };
  }

  try {
    const resp = await fetch(`https://image.thum.io/get/width/600/https://${domain}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { ok: false, error: `thum.io ${resp.status}` };

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 1000) return { ok: false, error: "screenshot too small" };

    const { error: uploadErr } = await supabase.storage.from("screenshots").upload(filename, buf, {
      contentType: "image/png",
      upsert: true,
    });
    if (uploadErr) return { ok: false, error: `upload: ${uploadErr.message}` };

    const { data: uploaded } = await supabase.storage.from("screenshots").createSignedUrl(filename, 60 * 60 * 24 * 365);
    await supabase.from("domains").upsert({
      domain,
      screenshot_path: uploaded?.signedUrl ?? "",
      screenshot_source: "storage",
      updated_at: new Date().toISOString(),
    });
    return { ok: true };

  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const HANDLERS: Record<string, (d: string) => Promise<{ ok: boolean; error?: string }>> = {
  rank: doRank,
  meta: doMeta,
  screenshot: doScreenshot,
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    }});
  }

  try {
    const body = await req.json().catch(() => ({}));
    const kind = body.kind ?? "rank";
    const limit = body.limit ?? 10;

    await supabase.rpc("reap_expired_leases");

    const { data: tasks, error } = await supabase.rpc("claim_tasks", {
      p_kind: kind,
      p_limit: limit,
      p_lease_sec: 120,
    });

    if (error) throw new Error(error.message);
    if (!tasks || tasks.length === 0) {
      return json({ ok: true, processed: 0, message: "no pending tasks" });
    }

    const handler = HANDLERS[kind];
    let done = 0, failed = 0;

    for (const task of tasks) {
      const result = await handler(task.domain);
      if (result.ok) {
        await supabase.rpc("complete_task", { p_domain: task.domain, p_kind: kind });
        done++;
      } else {
        await supabase.rpc("fail_task", {
          p_domain: task.domain,
          p_kind: kind,
          p_error: result.error ?? "unknown",
        });
        failed++;
      }
    }

    return json({ ok: true, kind, processed: tasks.length, done, failed });

  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
