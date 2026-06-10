import { createHash } from "node:crypto";

const DEFAULT_README_CHAR_LIMIT = 16000;

export function cleanMarkdownForSearch(text = "", options = {}) {
  const limit = Math.max(Number(options.limit || DEFAULT_README_CHAR_LIMIT), 1000);
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\([^)]*\)/g, (match) => match.replace(/^\[|\]\([^)]*\)$/g, " "))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[|: -]{5,}\s*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

export function buildRepositorySearchDocument(repo, readme = "", options = {}) {
  const fullName = repo.fullName || repo.full_name || `${repo.owner || repo.owner_login}/${repo.name}`;
  const titleText = [fullName, repo.name].filter(Boolean).join(" ");
  const descriptionText = repo.description || "";
  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  const readmeText = cleanMarkdownForSearch(readme, options);
  const combinedText = [
    `Repository: ${fullName}`,
    `Name: ${repo.name || fullName.split("/").pop()}`,
    `Description: ${descriptionText || "No description"}`,
    topics.length ? `Topics: ${topics.join(", ")}` : "",
    readmeText ? `README:\n${readmeText}` : ""
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    repoGithubId: repo.id || repo.github_id,
    fullName,
    titleText,
    descriptionText,
    readmeText,
    combinedText,
    contentHash: sha256(combinedText),
    readmeFetchedAt: new Date().toISOString()
  };
}

export function sha256(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}
