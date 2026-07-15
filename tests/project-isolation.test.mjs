import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const namespace = "zhengzhidaotu_20260715_k4m8";

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("all application storage names share the unique project namespace", async () => {
  const config = await source("app/lib/app-config.ts");
  for (const suffix of ["library-v1", "auth-session", "settings-v1", "sync-state-v1", "cache-v1"]) {
    assert.match(config, new RegExp(`${namespace}.*${suffix}|APP_NAMESPACE.*${suffix}`));
  }
  assert.match(config, new RegExp(`APP_NAMESPACE = "${namespace}"`));
});

test("application never clears or reads generic browser storage", async () => {
  const files = await Promise.all([
    source("app/study-reader.tsx"),
    source("app/lib/use-cloud-sync.ts"),
    source("app/lib/supabase-client.ts"),
  ]);
  const joined = files.join("\n");
  assert.doesNotMatch(joined, /localStorage\.clear\s*\(/);
  assert.doesNotMatch(joined, /sessionStorage\.(?:getItem|setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(joined, /politics-map-(?:highlights|entry-notes|study-versions)/);
  for (const match of joined.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(([^,\n)]+)/g)) {
    assert.match(match[1], /STORAGE_KEYS\.|\bkey\b/);
  }
  assert.match(joined, /key\.startsWith\(STORAGE_KEYS\.authSession\)/);
});

test("cache cleanup is limited to this project's cache prefix", async () => {
  const worker = await source("public/sw.js");
  assert.match(worker, new RegExp(`APP_NAMESPACE = "${namespace}"`));
  assert.match(worker, /name\.startsWith\(`\$\{APP_NAMESPACE\}-`\)/);
  assert.doesNotMatch(worker, /caches\.keys\(\)[\s\S]*map\(\(name\) => caches\.delete\(name\)\)(?![\s\S]*startsWith)/);
});

test("database grants and each RLS operation are scoped to auth.uid", async () => {
  const sql = await source("supabase/zhengzhidaotu_20260715_k4m8_schema.sql");
  assert.match(sql, new RegExp(`public\\.${namespace}_items`));
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all[\s\S]*from anon/i);
  for (const operation of ["select", "insert", "update", "delete"]) {
    const policy = new RegExp(`for ${operation}[\\s\\S]*?to authenticated[\\s\\S]*?auth\\.uid\\(\\)\\) = user_id`, "i");
    assert.match(sql, policy);
  }
});

test("only the public Supabase browser variables are referenced", async () => {
  const [client, env, workflow] = await Promise.all([
    source("app/lib/supabase-client.ts"),
    source(".env.example"),
    source(".github/workflows/deploy-pages.yml"),
  ]);
  const joined = `${client}\n${env}\n${workflow}`;
  assert.match(joined, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(joined, /service_role|SUPABASE_SECRET_KEY/i);
});
