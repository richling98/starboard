import { closePool, getPool } from "../db.mjs";
import { loadLocalEnv } from "../backend-cache.mjs";
import { assessEnglishContent, cleanMarkdownForLanguageCheck } from "../language-gate.mjs";

const GITHUB_API = "https://api.github.com";
const args = parseArgs(process.argv.slice(2));
const limit = Math.min(Math.max(Number(args.limit || process.env.STARBOARD_LANGUAGE_LIMIT || 500), 1), 2000);
const fullName = args.repo || "";

loadLocalEnv();

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is not configured. Add it to .env.local.");
  process.exit(1);
}

try {
  const repos = await selectRepos();
  const summary = {
    checked: 0,
    accepted: 0,
    rejected: 0,
    unknown: 0
  };

  for (const repo of repos) {
    const readme = await fetchReadme(repo.full_name);
    const assessment = assessEnglishContent(repo.description || "", readme);
    await updateRepo(repo.full_name, assessment);
    summary.checked += 1;
    summary[assessment.status] += 1;
    console.log(`${assessment.status.padEnd(8)} ${repo.full_name}`);
  }

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await closePool();
}

async function selectRepos() {
  if (fullName) {
    const result = await getPool().query(
      `
        select full_name, description
        from repositories
        where full_name = $1
      `,
      [fullName]
    );
    return result.rows;
  }

  const result = await getPool().query(
    `
      select full_name, description
      from repositories
      where stars >= 1
        and fork = false
        and archived = false
        and (
          english_check_status in ('unknown', 'accepted')
          or english_checked_at < now() - interval '7 days'
        )
      order by repo_created_at desc nulls last, stars desc, full_name asc
      limit $1
    `,
    [limit]
  );
  return result.rows;
}

async function updateRepo(repoFullName, assessment) {
  await getPool().query(
    `
      update repositories
      set
        english_check_status = $2,
        english_check_confidence = $3,
        english_checked_at = now(),
        updated_at = now()
      where full_name = $1
    `,
    [repoFullName, assessment.status, assessment.confidence]
  );
}

async function fetchReadme(repoFullName) {
  const endpoint = `/repos/${repoFullName.split("/").map(encodeURIComponent).join("/")}/readme`;
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

async function githubFetch(pathname) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "user-agent": "starboard-language-job",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }

  return {
    data: await response.json(),
    headers: response.headers
  };
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    })
  );
}
