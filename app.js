const GITHUB_API = "/api/github";
const RAW_GITHUB = "https://raw.githubusercontent.com";
const STATIC_LEADERBOARD_BASE = "./data/leaderboards";
const CACHE_VERSION = "v20";
const CACHE_TTL_MS = 15 * 60 * 1000;
const README_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UI_REVEAL_SIZE = 20;
const GITHUB_FETCH_PAGE_SIZE = 100;
const GITHUB_SEARCH_RESULT_CAP = 1000;
const MAX_GITHUB_PAGE = GITHUB_SEARCH_RESULT_CAP / GITHUB_FETCH_PAGE_SIZE;
const README_BATCH_SIZE = 12;
const README_TIMEOUT_MS = 3500;
const GITHUB_TIMEOUT_MS = 10000;
const OWNER_ENRICHMENT_BATCH_SIZE = 1;
const ACCOUNT_SEED_PREFETCH_PAGES = 2;

let lastVisibleRepositories = [];
const expandedAccounts = new Set();

const periodStores = {
  today: createPeriodStore(),
  week: createPeriodStore(),
  month: createPeriodStore(),
  all: createPeriodStore()
};

const state = {
  view: "repos",
  period: "today",
  query: "",
  compact: false,
  loading: true,
  error: "",
  sortKey: "default",
  sortDirection: "desc"
};

const repoList = document.querySelector("#repo-list");
const repoTemplate = document.querySelector("#repo-template");
const accountTemplate = document.querySelector("#account-template");
const starMetricTemplate = document.querySelector("#star-metric-template");
const forkMetricTemplate = document.querySelector("#fork-metric-template");
const paginationStatus = document.querySelector("#pagination-status");
const loadMoreButton = document.querySelector("#load-more-button");
const searchInput = document.querySelector("#search-input");
const densityToggle = document.querySelector("#density-toggle");
const sortButtons = document.querySelectorAll(".sort-button");
const viewTabs = document.querySelectorAll(".view-tab");
const tableHeaders = document.querySelectorAll(".table-header");

function createPeriodStore() {
  return {
    githubPage: 0,
    fetchedRepos: [],
    accountSeedRepos: [],
    visibleCount: UI_REVEAL_SIZE,
    totalCount: 0,
    incompleteResults: false,
    reachedGithubCap: false,
    isLoading: false,
    error: "",
    ownerDetails: {},
    enrichingOwners: new Set(),
    ownerErrors: {},
    directAccounts: {},
    directAccountQueries: new Set(),
    directAccountErrors: {},
    prefetchingAccountSeeds: false,
    serverAccounts: [],
    serverAccountTotal: 0,
    serverAccountsLoaded: false,
    serverAccountsLoading: false,
    serverAccountsAttempted: false,
    serverAccountsError: "",
    serverAccountsMeta: null,
    serverReposLoaded: false,
    serverReposLoading: false,
    serverReposError: "",
    serverReposMeta: null
  };
}

function currentStore() {
  return periodStores[state.period];
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function cacheKey(key) {
  return `starboard:${CACHE_VERSION}:${key}`;
}

function readCache(key, ttl = CACHE_TTL_MS) {
  try {
    const raw = localStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.createdAt > ttl) return null;
    return cached.value;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(cacheKey(key), JSON.stringify({ createdAt: Date.now(), value }));
  } catch {
    // Local storage can fail in private browsing. The app still works without caching.
  }
}

async function githubFetch(path) {
  const { data } = await githubFetchWithHeaders(path);
  return data;
}

