import {
  closePool,
  finishIngestionRun,
  listEnabledDiscoveryQueries,
  markDiscoveryQueryRun,
  seedDefaultDiscoveryQueries,
  startIngestionRun,
  upsertRepositories
} from "../db.mjs";
import {
  GITHUB_FETCH_PAGE_SIZE,
  MAX_GITHUB_PAGE,
  SEARCH_REQUEST_SPACING_MS,
  loadLocalEnv
} from "../backend-cache.mjs";
import { assessEnglishContent, cleanMarkdownForLanguageCheck } from "../language-gate.mjs";

const GITHUB_API = "https://api.github.com";
const args = parseArgs(process.argv.slice(2));

loadLocalEnv();

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is not configured. Add it to .env.local.");
  process.exit(1);
}

const maxQueries = Number(args["max-queries"] || process.env.STARBOARD_MAX_QUERIES || 20);
const maxPages = Math.min(Number(args["max-pages"] || process.env.STARBOARD_MAX_PAGES || 2), MAX_GITHUB_PAGE);
const readmeLimit = Number(args["readme-limit"] || process.env.STARBOARD_README_LIMIT || 240);
const period = args.period || process.env.STARBOARD_PERIOD || "";
const forceSeed = args.seed !== "false";

let runId;
const summary = {
  queries: 0,
  githubRequests: 0,
  reposDiscovered: 0,
  accountsDiscovered: 0,
  failedQueries: 0
};

try {
  if (forceSeed) await seedDefaultDiscoveryQueries();
  runId = await startIngestionRun("discover-repositories", { maxQueries, maxPages, period: period || "all-enabled" });
  const queries = await listEnabledDiscoveryQueries({ period: period || null, limit: maxQueries });

  for (const queryConfig of queries) {
    summary.queries += 1;
    try {
      const result = await runDiscoveryQuery(queryConfig, maxPages, readmeLimit);
      summary.githubRequests += result.githubRequests;
      summary.reposDiscovered += result.reposDiscovered;
      summary.accountsDiscovered += result.accountsDiscovered;
      await markDiscoveryQueryRun(queryConfig.queryKey, {
        status: "completed",
        resultCount: result.reposDiscovered,
        metadata: { githubRequests: result.githubRequests }
      });
      console.log(`${queryConfig.queryKey}: ${result.reposDiscovered} repos`);
    } catch (error) {
      summary.failedQueries += 1;
      await markDiscoveryQueryRun(queryConfig.queryKey, {
        status: "failed",
        resultCount: 0,
        metadata: { error: error.message || String(error) }
      });
      console.error(`${queryConfig.queryKey}: ${error.message || error}`);
    }
  }

  await finishIngestionRun(runId, {
    status: summary.failedQueries ? "completed_with_errors" : "completed",
    ...summary
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (runId) {
    await finishIngestionRun(runId, {
      status: "failed",
      errorMessage: error.message || String(error),
      ...summary
    });
  }
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}

async function runDiscoveryQuery(queryConfig, maxPagesForQuery, readmeLimitForQuery) {
  const reposById = new Map();
  let githubRequests = 0;
  let readmeRequests = 0;

  for (let page = 1; page <= maxPagesForQuery; page += 1) {
    const query = expandRollingQuery(queryConfig.query, queryConfig.period);
    const endpoint = `/search/repositories?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(queryConfig.sort || "stars")}&order=desc&per_page=${GITHUB_FETCH_PAGE_SIZE}&page=${page}`;
    const { data, headers } = await githubFetch(endpoint);
    githubRequests += 1;

    const repos = (data.items || [])
      .map(normalizeRepo)
      .filter((repo) => repo.stars >= 1 && !repo.fork && !repo.archived);

    for (const repo of repos.slice(0, readmeLimitForQuery)) {
      const readme = await fetchReadme(repo);
      readmeRequests += 1;
      const english = assessEnglishContent(repo.description, readme);
      repo.englishCheckStatus = english.status;
      repo.englishCheckConfidence = english.confidence;
      repo.englishCheckedAt = new Date().toISOString();
    }

    repos.forEach((repo) => reposById.set(String(repo.id), repo));
    await upsertRepositories(repos, { sourceQueryKey: queryConfig.queryKey });
    await waitForSearchBudget(headers);

    if (!hasNextLink(headers) || !repos.length) break;
  }

  const repos = [...reposById.values()];
  return {
    githubRequests: githubRequests + readmeRequests,
    reposDiscovered: repos.length,
    accountsDiscovered: new Set(repos.map((repo) => String(repo.ownerId))).size
  };
}

async function githubFetch(pathname) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "user-agent": "starboard-discovery-job",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    const reset = response.headers.get("x-ratelimit-reset");
    const resetText = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "later";
    throw new Error(`GitHub request failed: ${response.status}. Try again after ${resetText}.`);
  }

  return {
    data: await response.json(),
    headers: response.headers
  };
}

function normalizeRepo(item) {
  const owner = item.owner?.login || "unknown";
  const description = item.description || "";
  const english = assessEnglishContent(description);
  return {
    id: item.id,
    fullName: item.full_name || `${owner}/${item.name}`,
    owner,
    ownerId: String(item.owner?.id || owner),
    ownerType: item.owner?.type || "User",
    ownerUrl: item.owner?.html_url || `https://github.com/${owner}`,
    name: item.name,
    description,
    language: item.language || "Unknown",
    topics: item.topics || [],
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
    fork: Boolean(item.fork),
    archived: Boolean(item.archived),
    avatar: item.owner?.avatar_url,
    repoUrl: item.html_url,
    defaultBranch: item.default_branch || "main",
    createdAt: item.created_at || null,
    pushedAt: item.pushed_at || null,
    updatedAt: item.updated_at || null,
    englishCheckStatus: english.status,
    englishCheckConfidence: english.confidence,
    englishCheckedAt: new Date().toISOString()
  };
}

function expandRollingQuery(query, period) {
  if (!query.includes("{cutoff}")) return query;
  return query.replaceAll("{cutoff}", cutoffDate(period));
}

function cutoffDate(period) {
  const days = { today: 1, week: 7, month: 30 }[period] || 30;
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

async function fetchReadme(repo) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  const endpoint = `/repos/${owner}/${name}/readme`;

  try {
    const { data } = await githubFetch(endpoint);
    if (!data?.download_url) return "";
    const response = await fetch(data.download_url, {
      headers: { "user-agent": "starboard-language-job" }
    });
    if (!response.ok) return "";
    return cleanMarkdownForLanguageCheck(await response.text()).slice(0, 20000);
  } catch {
    return "";
  }
}

function hasNextLink(headers) {
  return headers.get("link")?.includes('rel="next"') || false;
}

async function waitForSearchBudget(headers) {
  const remaining = Number(headers.get("x-ratelimit-remaining") || 1);
  const reset = Number(headers.get("x-ratelimit-reset") || 0);
  if (remaining <= 1 && reset) {
    await delay(Math.max(reset * 1000 - Date.now(), SEARCH_REQUEST_SPACING_MS));
    return;
  }
  await delay(SEARCH_REQUEST_SPACING_MS);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    })
  );
}
