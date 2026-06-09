import pg from "pg";

const { Pool } = pg;
let pool;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured. Add it to .env.local.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 4
    });
  }

  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export async function ensureSchema() {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`
      create table if not exists accounts (
        github_id text primary key,
        login text not null unique,
        type text not null,
        avatar_url text,
        html_url text,
        total_stars integer not null default 0,
        starred_repo_count integer not null default 0,
        top_repo_full_name text,
        top_repo_stars integer,
        repo_names jsonb not null default '[]'::jsonb,
        repos jsonb not null default '[]'::jsonb,
        refreshed_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await client.query(`
      create table if not exists repositories (
        github_id bigint primary key,
        full_name text not null unique,
        owner_github_id text not null references accounts(github_id) on delete cascade,
        owner_login text not null,
        name text not null,
        description text,
        language text,
        topics jsonb not null default '[]'::jsonb,
        stars integer not null default 0,
        forks integer not null default 0,
        fork boolean not null default false,
        archived boolean not null default false,
        avatar_url text,
        html_url text,
        default_branch text,
        owner_type text,
        owner_html_url text,
        repo_created_at timestamptz,
        repo_pushed_at timestamptz,
        repo_updated_at timestamptz,
        source_query_keys jsonb not null default '[]'::jsonb,
        english_check_status text not null default 'unknown',
        english_check_confidence numeric,
        english_checked_at timestamptz,
        refreshed_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await client.query(`
      create table if not exists leaderboard_snapshots (
        period text not null,
        view text not null,
        subject_id text not null,
        rank integer not null,
        stars integer not null default 0,
        repo_count integer not null default 0,
        sort_key text not null default 'stars',
        snapshot_rows jsonb not null default '[]'::jsonb,
        total_indexed_count integer not null default 0,
        coverage_label text,
        metadata jsonb not null default '{}'::jsonb,
        generated_at timestamptz not null default now(),
        computed_at timestamptz not null default now(),
        primary key (period, view, subject_id)
      );
    `);
    await client.query(`
      create table if not exists ingestion_runs (
        id bigserial primary key,
        job_type text not null,
        status text not null,
        started_at timestamptz not null default now(),
        finished_at timestamptz,
        github_requests integer not null default 0,
        repos_discovered integer not null default 0,
        accounts_discovered integer not null default 0,
        error_message text,
        metadata jsonb not null default '{}'::jsonb
      );
    `);
    await client.query(`
      create table if not exists discovery_queries (
        id bigserial primary key,
        query_key text not null unique,
        query text not null,
        period text not null default 'all',
        sort text not null default 'stars',
        enabled boolean not null default true,
        last_run_at timestamptz,
        last_status text,
        last_result_count integer,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await addColumnIfMissing(client, "repositories", "owner_type", "text");
    await addColumnIfMissing(client, "repositories", "owner_html_url", "text");
    await addColumnIfMissing(client, "repositories", "repo_created_at", "timestamptz");
    await addColumnIfMissing(client, "repositories", "repo_pushed_at", "timestamptz");
    await addColumnIfMissing(client, "repositories", "repo_updated_at", "timestamptz");
    await addColumnIfMissing(client, "repositories", "source_query_keys", "jsonb not null default '[]'::jsonb");
    await addColumnIfMissing(client, "repositories", "english_check_status", "text not null default 'unknown'");
    await addColumnIfMissing(client, "repositories", "english_check_confidence", "numeric");
    await addColumnIfMissing(client, "repositories", "english_checked_at", "timestamptz");
    await addColumnIfMissing(client, "leaderboard_snapshots", "sort_key", "text not null default 'stars'");
    await addColumnIfMissing(client, "leaderboard_snapshots", "snapshot_rows", "jsonb not null default '[]'::jsonb");
    await addColumnIfMissing(client, "leaderboard_snapshots", "total_indexed_count", "integer not null default 0");
    await addColumnIfMissing(client, "leaderboard_snapshots", "coverage_label", "text");
    await addColumnIfMissing(client, "leaderboard_snapshots", "metadata", "jsonb not null default '{}'::jsonb");
    await addColumnIfMissing(client, "leaderboard_snapshots", "generated_at", "timestamptz not null default now()");
    await client.query("create index if not exists accounts_total_stars_idx on accounts (total_stars desc);");
    await client.query("create index if not exists accounts_starred_repo_count_idx on accounts (starred_repo_count desc);");
    await client.query("create index if not exists repositories_owner_github_id_idx on repositories (owner_github_id);");
    await client.query("create index if not exists repositories_stars_idx on repositories (stars desc);");
    await client.query("create index if not exists repositories_repo_created_at_idx on repositories (repo_created_at desc);");
    await client.query("create index if not exists repositories_english_check_status_idx on repositories (english_check_status);");
    await client.query("create index if not exists discovery_queries_enabled_idx on discovery_queries (enabled, period);");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function addColumnIfMissing(client, tableName, columnName, columnDefinition) {
  await client.query(`alter table ${tableName} add column if not exists ${columnName} ${columnDefinition};`);
}

export async function seedDefaultDiscoveryQueries() {
  await ensureSchema();
  const queries = defaultDiscoveryQueries();
  for (const query of queries) {
    await getPool().query(
      `
        insert into discovery_queries (query_key, query, period, sort, enabled, metadata, updated_at)
        values ($1, $2, $3, $4, true, $5::jsonb, now())
        on conflict (query_key) do update set
          query = excluded.query,
          period = excluded.period,
          sort = excluded.sort,
          metadata = discovery_queries.metadata || excluded.metadata,
          updated_at = now()
      `,
      [
        query.queryKey,
        query.query,
        query.period,
        query.sort || "stars",
        JSON.stringify(query.metadata || {})
      ]
    );
  }
  return queries.length;
}

export async function listEnabledDiscoveryQueries(options = {}) {
  await ensureSchema();
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const values = [];
  const where = ["enabled = true"];
  if (options.period) {
    values.push(options.period);
    where.push(`period = $${values.length}`);
  }
  values.push(limit);
  const result = await getPool().query(
    `
      select *
      from discovery_queries
      where ${where.join(" and ")}
      order by period asc, id asc
      limit $${values.length}
    `,
    values
  );
  return result.rows.map((row) => ({
    id: row.id,
    queryKey: row.query_key,
    query: row.query,
    period: row.period,
    sort: row.sort,
    enabled: row.enabled,
    metadata: row.metadata || {}
  }));
}

export async function startIngestionRun(jobType, metadata = {}) {
  await ensureSchema();
  const result = await getPool().query(
    `
      insert into ingestion_runs (job_type, status, metadata)
      values ($1, 'running', $2::jsonb)
      returning id
    `,
    [jobType, JSON.stringify(metadata)]
  );
  return result.rows[0].id;
}

export async function finishIngestionRun(runId, updates = {}) {
  await ensureSchema();
  await getPool().query(
    `
      update ingestion_runs
      set
        status = $2,
        finished_at = now(),
        github_requests = $3,
        repos_discovered = $4,
        accounts_discovered = $5,
        error_message = $6,
        metadata = metadata || $7::jsonb
      where id = $1
    `,
    [
      runId,
      updates.status || "completed",
      updates.githubRequests || 0,
      updates.reposDiscovered || 0,
      updates.accountsDiscovered || 0,
      updates.errorMessage || null,
      JSON.stringify(updates.metadata || {})
    ]
  );
}

export async function markDiscoveryQueryRun(queryKey, updates = {}) {
  await ensureSchema();
  await getPool().query(
    `
      update discovery_queries
      set
        last_run_at = now(),
        last_status = $2,
        last_result_count = $3,
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where query_key = $1
    `,
    [
      queryKey,
      updates.status || "completed",
      updates.resultCount || 0,
      JSON.stringify(updates.metadata || {})
    ]
  );
}

export async function upsertRepository(repo, options = {}) {
  if (!options.client) await ensureSchema();
  const ownerGithubId = String(repo.ownerId || repo.owner || repo.owner_github_id);
  const ownerLogin = repo.owner || repo.ownerLogin || repo.owner_login;
  const sourceQueryKey = options.sourceQueryKey || null;
  const sourceKeys = sourceQueryKey ? [sourceQueryKey] : [];
  const client = options.client || (await getPool().connect());
  const releaseClient = !options.client;

  try {
    await client.query(
      `
        insert into accounts (
          github_id, login, type, avatar_url, html_url, refreshed_at, updated_at
        )
        values ($1, $2, $3, $4, $5, now(), now())
        on conflict (github_id) do update set
          login = excluded.login,
          type = excluded.type,
          avatar_url = coalesce(excluded.avatar_url, accounts.avatar_url),
          html_url = coalesce(excluded.html_url, accounts.html_url),
          updated_at = now()
      `,
      [
        ownerGithubId,
        ownerLogin,
        repo.ownerType || "User",
        repo.avatar || null,
        repo.ownerUrl || null
      ]
    );

    await client.query(
      `
        insert into repositories (
          github_id, full_name, owner_github_id, owner_login, name, description, language,
          topics, stars, forks, fork, archived, avatar_url, html_url, default_branch,
          owner_type, owner_html_url, repo_created_at, repo_pushed_at, repo_updated_at,
          source_query_keys, english_check_status, english_check_confidence, english_checked_at,
          refreshed_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24, now(), now()
        )
        on conflict (github_id) do update set
          full_name = excluded.full_name,
          owner_github_id = excluded.owner_github_id,
          owner_login = excluded.owner_login,
          name = excluded.name,
          description = excluded.description,
          language = excluded.language,
          topics = excluded.topics,
          stars = excluded.stars,
          forks = excluded.forks,
          fork = excluded.fork,
          archived = excluded.archived,
          avatar_url = excluded.avatar_url,
          html_url = excluded.html_url,
          default_branch = excluded.default_branch,
          owner_type = excluded.owner_type,
          owner_html_url = excluded.owner_html_url,
          repo_created_at = excluded.repo_created_at,
          repo_pushed_at = excluded.repo_pushed_at,
          repo_updated_at = excluded.repo_updated_at,
          source_query_keys = (
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements(repositories.source_query_keys || excluded.source_query_keys) as value
          ),
          english_check_status = excluded.english_check_status,
          english_check_confidence = excluded.english_check_confidence,
          english_checked_at = excluded.english_checked_at,
          refreshed_at = now(),
          updated_at = now()
      `,
      [
        repo.id,
        repo.fullName,
        ownerGithubId,
        ownerLogin,
        repo.name,
        repo.description || null,
        repo.language || null,
        JSON.stringify(repo.topics || []),
        repo.stars || 0,
        repo.forks || 0,
        Boolean(repo.fork),
        Boolean(repo.archived),
        repo.avatar || null,
        repo.repoUrl || null,
        repo.defaultBranch || null,
        repo.ownerType || "User",
        repo.ownerUrl || null,
        repo.createdAt || null,
        repo.pushedAt || null,
        repo.updatedAt || null,
        JSON.stringify(sourceKeys),
        repo.englishCheckStatus || "unknown",
        repo.englishCheckConfidence ?? null,
        repo.englishCheckedAt || null
      ]
    );
  } finally {
    if (releaseClient) client.release();
  }
}

export async function upsertRepositories(repos, options = {}) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    for (const repo of repos) {
      await upsertRepository(repo, { ...options, client });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function readRepositoriesForSnapshot(period = "all") {
  await ensureSchema();
  const values = [];
  const where = [
    "stars >= 1",
    "fork = false",
    "archived = false",
    "english_check_status <> 'rejected'"
  ];

  const days = periodWindowDays(period);
  if (days) {
    values.push(days);
    where.push(`repo_created_at >= now() - ($${values.length}::text || ' days')::interval`);
  }

  const result = await getPool().query(
    `
      select *
      from repositories
      where ${where.join(" and ")}
      order by stars desc, full_name asc
      limit 1000
    `,
    values
  );

  return result.rows.map(repositoryRowFromDb);
}

export async function buildSnapshotRows(view, period) {
  await ensureSchema();
  if (view === "repositories") {
    const repos = await readRepositoriesForSnapshot(period);
    return repos.map((repo, index) => ({
      ...repo,
      rank: index + 1
    }));
  }

  if (view === "accounts") {
    if (period === "all") return readAllTimeAccountSnapshotRows();
    return readRollingAccountSnapshotRows(period);
  }

  throw new Error(`Unsupported snapshot view: ${view}`);
}

export async function writeLeaderboardSnapshot({ period, view, rows, coverageLabel, metadata = {} }) {
  await ensureSchema();
  const generatedAt = new Date().toISOString();
  await getPool().query(
    `
      insert into leaderboard_snapshots (
        period, view, subject_id, rank, stars, repo_count, sort_key, snapshot_rows,
        total_indexed_count, coverage_label, metadata, generated_at, computed_at
      )
      values ($1, $2, '__snapshot__', 0, 0, 0, 'stars', $3::jsonb, $4, $5, $6::jsonb, $7, now())
      on conflict (period, view, subject_id) do update set
        rank = excluded.rank,
        stars = excluded.stars,
        repo_count = excluded.repo_count,
        sort_key = excluded.sort_key,
        snapshot_rows = excluded.snapshot_rows,
        total_indexed_count = excluded.total_indexed_count,
        coverage_label = excluded.coverage_label,
        metadata = excluded.metadata,
        generated_at = excluded.generated_at,
        computed_at = now()
    `,
    [
      period,
      view,
      JSON.stringify(rows),
      rows.length,
      coverageLabel || defaultCoverageLabel(period, view, rows.length),
      JSON.stringify(metadata),
      generatedAt
    ]
  );
  return {
    period,
    view,
    generatedAt,
    total: rows.length
  };
}

export async function refreshAccountRollupsFromRepositories() {
  await ensureSchema();
  const result = await getPool().query(
    `
      with repo_rollups as (
        select
          owner_github_id,
          owner_login,
          coalesce(max(owner_type), 'User') as owner_type,
          max(avatar_url) as avatar_url,
          max(owner_html_url) as owner_html_url,
          sum(stars)::integer as total_stars,
          count(*)::integer as repo_count,
          (array_agg(full_name order by stars desc, full_name asc))[1] as top_repo_full_name,
          (array_agg(stars order by stars desc, full_name asc))[1] as top_repo_stars,
          jsonb_agg(full_name order by stars desc, full_name asc) as repo_names,
          jsonb_agg(to_jsonb(repositories) order by stars desc, full_name asc) as repos
        from repositories
        where stars >= 1
          and fork = false
          and archived = false
          and english_check_status <> 'rejected'
        group by owner_github_id, owner_login
      )
      update accounts
      set
        login = repo_rollups.owner_login,
        type = repo_rollups.owner_type,
        avatar_url = coalesce(repo_rollups.avatar_url, accounts.avatar_url),
        html_url = coalesce(repo_rollups.owner_html_url, accounts.html_url),
        total_stars = greatest(accounts.total_stars, repo_rollups.total_stars),
        starred_repo_count = greatest(accounts.starred_repo_count, repo_rollups.repo_count),
        top_repo_full_name = case
          when accounts.top_repo_stars is null or repo_rollups.top_repo_stars >= accounts.top_repo_stars
          then repo_rollups.top_repo_full_name
          else accounts.top_repo_full_name
        end,
        top_repo_stars = greatest(coalesce(accounts.top_repo_stars, 0), coalesce(repo_rollups.top_repo_stars, 0)),
        repo_names = case
          when jsonb_array_length(accounts.repo_names) >= jsonb_array_length(repo_rollups.repo_names)
          then accounts.repo_names
          else repo_rollups.repo_names
        end,
        repos = case
          when jsonb_array_length(accounts.repos) >= jsonb_array_length(repo_rollups.repos)
          then accounts.repos
          else repo_rollups.repos
        end,
        refreshed_at = now(),
        updated_at = now()
      from repo_rollups
      where accounts.github_id = repo_rollups.owner_github_id
      returning accounts.github_id
    `
  );
  return result.rowCount || 0;
}

export async function readLeaderboardSnapshot(options = {}) {
  await ensureSchema();
  const period = options.period || "all";
  const view = normalizeSnapshotView(options.view || "repositories");
  const query = (options.query || "").trim().toLowerCase();
  const sortKey = options.sortKey || "stars";
  const sortDirection = options.sortDirection === "asc" ? "asc" : "desc";
  const offset = Math.max(Number(options.offset || 0), 0);
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 1000);

  const result = await getPool().query(
    `
      select snapshot_rows, total_indexed_count, coverage_label, metadata, generated_at
      from leaderboard_snapshots
      where period = $1 and view = $2 and subject_id = '__snapshot__'
      limit 1
    `,
    [period, view]
  );
  const snapshot = result.rows[0];
  if (!snapshot) return null;

  const rows = filterSnapshotRows(snapshot.snapshot_rows || [], query, view);
  const sortedRows = sortSnapshotRows(rows, sortKey, sortDirection, view).map((row, index) => ({
    ...row,
    rank: index + 1
  }));

  return {
    generatedAt: snapshot.generated_at?.toISOString?.() || snapshot.generated_at,
    total: rows.length,
    totalIndexedCount: snapshot.total_indexed_count || rows.length,
    coverageLabel: snapshot.coverage_label,
    metadata: snapshot.metadata || {},
    rows: sortedRows.slice(offset, offset + limit)
  };
}

export async function getCacheStatus() {
  await ensureSchema();
  const [accounts, repositories, snapshots, runs] = await Promise.all([
    getPool().query("select count(*)::integer as count from accounts"),
    getPool().query("select count(*)::integer as count from repositories"),
    getPool().query("select count(*)::integer as count from leaderboard_snapshots where subject_id = '__snapshot__'"),
    getPool().query(`
      select job_type, status, started_at, finished_at, github_requests, repos_discovered, accounts_discovered, error_message
      from ingestion_runs
      order by started_at desc
      limit 5
    `)
  ]);

  return {
    accounts: accounts.rows[0]?.count || 0,
    repositories: repositories.rows[0]?.count || 0,
    snapshots: snapshots.rows[0]?.count || 0,
    recentRuns: runs.rows.map((row) => ({
      jobType: row.job_type,
      status: row.status,
      startedAt: row.started_at?.toISOString?.() || row.started_at,
      finishedAt: row.finished_at?.toISOString?.() || row.finished_at,
      githubRequests: row.github_requests,
      reposDiscovered: row.repos_discovered,
      accountsDiscovered: row.accounts_discovered,
      errorMessage: row.error_message
    }))
  };
}

export async function readAllTimeAccountsFromDb(options = {}) {
  await ensureSchema();
  const query = (options.query || "").trim().toLowerCase();
  const sortKey = options.sortKey === "repos" ? "starred_repo_count" : "total_stars";
  const sortDirection = options.sortDirection === "asc" ? "asc" : "desc";
  const offset = Math.max(Number(options.offset || 0), 0);
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 500);
  const values = [];
  const where = [];

  if (query) {
    values.push(`%${query}%`);
    where.push(`(
      lower(login) like $${values.length}
      or lower(type) like $${values.length}
      or lower(coalesce(top_repo_full_name, '')) like $${values.length}
      or exists (
        select 1
        from jsonb_array_elements_text(repo_names) repo_name
        where lower(repo_name) like $${values.length}
      )
    )`);
  }

  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  values.push(limit, offset);
  const limitIndex = values.length - 1;
  const offsetIndex = values.length;
  const countResult = await getPool().query(`select count(*)::integer as total from accounts ${whereSql}`, values.slice(0, -2));
  const rowsResult = await getPool().query(
    `
      select *
      from accounts
      ${whereSql}
      order by ${sortKey} ${sortDirection}, login asc
      limit $${limitIndex}
      offset $${offsetIndex}
    `,
    values
  );

  return {
    generatedAt: await latestAccountRefresh(),
    seedPages: null,
    total: countResult.rows[0]?.total || 0,
    rows: rowsResult.rows.map(accountRowFromDb)
  };
}

export async function upsertAccountDetail(account) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `
        insert into accounts (
          github_id, login, type, avatar_url, html_url, total_stars, starred_repo_count,
          top_repo_full_name, top_repo_stars, repo_names, repos, refreshed_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, now())
        on conflict (github_id) do update set
          login = excluded.login,
          type = excluded.type,
          avatar_url = excluded.avatar_url,
          html_url = excluded.html_url,
          total_stars = excluded.total_stars,
          starred_repo_count = excluded.starred_repo_count,
          top_repo_full_name = excluded.top_repo_full_name,
          top_repo_stars = excluded.top_repo_stars,
          repo_names = excluded.repo_names,
          repos = excluded.repos,
          refreshed_at = excluded.refreshed_at,
          updated_at = now()
      `,
      [
        account.id,
        account.login,
        account.type || "User",
        account.avatarUrl || null,
        account.htmlUrl || null,
        account.starScore || 0,
        account.repoCount || 0,
        account.topRepo?.fullName || null,
        account.topRepo?.stars || null,
        JSON.stringify(account.repoNames || []),
        JSON.stringify(account.repos || []),
        account.refreshedAt || new Date().toISOString()
      ]
    );

    for (const repo of account.repos || []) {
      await client.query(
        `
          insert into repositories (
            github_id, full_name, owner_github_id, owner_login, name, description, language,
            topics, stars, forks, fork, archived, avatar_url, html_url, default_branch,
            refreshed_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, now(), now())
          on conflict (github_id) do update set
            full_name = excluded.full_name,
            owner_github_id = excluded.owner_github_id,
            owner_login = excluded.owner_login,
            name = excluded.name,
            description = excluded.description,
            language = excluded.language,
            topics = excluded.topics,
            stars = excluded.stars,
            forks = excluded.forks,
            fork = excluded.fork,
            archived = excluded.archived,
            avatar_url = excluded.avatar_url,
            html_url = excluded.html_url,
            default_branch = excluded.default_branch,
            refreshed_at = now(),
            updated_at = now()
        `,
        [
          repo.id,
          repo.fullName,
          account.id,
          account.login,
          repo.name,
          repo.description || null,
          repo.language || null,
          JSON.stringify(repo.topics || []),
          repo.stars || 0,
          repo.forks || 0,
          Boolean(repo.fork),
          Boolean(repo.archived),
          repo.avatar || null,
          repo.repoUrl || null,
          repo.defaultBranch || null
        ]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertAccountSummary(account) {
  await ensureSchema();
  await getPool().query(
    `
      insert into accounts (
        github_id, login, type, avatar_url, html_url, total_stars, starred_repo_count,
        top_repo_full_name, top_repo_stars, repo_names, repos, refreshed_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, now())
      on conflict (github_id) do update set
        login = excluded.login,
        type = excluded.type,
        avatar_url = excluded.avatar_url,
        html_url = excluded.html_url,
        total_stars = excluded.total_stars,
        starred_repo_count = excluded.starred_repo_count,
        top_repo_full_name = excluded.top_repo_full_name,
        top_repo_stars = excluded.top_repo_stars,
        repo_names = excluded.repo_names,
        repos = excluded.repos,
        refreshed_at = excluded.refreshed_at,
        updated_at = now()
    `,
    [
      account.id,
      account.login,
      account.type || "User",
      account.avatarUrl || null,
      account.htmlUrl || null,
      account.starScore || 0,
      account.repoCount || 0,
      account.topRepo?.fullName || null,
      account.topRepo?.stars || null,
      JSON.stringify(account.repoNames || []),
      JSON.stringify(account.repos || []),
      account.refreshedAt || new Date().toISOString()
    ]
  );
}

export async function getAccountRefreshMap() {
  await ensureSchema();
  const result = await getPool().query("select github_id, refreshed_at from accounts");
  return new Map(result.rows.map((row) => [row.github_id, row.refreshed_at]));
}

async function latestAccountRefresh() {
  const result = await getPool().query("select max(refreshed_at) as generated_at from accounts");
  return result.rows[0]?.generated_at?.toISOString?.() || null;
}

function accountRowFromDb(row) {
  return {
    id: row.github_id,
    login: row.login,
    type: row.type,
    avatarUrl: row.avatar_url,
    htmlUrl: row.html_url,
    starScore: row.total_stars,
    repoCount: row.starred_repo_count,
    topRepo: row.top_repo_full_name
      ? {
          name: row.top_repo_full_name.split("/").pop(),
          fullName: row.top_repo_full_name,
          stars: row.top_repo_stars || 0,
          url: `https://github.com/${row.top_repo_full_name}`
        }
      : null,
    repoNames: row.repo_names || [],
    repos: row.repos || [],
    refreshedAt: row.refreshed_at?.toISOString?.() || row.refreshed_at,
    enriched: true
  };
}

