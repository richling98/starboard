const state = {
  data: null
};

const elements = {
  generatedAt: document.querySelector("#generated-at"),
  coveragePercent: document.querySelector("#coverage-percent"),
  embeddedCount: document.querySelector("#embedded-count"),
  missingCount: document.querySelector("#missing-count"),
  staleCount: document.querySelector("#stale-count"),
  coverageFill: document.querySelector("#coverage-fill"),
  coverageCopy: document.querySelector("#coverage-copy"),
  modelLabel: document.querySelector("#model-label"),
  runTable: document.querySelector("#run-table"),
  planCount: document.querySelector("#plan-count"),
  planList: document.querySelector("#plan-list"),
  rejectionCount: document.querySelector("#rejection-count"),
  rejectionList: document.querySelector("#rejection-list"),
  issueCount: document.querySelector("#issue-count"),
  issueList: document.querySelector("#issue-list")
};

loadDashboard();

async function loadDashboard() {
  try {
    const response = await fetch("./data/semantic-dashboard.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Dashboard data is not available.");
    state.data = await response.json();
    render();
  } catch (error) {
    renderError(error.message || "Unable to load dashboard data.");
  }
}

function render() {
  const data = state.data;
  const coverage = data.coverage || {};
  const percent = Number(coverage.coveragePercent || 0);
  const embedded = Number(coverage.embeddedRepositories || 0);
  const eligible = Number(coverage.eligibleRepositories || 0);
  const missing = Number(coverage.missingEmbeddings || 0);
  const actionableMissing = Number(coverage.actionableMissingEmbeddings || 0);
  const blockedMissing = Number(coverage.blockedMissingEmbeddings || 0);
  const stale = Number(coverage.staleEmbeddings || 0);

  elements.generatedAt.textContent = data.generatedAt
    ? `Updated ${formatDate(data.generatedAt)}`
    : "Updated unknown";
  elements.coveragePercent.textContent = `${percent.toFixed(2)}%`;
  elements.embeddedCount.textContent = formatNumber(embedded);
  elements.missingCount.textContent = formatNumber(missing);
  elements.staleCount.textContent = formatNumber(stale);
  elements.coverageFill.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
  elements.coverageCopy.textContent = `${formatNumber(embedded)} of ${formatNumber(eligible)} eligible repositories have semantic embeddings. ${formatNumber(actionableMissing)} missing repositories are currently actionable; ${formatNumber(blockedMissing)} are blocked by recent quality rejections.`;
  elements.modelLabel.textContent = data.embeddingModel || "";

  renderRuns(data.recentRuns || []);
  renderPlan(data.plan?.checklist || []);
  renderRejections(data.rejectionsByReason || []);
  renderIssues(data.knownIssues || []);
}

function renderRuns(runs) {
  elements.runTable.replaceChildren();
  if (!runs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No semantic runs recorded.";
    row.append(cell);
    elements.runTable.append(row);
    return;
  }

  for (const run of runs) {
    const metadata = run.metadata || {};
    const row = document.createElement("tr");
    row.append(
      tableCell(formatDate(run.startedAt)),
      tableCell(run.jobType || "unknown"),
      tableCell(run.status || "unknown", `status ${statusClass(run.status)}`),
      tableCell(formatNumber(metadata.embeddingsUpdated || 0)),
      tableCell(formatNumber(metadata.failed || 0)),
      tableCell(metadata.estimatedEmbeddingCostUsd == null ? "n/a" : `$${metadata.estimatedEmbeddingCostUsd}`)
    );
    elements.runTable.append(row);
  }
}

function renderPlan(items) {
  const complete = items.filter((item) => item.status === "complete").length;
  elements.planCount.textContent = `${complete}/${items.length || 0}`;
  elements.planList.replaceChildren();
  if (!items.length) {
    elements.planList.append(listItem("Plan checklist unavailable.", "muted"));
    return;
  }
  for (const item of items.slice(0, 12)) {
    elements.planList.append(listItem(item.label, item.status === "complete" ? "complete" : "planned"));
  }
}

function renderRejections(items) {
  const total = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
  elements.rejectionCount.textContent = formatNumber(total);
  elements.rejectionList.replaceChildren();
  if (!items.length) {
    elements.rejectionList.append(listItem("No semantic rejections recorded.", "muted"));
    return;
  }
  for (const item of items) {
    elements.rejectionList.append(listItem(`${item.reason}: ${formatNumber(item.count)}`, "plain"));
  }
}

function renderIssues(items) {
  elements.issueCount.textContent = formatNumber(items.length);
  elements.issueList.replaceChildren();
  if (!items.length) {
    elements.issueList.append(listItem("No recent semantic run issues.", "complete"));
    return;
  }
  for (const item of items) {
    elements.issueList.append(listItem(`${item.status}: ${item.issue}`, "planned"));
  }
}

function renderError(message) {
  elements.generatedAt.textContent = message;
  elements.coverageCopy.textContent = message;
}

function tableCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function listItem(label, status) {
  const item = document.createElement("li");
  item.className = status;
  item.textContent = label;
  return item;
}

function statusClass(status) {
  if (status === "completed") return "ok";
  if (status === "running") return "running";
  return "warn";
}

function formatDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en");
}
