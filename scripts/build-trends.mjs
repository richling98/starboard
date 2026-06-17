import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../src/backend-cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const leaderboardDir = path.join(root, "data", "leaderboards");
const SOURCE_LIMIT = 20;
const MAX_TRENDS = 5;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const SOURCE_REUSE_TTL_MS = 24 * 60 * 60 * 1000;

loadLocalEnv();

const requestTimeoutMs = Math.max(Number(process.env.STARBOARD_TREND_REQUEST_TIMEOUT_MS || 20000), 1000);
const trendModel = process.env.STARBOARD_TREND_MODEL || "gpt-5.4-mini";
const force = process.argv.includes("--force");

const trendBuckets = [
  {
    id: "ai-agent-tooling",
    name: "AI agent tooling",
    description: "Agent-focused projects are packaging reusable skills, harnesses, and workflow rules for coding assistants.",
    terms: [
      "agent", "agents", "agentic", "claude", "codex", "cursor", "mcp", "skill", "skills",
      "prompt", "llm", "ai coding", "assistant"
    ]
  },
  {
    id: "terminal-cli",
    name: "Terminal and CLI tools",
    description: "Command-line and terminal projects are improving developer workflows with faster shells, richer interfaces, and local automation.",
    terms: [
      "terminal", "shell", "cli", "command line", "console", "tui", "pty", "emulator",
      "prompt", "zsh", "bash", "developer tools"
    ]
  },
  {
    id: "browser-visual-automation",
    name: "Browser and visual automation",
    description: "New tools are using screenshots, browser control, and visual checks to automate testing and product workflows.",
    terms: [
      "screenshot", "screen", "browser", "playwright", "puppeteer", "visual", "ui test",
      "automation", "web", "capture", "computer use"
    ]
  },
  {
    id: "data-search-infra",
    name: "Data, search, and infrastructure",
    description: "Infrastructure projects are clustering around databases, search, indexing, observability, and deployment foundations.",
    terms: [
      "database", "db", "postgres", "sqlite", "search", "index", "vector", "embedding",
      "observability", "deploy", "server", "infra", "cloud", "api"
    ]
  },
  {
    id: "developer-education",
    name: "Developer education and playbooks",
    description: "Guides and playbooks are turning emerging engineering practices into reusable learning material.",
    terms: [
      "guide", "book", "playbook", "course", "learn", "tutorial", "engineering",
      "principles", "rules", "best practices", "documentation"
    ]
  },
  {
    id: "ui-product-frameworks",
    name: "UI and product frameworks",
    description: "Frontend projects are shipping interface kits, product scaffolds, and reusable app-building patterns.",
    terms: [
      "ui", "frontend", "react", "vue", "svelte", "component", "design", "css",
      "dashboard", "app", "framework", "template"
    ]
  }
];

const [todaySnapshot, weekSnapshot] = await Promise.all([
  readSnapshot("repositories-today.json"),
  readSnapshot("repositories-week.json")
]);

const repos = dedupeRepos([
  ...(todaySnapshot.rows || []).slice(0, SOURCE_LIMIT).map((repo) => withSourcePeriod(repo, "today")),
  ...(weekSnapshot.rows || []).slice(0, SOURCE_LIMIT).map((repo) => withSourcePeriod(repo, "week"))
]);
const sourceHash = hashTrendSource(repos);
const existingSnapshot = await readOptionalSnapshot("trends.json");
if (!force && canReuseSnapshot(existingSnapshot, sourceHash)) {
  console.log(`Reusing existing trends snapshot for unchanged source hash ${sourceHash}.`);
  process.exit(0);
}

const result = await buildTrendRows(repos);
const payload = {
  generatedAt: new Date().toISOString(),
  total: result.trends.length,
  totalIndexedCount: repos.length,
  coverageLabel: `Showing ${result.trends.length.toLocaleString("en")} trends from the top ${SOURCE_LIMIT} today and week repositories.`,
  metadata: {
    generatedBy: "scripts/build-trends.mjs",
    mode: result.mode,
    model: result.model || null,
    sourceHash,
    sourcePeriods: ["today", "week"],
    sourceLimit: SOURCE_LIMIT,
    maxTrends: MAX_TRENDS,
    fallbackReason: result.fallbackReason || null
  },
  rows: result.trends
};