function repositoryRowFromDb(row) {
  return {
    id: row.github_id,
    fullName: row.full_name,
    owner: row.owner_login,
    ownerId: row.owner_github_id,
    ownerType: row.owner_type || "User",
    ownerUrl: row.owner_html_url || `https://github.com/${row.owner_login}`,
    name: row.name,
    description: row.description || "",
    language: row.language || "Unknown",
    topics: row.topics || [],
    stars: row.stars || 0,
    forks: row.forks || 0,
    fork: Boolean(row.fork),
    archived: Boolean(row.archived),
    avatar: row.avatar_url,
    repoUrl: row.html_url,
    defaultBranch: row.default_branch || "main",
    createdAt: row.repo_created_at?.toISOString?.() || row.repo_created_at,
    pushedAt: row.repo_pushed_at?.toISOString?.() || row.repo_pushed_at,
    updatedAt: row.repo_updated_at?.toISOString?.() || row.repo_updated_at
  };
}

async function readAllTimeAccountSnapshotRows() {
  const result = await getPool().query(
    `
      select *
      from accounts
      where total_stars >= 1
      order by total_stars desc, login asc
      limit 1000
    `
  );
  return result.rows.map((row, index) => ({
    ...accountRowFromDb(row),
    rank: index + 1
  }));
}