async function githubFetchWithHeaders(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
  } catch {
    throw new Error("GitHub is taking too long to respond. Refresh and try again.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const resetText = reset
      ? new Date(Number(reset) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "later";
    if (response.status === 403 || remaining === "0") {
      throw new Error(`GitHub rate limit reached. Try again after ${resetText}.`);
    }
    throw new Error(`GitHub request failed: ${response.status}`);
  }

  return {
    data: await response.json(),
    headers: response.headers
  };
}

function repositorySearchPath(period, page) {
  const encodedBase = "archived:false fork:false stars:>=1";
  const query =
    period === "all"
      ? encodedBase
      : `${encodedBase} created:>=${daysAgo(periodDays(period))}`;

  return `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${GITHUB_FETCH_PAGE_SIZE}&page=${page}`;
}

function periodDays(period) {
  return {
    today: 1,
    week: 7,
    month: 30
  }[period] || 7;
}

function normalizeRepo(item) {
  const owner = item.owner?.login || "unknown";
  return {
    id: item.id,
    fullName: item.full_name || `${owner}/${item.name}`,
    owner,
    ownerId: item.owner?.id || owner,
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

async function fetchRepositoryPage(period, page) {
  const cached = readCache(`repos:${period}:page:${page}`);
  if (cached) return cached;

  const data = await githubFetch(repositorySearchPath(period, page));
  const normalizedRepos = (data.items || []).map(normalizeRepo);
  const value = {
    totalCount: data.total_count || 0,
    incompleteResults: Boolean(data.incomplete_results),
    accountSeedRepos: normalizedRepos.filter((repo) => repo.stars >= 1 && !repo.fork && !repo.archived),
    repos: normalizedRepos.filter((repo) => passesEnglishGate(repo.description))
  };
  writeCache(`repos:${period}:page:${page}`, value);
  return value;
}

async function fetchNextPage(period) {
  const store = periodStores[period];
  if (store.isLoading || store.reachedGithubCap) return;

  const nextPage = store.githubPage + 1;
  if (nextPage > MAX_GITHUB_PAGE) {
    store.reachedGithubCap = true;
    return;
  }

  store.isLoading = true;
  state.loading = state.period === period;
  render();

  try {
    const page = await fetchRepositoryPage(period, nextPage);
    store.githubPage = nextPage;
    store.totalCount = page.totalCount;
    store.incompleteResults = page.incompleteResults;
    store.reachedGithubCap = nextPage >= MAX_GITHUB_PAGE || nextPage * GITHUB_FETCH_PAGE_SIZE >= Math.min(page.totalCount, GITHUB_SEARCH_RESULT_CAP);
    mergeAccountSeedRepos(store, page.accountSeedRepos || page.repos);
    mergeRepos(store, page.repos);
    refineEnglishReadmes(period, page.repos);
  } catch (error) {
    store.error = error.message || "Unable to load GitHub data.";
    if (state.period === period) state.error = store.error;
  } finally {
    store.isLoading = false;
    if (state.period === period) state.loading = false;
    render();
  }
}

function mergeRepos(store, repos) {
  const byId = new Map(store.fetchedRepos.map((repo) => [repo.id, repo]));
  repos.forEach((repo) => byId.set(repo.id, repo));
  store.fetchedRepos = [...byId.values()];
}

function mergeAccountSeedRepos(store, repos) {
  const byId = new Map(store.accountSeedRepos.map((repo) => [repo.id, repo]));
  repos.forEach((repo) => byId.set(repo.id, repo));
  store.accountSeedRepos = [...byId.values()];
}

async function refineEnglishReadmes(period, repos) {
  if (!repos.length) return;

  try {
    const englishRepos = await filterEnglishRepositories(repos);
    if (englishRepos.length < Math.min(UI_REVEAL_SIZE, repos.length)) return;

    const store = periodStores[period];
    const pageIds = new Set(repos.map((repo) => repo.id));
    store.fetchedRepos = store.fetchedRepos.filter((repo) => !pageIds.has(repo.id));
    mergeRepos(store, englishRepos);

    if (state.period === period) {
      lastVisibleRepositories = getVisibleRepos();
      render();
    }
  } catch {
    // Keep the visible description-filtered repos if README refinement fails.
  }
}

async function filterEnglishRepositories(repos) {
  const accepted = [];
  const candidates = repos.filter((repo) => passesEnglishGate(repo.description));

  for (let index = 0; index < candidates.length; index += README_BATCH_SIZE) {
    const batch = candidates.slice(index, index + README_BATCH_SIZE);
    const checked = await Promise.all(
      batch.map(async (repo) => {
        const readme = await fetchReadme(repo);
        return passesEnglishGate(readme, { minLetters: 80 }) ? repo : null;
      })
    );

    checked.forEach((repo) => {
      if (repo) accepted.push(repo);
    });
  }

  return accepted;
}

async function fetchReadme(repo) {
  const key = `readme:${repo.owner}/${repo.name}`;
  const cached = readCache(key, README_CACHE_TTL_MS);
  if (cached !== null) return cached;

  const readmeNames = ["README.md", "README", "readme.md"];
  for (const fileName of readmeNames) {
    const text = await fetchRawReadme(repo, fileName);
    if (!text) continue;
    const sampled = cleanMarkdownForLanguageCheck(text).slice(0, 12000);
    writeCache(key, sampled);
    return sampled;
  }

  writeCache(key, "");
  return "";
}

async function fetchRawReadme(repo, fileName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), README_TIMEOUT_MS);
  try {
    const response = await fetch(rawReadmeUrl(repo, fileName), { signal: controller.signal });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function rawReadmeUrl(repo, fileName) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  const branch = encodeURIComponent(repo.defaultBranch);
  return `${RAW_GITHUB}/${owner}/${name}/${branch}/${fileName}`;
}

function cleanMarkdownForLanguageCheck(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_|~=[\]()-]/g, " ");
}

