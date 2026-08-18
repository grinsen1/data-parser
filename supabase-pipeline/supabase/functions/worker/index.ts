// Universal Parser worker
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const CRUX_KEY = Deno.env.get("CRUX_KEY") ?? "";
const CF_API_TOKEN = Deno.env.get("CF_API_TOKEN") ?? "";
const CF_ACCOUNT_ID = Deno.env.get("CF_ACCOUNT_ID") ?? "";

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
  const { data: existingDom } = await supabase.from("domains").select("screenshot_path, screenshot_source").eq("domain", domain).maybeSingle();
  if (existingDom?.screenshot_path && existingDom.screenshot_source === "storage") {
    return { ok: true };
  }

  try {
    const resp = await fetch(`https://image.thum.io/get/width/600/noanimate/https://${domain}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { ok: false, error: `thum.io ${resp.status}` };

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 1000) return { ok: false, error: "screenshot too small" };

    const ct = (resp.headers.get("content-type") || "image/png").toLowerCase();
    const ext = ct.includes("gif") ? "gif" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "png";
    const realFilename = `${domain}.${ext}`;

    const { error: uploadErr } = await supabase.storage.from("screenshots").upload(realFilename, buf, {
      contentType: ct,
      upsert: true,
    });
    if (uploadErr) return { ok: false, error: `upload: ${uploadErr.message}` };

    const { data: uploaded } = await supabase.storage.from("screenshots").createSignedUrl(realFilename, 60 * 60 * 24 * 365);
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

// ============================================================
// CrUX: поведение + техкачество
// ============================================================
async function doCrux(domain: string): Promise<{ ok: boolean; error?: string }> {
  const variants = [
    `https://${domain}`,
    `https://www.${domain}`,
    `http://${domain}`,
    `http://www.${domain}`,
  ];

  let found = null;
  for (const origin of variants) {
    const url = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${CRUX_KEY}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin }),
      signal: AbortSignal.timeout(20_000),
    });

    if (resp.status === 404) continue; // нет такой записи — пробуем следующий вариант

    if (resp.status === 429 || resp.status >= 500) {
      // временный сбой — повторяем тот же вариант
      await new Promise(r => setTimeout(r, 1500));
      const retry = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin }),
        signal: AbortSignal.timeout(20_000),
      });
      if (retry.status === 404) continue;
      if (retry.ok) { found = { origin, data: await retry.json() }; break; }
      continue;
    }

    if (resp.ok) { found = { origin, data: await resp.json() }; break; }
  }

  if (!found) {
    await supabase.from("domains").upsert({
      domain,
      crux_variant: "not_found",
      checked_at: new Date().toISOString(),
    });
    return { ok: true };
  }

  const m = found.data?.record?.metrics ?? {};
  const lcp = m.largest_contentful_paint?.percentiles?.p75 ?? null;
  const inp = m.interaction_to_next_paint?.percentiles?.p75 ?? null;
  const cls = m.cumulative_layout_shift?.percentiles?.p75 ?? null;

  const nav = m.navigation_types?.fractions ?? {};
  const ff = m.form_factors?.fractions ?? {};
  const reload = nav.reload ?? null;
  const bf_sum = (nav.back_forward ?? 0) + (nav.back_forward_cache ?? 0);
  const navigate = nav.navigate ?? null;
  const prerender = nav.prerender ?? null;
  const phone = ff.phone ?? null;

  await supabase.from("domains").upsert({
    domain,
    lcp_p75: lcp,
    inp_p75: inp,
    cls_p75: cls,
    reload,
    bf_sum,
    navigate,
    prerender,
    phone,
    crux_variant: found.origin,
    raw: found.data,
    checked_at: new Date().toISOString(),
  });
  return { ok: true };
}

// ============================================================
// Cloudflare Radar DNS: география
// ============================================================
const NON_EU = ["IN", "VN", "BD", "PK", "PH", "ID", "NG", "EG"];

async function doGeo(domain: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `https://api.cloudflare.com/client/v4/radar/dns/top/locations?domain=${domain}&dateRange=28d&limit=20&format=JSON`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { ok: false, error: `CF ${resp.status}` };

    const json = await resp.json();
    const top = json?.result?.top_0 ?? [];

    let ru_share = 0, ru_rank = null, top_country = "", foreign_tail = 0;
    if (top.length > 0) {
      top_country = top[0].clientCountryAlpha2;
      top.forEach((x: any, i: number) => {
        const v = parseFloat(x.value);
        if (x.clientCountryAlpha2 === "RU") { ru_share = v; ru_rank = i + 1; }
        if (NON_EU.includes(x.clientCountryAlpha2)) foreign_tail += v;
      });
    }
    const geo_verdict = top.length <= 2 ? "unknown" : "ok";

    await supabase.from("domains").upsert({
      domain,
      ru_share,
      ru_rank,
      top_country,
      foreign_tail: Math.round(foreign_tail * 100) / 100,
      geo_verdict,
      geo_countries: top,
      raw: json,
      checked_at: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ============================================================
// Cloudflare Intel: категория (bulk, обрабатывается пачкой)
// ============================================================
async function doIntel(domains: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!domains.length) return { ok: true };

  try {
    const params = domains.map(d => `domain=${encodeURIComponent(d)}`).join("&");
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/intel/domain/bulk?${params}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return { ok: false, error: `CF intel ${resp.status}` };

    const json = await resp.json();
    const results = json?.result ?? [];

    for (const item of results) {
      const dom = item.domain;
      let category = "", super_category = "";
      for (const c of item.content_categories ?? []) {
        if (c.super_category_id != null && !category) category = c.name;
        if (c.super_category_id == null && !super_category) super_category = c.name;
      }
      await supabase.from("domains").upsert({
        domain: dom,
        category,
        super_category,
        checked_at: new Date().toISOString(),
      });
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const HANDLERS: Record<string, (d: string) => Promise<{ ok: boolean; error?: string }>> = {
  rank: doRank,
  meta: doMeta,
  screenshot: doScreenshot,
  crux: doCrux,
  geo: doGeo,
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
      p_lease_sec: 180,
    });

    if (error) throw new Error(error.message);
    if (!tasks || tasks.length === 0) {
      return json({ ok: true, processed: 0, message: "no pending tasks" });
    }

    // intel — bulk, отдельная ветка
    if (kind === "intel") {
      const domains = tasks.map((t: any) => t.domain);
      const result = await doIntel(domains);
      if (result.ok) {
        for (const task of tasks) {
          await supabase.rpc("complete_task", { p_domain: task.domain, p_kind: "intel" });
        }
        return json({ ok: true, kind, processed: tasks.length, done: tasks.length, failed: 0 });
      } else {
        for (const task of tasks) {
          await supabase.rpc("fail_task", { p_domain: task.domain, p_kind: "intel", p_error: result.error ?? "unknown" });
        }
        return json({ ok: true, kind, processed: tasks.length, done: 0, failed: tasks.length });
      }
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
