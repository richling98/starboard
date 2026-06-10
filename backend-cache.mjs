import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAccountRefreshMap,
  hasDatabaseUrl,
  readAllTimeAccountsFromDb,
  upsertAccountDetail
} from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_API = "https://api.github.com";
const CACHE_DIR = path.join(__dirname, ".cache");
const ALL_TIME_ACCOUNTS_PATH = path.join(CACHE_DIR, "all-time-accounts.json");
const GITHUB_SEARCH_RESULT_CAP = 1000;
const GITHUB_FETCH_PAGE_SIZE = 100;
const MAX_GITHUB_PAGE = GITHUB_SEARCH_RESULT_CAP / GITHUB_FETCH_PAGE_SIZE;
const DEFAULT_OWNER_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEED_PAGES = 2;
const SEARCH_REQUEST_SPACING_MS = 2200;

export {
  ALL_TIME_ACCOUNTS_PATH,
  DEFAULT_OWNER_TTL_MS,
  DEFAULT_SEED_PAGES,
  GITHUB_FETCH_PAGE_SIZE,
  MAX_GITHUB_PAGE,
  SEARCH_REQUEST_SPACING_MS
};

export function loadLocalEnv() {
  [".env.local", ".supabase-secrets.local"].forEach((fileName) => loadEnvFile(path.join(__dirname, fileName)));
}

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

export async function readAllTimeAccountsCache() {
  if (hasDatabaseUrl()) {
    const dbRows = await readAllTimeAccountsFromDb({ limit: 500 });
    return {
      generatedAt: dbRows.generatedAt,
      seedPages: dbRows.seedPages || 0,
      accounts: Object.fromEntries(dbRows.rows.map((account) => [account.id, account]))
    };
  }

  try {
    const raw = await readFile(ALL_TIME_ACCOUNTS_PATH, "utf8");
    const cache = JSON.parse(raw);
    return {
      generatedAt: cache.generatedAt || null,
      seedPages: cache.seedPages || 0,
      accounts: cache.accounts || {}
    };
  } catch {
    return {
      generatedAt: null,
      seedPages: 0,
      accounts: {}
    };
  }
}

export async function writeAllTimeAccountsCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  const accounts = cache.accounts || {};
  const normalized = {
    generatedAt: new Date().toISOString(),
    seedPages: cache.seedPages || 0,
    accountCount: Object.keys(accounts).length,
    accounts
  };
  await writeFile(ALL_TIME_ACCOUNTS_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
}

export function getAllTimeAccountRows(cache, options = {}) {
  const query = (options.query || "").trim().toLowerCase();
  const sortKey = options.sortKey === "repos" ? "repos" : "stars";
  const sortDirection = options.sortDirection === "asc" ? "asc" : "desc";
  const offset = Math.max(Number(options.offset || 0), 0);
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 500);

  const rows = Object.values(cache.accounts || {})
    .filter((account) => !query || accountMatchesQuery(account, query))
    .sort((a, b) => compareAccounts(a, b, sortKey, sortDirection));

  return {
    generatedAt: cache.generatedAt,
    seedPages: cache.seedPages || 0,
    total: rows.length,
    rows: rows.slice(offset, offset + limit)
  };
}

export async function refreshAllTimeAccounts(options = {}) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not configured. Add it to .env.local.");
  }

  const seedPages = Math.min(Math.max(Number(options.seedPages || DEFAULT_SEED_PAGES), 1), MAX_GITHUB_PAGE);
  const ownerTtlMs = options.force ? 0 : Number(options.ownerTtlMs || DEFAULT_OWNER_TTL_MS);
  const cache = await readAllTimeAccountsCache();
  const dbRefreshMap = hasDatabaseUrl() ? await getAccountRefreshMap() : null;
  const seedRepos = await fetchAllTimeSeedRepos(seedPages);
  const owners = uniqueOwners(seedRepos);
  const summary = {
    seedPages,
    seedRepoCount: seedRepos.length,
    ownerCount: owners.length,
    refreshed: 0,
    skippedFresh: 0,
    failed: 0
  };

  for (const owner of owners) {
    const existing = cache.accounts[owner.id];
    const dbRefreshedAt = dbRefreshMap?.get(owner.id);
    if (dbRefreshedAt && ownerTtlMs && Date.now() - Date.parse(dbRefreshedAt) < ownerTtlMs) {
      summary.skippedFresh += 1;
      continue;
    }

    if (existing && ownerTtlMs && Date.now() - Date.parse(existing.refreshedAt || 0) < ownerTtlMs) {
      summary.skippedFresh += 1;
      continue;
    }

    try {
      const detail = await fetchOwnerStarredRepos(owner);
      cache.accounts[owner.id] = detail;
      cache.seedPages = Math.max(cache.seedPages || 0, seedPages);
      summary.refreshed += 1;
      if (hasDatabaseUrl()) await upsertAccountDetail(detail);
      await writeAllTimeAccountsCache(cache);
    } catch (error) {
      summary.failed += 1;
      cache.accounts[owner.id] = {
        ...(existing || owner),
        error: error.message || "Unable to refresh account.",
        refreshedAt: new Date().toISOString()
      };
      await writeAllTimeAccountsCache(cache);
    }
  }

  cache.seedPages = Math.max(cache.seedPages || 0, seedPages);
  await writeAllTimeAccountsCache(cache);
  return summary;
}