function passesEnglishGate(text, options = {}) {
  const { minLetters = 12 } = options;
  if (!text || typeof text !== "string") return false;

  const cleaned = cleanMarkdownForLanguageCheck(text);
  const blockedScripts =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}]/u;
  if (blockedScripts.test(cleaned)) return false;

  const letters = cleaned.match(/\p{Letter}/gu) || [];
  if (letters.length < minLetters) return false;

  const latinLetters = cleaned.match(/\p{Script=Latin}/gu) || [];
  return latinLetters.length / letters.length >= 0.96;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function getFilteredRepos() {
  const store = currentStore();
  const query = state.query.trim().toLowerCase();
  const filtered = store.fetchedRepos.filter((repo) => {
    const searchText = [repo.owner, repo.name, repo.description, repo.language, ...repo.topics]
      .join(" ")
      .toLowerCase();
    return !query || searchText.includes(query);
  });

  return sortRepos(filtered);
}

function getFilteredAccounts() {
  if (usesServerAccounts()) {
    const rows = currentStore().serverAccounts;
    return sortAccounts(filterAccountRows(rows));
  }

  return sortAccounts(filterAccountRows(getAllAccountRows()));
}

function filterAccountRows(accounts) {
  const query = state.query.trim().toLowerCase();
  return accounts.filter((account) => {
    const searchText = [
      account.login,
      account.type,
      account.topRepo?.name,
      account.topRepo?.fullName,
      ...account.repoNames
    ]
      .join(" ")
      .toLowerCase();
    return !query || searchText.includes(query);
  });
}

function getAllAccountRows() {
  const byId = new Map(buildAccountRows(accountSourceRepos()).map((account) => [account.id, account]));
  if (state.period === "all") {
    Object.values(currentStore().directAccounts).forEach((account) => byId.set(account.id, account));
  }
  return [...byId.values()];
}

function accountSourceRepos() {
  const store = currentStore();
  const repos = state.period === "all"
    ? [...store.fetchedRepos, ...store.accountSeedRepos]
    : store.fetchedRepos;
  return [...new Map(repos.map((repo) => [repo.id, repo])).values()];
}

function buildAccountRows(repos) {
  const byOwner = new Map();

  repos.forEach((repo) => {
    if (repo.stars < 1) return;

    const key = String(repo.ownerId || repo.owner);
    const existing = byOwner.get(key) || {
      id: key,
      login: repo.owner,
      type: repo.ownerType || "User",
      avatarUrl: repo.avatar,
      htmlUrl: repo.ownerUrl,
      starScore: 0,
      repoCount: 0,
      topRepo: null,
      repoNames: [],
      repos: []
    };

    existing.starScore += repo.stars;
    existing.repoCount += 1;
    existing.repoNames.push(repo.fullName || `${repo.owner}/${repo.name}`);
    existing.repos.push(repo);

    if (!existing.topRepo || repo.stars > existing.topRepo.stars) {
      existing.topRepo = {
        name: repo.name,
        fullName: repo.fullName || `${repo.owner}/${repo.name}`,
        stars: repo.stars,
        url: repo.repoUrl
      };
    }

    byOwner.set(key, existing);
  });

  const store = currentStore();
  return [...byOwner.values()].map((account) => {
    const sortedRepos = account.repos.sort((a, b) => b.stars - a.stars);
    const detail = state.period === "all" ? store.ownerDetails[account.id] : null;
    if (!detail) {
      return {
        ...account,
        repos: sortedRepos,
        enriched: false,
        enriching: state.period === "all" && store.enrichingOwners.has(account.id)
      };
    }

    return {
      ...account,
      starScore: detail.starScore,
      repoCount: detail.repoCount,
      topRepo: detail.topRepo,
      repoNames: detail.repoNames,
      repos: detail.repos,
      enriched: true,
      enriching: false
    };
  });
}

function sortRepos(repos) {
  const sorted = [...repos];
  if (state.sortKey === "stars") {
    sorted.sort((a, b) => compareNumeric(a.stars, b.stars));
  } else if (state.sortKey === "forks") {
    sorted.sort((a, b) => compareNumeric(a.forks, b.forks));
  }
  return sorted;
}

function sortAccounts(accounts) {
  const sorted = [...accounts];
  const sortKey = state.sortKey === "repos" ? "repos" : "stars";

  if (sortKey === "stars") {
    sorted.sort((a, b) => compareNumeric(a.starScore, b.starScore));
  } else if (sortKey === "repos") {
    sorted.sort((a, b) => compareNumeric(a.repoCount, b.repoCount));
  }

  return sorted;
}

function compareNumeric(a, b) {
  return state.sortDirection === "desc" ? b - a : a - b;
}