await writeFile(path.join(leaderboardDir, "trends.json"), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Generated ${result.trends.length} trends from ${repos.length} repositories using ${result.mode}.`);

async function readSnapshot(fileName) {
  return JSON.parse(await readFile(path.join(leaderboardDir, fileName), "utf8"));
}

async function readOptionalSnapshot(fileName) {
  try {
    return await readSnapshot(fileName);
  } catch {
    return null;
  }
}

function canReuseSnapshot(snapshot, hash) {
  if (!snapshot?.metadata?.sourceHash || snapshot.metadata.sourceHash !== hash) return false;
  const generatedAt = Date.parse(snapshot.generatedAt || "");
  if (!Number.isFinite(generatedAt)) return false;
  return Date.now() - generatedAt < SOURCE_REUSE_TTL_MS;
}

function withSourcePeriod(repo, period) {
  return {
    ...repo,
    sourcePeriods: [...new Set([...(repo.sourcePeriods || []), period])]
  };
}

function dedupeRepos(sourceRepos) {
  const byId = new Map();
  for (const repo of sourceRepos) {
    const key = String(repo.id || repo.fullName);
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, repo);
      continue;
    }

    byId.set(key, {
      ...existing,
      stars: Math.max(existing.stars || 0, repo.stars || 0),
      forks: Math.max(existing.forks || 0, repo.forks || 0),
      sourcePeriods: [...new Set([...(existing.sourcePeriods || []), ...(repo.sourcePeriods || [])])]
    });
  }
  return [...byId.values()];
}

async function buildTrendRows(sourceRepos) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.STARBOARD_OPENAI_API_KEY;
  if (!apiKey) {
    return {
      trends: buildHeuristicTrends(sourceRepos),
      mode: "heuristic",
      fallbackReason: "OPENAI_API_KEY or STARBOARD_OPENAI_API_KEY is not configured"
    };
  }

  try {
    const candidates = await generateLlmTrendCandidates(sourceRepos, apiKey);
    const trends = validateTrendCandidates(candidates, sourceRepos);
    if (trends.length) {
      return { trends, mode: "llm", model: trendModel };
    }
    return {
      trends: buildHeuristicTrends(sourceRepos),
      mode: "heuristic",
      model: trendModel,
      fallbackReason: "LLM returned no valid multi-repo trends"
    };
  } catch (error) {
    return {
      trends: buildHeuristicTrends(sourceRepos),
      mode: "heuristic",
      model: trendModel,
      fallbackReason: `LLM trend generation failed: ${error.message || error}`
    };
  }
}

async function generateLlmTrendCandidates(sourceRepos, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: trendModel,
      instructions: [
        "You identify concise technology trends from GitHub repository metadata.",
        "Return JSON only. Do not include markdown.",
        "Use only the supplied repositories. Do not invent repositories, stars, forks, or facts.",
        "Prefer specific trend names over broad labels like Developer tools.",
        "Return at most five trends. Each trend should usually contain at least two repositories."
      ].join("\n"),
      input: JSON.stringify({
        task: "Cluster these top daily and weekly GitHub repositories into no more than five major trends.",
        outputShape: {
          trends: [
            {
              name: "Short trend name",
              description: "One sentence explaining what is happening.",
              repoIds: ["repository id strings from input only"]
            }
          ]
        },
        repositories: sourceRepos.map((repo) => ({
          id: String(repo.id || repo.fullName),
          fullName: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          description: repo.description || "",
          language: repo.language || "",
          topics: repo.topics || [],
          stars: repo.stars || 0,
          forks: repo.forks || 0,
          sourcePeriods: repo.sourcePeriods || []
        }))
      })
    })
  }).finally(() => clearTimeout(timeout));

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI trend request failed: ${response.status}`);
  }

  const text = extractResponseText(data);
  const parsed = parseJsonObject(text);
  return Array.isArray(parsed?.trends) ? parsed.trends : [];
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("LLM returned an empty response");
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(withoutFence);
}

