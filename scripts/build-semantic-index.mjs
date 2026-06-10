import { loadLocalEnv } from "../backend-cache.mjs";
import { createEmbeddings, embeddingDimensions, embeddingModel } from "../embeddings.mjs";
import {
  closePool,
  finishIngestionRun,
  readRepositoriesForSemanticIndex,
  startIngestionRun,
  upsertRepositoryEmbedding,
  upsertRepositorySemanticRejection,
  upsertRepositorySearchDocument
} from "../db.mjs";
import { buildRepositorySearchDocument, cleanMarkdownForSearch } from "../search-document.mjs";
import { evaluateRepositoryQuality } from "../quality-filter.mjs";

const GITHUB_API = "https://api.github.com";
const EMBEDDING_COST_PER_1M_TOKENS_USD = 0.02;
const args = parseArgs(process.argv.slice(2));

loadLocalEnv();

const limit = Math.min(Math.max(Number(args.limit || process.env.STARBOARD_SEMANTIC_LIMIT || 500), 1), 2000);
const batchSize = Math.min(Math.max(Number(args["batch-size"] || process.env.STARBOARD_SEMANTIC_BATCH_SIZE || 50), 1), 100);
const readmeLimit = Math.max(Number(args["readme-chars"] || process.env.STARBOARD_README_CHAR_LIMIT || 16000), 1000);
const requestTimeoutMs = Math.max(Number(args["timeout-ms"] || process.env.STARBOARD_SEMANTIC_REQUEST_TIMEOUT_MS || 10000), 1000);
const model = embeddingModel();
const dimensions = embeddingDimensions();

if (!process.env.OPENAI_API_KEY && !process.env.STARBOARD_OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY or STARBOARD_OPENAI_API_KEY is not configured. Add it to .env.local or GitHub Actions secrets.");
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is not configured. Add it to .env.local or GitHub Actions secrets.");
  process.exit(1);
}

let runId;
const summary = {
  candidates: 0,
  documentsUpdated: 0,
  embeddingsUpdated: 0,
  skipped: 0,
  skippedUnchanged: 0,
  failed: 0,
  githubRequests: 0,
  embeddingRequests: 0,
  embeddingTokens: 0,
  estimatedEmbeddingCostUsd: 0,
  totalDocumentChars: 0,
  averageCharsPerDocument: 0,
  averageTokensPerDocument: 0,
  qualityRejected: 0,
  qualityRejectsByReason: {}
};

try {
  runId = await startIngestionRun("build-semantic-index", { limit, batchSize, model, dimensions });
  const repos = await readRepositoriesForSemanticIndex({ limit, embeddingModel: model });
  summary.candidates = repos.length;

  const pending = [];
  for (const repo of repos) {
    try {
      const metadataQuality = evaluateRepositoryQuality(repo);
      if (!metadataQuality.accepted) {
        await recordQualityReject(repo, metadataQuality.reason);
        continue;
      }

      const readme = await fetchReadme(repo);
      summary.githubRequests += 1;
      const document = buildRepositorySearchDocument(repo, readme, { limit: readmeLimit });
      const documentQuality = evaluateRepositoryQuality(repo, document);
      if (!documentQuality.accepted) {
        await recordQualityReject(repo, documentQuality.reason);
        continue;
      }

      await upsertRepositorySearchDocument(document);
      summary.documentsUpdated += 1;
      summary.totalDocumentChars += document.combinedText.length;
      summary.averageCharsPerDocument = Math.round(summary.totalDocumentChars / summary.documentsUpdated);

      if (repo.embeddingHash === document.contentHash && repo.embeddingModel === model) {
        summary.skipped += 1;
        summary.skippedUnchanged += 1;
        continue;
      }

      pending.push(document);
      if (pending.length >= batchSize) {
        await embedBatch(pending.splice(0, pending.length));
      }
      if (summary.documentsUpdated % 10 === 0) {
        console.log(`Prepared ${summary.documentsUpdated}/${summary.candidates} semantic documents.`);
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`${repo.fullName}: ${error.message || error}`);
    }
  }

  if (pending.length) {
    await embedBatch(pending);
  }

  await finishIngestionRun(runId, {
    status: summary.failed ? "completed_with_errors" : "completed",
    githubRequests: summary.githubRequests,
    reposDiscovered: summary.documentsUpdated,
    metadata: summary
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (runId) {
    await finishIngestionRun(runId, {
      status: "failed",
      errorMessage: error.message || String(error),
      githubRequests: summary.githubRequests,
      reposDiscovered: summary.documentsUpdated,
      metadata: summary
    });
  }
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}

async function embedBatch(documents) {
  console.log(`Embedding ${documents.length} documents...`);
  const result = await createEmbeddings(documents.map((document) => document.combinedText), { model, dimensions });
  const vectors = result.embeddings;
  const tokenCount = Number(result.usage?.total_tokens || result.usage?.prompt_tokens || 0);
  summary.embeddingRequests += 1;
  summary.embeddingTokens += tokenCount;
  summary.estimatedEmbeddingCostUsd = Number(((summary.embeddingTokens / 1_000_000) * EMBEDDING_COST_PER_1M_TOKENS_USD).toFixed(6));
  summary.averageTokensPerDocument = summary.documentsUpdated
    ? Math.round(summary.embeddingTokens / summary.documentsUpdated)
    : 0;
  for (let index = 0; index < documents.length; index += 1) {
    await upsertRepositoryEmbedding({
      repoGithubId: documents[index].repoGithubId,
      vector: vectors[index],
      embeddingModel: model,
      contentHash: documents[index].contentHash
    });
    summary.embeddingsUpdated += 1;
  }
  console.log(`Stored ${summary.embeddingsUpdated} embeddings.`);
}

async function recordQualityReject(repo, reason) {
  summary.qualityRejected += 1;
  summary.qualityRejectsByReason[reason] = (summary.qualityRejectsByReason[reason] || 0) + 1;
  if (repo?.id) {
    await upsertRepositorySemanticRejection({
      repoGithubId: repo.id,
      embeddingModel: model,
      reason
    });
  }
}

async function fetchReadme(repo) {
  const endpoint = `/repos/${repo.fullName.split("/").map(encodeURIComponent).join("/")}/readme`;
  try {
    const response = await githubFetch(endpoint);
    if (!response?.download_url) return "";
    const readmeResponse = await fetch(response.download_url, {
      headers: { "user-agent": "starboard-semantic-index" },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (!readmeResponse.ok) return "";
    return cleanMarkdownForSearch(await readmeResponse.text(), { limit: readmeLimit });
  } catch {
    return "";
  }
}

async function githubFetch(pathname) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "user-agent": "starboard-semantic-index",
      "x-github-api-version": "2022-11-28"
    },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }

  return response.json();
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    })
  );
}