function getVisibleRepos() {
  const store = currentStore();
  return getFilteredRepos().slice(0, store.visibleCount);
}

function getCurrentRows() {
  return state.view === "accounts" ? getFilteredAccounts() : getFilteredRepos();
}

function getVisibleRows() {
  return getCurrentRows().slice(0, currentStore().visibleCount);
}

function metricNode(template, value) {
  const node = template.content.cloneNode(true);
  node.querySelector("span span").textContent = formatNumber(value);
  return node;
}

function renderLeaderboard() {
  const store = currentStore();
  const rows = getCurrentRows();
  const visibleRows = rows.slice(0, store.visibleCount);
  const isLoading = store.isLoading || state.loading;
  const serverLoading = state.view === "accounts" && store.serverAccountsLoading && !store.serverAccountsLoaded;
  const error = (usesServerAccounts() && store.serverAccountsError) || store.error || state.error;

  repoList.classList.toggle("is-compact", state.compact);
  repoList.classList.toggle("is-account-view", state.view === "accounts");
  repoList.replaceChildren();

  if ((isLoading && !store.fetchedRepos.length) || serverLoading) {
    repoList.append(...skeletonRows(4));
  } else if (error && (!store.fetchedRepos.length || usesServerAccounts())) {
    repoList.append(statusBlock(error));
  } else if (!visibleRows.length) {
    repoList.append(statusBlock(state.view === "accounts" ? "No accounts match the current view." : "No repositories match the current view."));
  }

  if (state.view === "accounts") {
    visibleRows.forEach(renderAccountRow);
  } else {
    visibleRows.forEach(renderRepoRow);
  }

  lastVisibleRepositories = state.view === "repos" && visibleRows.length ? visibleRows : lastVisibleRepositories;
  renderPagination(rows, visibleRows);
  if (state.view === "accounts") {
    ensureServerAccountsLoaded();
    if (!usesServerAccounts()) {
      prefetchAllTimeAccountSeeds();
      ensureQueriedAllTimeOwner(rows);
      enrichVisibleAllTimeAccounts(visibleRows);
    }
  } else {
    prefetchAllTimeAccountSeeds();
    ensureQueriedAllTimeOwner(rows);
    enrichVisibleAllTimeAccounts(visibleRows);
  }
}

function renderRepoRow(repo, index) {
    const node = repoTemplate.content.cloneNode(true);
    const row = node.querySelector(".repo-row");
    row.dataset.repoId = repo.id;
    node.querySelector(".repo-rank").textContent = String(index + 1);
    node.querySelector(".repo-avatar").src = repo.avatar;
    node.querySelector(".repo-avatar").alt = `${repo.owner} avatar`;
    node.querySelector(".repo-owner").textContent = repo.owner;
    node.querySelector(".repo-name").textContent = repo.name;
    node.querySelector(".repo-description").textContent = repo.description;
    node.querySelector(".repo-stars").append(metricNode(starMetricTemplate, repo.stars));
    node.querySelector(".repo-forks").append(metricNode(forkMetricTemplate, repo.forks));

    const repoLink = document.createElement("a");
    repoLink.className = "action primary";
    repoLink.href = repo.repoUrl;
    repoLink.target = "_blank";
    repoLink.rel = "noreferrer";
    repoLink.textContent = "Visit repo";
    node.querySelector(".repo-actions").append(repoLink);

    repoList.append(node);
}

function renderAccountRow(account, index) {
  const node = accountTemplate.content.cloneNode(true);
  const row = node.querySelector(".account-row");
  const accountKey = accountKeyFor(account.id);
  const isExpanded = expandedAccounts.has(accountKey);
  row.dataset.accountId = account.id;
  row.classList.toggle("is-expanded", isExpanded);
  node.querySelector(".repo-rank").textContent = String(index + 1);
  node.querySelector(".repo-avatar").src = account.avatarUrl;
  node.querySelector(".repo-avatar").alt = `${account.login} avatar`;
  node.querySelector(".repo-owner").textContent = account.type === "Organization" ? "Organization" : "User";
  node.querySelector(".repo-name").textContent = account.login;
  node.querySelector(".repo-description").remove();
  node.querySelector(".account-type").textContent = account.type === "Organization" ? "Org" : "User";
  node.querySelector(".account-stars").append(metricNode(starMetricTemplate, account.starScore));
  node.querySelector(".account-repos").textContent = formatPlainNumber(account.repoCount);

  if (account.enriching) {
    node.querySelector(".account-top-repo").textContent = "Loading repos";
  } else if (account.error) {
    node.querySelector(".account-top-repo").textContent = account.error;
  } else if (account.topRepo) {
    const topRepoLink = document.createElement("a");
    topRepoLink.className = "top-repo-link";
    topRepoLink.href = account.topRepo.url;
    topRepoLink.target = "_blank";
    topRepoLink.rel = "noreferrer";
    topRepoLink.textContent = `${account.topRepo.fullName} · ${formatNumber(account.topRepo.stars)} stars`;
    node.querySelector(".account-top-repo").append(topRepoLink);
  } else {
    node.querySelector(".account-top-repo").textContent = "No starred repos";
  }

  const accountLink = document.createElement("a");
  accountLink.className = "action primary";
  accountLink.href = account.htmlUrl;
  accountLink.target = "_blank";
  accountLink.rel = "noreferrer";
  accountLink.textContent = "Visit";
  const expandButton = document.createElement("button");
  expandButton.className = "account-expand-button";
  expandButton.type = "button";
  expandButton.dataset.accountId = account.id;
  expandButton.disabled = !account.repos.length;
  expandButton.setAttribute("aria-expanded", String(isExpanded));
  expandButton.setAttribute("aria-label", `${isExpanded ? "Hide" : "Show"} repositories for ${account.login}`);
  expandButton.textContent = isExpanded ? "Hide repos" : "Show repos";

  node.querySelector(".repo-actions").append(expandButton, accountLink);

  repoList.append(node);

  if (isExpanded) {
    repoList.append(accountReposPanel(account));
  }
}

