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
    source("app/lib/cloudflare-client.ts"),
  ]);
  const joined = files.join("\n");
  assert.doesNotMatch(joined, /localStorage\.clear\s*\(/);
  assert.doesNotMatch(joined, /sessionStorage\.(?:getItem|setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(joined, /politics-map-(?:highlights|entry-notes|study-versions)/);
  for (const match of joined.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(([^,\n)]+)/g)) {
    assert.match(match[1], /STORAGE_KEYS\.|\bkey\b/);
  }
  assert.match(joined, /localStorage\.removeItem\(STORAGE_KEYS\.cloudflareAuthSession\)/);
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

test("AI usage totals are account-scoped and browser clients cannot modify them", async () => {
  const sql = await source("supabase/migrations/20260725180000_zhengzhidaotu_ai_usage.sql");
  assert.match(sql, new RegExp(`public\\.${namespace}_ai_usage`));
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /grant select[\s\S]*to authenticated/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|all)[\s\S]*to authenticated/i);
  assert.match(
    sql,
    /for select[\s\S]*?to authenticated[\s\S]*?auth\.uid\(\)\) = user_id/i,
  );
  assert.match(sql, /security definer/i);
  assert.match(
    sql,
    /revoke all on function[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
});

test("runtime configuration only exposes the public Cloudflare Worker URL", async () => {
  const [client, env, workflow] = await Promise.all([
    source("app/lib/cloudflare-client.ts"),
    source(".env.example"),
    source(".github/workflows/deploy-pages.yml"),
  ]);
  const joined = `${client}\n${env}\n${workflow}`;
  assert.match(joined, /NEXT_PUBLIC_CLOUDFLARE_API_URL/);
  assert.doesNotMatch(joined, /NEXT_PUBLIC_SUPABASE|service_role|SUPABASE_SECRET_KEY/i);
});

test("critical study edits are durable before a sync cursor can advance", async () => {
  const [reader, sync] = await Promise.all([
    source("app/study-reader.tsx"),
    source("app/lib/use-cloud-sync.ts"),
  ]);
  assert.match(reader, /commitVersionsDurably[\s\S]*?localStorage\.setItem\([\s\S]*?STORAGE_KEYS\.library/);
  assert.match(sync, /ANNOTATION_RECORDS_VERSION = 2/);
  const mergeWrite = sync.indexOf("STORAGE_KEYS.library", sync.indexOf("const applyMergedRecords"));
  const cursorAdvance = sync.indexOf("cursorRef.current = confirmed.cursor", sync.indexOf("const performSync"));
  assert.ok(mergeWrite >= 0 && cursorAdvance > mergeWrite);
});

test("a cloud sync finishing after a highlight always reconciles against the newest durable memory", async () => {
  const [reader, sync] = await Promise.all([
    source("app/study-reader.tsx"),
    source("app/lib/use-cloud-sync.ts"),
  ]);
  assert.match(reader, /commitVersionsDurably[\s\S]*?versionsRef\.current = next;[\s\S]*?setVersions\(next\)/);
  assert.match(sync, /const currentVersions = latestInputs\.current\.versionsRef\.current/);
  assert.match(sync, /reconcileVersionSnapshots\(currentVersions, nextVersions/);
  assert.match(sync, /setters\.versionsRef\.current = reconciled;[\s\S]*?setters\.setVersions\(reconciled\)/);
  assert.doesNotMatch(sync, /reconcileVersionSnapshots\(latestInputs\.current\.versions,/);
});

test("highlight feedback paints immediately without weakening durable storage or sync", async () => {
  const [reader, noteText, entryText, feedback, css, sync] = await Promise.all([
    source("app/study-reader.tsx"),
    source("app/note-highlight-text.tsx"),
    source("app/entry-highlight-text.tsx"),
    source("app/lib/selection-feedback.ts"),
    source("app/globals.css"),
    source("app/lib/use-cloud-sync.ts"),
  ]);

  const durableWrite = reader.indexOf("window.localStorage.setItem(", reader.indexOf("const commitVersionsDurably"));
  const newestMemory = reader.indexOf("versionsRef.current = next", durableWrite);
  const paintSchedule = reader.indexOf("scheduleVersionsRenderAfterPaint()", newestMemory);
  assert.ok(durableWrite >= 0 && newestMemory > durableWrite && paintSchedule > newestMemory);
  assert.equal([...reader.matchAll(/\{ afterPaint: true \}/g)].length, 4);
  assert.equal([...reader.matchAll(/localStorage\.setItem\(\s*STORAGE_KEYS\.library/g)].length, 2);
  assert.match(reader, /mapVersionsIfChanged[\s\S]*?return changed \? next : current/);
  assert.match(noteText, /onPointerUp=\{\(\) => \{\s*if \(!rememberSelectedNoteText\(\)\) queueMicrotask/);
  assert.match(entryText, /onPointerUp=\{\(\) => \{\s*if \(!rememberSelectedEntryText\(\)\) queueMicrotask/);
  assert.match(feedback, /sameSelection[\s\S]*?requestAnimationFrame[\s\S]*?requestAnimationFrame[\s\S]*?requestAnimationFrame/);
  assert.match(css, /\.note-highlight-text::selection[\s\S]*?background: rgba\(255, 214, 10, 0\.58\)/);
  assert.match(css, /\.entry-highlight-text::selection[\s\S]*?background: #ffe27a/);
  assert.match(css, /\.floating-note\.history-docked-note[\s\S]*?backdrop-filter: none/);
  assert.match(css, /\.annotation-quick-review[\s\S]*?contain: paint/);
  assert.match(sync, /latestInputs\.current\.versionsRef\.current/);
});

test("review bookmark is durable locally and synchronized as an independent record", async () => {
  const [reader, sync, bookmark] = await Promise.all([
    source("app/study-reader.tsx"),
    source("app/lib/use-cloud-sync.ts"),
    source("app/lib/review-bookmark.ts"),
  ]);
  assert.match(reader, /commitReviewBookmarkDurably[\s\S]*?STORAGE_KEYS\.reviewBookmark[\s\S]*?reviewBookmarkRef\.current = bookmark/);
  assert.match(sync, /item_type: "review_bookmark"/);
  assert.match(sync, /latestInputs\.current\.reviewBookmarkRef\.current/);
  assert.match(sync, /STORAGE_KEYS\.reviewBookmark/);
  assert.doesNotMatch(bookmark, /noteHighlights|entryTextHighlights|\bnote:/);
});
