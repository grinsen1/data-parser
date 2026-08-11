import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const daysThreshold = parseInt(Deno.env.get("DAYS_THRESHOLD") ?? "30");
const PAGESPEED_API_KEY = Deno.env.get("PAGESPEED_API_KEY") ?? "";

function classifyEntry(id: string): "website" | "googleplay" | "appstore" {
  if (/^id\d+$/.test(id) || /^\d{6,}$/.test(id)) return "appstore";
  if (!id.includes(".")) return "googleplay";
  return "website";
}

function computeTier(rank: number | null): string {
  if (rank === null) return "E";
  if (rank <= 1000) return "A";
  if (rank <= 50000) return "B";
  if (rank <= 500000) return "C";
  return "D";
}

function computeQuality(tier: string): { score: number; label: string } {
  if (tier === "E") return { score: 1, label: "unproven" };
  let score = 5;
  if (tier === "A") score += 3;
  else if (tier === "B") score += 2;
  else if (tier === "C") score += 1;
  const label = score >= 8 ? "premium" : score >= 5 ? "good" : score >= 3 ? "low" : "poor";
  return { score: Math.min(10, Math.max(0, score)), label };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// Phase 1: CrUX rank (DB query, instant)
// ============================================================
async function getCruxRank(domain: string): Promise<{ rankGlobal: number | null; rankRu: number | null; tier: string }> {
  const { data: ranks } = await supabase.from("crux_ranks").select("scope, rank").eq("domain", domain);
  const g = (ranks ?? []).find((r: any) => r.scope === "global")?.rank ?? null;
  const ru = (ranks ?? []).find((r: any) => r.scope === "ru")?.rank ?? null;
  const best = [g, ru].filter((r): r is number => r != null);
  const tier = computeTier(best.length > 0 ? Math.min(...best) : null);
  return { rankGlobal: g, rankRu: ru, tier };
}

// ============================================================
// Phase 2: Screenshot (PageSpeed API → Storage)
// ============================================================
async function getScreenshot(domain: string): Promise<string> {
  const filename = `${domain}.png`;
  const { data: existing } = await supabase.storage.from("screenshots").createSignedUrl(filename, 60);
  if (existing?.signedUrl) return existing.signedUrl;

  const params = new URLSearchParams({ url: `https://${domain}`, screenshot: "true", strategy: "desktop" });
  if (PAGESPEED_API_KEY) params.set("key", PAGESPEED_API_KEY);

  try {
    const resp = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return "";
    const json = await resp.json();
    const b64 = json?.lighthouseResult?.audits?.["final-screenshot"]?.details?.data;
    if (!b64) return "";
    const clean = b64.replace(/^data:image\/\w+;base64,/, "");
    const binary = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
    await supabase.storage.from("screenshots").upload(filename, binary, { contentType: "image/png", upsert: true });
    const { data: uploaded } = await supabase.storage.from("screenshots").createSignedUrl(filename, 60 * 60 * 24 * 365);
    return uploaded?.signedUrl ?? "";
  } catch { return ""; }
}

// ============================================================
// Phase 3: Title & Description (fetch <head> only)
// ============================================================
async function getMeta(domain: string): Promise<{ name: string; description: string }> {
  try {
    const resp = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ParserBot/4.0)" },
    });
    if (!resp.ok) return { name: "", description: "" };
    const html = await resp.text();
    const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    const mDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const title = html.match(/<title>([^<]+)<\/title>/i);
    return {
      name: (ogTitle?.[1] || title?.[1] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim(),
      description: (ogDesc?.[1] || mDesc?.[1] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim(),
    };
  } catch { return { name: "", description: "" }; }
}

