import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const MODEL = Deno.env.get("STARBOARD_EMBEDDING_MODEL") || "text-embedding-3-small";
const DIMENSIONS = Number(Deno.env.get("STARBOARD_EMBEDDING_DIMENSIONS") || "1024");
const MAX_QUERY_CHARS = Number(Deno.env.get("STARBOARD_MAX_QUERY_CHARS") || "300");
const MAX_BODY_BYTES = Number(Deno.env.get("STARBOARD_MAX_BODY_BYTES") || "4096");
const RATE_LIMIT_WINDOW_MS = Number(Deno.env.get("STARBOARD_RATE_LIMIT_WINDOW_MS") || "60000");
const RATE_LIMIT_MAX_REQUESTS = Number(Deno.env.get("STARBOARD_RATE_LIMIT_MAX_REQUESTS") || "60");
const DEFAULT_ALLOWED_ORIGINS = [
  "https://starboard.place",
  "https://richling98.github.io",
  "https://starboard-xi.vercel.app"
];
const ALLOWED_ORIGINS = (Deno.env.get("STARBOARD_ALLOWED_ORIGIN") || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const rateLimitBuckets = new Map<string, { windowStartedAt: number; count: number }>();

serve(async (request) => {
  const requestOrigin = request.headers.get("origin");
  const corsHeaders = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin) ? {
    "access-control-allow-origin": requestOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8"
  } : { "content-type": "application/json; charset=utf-8" };

  if (!requestOrigin || !ALLOWED_ORIGINS.includes(requestOrigin)) {
    return json({ error: "Origin not allowed." }, 403, corsHeaders);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  try {
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Request body too large." }, 413, corsHeaders);
    }

    if (!checkRateLimit(clientKey(request))) {
      return json({ error: "Too many requests." }, 429, corsHeaders);
    }

    const payload = await request.json().catch(() => ({}));
    const query = String(payload.query || "").trim();
    if (query.length < 3) {
      return json({ mode: "semantic", query, rows: [], total: 0 }, 200, corsHeaders);
    }
    if (query.length > MAX_QUERY_CHARS) {
      return json({ error: `Query must be ${MAX_QUERY_CHARS} characters or fewer.` }, 400, corsHeaders);
    }

    const period = normalize(payload.period, ["today", "week", "month", "all"], "all");
    const view = normalize(payload.view, ["repositories", "accounts"], "repositories");
    const limit = clamp(Number(payload.limit || 20), 1, 200);
    const offset = Math.max(Number(payload.offset || 0), 0);
    const sortKey = normalize(payload.sortKey, ["relevance", "stars", "forks", "repos"], "stars");
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
    console.error(error);
    return json({ error: "Semantic search failed." }, 500, corsHeaders);
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

function clientKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  return forwardedFor.split(",")[0].trim() || "unknown";
}

function checkRateLimit(key: string) {
  const now = Date.now();
  const current = rateLimitBuckets.get(key);
  if (!current || now - current.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(key, { windowStartedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_MAX_REQUESTS;
}

function json(payload: Record<string, unknown>, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(payload), { status, headers });
}