function accountReposPanel(account) {
  const panel = document.createElement("section");
  panel.className = "account-repos-panel";
  panel.setAttribute("aria-label", `Repositories contributing to ${account.login}`);

  const heading = document.createElement("div");
  heading.className = "account-repos-heading";
  heading.innerHTML = `
    <span>Contributing repos</span>
    <span>${formatPlainNumber(account.repoCount)} ${account.repoCount === 1 ? "repo" : "repos"} · ${formatNumber(account.starScore)} stars</span>
  `;
  panel.append(heading);

  account.repos.forEach((repo) => {
    const item = document.createElement("article");
    item.className = "account-repo-item";

    const copy = document.createElement("div");
    copy.className = "account-repo-copy";

    const name = document.createElement("a");
    name.className = "account-repo-name";
    name.href = repo.repoUrl;
    name.target = "_blank";
    name.rel = "noreferrer";
    name.textContent = repo.fullName || `${repo.owner}/${repo.name}`;

    const description = document.createElement("p");
    description.className = "account-repo-description";
    description.textContent = repo.description || "No description available.";

    copy.append(name, description);

    const stats = document.createElement("div");
    stats.className = "account-repo-stats";
    stats.append(metricNode(starMetricTemplate, repo.stars), metricNode(forkMetricTemplate, repo.forks));

    const visit = document.createElement("a");
    visit.className = "account-repo-visit";
    visit.href = repo.repoUrl;
    visit.target = "_blank";
    visit.rel = "noreferrer";
    visit.textContent = "Visit repo";

    item.append(copy, stats, visit);
    panel.append(item);
  });

  return panel;
}

