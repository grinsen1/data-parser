import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// Edge Function: crux-rank
// Запрашивает CrUX REST API (наличие + метрики) и
// ищет ранг в локальной таблице crux_ranks (SQLite-подобная)
// ============================================================

const PAGESPEED_API_KEY = Deno.env.get("PAGESPEED_API_KEY") ?? "";
const CRUX_API_URL = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

interface CruxMetrics {
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  hasDesktop: boolean;
  hasMobile: boolean;
}

interface CruxResult {
  present: boolean;
  rankGlobal: number | null;
  rankRu: number | null;
  tier: string; // A / B / C / D / E
  metrics: CruxMetrics | null;
}

const TIERS: [number, string][] = [
  [1_000, "A"],
  [5_000, "B"],
  [10_000, "B"],
  [50_000, "B"],
  [100_000, "C"],
  [500_000, "C"],
  [1_000_000, "D"],
];

function computeTier(rank: number | null): string {
  if (rank === null) return "E";
  for (const [limit, label] of TIERS) {
    if (rank <= limit) return label;
  }
  return "D";
}

// ----------------------------------------------------------------
// CrUX REST API: проверяет наличие сайта в базе и получает метрики
// ----------------------------------------------------------------
async function fetchCruxRest(domain: string): Promise<{ present: boolean; metrics: CruxMetrics | null }> {
  const body = JSON.stringify({ origin: `https://${domain}` });
  const params = PAGESPEED_API_KEY ? `?key=${PAGESPEED_API_KEY}` : "";

  try {
    const resp = await fetch(CRUX_API_URL + params, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.status === 404 || resp.status === 429) {
      return { present: false, metrics: null };
    }

    const json = await resp.json();
    const record = json?.record;

    if (!record) return { present: false, metrics: null };

    const metrics = record.metrics ?? {};
    const ff = record.collectionPeriods ?? [];

    return {
      present: true,
      metrics: {
        lcp: extractPercentile(metrics.largest_contentful_paint, 0.75),
        inp: extractPercentile(metrics.interaction_to_next_paint, 0.75),
        cls: extractPercentile(metrics.cumulative_layout_shift, 0.75),
        hasDesktop: ff.some((p: any) => p.formFactor === "DESKTOP"),
        hasMobile: ff.some((p: any) => p.formFactor === "PHONE"),
      },
    };
  } catch {
    return { present: false, metrics: null };
  }
}

function extractPercentile(metric: any, pct: number): number | null {
  if (!metric?.histogram) return null;
  const bins = metric.histogram;
  let cumulative = 0;
  for (const bin of bins) {
    cumulative += bin.density ?? 0;
    if (cumulative >= pct) return (bin.start ?? 0) + ((bin.end ?? 0) - (bin.start ?? 0)) / 2;
  }
  return null;
}

// ----------------------------------------------------------------
// Локальный ранг из crux_ranks (загружается из crux-top-lists)
// ----------------------------------------------------------------
async function fetchCruxRank(
  client: ReturnType<typeof createClient>,
  domain: string,
): Promise<{ rankGlobal: number | null; rankRu: number | null }> {
  const { data } = await client
    .from("crux_ranks")
    .select("scope, rank")
    .eq("domain", domain);

  const ranks: Record<string, number> = {};
  for (const row of data ?? []) {
    if (!ranks[row.scope] || row.rank < ranks[row.scope]) {
      ranks[row.scope] = row.rank;
    }
  }

  return {
    rankGlobal: ranks["global"] ?? null,
    rankRu: ranks["ru"] ?? null,
  };
}

// ============================================================
// MAIN
// ============================================================
serve(async (req: Request) => {
  try {
    const { id } = await req.json();
    if (!id) return jsonErr(400, "id is required");

    const domain = id.replace(/^https?:\/\//, "").replace(/\/$/, "");

    // DOMAIN vs APP: проверяем CrUX только для доменов
    if (!domain.includes(".") || domain.match(/^\d+$/)) {
      return new Response(JSON.stringify({
        result: {
          present: false,
          rankGlobal: null,
          rankRu: null,
          tier: "E",
          metrics: null,
        } as CruxResult,
      }), { headers: ctype() });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Параллельно запрашиваем REST API и локальный ранг
    const [cruxRest, { rankGlobal, rankRu }] = await Promise.all([
      fetchCruxRest(domain),
      fetchCruxRank(supabase, domain),
    ]);

    const bestRank = [rankGlobal, rankRu].filter((r): r is number => r !== null);
    const tier = computeTier(bestRank.length > 0 ? Math.min(...bestRank) : null);

    const result: CruxResult = {
      present: cruxRest.present,
      rankGlobal,
      rankRu,
      tier,
      metrics: cruxRest.metrics,
    };

    return new Response(JSON.stringify({ result }), { headers: ctype() });

  } catch (e) {
    return jsonErr(500, String(e));
  }
});

function ctype() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
}

function jsonErr(code: number, msg: string) {
  return new Response(JSON.stringify({ error: true, code, message: msg }), {
    status: code,
    headers: ctype(),
  });
}
