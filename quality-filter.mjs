const SPAM_KEYWORDS = [
  "activation",
  "activator",
  "crack",
  "cracked",
  "keygen",
  "license-key",
  "license key",
  "unlock",
  "unlocked",
  "premium-unlocked",
  "serial-key",
  "serial key",
  "free-download",
  "free download"
];

export function evaluateRepositoryQuality(repo, document = null) {
  if (!repo) return reject("missing_repo");
  if (repo.archived) return reject("archived");
  if (repo.fork) return reject("fork");
  if (Number(repo.stars || 0) < 1) return reject("no_stars");
  if (repo.englishCheckStatus === "rejected" || repo.english_check_status === "rejected") {
    return reject("english_rejected");
  }

  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  const metadataText = [
    repo.fullName,
    repo.full_name,
    repo.name,
    repo.description,
    ...topics
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (SPAM_KEYWORDS.some((keyword) => metadataText.includes(keyword))) {
    return reject("spam_keyword");
  }

  if (document) {
    const hasDescription = Boolean(String(document.descriptionText || repo.description || "").trim());
    const hasTopics = topics.length > 0;
    const hasReadme = Boolean(String(document.readmeText || "").trim());
    if (!hasDescription && !hasTopics && !hasReadme) return reject("empty_document");
    if (!hasDescription && !hasTopics && Number(repo.stars || 0) < 10) return reject("weak_metadata");
  }

  return { accepted: true, reason: "accepted" };
}

function reject(reason) {
  return { accepted: false, reason };
}