async function readRollingAccountSnapshotRows(period) {
  const days = periodWindowDays(period);
  if (!days) return [];
  const result = await getPool().query(
    `
      with qualifying_repos as (
        select *
        from repositories
        where stars >= 1
          and fork = false
          and archived = false
          and english_check_status <> 'rejected'
          and repo_created_at >= now() - ($1::text || ' days')::interval
      ),
      account_rollups as (
        select
          owner_github_id,
          owner_login,
          coalesce(max(owner_type), 'User') as owner_type,
          max(avatar_url) as avatar_url,
          max(owner_html_url) as owner_html_url,
          sum(stars)::integer as total_stars,
          count(*)::integer as repo_count,
          jsonb_agg(to_jsonb(qualifying_repos) order by stars desc, full_name asc) as repos
        from qualifying_repos
        group by owner_github_id, owner_login
      )
      select *
      from account_rollups
      order by total_stars desc, owner_login asc
      limit 1000
    `,
    [days]
  );

  return result.rows.map((row, index) => {
    const repos = (row.repos || []).map(repositoryRowFromDb);
    const topRepo = repos[0]
      ? {
          name: repos[0].name,
          fullName: repos[0].fullName,
          stars: repos[0].stars,
          url: repos[0].repoUrl
        }
      : null;
    return {
      id: row.owner_github_id,
      login: row.owner_login,
      type: row.owner_type,
      avatarUrl: row.avatar_url,
      htmlUrl: row.owner_html_url || `https://github.com/${row.owner_login}`,
      starScore: row.total_stars,
      repoCount: row.repo_count,
      topRepo,
      repoNames: repos.map((repo) => repo.fullName),
      repos,
      enriched: true,
      rank: index + 1
    };
  });
}