function renderPagination(filteredRows, visibleRows) {
  const store = currentStore();
  if (usesServerRepositories()) {
    const meta = store.serverReposMeta;
    if (store.serverReposLoading && !store.serverReposLoaded) {
      paginationStatus.textContent = "Loading cached repositories.";
    } else if (meta?.generatedAt) {
      paginationStatus.textContent = `${meta.coverageLabel || `Showing ${formatPlainNumber(visibleRows.length)} cached repositories.`} Updated ${new Date(meta.generatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
    } else {
      paginationStatus.textContent = "";
    }
    renderLoadMore(filteredRows.length, store);
    return;
  }

  if (usesServerAccounts()) {
    const meta = store.serverAccountsMeta;
    if (store.serverAccountsLoading && !store.serverAccountsLoaded) {
      paginationStatus.textContent = "Loading cached accounts.";
    } else if (meta?.generatedAt) {
      paginationStatus.textContent = `${meta.coverageLabel || `Showing ${formatPlainNumber(visibleRows.length)} of ${formatPlainNumber(store.serverAccountTotal)} cached accounts.`} Updated ${new Date(meta.generatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
    } else {
      paginationStatus.textContent = "No cached accounts yet. Run npm run refresh:all-time-accounts to build the cache.";
    }
    renderLoadMore(filteredRows.length, store);
    return;
  }

  const totalLabel = store.totalCount > GITHUB_SEARCH_RESULT_CAP
    ? `the first ${formatPlainNumber(GITHUB_SEARCH_RESULT_CAP)} searchable GitHub results`
    : `${formatPlainNumber(store.totalCount)} GitHub matches`;

  if (store.totalCount) {
    if (state.view === "accounts") {
      const sourceCount = Math.min(store.fetchedRepos.length, GITHUB_SEARCH_RESULT_CAP);
      const pending = state.period === "all" && store.enrichingOwners.size;
      const searching = state.period === "all" && store.directAccountQueries.size;
      paginationStatus.textContent = pending || searching
        ? `Updating all-time account totals from owner repositories. Showing ${formatPlainNumber(visibleRows.length)} accounts from ${formatPlainNumber(sourceCount)} fetched seed repositories.`
        : `Showing ${formatPlainNumber(visibleRows.length)} accounts aggregated from ${formatPlainNumber(sourceCount)} fetched repositories.`;
    } else {
      paginationStatus.textContent = `Showing ${formatPlainNumber(visibleRows.length)} of ${totalLabel}.`;
    }
  } else if (store.isLoading) {
    paginationStatus.textContent = "Loading GitHub repositories.";
  } else {
    paginationStatus.textContent = "";
  }

  const canRevealCached = filteredRows.length > store.visibleCount;
  const canFetchMore = !store.reachedGithubCap && store.githubPage < MAX_GITHUB_PAGE && store.totalCount > store.githubPage * GITHUB_FETCH_PAGE_SIZE;
  const canLoadMore = canRevealCached || canFetchMore;

  loadMoreButton.hidden = !canLoadMore && !store.isLoading;
  loadMoreButton.disabled = store.isLoading;
  loadMoreButton.textContent = store.isLoading ? "Loading" : "Load more";
}

function renderLoadMore(filteredCount, store) {
  const canRevealCached = filteredCount > store.visibleCount;
  loadMoreButton.hidden = !canRevealCached;
  loadMoreButton.disabled = store.serverAccountsLoading;
  loadMoreButton.textContent = store.serverAccountsLoading ? "Loading" : "Load more";
}

function formatPlainNumber(value) {
  return new Intl.NumberFormat("en").format(value);
}

function accountKeyFor(accountId) {
  return `${state.period}:${accountId}`;
}

function enrichVisibleAllTimeAccounts(visibleRows) {
  if (state.view !== "accounts" || state.period !== "all") return;
  if (state.query.trim()) return;
  const store = currentStore();
  const pending = visibleRows
    .filter((account) => !store.ownerDetails[account.id] && !store.enrichingOwners.has(account.id) && !store.ownerErrors[account.id])
    .slice(0, OWNER_ENRICHMENT_BATCH_SIZE);

  pending.forEach((account) => store.enrichingOwners.add(account.id));
  pending.forEach((account) => enrichOwnerAccount(account, store));
}

async function prefetchAllTimeAccountSeeds() {
  if (state.view !== "accounts" || state.period !== "all") return;
  if (state.query.trim()) return;
  const store = currentStore();
  if (store.prefetchingAccountSeeds || store.reachedGithubCap || store.githubPage >= ACCOUNT_SEED_PREFETCH_PAGES) return;

  store.prefetchingAccountSeeds = true;
  try {
    while (
      state.view === "accounts" &&
      state.period === "all" &&
      !store.reachedGithubCap &&
      store.githubPage < ACCOUNT_SEED_PREFETCH_PAGES
    ) {
      await fetchNextPage("all");
    }
  } finally {
    store.prefetchingAccountSeeds = false;
    if (currentStore() === store) render();
  }
}

function ensureQueriedAllTimeOwner(accounts) {
  if (state.view !== "accounts" || state.period !== "all") return;

  const query = state.query.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,39}$/i.test(query)) return;

  const store = currentStore();
  const hasExactAccount = accounts.some((account) => account.login.toLowerCase() === query);
  const hasDirectAccount = Object.values(store.directAccounts).some((account) => account.login.toLowerCase() === query);
  if (hasExactAccount || hasDirectAccount || store.directAccountQueries.has(query) || store.directAccountErrors[query]) return;

  store.directAccountQueries.add(query);
  fetchDirectAllTimeAccount(query, store);
}

async function fetchDirectAllTimeAccount(login, store) {
  try {
    const profile = await githubFetch(`/users/${encodeURIComponent(login)}`);
    const account = {
      id: String(profile.id || profile.login),
      login: profile.login,
      type: profile.type || "User",
      avatarUrl: profile.avatar_url,
      htmlUrl: profile.html_url,
      starScore: 0,
      repoCount: 0,
      topRepo: null,
      repoNames: [],
      repos: [],
      enriched: false,
      enriching: true
    };
    store.directAccounts[account.id] = account;
    if (currentStore() === store) render();

    const detail = await fetchOwnerStarredRepos(account);
    store.directAccounts[account.id] = {
      ...account,
      starScore: detail.starScore,
      repoCount: detail.repoCount,
      topRepo: detail.topRepo,
      repoNames: detail.repoNames,
      repos: detail.repos,
      enriched: true,
      enriching: false
    };
  } catch (error) {
    store.directAccountErrors[login] = error.message || "Unable to load account.";
    const directAccount = Object.values(store.directAccounts).find((account) => account.login.toLowerCase() === login);
    if (directAccount) {
      directAccount.enriching = false;
      directAccount.error = store.directAccountErrors[login];
    }
  } finally {
    store.directAccountQueries.delete(login);
    if (currentStore() === store) render();
  }
}

