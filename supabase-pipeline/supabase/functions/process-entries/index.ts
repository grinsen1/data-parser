import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// Edge Function: process-entries
// Оркестратор: для каждого домена из domain_list последовательно:
//   1. CrUX rank + метрики
//   2. Скриншот (если сайт и нет кэша)
//   3. Оценка качества
//   4. Сохранение в entries
// ============================================================

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const daysThreshold = parseInt(Deno.env.get("DAYS_THRESHOLD") ?? "30");

// Типы записей по ID
function classifyEntry(id: string): "website" | "googleplay" | "appstore" {
  if (/^id\d+$/.test(id) || /^\d{6,}$/.test(id)) return "appstore";
  if (!id.includes(".")) return "googleplay";
  // есть точка → проверяем, похоже ли на домен
  return "website";
}

// Оценка качества на основе CrUX
function computeQuality(crux: any, hasScreenshot: boolean): { score: number; label: string } {
  if (!crux?.present) {
    return { score: 1, label: "unproven" };
  }

  let score = 5; // базовый балл за наличие в CrUX

  // Ранг добавляет баллы
  const tier = crux.tier ?? "E";
  if (tier === "A") score += 3;
  else if (tier === "B") score += 2;
  else if (tier === "C") score += 1;

  // Метрики
  const m = crux.metrics;
  if (m) {
    if (m.lcp !== null && m.lcp > 4000) score -= 2;
    if (m.cls !== null && m.cls > 0.25) score -= 1;
    if (m.inp !== null && m.inp > 500) score -= 1;
    if (m.hasDesktop) score += 1;
  }

  if (hasScreenshot) score += 1;

  score = Math.max(0, Math.min(10, score));

  let label = "ok";
  if (score >= 8) label = "premium";
  else if (score >= 5) label = "good";
  else if (score >= 3) label = "low";
  else label = "poor";

  return { score, label };
}

// Определение статуса удаления (как Get-RemoveStatusAndReason в parser.ps1)
function computeRemoveStatus(qualityLabel: string, visits: string): { toRemove: boolean; reason: string } {
  if (qualityLabel === "poor") return { toRemove: true, reason: "low quality" };
  if (qualityLabel === "unproven" && (!visits || visits === "0")) {
    return { toRemove: true, reason: "no data" };
  }
  return { toRemove: false, reason: "" };
}

// ----------------------------------------------------------------
// Вызов другой Edge Function
// ----------------------------------------------------------------
async function callFunction(name: string, body: Record<string, any>) {
  const projectRef = Deno.env.get("SUPABASE_URL")?.match(/https:\/\/(.+)\.supabase\.co/)?.[1] ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const url = `https://${projectRef}.supabase.co/functions/v1/${name}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  return resp.json();
}

// ============================================================
// MAIN
// ============================================================
serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const limit = body.limit ?? 30;
    const id = body.id ?? null;

    let domains: { id: string }[];

    if (id) {
      domains = [{ id }];
    } else {
      // Берём все активные домены из domain_list
      const { data } = await supabase
        .from("domain_list")
        .select("domain")
        .eq("active", true)
        .order("domain")
        .limit(limit);

      domains = (data ?? []).map((d) => ({ id: d.domain }));
    }

    const results: any[] = [];
    let processed = 0;
    let skipped = 0;

    for (const { id: entryId } of domains) {
      const type = classifyEntry(entryId);
      console.log(`[${processed + skipped + 1}/${domains.length}] ${entryId} (${type})`);

      // Проверяем, нужно ли обновлять
      const { data: existing } = await supabase
        .from("entries")
        .select("last_updated, quality_score")
        .eq("id", entryId)
        .maybeSingle();

      if (existing?.last_updated) {
        const daysSince = (Date.now() - new Date(existing.last_updated).getTime()) / 86_400_000;
        if (daysSince <= daysThreshold && existing.quality_score > 0) {
          console.log(`  [SKIP] Updated ${daysSince.toFixed(0)} days ago`);
          skipped++;
          continue;
        }
      }

      // === Шаг 1: CrUX rank + метрики ===
      let crux = null;
      if (type === "website") {
        console.log(`  [CRUX] Fetching rank + metrics...`);
        const cruxResp = await callFunction("crux-rank", { id: entryId });
        crux = cruxResp?.result;
      }

      // === Шаг 2: Скриншот ===
      let screenshotUrl = "";
      let hasScreenshot = false;
      if (type === "website") {
        console.log(`  [SCREENSHOT] Fetching...`);
        const ssResp = await callFunction("screenshot", { domain: entryId, id: entryId });
        if (ssResp?.ok) {
          screenshotUrl = ssResp.url ?? "";
          hasScreenshot = !!screenshotUrl;
          console.log(`  [SCREENSHOT] ${ssResp.cached ? "CACHED" : "NEW"}`);
        }
      }

      // === Шаг 3: Оценка качества ===
      const quality = computeQuality(crux, hasScreenshot);

      // === Шаг 4: Сохранение ===
      const { toRemove, reason } = computeRemoveStatus(quality.label, "");

      const entry = {
        id: entryId,
        entry_type: type,
        screenshot_url: screenshotUrl,
        crux_present: crux?.present ?? false,
        crux_rank_global: crux?.rankGlobal ?? null,
        crux_rank_ru: crux?.rankRu ?? null,
        crux_tier: crux?.tier ?? "E",
        crux_lcp: crux?.metrics?.lcp ?? null,
        crux_inp: crux?.metrics?.inp ?? null,
        crux_cls: crux?.metrics?.cls ?? null,
        crux_has_desktop: crux?.metrics?.hasDesktop ?? null,
        crux_has_mobile: crux?.metrics?.hasMobile ?? null,
        quality_score: quality.score,
        quality_label: quality.label,
        to_remove: toRemove,
        remove_reason: reason,
        last_updated: new Date().toISOString(),
      };

      const { error: saveErr } = await supabase.rpc("upsert_entry", {
        data: entry,
      });

      if (saveErr) {
        console.log(`  [ERROR] Save failed: ${saveErr.message}`);
      } else {
        console.log(`  [OK] Saved — tier ${crux?.tier ?? "E"}, score ${quality.score} (${quality.label})`);
      }

      results.push({ id: entryId, type, cruxTier: crux?.tier, qualityLabel: quality.label });

      processed++;
      await sleep(500); // небольшая пауза между доменами
    }

    return new Response(JSON.stringify({
      ok: true,
      total: domains.length,
      processed,
      skipped,
      results,
    }), { headers: ctype() });

  } catch (e) {
    return jsonErr(500, String(e));
  }
});

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
