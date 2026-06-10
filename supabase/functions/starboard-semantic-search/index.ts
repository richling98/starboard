import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const MODEL = Deno.env.get("STARBOARD_EMBEDDING_MODEL") || "text-embedding-3-small";
const DIMENSIONS = Number(Deno.env.get("STARBOARD_EMBEDDING_DIMENSIONS") || "1024");
const ALLOWED_ORIGIN = Deno.env.get("STARBOARD_ALLOWED_ORIGIN") || "https://richling98.github.io";

serve(async (request) => {
  const corsHeaders = {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "content-type": "application/json; charset=utf-8"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  try {
    const payload = await request.json().catch(() => ({}));
    const query = String(payload.query || "").trim();
    if (query.length < 3) {
      return json({ mode: "semantic", query, rows: [], total: 0 }, 200, corsHeaders);
    }

    const period = normalize(payload.period, ["today", "week", "month", "all"], "all");
    const view = normalize(payload.view, ["repositories", "accounts"], "repositories");
    const limit = clamp(Number(payload.limit || 20), 1, 200);
    const offset = Math.max(Number(payload.offset || 0), 0);
    const sortKey = normalize(payload.sortKey, ["relevance", "stars", "forks", "repos"], "relevance");
    const sortDirection = payload.sortDirection === "asc" ? "asc" : "desc";
    const matchLimit = clamp(Number(payload.matchLimit || 1000), 20, 1000);

    const queryEmbedding = await createEmbedding(query);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || requiredEnv("STARBOARD_SUPABASE_URL"),
      Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("STARBOARD_SERVICE_ROLE_KEY") || requiredEnv("STARBOARD_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabase.rpc("match_semantic_repositories", {
      query_embedding: vectorLiteral(queryEmbedding),
      target_period: period,
      embedding_model_filter: MODEL,
      match_count: matchLimit,
      min_similarity: 0.18
    });

    if (error) throw new Error(error.message);

    const repos = (data || []).map(repoFromRpc);
    const rows = view === "accounts"
      ? accountRows(repos, sortKey, sortDirection).slice(offset, offset + limit)
      : sortRepoRows(repos, sortKey, sortDirection).slice(offset, offset + limit);
    const total = view === "accounts" ? accountRows(repos, sortKey, sortDirection).length : repos.length;

    return json({
      mode: "semantic",
      query,
      period,
      view,
      model: MODEL,
      dimensions: DIMENSIONS,
      total,
      rows: rows.map((row, index) => ({ ...row, rank: offset + index + 1 }))
    }, 200, corsHeaders);
  } catch (error) {
    return json({ error: error.message || "Semantic search failed." }, 500, corsHeaders);
  }
});

async function createEmbedding(input: string): Promise<number[]> {
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      input,
      model: MODEL,
      dimensions: DIMENSIONS
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI embeddings request failed: ${response.status}`);
  }
  return data.data?.[0]?.embedding || [];
}

function repoFromRpc(row: Record<string, unknown>) {
  return {
    id: row.github_id,
    fullName: row.full_name,
    owner: row.owner_login,
    ownerId: row.owner_github_id,
    ownerType: row.owner_type || "User",
    ownerUrl: row.owner_html_url || `https://github.com/${row.owner_login}`,
    name: row.name,
    description: row.description || "",
    language: row.language || "Unknown",
    topics: row.topics || [],
    stars: row.stars || 0,
    forks: row.forks || 0,
    fork: Boolean(row.fork),
    archived: Boolean(row.archived),
    avatar: row.avatar_url,
    repoUrl: row.html_url,
    defaultBranch: row.default_branch || "main",
    createdAt: row.repo_created_at,
    pushedAt: row.repo_pushed_at,
    updatedAt: row.repo_updated_at,
    semanticScore: Number(row.semantic_score || 0)
  };
}

function sortRepoRows(repos: ReturnType<typeof repoFromRpc>[], sortKey: string, sortDirection: string) {
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...repos].sort((a, b) => {
    if (sortKey === "stars" && a.stars !== b.stars) return (a.stars - b.stars) * direction;
    if (sortKey === "forks" && a.forks !== b.forks) return (a.forks - b.forks) * direction;
    if (a.semanticScore !== b.semanticScore) return (a.semanticScore - b.semanticScore) * direction;
    if (a.stars !== b.stars) return b.stars - a.stars;
    return String(a.fullName).localeCompare(String(b.fullName));
  });
}

function accountRows(repos: ReturnType<typeof repoFromRpc>[], sortKey: string, sortDirection: string) {
  const byOwner = new Map<string, any>();
  for (const repo of repos) {
    const key = String(repo.ownerId);
    const account = byOwner.get(key) || {
      id: key,
      login: repo.owner,
      type: repo.ownerType,
      avatarUrl: repo.avatar,
      htmlUrl: repo.ownerUrl,
      starScore: 0,
      repoCount: 0,
      matchingRepoCount: 0,
      semanticScore: 0,
      topRepo: null,
      repoNames: [],
      repos: [],
      enriched: true
    };
    account.starScore += Number(repo.stars || 0);
    account.repoCount += 1;
    account.matchingRepoCount += 1;
    account.semanticScore = Math.max(account.semanticScore, repo.semanticScore || 0);
    account.repoNames.push(repo.fullName);
    account.repos.push(repo);
    if (!account.topRepo || repo.stars > account.topRepo.stars) {
      account.topRepo = {
        name: repo.name,
        fullName: repo.fullName,
        stars: repo.stars,
        url: repo.repoUrl
      };
    }
    byOwner.set(key, account);
  }

  const direction = sortDirection === "asc" ? 1 : -1;
  return [...byOwner.values()].sort((a, b) => {
    if (sortKey === "stars" && a.starScore !== b.starScore) return (a.starScore - b.starScore) * direction;
    if (sortKey === "repos" && a.repoCount !== b.repoCount) return (a.repoCount - b.repoCount) * direction;
    if (a.semanticScore !== b.semanticScore) return (a.semanticScore - b.semanticScore) * direction;
    if (a.starScore !== b.starScore) return b.starScore - a.starScore;
    return a.login.localeCompare(b.login);
  });
}

function vectorLiteral(values: number[]) {
  return `[${values.map((value) => Number(value) || 0).join(",")}]`;
}

function normalize(value: unknown, allowed: string[], fallback: string) {
  const text = String(value || "");
  return allowed.includes(text) ? text : fallback;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function requiredEnv(name: string) {
  if (name === "OPENAI_API_KEY") {
    const openaiKey = Deno.env.get("STARBOARD_OPENAI_API_KEY") || Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) throw new Error("STARBOARD_OPENAI_API_KEY is not configured.");
    return openaiKey;
  }
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return ALLOWED_ORIGIN;
  return origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
}

function json(payload: Record<string, unknown>, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(payload), { status, headers });
}