async function enrichOwnerAccount(account, store) {
  try {
    store.ownerDetails[account.id] = await fetchOwnerStarredRepos(account);
  } catch (error) {
    store.ownerErrors[account.id] = error.message || "Unable to update owner repositories.";
  } finally {
    store.enrichingOwners.delete(account.id);
    if (currentStore() === store) render();
  }
}

async function fetchOwnerStarredRepos(account) {
  const cached = readCache(`owner-repos:${account.login}`);
  if (cached) return cached;

  const repos = [];
  let page = 1;

  while (true) {
    const query = `user:${account.login} stars:>=1 fork:false archived:false`;
    const endpoint = `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${page}`;
    const { data, headers } = await githubFetchWithHeaders(endpoint);
    const items = data.items || [];
    if (!items.length) break;

    items
      .map(normalizeRepo)
      .filter((repo) => repo.stars >= 1 && !repo.fork && !repo.archived)
      .forEach((repo) => repos.push(repo));

    if (!hasNextLink(headers) || page >= MAX_GITHUB_PAGE) break;
    page += 1;
  }

  repos.sort((a, b) => b.stars - a.stars);
  const detail = {
    starScore: repos.reduce((total, repo) => total + repo.stars, 0),
    repoCount: repos.length,
    topRepo: repos.length
      ? {
          name: repos[0].name,
          fullName: repos[0].fullName,
          stars: repos[0].stars,
          url: repos[0].repoUrl
        }
      : account.topRepo,
    repoNames: repos.map((repo) => repo.fullName),
    repos
  };

  writeCache(`owner-repos:${account.login}`, detail);
  return detail;
}

function hasNextLink(headers) {
  return headers.get("link")?.includes('rel="next"') || false;
}

function statusBlock(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function skeletonRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const row = document.createElement("article");
    row.className = "repo-row skeleton-row";
    row.innerHTML = `
      <div class="repo-rank">${index + 1}</div>
      <div class="repo-identity">
        <div class="skeleton-avatar"></div>
        <div class="repo-copy">
          <div class="skeleton-line short"></div>
          <div class="skeleton-line title"></div>
          <div class="skeleton-line wide"></div>
        </div>
      </div>
      <div class="skeleton-line metric"></div>
      <div class="skeleton-line metric"></div>
      <div class="skeleton-button"></div>
    `;
    return row;
  });
}

async function setPeriod(period) {
  if (state.period === period && !state.error) return;
  state.period = period;
  state.error = "";
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.period === period;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  await loadPeriod();
}

async function loadPeriod() {
  const store = currentStore();
  state.loading = usesServerAccounts() ? !store.serverAccountsLoaded : !store.fetchedRepos.length;
  state.error = store.error;
  render();

  if (state.view === "repos" && !store.fetchedRepos.length) {
    const loadedSnapshot = await loadServerRepositories();
    if (loadedSnapshot) {
      state.loading = false;
      render();
      return;
    }
  }

  if (usesServerAccounts()) {
    await loadServerAccounts();
    state.loading = false;
    render();
    return;
  }

  if (!store.fetchedRepos.length && !store.isLoading) {
    await fetchNextPage(state.period);
  } else {
    state.loading = false;
    render();
  }
}

async function loadMore() {
  const store = currentStore();
  const filteredRows = getCurrentRows();
  const hiddenCachedRows = filteredRows.length - store.visibleCount;

  if (usesServerAccounts()) {
    store.visibleCount += UI_REVEAL_SIZE;
    render();
    return;
  }

  if (hiddenCachedRows >= UI_REVEAL_SIZE || store.reachedGithubCap) {
    store.visibleCount += UI_REVEAL_SIZE;
    render();
    return;
  }

  if (!store.reachedGithubCap && store.githubPage < MAX_GITHUB_PAGE) {
    await fetchNextPage(state.period);
  }

  store.visibleCount += UI_REVEAL_SIZE;
  render();
}

function toggleSort(sortKey) {
  if (state.sortKey === sortKey) {
    state.sortDirection = state.sortDirection === "desc" ? "asc" : "desc";
  } else {
    state.sortKey = sortKey;
    state.sortDirection = "desc";
  }
  renderSortHeaders();
  render();
}

