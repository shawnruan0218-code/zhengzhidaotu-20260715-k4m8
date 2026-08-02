import { readFile, writeFile } from "node:fs/promises";

const [backupPath, outputPath, githubId, githubLogin] = process.argv.slice(2);

if (!backupPath || !outputPath || !githubId || !githubLogin) {
  throw new Error(
    "用法: node scripts/migrate-supabase-backup-to-d1.mjs <backup.json> <output.sql> <github-id> <github-login>",
  );
}

const namespace = "zhengzhidaotu_20260715_k4m8";
const userId = `github:${githubId}`;
const rows = JSON.parse(await readFile(backupPath, "utf8"));

if (!Array.isArray(rows)) throw new Error("Supabase 备份格式不正确");

function timestamp(value) {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function chooseLatest(left, right) {
  const delta = timestamp(left.updated_at) - timestamp(right.updated_at);
  if (delta !== 0) return delta > 0 ? left : right;
  if (Boolean(left.deleted_at) !== Boolean(right.deleted_at)) {
    return left.deleted_at ? left : right;
  }
  return JSON.stringify(left.item_data).localeCompare(JSON.stringify(right.item_data)) >= 0
    ? left
    : right;
}

const merged = new Map();
for (const row of rows) {
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.item_key !== "string" ||
    !row.item_key.startsWith(`${namespace}:`) ||
    typeof row.item_type !== "string" ||
    !row.item_data ||
    typeof row.item_data !== "object" ||
    Array.isArray(row.item_data)
  ) {
    throw new Error("Supabase 备份中包含不符合项目命名空间的记录");
  }
  const current = merged.get(row.item_key);
  merged.set(row.item_key, current ? chooseLatest(current, row) : row);
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const now = new Date().toISOString();
const statements = [
  "PRAGMA foreign_keys = ON;",
  `INSERT INTO ${namespace}_users (id,github_id,github_login,display_name,email,avatar_url,created_at,updated_at) VALUES (${sql(userId)},${sql(githubId)},${sql(githubLogin)},NULL,NULL,${sql(`https://avatars.githubusercontent.com/u/${githubId}?v=4`)},${sql(now)},${sql(now)}) ON CONFLICT(id) DO UPDATE SET github_login=excluded.github_login,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;`,
];

for (const row of merged.values()) {
  const addedAt = typeof row.added_at === "string" ? row.added_at : row.updated_at;
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : now;
  statements.push(
    `INSERT INTO ${namespace}_items (id,user_id,item_key,item_type,item_data,added_at,updated_at,server_changed_at,deleted_at) VALUES (${sql(`${userId}::${row.item_key}`)},${sql(userId)},${sql(row.item_key)},${sql(row.item_type)},${sql(JSON.stringify(row.item_data))},${sql(addedAt)},${sql(updatedAt)},${sql(now)},${sql(row.deleted_at)}) ON CONFLICT(user_id,item_key) DO UPDATE SET item_type=excluded.item_type,item_data=excluded.item_data,added_at=excluded.added_at,updated_at=excluded.updated_at,server_changed_at=excluded.server_changed_at,deleted_at=excluded.deleted_at WHERE excluded.updated_at>${namespace}_items.updated_at;`,
  );
}

await writeFile(outputPath, `${statements.join("\n")}\n`, { mode: 0o600 });
console.log(JSON.stringify({ sourceRecords: rows.length, migratedRecords: merged.size, outputPath }));
