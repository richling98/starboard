import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAllTimeAccountRows,
  loadLocalEnv,
  readAllTimeAccountsCache
} from "./backend-cache.mjs";
import {
  getCacheStatus,
  hasDatabaseUrl,
  readAllTimeAccountsFromDb,
  readLeaderboardSnapshot
} from "./db.mjs";
import { runSemanticSearch } from "./semantic-search.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4176);
const GITHUB_API = "https://api.github.com";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};

loadLocalEnv();

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (requestUrl.pathname.startsWith("/api/github/")) {
      await proxyGitHub(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/leaderboard/accounts") {
      await serveAccountsLeaderboard(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/leaderboard/repositories") {
      await serveRepositoriesLeaderboard(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/cache/status") {
      await serveCacheStatus(response);
      return;
    }

    if (requestUrl.pathname === "/api/semantic-search") {
      await serveSemanticSearch(request, response);
      return;
    }

    await serveStatic(requestUrl, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message || "Server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`Starboard running at http://127.0.0.1:${PORT}`);
  console.log(process.env.GITHUB_TOKEN ? "GitHub token loaded from environment." : "GITHUB_TOKEN is missing.");
});

async function proxyGitHub(requestUrl, response) {
  if (!process.env.GITHUB_TOKEN) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "GITHUB_TOKEN is not configured on the server." }));
    return;
  }

  const githubPath = requestUrl.pathname.replace(/^\/api\/github/, "");
  const githubUrl = `${GITHUB_API}${githubPath}${requestUrl.search}`;
  const githubResponse = await fetch(githubUrl, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "user-agent": "starboard-local-dev",
      "x-github-api-version": "2022-11-28"
    }
  });

  const body = await githubResponse.arrayBuffer();
  const headers = {
    "access-control-expose-headers": "link,x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset",
    "content-type": githubResponse.headers.get("content-type") || "application/json; charset=utf-8"
  };

  ["link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"].forEach((header) => {
    const value = githubResponse.headers.get(header);
    if (value) headers[header] = value;
  });

  response.writeHead(githubResponse.status, headers);
  response.end(Buffer.from(body));
}

async function serveAccountsLeaderboard(requestUrl, response) {
  const period = requestUrl.searchParams.get("period") || "all";
  const options = {
    period,
    view: "accounts",
    query: requestUrl.searchParams.get("query") || "",
    offset: requestUrl.searchParams.get("offset") || 0,
    limit: requestUrl.searchParams.get("limit") || 20,
    sortKey: requestUrl.searchParams.get("sortKey") || "stars",
    sortDirection: requestUrl.searchParams.get("sortDirection") || "desc"
  };
  const snapshot = hasDatabaseUrl() ? await readLeaderboardSnapshot(options) : null;
  if (!snapshot && period !== "all") {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "No cached account snapshot yet. Run npm run build:snapshots." }));
    return;
  }

  const payload = snapshot || (hasDatabaseUrl()
    ? await readAllTimeAccountsFromDb(options)
    : getAllTimeAccountRows(await readAllTimeAccountsCache(), options));

  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function serveRepositoriesLeaderboard(requestUrl, response) {
  const options = {
    period: requestUrl.searchParams.get("period") || "today",
    view: "repositories",
    query: requestUrl.searchParams.get("query") || "",
    offset: requestUrl.searchParams.get("offset") || 0,
    limit: requestUrl.searchParams.get("limit") || 20,
    sortKey: requestUrl.searchParams.get("sortKey") || "stars",
    sortDirection: requestUrl.searchParams.get("sortDirection") || "desc"
  };
  const payload = hasDatabaseUrl() ? await readLeaderboardSnapshot(options) : null;

  if (!payload) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "No cached repository snapshot yet. Run npm run build:snapshots." }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function serveCacheStatus(response) {
  if (!hasDatabaseUrl()) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ database: false }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ database: true, ...(await getCacheStatus()) }));
}

async function serveSemanticSearch(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (!hasDatabaseUrl()) {
    response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "DATABASE_URL is not configured." }));
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const result = await runSemanticSearch(payload);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message || "Semantic search failed." }));
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : decodeURIComponent(requestUrl.pathname);
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, normalized);

  if (!filePath.startsWith(__dirname)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const extension = path.extname(filePath);
    response.writeHead(200, { "content-type": MIME_TYPES[extension] || "application/octet-stream" });
    response.end(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}