function filterSnapshotRows(rows, query, view) {
  if (!query) return rows;
  return rows.filter((row) => {
    const text = view === "accounts"
      ? [
          row.login,
          row.type,
          row.topRepo?.fullName,
          ...(row.repoNames || [])
        ]
      : [
          row.owner,
          row.name,
          row.fullName,
          row.description,
          row.language,
          ...(row.topics || [])
        ];
    return text.join(" ").toLowerCase().includes(query);
  });
}

function sortSnapshotRows(rows, sortKey, sortDirection, view) {
  const normalizedKey = view === "accounts" && sortKey === "repos" ? "repos" : sortKey;
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = snapshotSortValue(a, normalizedKey, view);
    const bValue = snapshotSortValue(b, normalizedKey, view);
    if (aValue === bValue) {
      const aName = view === "accounts" ? a.login : a.fullName;
      const bName = view === "accounts" ? b.login : b.fullName;
      return String(aName).localeCompare(String(bName));
    }
    return (aValue - bValue) * direction;
  });
}

function snapshotSortValue(row, sortKey, view) {
  if (sortKey === "forks") return row.forks || 0;
  if (sortKey === "repos") return row.repoCount || 0;
  return view === "accounts" ? row.starScore || 0 : row.stars || 0;
}

function normalizeSnapshotView(view) {
  return view === "repos" ? "repositories" : view;
}