// ============================================================
// Base entry builder (Phase 1 only)
// ============================================================
async function buildEntry(domain: string): Promise<any> {
  const type = classifyEntry(domain);
  const cached = await supabase.from("entries").select("*").eq("id", domain).maybeSingle();
  const cache = cached?.data;

  // Use cache if fresh
  if (cache?.last_updated && cache.quality_score > 0) {
    const daysSince = (Date.now() - new Date(cache.last_updated).getTime()) / 86_400_000;
    if (daysSince <= daysThreshold) return { ...cache, _source: "cache" };
  }

  // Fresh: get CrUX rank
  const { rankGlobal, rankRu, tier } = type === "website"
    ? await getCruxRank(domain)
    : { rankGlobal: null, rankRu: null, tier: "E" };

  const quality = computeQuality(tier);
  const toRemove = quality.label === "unproven" || quality.label === "poor";

  const entry = {
    id: domain,
    name: cache?.name || "",
    description: cache?.description || "",
    entry_type: type,
    screenshot_url: cache?.screenshot_url || "",
    crux_present: (rankGlobal !== null || rankRu !== null),
    crux_rank_global: rankGlobal,
    crux_rank_ru: rankRu,
    crux_tier: tier,
    quality_score: quality.score,
    quality_label: quality.label,
    to_remove,
    remove_reason: toRemove ? "low quality" : "",
    last_updated: new Date().toISOString(),
    _source: "fresh",
  };

  await supabase.rpc("upsert_entry", { data: entry });
  return entry;
}

// ============================================================
// SSE stream
// ============================================================
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const body = await req.json().catch(() => ({}));
  const domains: string[] = (body.domains ?? []).map((d: string) => d.trim()).filter(Boolean);
  const phases: string[] = body.phases ?? ["rank", "screenshot", "meta"];

  if (domains.length === 0) {
    return new Response(JSON.stringify({ error: "No domains" }), { status: 400, headers: jsonHeaders() });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      const total = domains.length;

      send({ type: "start", total, phases });

      const entryMap: Record<string, any> = {};

      // === PHASE 1: Rank (fast, sequential) ===
      if (phases.includes("rank")) {
        for (let i = 0; i < total; i++) {
          const domain = domains[i];
          const entry = await buildEntry(domain);
          entryMap[domain] = entry;
          entries.push(entry);
          send({ type: "result", index: i, domain, entry, phase: "rank" });
        }
      } else {
        // Need base entries for other phases
        for (let i = 0; i < total; i++) {
          const domain = domains[i];
          const { data: cached } = await supabase.from("entries").select("*").eq("id", domain).maybeSingle();
          if (cached) {
            entryMap[domain] = cached;
            entries.push(cached);
            send({ type: "result", index: i, domain, entry: cached, phase: "base" });
          } else {
            const entry = await buildEntry(domain);
            entryMap[domain] = entry;
            entries.push(entry);
            send({ type: "result", index: i, domain, entry, phase: "base" });
          }
        }
      }

      // === PHASE 2: Screenshots (parallel by 3) ===
      if (phases.includes("screenshot")) {
        const toShot = domains.map((d, i) => ({ domain: d, index: i }))
          .filter(x => entryMap[x.domain] && entryMap[x.domain].crux_tier !== "E" && !entryMap[x.domain].screenshot_url);

        const concurrency = 3;
        for (let batch = 0; batch < toShot.length; batch += concurrency) {
          const chunk = toShot.slice(batch, batch + concurrency);
          await Promise.all(chunk.map(async ({ domain, index }) => {
            const url = await getScreenshot(domain);
            if (url) {
              entryMap[domain].screenshot_url = url;
              entries[index] = { ...entryMap[domain] };
              send({ type: "result", index, domain, entry: entries[index], phase: "screenshot" });
            }
          }));
          await sleep(500);
        }
      }

      // === PHASE 3: Meta (parallel by 5) ===
      if (phases.includes("meta")) {
        const toMeta = domains.map((d, i) => ({ domain: d, index: i }))
          .filter(x => entryMap[x.domain] && entryMap[x.domain].entry_type === "website" && (!entryMap[x.domain].name || !entryMap[x.domain].description));

        const concurrency = 5;
        for (let batch = 0; batch < toMeta.length; batch += concurrency) {
          const chunk = toMeta.slice(batch, batch + concurrency);
          await Promise.all(chunk.map(async ({ domain, index }) => {
            const { name, description } = await getMeta(domain);
            if (name || description) {
              if (name) entryMap[domain].name = name;
              if (description) entryMap[domain].description = description;
              entries[index] = { ...entryMap[domain] };
              send({ type: "result", index, domain, entry: entries[index], phase: "meta" });
            }
          }));
          await sleep(300);
        }
      }

      // Save all to DB
      for (const e of entries) {
        if (e) await supabase.rpc("upsert_entry", { data: e });
      }

      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" } });
});

function corsHeaders() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" }; }
function jsonHeaders() { return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }; }