async function fetchAllTimeSeedRepos(seedPages) {
  const repos = [];
  for (let page = 1; page <= seedPages; page += 1) {
    const query = "archived:false fork:false stars:>=1";
    const endpoint = `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${GITHUB_FETCH_PAGE_SIZE}&page=${page}`;
    const { data, headers } = await githubFetch(endpoint);
    (data.items || []).map(normalizeRepo).forEach((repo) => repos.push(repo));
    await waitForSearchBudget(headers);
  }
  return repos;
}

async function fetchOwnerStarredRepos(owner) {
  const repos = [];
  for (let page = 1; page <= MAX_GITHUB_PAGE; page += 1) {
    const query = `user:${owner.login} stars:>=1 fork:false archived:false`;
    const endpoint = `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${GITHUB_FETCH_PAGE_SIZE}&page=${page}`;
    const { data, headers } = await githubFetch(endpoint);
    const items = data.items || [];
    items.map(normalizeRepo).forEach((repo) => repos.push(repo));
    await waitForSearchBudget(headers);
    if (!hasNextLink(headers) || !items.length) break;
  }

  repos.sort((a, b) => b.stars - a.stars);
  const topRepo = repos[0]
    ? {
        name: repos[0].name,
        fullName: repos[0].fullName,
        stars: repos[0].stars,
        url: repos[0].repoUrl
      }
    : null;

  return {
    id: owner.id,
    login: owner.login,
    type: owner.type || "User",
    avatarUrl: owner.avatarUrl,
    htmlUrl: owner.htmlUrl,
    starScore: repos.reduce((total, repo) => total + repo.stars, 0),
    repoCount: repos.length,
    topRepo,
    repoNames: repos.map((repo) => repo.fullName),
    repos,
    refreshedAt: new Date().toISOString(),
    enriched: true
  };
}

async function githubFetch(pathname) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "user-agent": "starboard-cache-job",
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
  return {
    id: item.id,
    fullName: item.full_name || `${owner}/${item.name}`,
    owner,
    ownerId: String(item.owner?.id || owner),
    ownerType: item.owner?.type || "User",
    ownerUrl: item.owner?.html_url || `https://github.com/${owner}`,
    name: item.name,
    description: item.description || "",
    language: item.language || "Unknown",
    topics: item.topics || [],
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
    fork: Boolean(item.fork),
    archived: Boolean(item.archived),
    avatar: item.owner?.avatar_url,
    repoUrl: item.html_url,
    defaultBranch: item.default_branch || "main"
  };
}

function uniqueOwners(repos) {
  const owners = new Map();
  repos.forEach((repo) => {
    if (!owners.has(repo.ownerId)) {
      owners.set(repo.ownerId, {
        id: repo.ownerId,
        login: repo.owner,
        type: repo.ownerType,
        avatarUrl: repo.avatar,
        htmlUrl: repo.ownerUrl
      });
    }
  });
  return [...owners.values()];
}

function compareAccounts(a, b, sortKey, sortDirection) {
  const aValue = sortKey === "repos" ? a.repoCount || 0 : a.starScore || 0;
  const bValue = sortKey === "repos" ? b.repoCount || 0 : b.starScore || 0;
  return sortDirection === "asc" ? aValue - bValue : bValue - aValue;
}

function accountMatchesQuery(account, query) {
  return [
    account.login,
    account.type,
    account.topRepo?.name,
    account.topRepo?.fullName,
    ...(account.repoNames || [])
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function hasNextLink(headers) {
  return headers.get("link")?.includes('rel="next"') || false;
}

async function waitForSearchBudget(headers) {
  const remaining = Number(headers.get("x-ratelimit-remaining") || 1);
  const reset = Number(headers.get("x-ratelimit-reset") || 0);
  if (remaining <= 1 && reset) {
    const waitMs = Math.max(reset * 1000 - Date.now(), SEARCH_REQUEST_SPACING_MS);
    await delay(waitMs);
    return;
  }
  await delay(SEARCH_REQUEST_SPACING_MS);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