function renderSortHeaders() {
  sortButtons.forEach((button) => {
    const tableView = button.closest(".table-header")?.dataset.view;
    const visibleInCurrentView = tableView === state.view;
    const active = state.sortKey === button.dataset.sortKey;
    const labels = {
      stars: "Stars",
      forks: "Forks",
      repos: "Repos"
    };
    const label = labels[button.dataset.sortKey] || button.dataset.sortKey;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active && visibleInCurrentView));
    button.textContent = active ? `${label} ${state.sortDirection === "desc" ? "↓" : "↑"}` : label;
  });
}

function render() {
  renderSortHeaders();
  renderViewTabs();
  renderTableHeaders();
  renderLeaderboard();
}

function usesServerAccounts() {
  return state.view === "accounts" && currentStore().serverAccountsLoaded;
}

function usesServerRepositories() {
  return state.view === "repos" && currentStore().serverReposLoaded;
}

async function ensureServerAccountsLoaded() {
  const store = currentStore();
  if (state.view !== "accounts" || store.serverAccountsLoaded || store.serverAccountsLoading || store.serverAccountsAttempted) return;
  await loadServerAccounts();
}

async function loadServerAccounts() {
  const store = currentStore();
  if (store.serverAccountsLoading) return;

  store.serverAccountsAttempted = true;
  store.serverAccountsLoading = true;
  store.serverAccountsError = "";
  render();

  try {
    const params = new URLSearchParams({
      period: state.period,
      limit: "500",
      offset: "0",
      sortKey: "stars",
      sortDirection: "desc"
    });
    const data = await fetchLeaderboardData("accounts", state.period, params);

    store.serverAccounts = data.rows || [];
    store.serverAccountTotal = data.total || store.serverAccounts.length;
    store.serverAccountsMeta = {
      generatedAt: data.generatedAt,
      seedPages: data.seedPages,
      coverageLabel: data.coverageLabel
    };
    store.serverAccountsLoaded = true;
  } catch (error) {
    store.serverAccountsError = error.message || "Unable to load cached accounts.";
  } finally {
    store.serverAccountsLoading = false;
    render();
  }
}

async function loadServerRepositories() {
  const store = currentStore();
  if (store.serverReposLoading || store.serverReposLoaded) return store.serverReposLoaded;

  store.serverReposLoading = true;
  store.serverReposError = "";
  render();

  try {
    const params = new URLSearchParams({
      period: state.period,
      limit: "1000",
      offset: "0",
      sortKey: "stars",
      sortDirection: "desc"
    });
    const data = await fetchLeaderboardData("repositories", state.period, params);

    store.fetchedRepos = data.rows || [];
    store.totalCount = data.totalIndexedCount || data.total || store.fetchedRepos.length;
    store.reachedGithubCap = true;
    store.serverReposMeta = {
      generatedAt: data.generatedAt,
      coverageLabel: data.coverageLabel
    };
    store.serverReposLoaded = true;
    return true;
  } catch (error) {
    store.serverReposError = error.message || "Unable to load cached repositories.";
    return false;
  } finally {
    store.serverReposLoading = false;
    render();
  }
}

async function fetchLeaderboardData(view, period, params) {
  const apiPath = view === "accounts" ? "accounts" : "repositories";
  try {
    const response = await fetch(`/api/leaderboard/${apiPath}?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Leaderboard request failed: ${response.status}`);
    }
    return data;
  } catch {
    const response = await fetch(`${STATIC_LEADERBOARD_BASE}/${view}-${period}.json`);
    if (!response.ok) {
      throw new Error(`No cached ${view} data is available for ${period}.`);
    }
    return response.json();
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setPeriod(tab.dataset.period));
});

sortButtons.forEach((button) => {
  button.addEventListener("click", () => toggleSort(button.dataset.sortKey));
});

viewTabs.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

densityToggle.addEventListener("click", () => {
  state.compact = !state.compact;
  densityToggle.setAttribute("aria-pressed", String(state.compact));
  render();
});

loadMoreButton.addEventListener("click", loadMore);

repoList.addEventListener("click", (event) => {
  const button = event.target.closest(".account-expand-button");
  if (!button) return;

  const key = accountKeyFor(button.dataset.accountId);
  if (expandedAccounts.has(key)) {
    expandedAccounts.delete(key);
  } else {
    expandedAccounts.add(key);
  }
  render();
});

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  state.sortKey = view === "accounts" ? "stars" : "default";
  state.sortDirection = "desc";
  render();
}

function renderViewTabs() {
  viewTabs.forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function renderTableHeaders() {
  tableHeaders.forEach((header) => {
    header.classList.toggle("is-active", header.dataset.view === state.view);
  });
}

async function boot() {
  render();
  await loadPeriod();
}

boot();
