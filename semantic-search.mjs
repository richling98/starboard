import { embeddingDimensions, embeddingModel, createEmbedding } from "./embeddings.mjs";
import { readSemanticAccountRows, readSemanticRepositoryRows } from "./db.mjs";

const VALID_PERIODS = new Set(["today", "week", "month", "all"]);
const VALID_VIEWS = new Set(["repositories", "accounts"]);

export async function runSemanticSearch(input = {}) {
  const query = String(input.query || "").trim();
  if (query.length < 3) {
    return {
      mode: "semantic",
      query,
      period: normalizePeriod(input.period),
      view: normalizeView(input.view),
      total: 0,
      rows: []
    };
  }

  const period = normalizePeriod(input.period);
  const view = normalizeView(input.view);
  const limit = Math.min(Math.max(Number(input.limit || 20), 1), 200);
  const offset = Math.max(Number(input.offset || 0), 0);
  const model = embeddingModel();
  const dimensions = embeddingDimensions();
  const queryEmbedding = await createEmbedding(query, { model, dimensions });
  const options = {
    queryEmbedding,
    embeddingModel: model,
    period,
    limit,
    offset,
    sortKey: input.sortKey || "relevance",
    sortDirection: input.sortDirection || "desc",
    matchLimit: Math.min(Math.max(Number(input.matchLimit || 1000), 20), 1000)
  };
  const result = view === "accounts"
    ? await readSemanticAccountRows(options)
    : await readSemanticRepositoryRows(options);

  return {
    mode: "semantic",
    query,
    period,
    view,
    model,
    dimensions,
    total: result.total,
    rows: result.rows
  };
}

function normalizePeriod(period) {
  return VALID_PERIODS.has(period) ? period : "all";
}

function normalizeView(view) {
  return VALID_VIEWS.has(view) ? view : "repositories";
}
