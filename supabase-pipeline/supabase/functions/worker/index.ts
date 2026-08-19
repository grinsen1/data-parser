// Universal Parser worker
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { decode as decodePng } from "https://esm.sh/@jsquash/png@3.0.1";
import { encode as encodeJpeg } from "https://esm.sh/@jsquash/jpeg@1.2.0";
import { zipSync } from "https://esm.sh/fflate@0.8.2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const CRUX_KEY = Deno.env.get("CRUX_KEY") ?? "";
const CF_API_TOKEN = Deno.env.get("CF_API_TOKEN") ?? "";
const CF_ACCOUNT_ID = Deno.env.get("CF_ACCOUNT_ID") ?? "";

const R2 = new AwsClient({
  accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") ?? "",
  secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "",
  region: "auto",
});
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT") ?? "";
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL") ?? "";

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
      const err = `HTTP ${resp.status}`;
      await supabase.from("domains").upsert({ domain, meta_error: err, updated_at: new Date().toISOString() });
      return { ok: false, error: err };
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
      meta_error: null,
      updated_at: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    const err = String(e);
    await supabase.from("domains").upsert({ domain, meta_error: err, updated_at: new Date().toISOString() });
    return { ok: false, error: err };
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
  if (existingDom?.screenshot_path && existingDom.screenshot_source === "r2") {
    return { ok: true };
  }

  try {
    const resp = await fetch(`https://image.thum.io/get/width/600/noanimate/https://${domain}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { ok: false, error: `thum.io ${resp.status}` };

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 1000) return { ok: false, error: "screenshot too small" };

    // Конвертация PNG → JPEG (качество 80)
    let finalBuf = buf;
    let finalCt = "image/png";
    let ext = "png";

    try {
      const imageData = await decodePng(buf.buffer as ArrayBuffer);
      const jpegBuf = await encodeJpeg(imageData, { quality: 80 });
      finalBuf = new Uint8Array(jpegBuf);
      finalCt = "image/jpeg";
      ext = "jpg";
    } catch {
      // не PNG — сохраняем как есть
    }

    const key = `${domain}.${ext}`;

    // Загрузка в R2 (S3 API)
    const r2Resp = await R2.fetch(`${R2_ENDPOINT}/screenshots/${key}`, {
      method: "PUT",
      body: finalBuf,
      headers: { "Content-Type": finalCt },
    });
    if (r2Resp.status !== 200 && r2Resp.status !== 201) {
      return { ok: false, error: `r2 upload ${r2Resp.status}` };
    }

    const publicUrl = `${R2_PUBLIC_URL}/${key}`;
    await supabase.from("domains").upsert({
      domain,
      screenshot_path: publicUrl,
      screenshot_source: "r2",
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
    crux_raw: found.data,
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
      geo_raw: json,
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
      const cats = item.content_categories ?? [];
      // конкретные (с super_category_id) и родительские (без)
      const concrete = cats.filter((c: any) => c.super_category_id != null).map((c: any) => c.name);
      const parents = [...new Set(cats.filter((c: any) => c.super_category_id == null).map((c: any) => c.name))];

      await supabase.from("domains").upsert({
        domain: dom,
        category: concrete.join(", "),
        super_category: parents.join(", "),
        categories: cats,
        intel_raw: item,
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

const COLS = "domain,rank,rank_source,title,description,category,super_category,lcp_p75,inp_p75,cls_p75,reload,bf_sum,navigate,prerender,phone,crux_variant,ru_share,ru_rank,top_country,foreign_tail,geo_verdict,screenshot_path,meta_error,geo_countries";

async function buildList() {
  const { data: batches } = await supabase.from("batches").select("id,name,created_at").order("created_at", { ascending: false }).limit(100);
  const counts: Record<string, number> = {};
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const { data: items } = await supabase.from("batch_items").select("batch_id").range(off, off + PAGE - 1);
    if (!items || items.length === 0) break;
    for (const it of items) counts[it.batch_id] = (counts[it.batch_id] || 0) + 1;
    if (items.length < PAGE) break;
  }
  return { batches: batches ?? [], counts };
}

async function buildRead(batchId: number) {
  const { data: b } = await supabase.from("batches").select("id,name").eq("id", batchId).maybeSingle();
  const domains: string[] = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const { data: items } = await supabase.from("batch_items")
      .select("domain").eq("batch_id", batchId).order("domain").range(off, off + PAGE - 1);
    if (!items || items.length === 0) break;
    for (const it of items) domains.push(it.domain);
    if (items.length < PAGE) break;
  }
  const doms: any[] = [];
  const CHUNK = 1000;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const { data: chunk } = await supabase.from("domains").select(COLS).in("domain", domains.slice(i, i + CHUNK));
    for (const d of chunk ?? []) doms.push(d);
  }
  const { data: prog } = await supabase.rpc("batch_progress", { p_batch_id: batchId });
  return { name: b?.name ?? "", domains: doms, progress: prog ?? [] };
}

async function putR2(key: string, body: string | Uint8Array, contentType: string, extraHeaders: Record<string, string> = {}) {
  const r = await R2.fetch(`${R2_ENDPOINT}/screenshots/${key}`, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType, ...extraHeaders },
  });
  return r.status;
}

function tierOf(rank: number | null | undefined): string {
  if (rank === null || rank === undefined) return "E";
  if (rank <= 1000) return "A";
  if (rank <= 50000) return "B";
  if (rank <= 500000) return "C";
  return "D";
}

function verdictOf(d: any): string {
  const tier = d.rank_source == null ? null : tierOf(d.rank);
  const foreignTail = d.foreign_tail ?? 0;
  if (tier === "E" || (foreignTail > 15 && d.geo_verdict === "ok")) return "delete";
  const lcp = d.lcp_p75, inp = d.inp_p75, cls = d.cls_p75, phone = d.phone, reload = d.reload, prerender = d.prerender;
  if ((lcp != null && lcp > 4000) ||
      (inp != null && inp > 500) ||
      (cls != null && cls > 0.25) ||
      (phone != null && phone > 0.9) ||
      (reload != null && reload > 0.15) ||
      (prerender != null && prerender > 0.035)) return "check";
  return "ok";
}

const SS_BASE = "https://cdn.appquantum.ru/";

function buildXlsx(doms: any[]): Uint8Array {
  const cols: [string, string][] = [
    ["domain", "Домен"], ["verdict", "Вердикт"], ["rank", "Ранг CrUX"], ["tier", "Тир"],
    ["title", "Название"], ["description", "Описание"], ["category", "Категория"], ["super_category", "Раздел"],
    ["lcp_p75", "LCP мс"], ["inp_p75", "INP мс"], ["cls_p75", "CLS"], ["reload", "Перезагрузки"],
    ["bf_sum", "Переходы назад"], ["navigate", "Новые заходы"], ["prerender", "Предзагрузка"], ["phone", "Доля мобильных"],
    ["crux_variant", "Origin"], ["ru_share", "Доля РФ %"], ["ru_rank", "Место РФ"], ["top_country", "Первая страна"],
    ["foreign_tail", "Неевропейский хвост %"], ["geo_verdict", "Гео-вердикт"], ["screenshot_path", "Скриншот"],
  ];
  const header = cols.map(c => c[1]);
  const rows = doms.map(d => cols.map(c => {
    let v = d[c[0]];
    if (c[0] === "verdict") v = verdictOf(d);
    if (c[0] === "tier") v = (d.rank_source == null) ? "" : tierOf(d.rank);
    if (c[0] === "ru_share" && v != null) v = Math.round(v * 10) / 10;
    if (c[0] === "screenshot_path" && d.screenshot_path) v = `${SS_BASE}${d.domain}.jpg`;
    return v ?? "";
  }));
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Домены");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out);
}

async function buildZip(domains: string[]): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const CONC = 25;
  for (let i = 0; i < domains.length; i += CONC) {
    const chunk = domains.slice(i, i + CONC);
    const results = await Promise.all(chunk.map(async (domain) => {
      const key = `${domain}.jpg`;
      try {
        const resp = await R2.fetch(`${R2_ENDPOINT}/screenshots/${key}`, { method: "GET" });
        if (resp.status === 200) {
          return [key, new Uint8Array(await resp.arrayBuffer())] as const;
        }
      } catch { /* skip */ }
      return null;
    }));
    for (const r of results) if (r) files[r[0]] = r[1];
  }
  return zipSync(files, { level: 0 });
}

async function cleanupExports() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const resp = await R2.fetch(`${R2_ENDPOINT}/screenshots?list-type=2&prefix=exports/`, { method: "GET" });
    if (resp.status !== 200) return;
    const xml = await resp.text();
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const block = m[1];
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1];
      const lm = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1];
      if (key && lm) {
        const ts = Date.parse(lm);
        if (ts > 0 && ts < cutoff) {
          await R2.fetch(`${R2_ENDPOINT}/screenshots/${key}`, { method: "DELETE" });
        }
      }
    }
  } catch { /* ignore */ }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    }});
  }

  try {
    let body: any = {};
    if (req.method === "GET") {
      const u = new URL(req.url);
      body.action = u.searchParams.get("action") ?? "";
      const bid = u.searchParams.get("batch_id");
      if (bid) body.batch_id = parseInt(bid, 10);
    } else {
      body = await req.json().catch(() => ({}));
    }

    // === action-based API (для фронта, обходит PostgREST) ===
    if (body.action === "create") {
      const name = body.name || ("Задача " + new Date().toISOString().slice(0, 19));
      const domains = (body.domains ?? []).map((d: string) => d.trim().toLowerCase()).filter(Boolean);

      const { data: bid } = await supabase.rpc("create_batch", { p_name: name, p_domains: [] });
      const CHUNK = 500;
      for (let i = 0; i < domains.length; i += CHUNK) {
        await supabase.rpc("add_batch_items", { p_batch_id: bid, p_domains: domains.slice(i, i + CHUNK) });
      }
      return json({ ok: true, batch_id: bid, total: domains.length });
    }

    if (body.action === "list") {
      return json({ ok: true, ...(await buildList()) });
    }

    if (body.action === "read") {
      return json({ ok: true, ...(await buildRead(body.batch_id)) });
    }

    if (body.action === "snapshot") {
      await cleanupExports();
      const { data: ids } = await supabase.rpc("list_done_batches");
      let n = 0;
      for (const row of (ids ?? [])) {
        const batchId = typeof row === "object" && row !== null ? row.batch_id : row;
        const snap = await buildRead(batchId);
        (snap as any).done = true;
        await putR2(`snapshots/batch_${batchId}.json`, JSON.stringify(snap), "application/json");

        const xlsx = buildXlsx(snap.domains);
        await putR2(`exports/batch_${batchId}.xlsx`, xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {
          "Content-Disposition": `attachment; filename="batch_${batchId}.xlsx"`,
        });

        const domsWithSS = snap.domains.filter((d: any) => d.screenshot_path).map((d: any) => d.domain);
        if (domsWithSS.length > 0) {
          const zip = await buildZip(domsWithSS);
          await putR2(`exports/batch_${batchId}.zip`, zip, "application/zip", {
            "Content-Disposition": `attachment; filename="batch_${batchId}_screenshots.zip"`,
          });
        }

        await supabase.from("batches").update({ snapshotted_at: new Date().toISOString() }).eq("id", batchId);
        n++;
      }
      const listSnap = await buildList();
      await putR2("snapshots/list.json", JSON.stringify(listSnap), "application/json");
      return json({ ok: true, snapshotted: n });
    }

    // === kind-based (обработка задач, вызывается кроном) ===
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