function validateTrendCandidates(candidates, sourceRepos) {
  const reposById = new Map(sourceRepos.map((repo) => [String(repo.id || repo.fullName), repo]));
  const usedRepoIds = new Set();
  const trends = [];

  for (const candidate of candidates) {
    if (trends.length >= MAX_TRENDS) break;
    const repoIds = Array.isArray(candidate?.repoIds) ? candidate.repoIds.map(String) : [];
    const repos = [];
    for (const repoId of repoIds) {
      const repo = reposById.get(repoId);
      if (!repo || usedRepoIds.has(repoId)) continue;
      repos.push(repo);
      usedRepoIds.add(repoId);
    }
    if (repos.length < 2) continue;

    const sortedRepos = repos.sort((a, b) => (b.stars || 0) - (a.stars || 0));
    trends.push({
      id: slugify(candidate.name || `trend-${trends.length + 1}`),
      name: cleanTrendText(candidate.name, `Trend ${trends.length + 1}`, 64),
      description: cleanTrendText(candidate.description, "Related repositories are gaining traction together.", 180),
      stars: sortedRepos.reduce((total, repo) => total + Number(repo.stars || 0), 0),
      forks: sortedRepos.reduce((total, repo) => total + Number(repo.forks || 0), 0),
      repoCount: sortedRepos.length,
      repos: sortedRepos
    });
  }

  return trends
    .sort((a, b) => {
      if (b.stars !== a.stars) return b.stars - a.stars;
      return b.repoCount - a.repoCount;
    })
    .slice(0, MAX_TRENDS)
    .map((trend, index) => ({ ...trend, rank: index + 1 }));
}

function buildHeuristicTrends(sourceRepos) {
  const assignments = new Map();
  const usedRepoIds = new Set();

  for (const repo of sourceRepos) {
    const scored = scoreRepo(repo)
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    const best = scored[0];
    const list = assignments.get(best.bucket.id) || [];
    list.push({ repo, score: best.score });
    assignments.set(best.bucket.id, list);
  }

  const rows = [];
  for (const bucket of trendBuckets) {
    const assigned = (assignments.get(bucket.id) || [])
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.repo.stars || 0) - (a.repo.stars || 0);
      })
      .map(({ repo }) => repo)
      .filter((repo) => {
        const key = String(repo.id || repo.fullName);
        if (usedRepoIds.has(key)) return false;
        usedRepoIds.add(key);
        return true;
      });

    if (assigned.length < 2) continue;
    const sortedRepos = assigned.sort((a, b) => (b.stars || 0) - (a.stars || 0));
    rows.push({
      id: bucket.id,
      name: bucket.name,
      description: bucket.description,
      stars: sortedRepos.reduce((total, repo) => total + Number(repo.stars || 0), 0),
      forks: sortedRepos.reduce((total, repo) => total + Number(repo.forks || 0), 0),
      repoCount: sortedRepos.length,
      repos: sortedRepos
    });
  }

  return rows
    .sort((a, b) => {
      if (b.stars !== a.stars) return b.stars - a.stars;
      return b.repoCount - a.repoCount;
    })
    .slice(0, MAX_TRENDS)
    .map((trend, index) => ({ ...trend, rank: index + 1 }));
}

function hashTrendSource(sourceRepos) {
  const stableSource = sourceRepos
    .map((repo) => ({
      id: String(repo.id || repo.fullName),
      fullName: repo.fullName,
      name: repo.name,
      description: repo.description || "",
      language: repo.language || "",
      topics: repo.topics || [],
      stars: repo.stars || 0,
      forks: repo.forks || 0,
      sourcePeriods: repo.sourcePeriods || []
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(stableSource)).digest("hex").slice(0, 16);
}

function slugify(value) {
  return String(value || "trend")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "trend";
}

function cleanTrendText(value, fallback, maxLength) {
  const cleaned = String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function scoreRepo(repo) {
  const text = [
    repo.name,
    repo.fullName,
    repo.description,
    repo.language,
    ...(repo.topics || [])
  ]
    .join(" ")
    .toLowerCase();

  return trendBuckets.map((bucket) => {
    const score = bucket.terms.reduce((total, term) => {
      const normalizedTerm = term.toLowerCase();
      if (!text.includes(normalizedTerm)) return total;
      const topicBonus = (repo.topics || []).some((topic) => topic.toLowerCase().includes(normalizedTerm)) ? 2 : 0;
      return total + 1 + topicBonus;
    }, 0);
    return { bucket, score };
  });
}
