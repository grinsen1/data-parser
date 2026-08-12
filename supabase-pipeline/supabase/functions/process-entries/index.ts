import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const daysThreshold = parseInt(Deno.env.get("DAYS_THRESHOLD") ?? "30");

function classifyEntry(id: string) {
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
function computeQuality(tier: string) {
  if (tier === "E") return { score: 1, label: "unproven" };
  let score = 5;
  if (tier === "A") score += 3;
  else if (tier === "B") score += 2;
  else if (tier === "C") score += 1;
  const label = score >= 8 ? "premium" : score >= 5 ? "good" : score >= 3 ? "low" : "poor";
  return { score: Math.min(10, Math.max(0, score)), label };
}

async function getCruxRank(domain: string) {
  const { data: ranks } = await supabase.from("crux_ranks").select("scope, rank").eq("domain", domain);
  const g = (ranks ?? []).find((r: any) => r.scope === "global")?.rank ?? null;
  const ru = (ranks ?? []).find((r: any) => r.scope === "ru")?.rank ?? null;
  const best = [g, ru].filter((r): r is number => r != null);
  return { rankGlobal: g, rankRu: ru, tier: computeTier(best.length > 0 ? Math.min(...best) : null) };
}

// ============================================================
// RANK — returns JSON array, no SSE
// ============================================================
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
    const domains: string[] = (body.domains ?? []).map((d: string) => d.trim()).filter(Boolean);

    if (domains.length === 0) {
      return new Response(JSON.stringify({ error: "No domains" }), {
        status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const results: any[] = [];

    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      const type = classifyEntry(domain);

      // Check cache
      const { data: cached } = await supabase.from("entries").select("*").eq("id", domain).maybeSingle();
      if (cached?.last_updated) {
        const daysSince = (Date.now() - new Date(cached.last_updated).getTime()) / 86_400_000;
        if (daysSince <= daysThreshold && cached.quality_score > 0) {
          results.push({ ...cached, _source: "cache" });
          continue;
        }
      }

      const { rankGlobal, rankRu, tier } = type === "website"
        ? await getCruxRank(domain)
        : { rankGlobal: null, rankRu: null, tier: "E" };

      const quality = computeQuality(tier);
      const toRemove = quality.label === "unproven" || quality.label === "poor";

      const entry = {
        id: domain,
        name: cached?.name || "",
        description: cached?.description || "",
        entry_type: type,
        screenshot_url: cached?.screenshot_url || "",
        crux_present: (rankGlobal !== null || rankRu !== null),
        crux_rank_global: rankGlobal,
        crux_rank_ru: rankRu,
        crux_tier: tier,
        quality_score: quality.score,
        quality_label: quality.label,
        to_remove: toRemove,
        remove_reason: toRemove ? "low quality" : "",
        last_updated: new Date().toISOString(),
        _source: "fresh",
      };

      await supabase.rpc("upsert_entry", { data: entry });
      results.push(entry);
    }

    return new Response(JSON.stringify({ ok: true, total: domains.length, results }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