function periodWindowDays(period) {
  return {
    today: 1,
    week: 7,
    month: 30
  }[period] || null;
}

function defaultCoverageLabel(period, view, count) {
  const noun = view === "accounts" ? "accounts" : "repositories";
  return `Showing ${count} indexed ${noun} for ${period}.`;
}

function defaultDiscoveryQueries() {
  const base = "fork:false archived:false stars:>=1";
  const starBuckets = [
    ["all-stars-100000-plus", "stars:>=100000 fork:false archived:false"],
    ["all-stars-50000-99999", "stars:50000..99999 fork:false archived:false"],
    ["all-stars-10000-49999", "stars:10000..49999 fork:false archived:false"],
    ["all-stars-5000-9999", "stars:5000..9999 fork:false archived:false"],
    ["all-stars-1000-4999", "stars:1000..4999 fork:false archived:false"],
    ["all-stars-500-999", "stars:500..999 fork:false archived:false"],
    ["all-stars-100-499", "stars:100..499 fork:false archived:false"]
  ];
  const languages = ["javascript", "typescript", "python", "go", "rust", "swift", "kotlin", "java"];

  return [
    ...starBuckets.map(([queryKey, query]) => ({
      queryKey,
      query,
      period: "all",
      sort: "stars",
      metadata: { family: "star_bucket" }
    })),
    ...["today", "week", "month"].map((period) => ({
      queryKey: `${period}-created`,
      query: `${base} created:>={cutoff}`,
      period,
      sort: "stars",
      metadata: { family: "rolling_created" }
    })),
    ...languages.map((language) => ({
      queryKey: `all-language-${language}`,
      query: `${base} language:${language}`,
      period: "all",
      sort: "stars",
      metadata: { family: "language", language }
    }))
  ];
}
